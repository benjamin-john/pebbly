-- Live Quiz: display-only screen links, admin access, and longer-lived sessions. Safe to re-run.
--  * live_keys: extra keys per session. 'owner' keys (e.g. given to the admin) work like the
--    organizer's own; 'display' keys only let a screen show the quiz (no controls).
--  * live_display: what a display-only screen shows: the current question, and its right answer and
--    counts only after the reveal. live_results also accepts a display key (for the results screen).
--  * live_admin_list / live_admin_grant / live_admin_delete use the shared admin password.
--  * Sessions are kept 30 days after the last change (was 7), so a quiz can be set up in advance.

create table if not exists live_keys (
  session_id uuid not null references live_sessions(id) on delete cascade,
  key_hash   text not null,
  kind       text not null check (kind in ('owner', 'display')),
  label      text not null default '',
  created_at timestamptz not null default now(),
  primary key (session_id, key_hash)
);
alter table live_keys enable row level security;
revoke all on live_keys from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on live_keys from %I', r); end if;
  end loop;
end $$;

-- Does p_token open this session as p_kind? The organizer's own key counts as both kinds.
create or replace function _live_has_key(s live_sessions, p_token text, p_kind text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p_token, '') <> '' and (_app_hash(p_token) = s.owner_hash
    or exists (select 1 from live_keys k where k.session_id = s.id and k.key_hash = _app_hash(p_token)
                 and (k.kind = p_kind or k.kind = 'owner')));
$$;

create or replace function _live_owner(p_code text, p_owner_token text) returns live_sessions
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype;
begin
  select * into s from live_sessions where code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found then raise exception 'session_not_found'; end if;
  if not _live_has_key(s, p_owner_token, 'owner') then raise exception 'not_owner'; end if;
  return s;
end $$;

create or replace function live_create(p_title text, p_questions jsonb, p_require_name boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_code text := _live_code(); v_token text := _app_token(); v_title text := _app_text(p_title, 80);
begin
  if v_title = '' then raise exception 'invalid_title'; end if;
  delete from live_sessions where updated_at < now() - interval '30 days';
  insert into live_sessions (code, owner_hash, title, require_name, questions)
  values (v_code, _app_hash(v_token), v_title, coalesce(p_require_name, false), _live_questions(p_questions));
  return jsonb_build_object('code', v_code, 'owner_token', v_token);
end $$;

create or replace function live_host(p_code text, p_owner_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype; q jsonb; v_people int; v_voted int;
begin
  select * into s from live_sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  if not _live_has_key(s, p_owner_token, 'owner') then raise exception 'not_owner'; end if;
  q := s.questions -> s.qindex;
  select count(*) into v_people from live_people where session_id = s.id;
  select count(*) into v_voted from live_votes where session_id = s.id and qindex = s.qindex;
  return jsonb_build_object('code', s.code, 'title', s.title, 'require_name', s.require_name, 'questions', s.questions,
    'phase', s.phase, 'qindex', s.qindex, 'version', s.version, 'total', jsonb_array_length(s.questions),
    'people', v_people, 'voted', v_voted,
    'counts', _live_counts(s.id, s.qindex, jsonb_array_length(q->'choices')),
    'names', case when s.require_name then (select coalesce(jsonb_agg(name order by joined_at desc), '[]'::jsonb)
                                               from (select name, joined_at from live_people where session_id = s.id order by joined_at desc limit 60) x) end);
end $$;

create or replace function live_results(p_code text, p_owner_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype;
begin
  select * into s from live_sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then raise exception 'session_not_found'; end if;
  if not (_live_has_key(s, p_owner_token, 'owner') or _live_has_key(s, p_owner_token, 'display')) then raise exception 'not_owner'; end if;
  return jsonb_build_object('title', s.title, 'require_name', s.require_name, 'questions', s.questions,
    'counts', (select coalesce(jsonb_agg(_live_counts(s.id, i - 1, jsonb_array_length(s.questions -> (i - 1) -> 'choices')) order by i), '[]'::jsonb)
                 from generate_series(1, jsonb_array_length(s.questions)) i),
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
                 'name', case when s.require_name then p.name else 'Person ' || p.n end,
                 'answers', (select coalesce(jsonb_object_agg(v.qindex::text, v.choice), '{}'::jsonb)
                               from live_votes v where v.session_id = s.id and v.pid_hash = p.pid_hash)) order by p.n), '[]'::jsonb)
               from (select *, row_number() over (order by joined_at) n from live_people where session_id = s.id) p));
end $$;

-- Organizer: a new link for a screen that only shows the quiz (projector), no controls.
create or replace function live_display_link(p_code text, p_owner_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype := _live_owner(p_code, p_owner_token); v_token text := _app_token();
begin
  delete from live_keys where session_id = s.id and kind = 'display' and created_at < now() - interval '30 days';
  insert into live_keys (session_id, key_hash, kind, label) values (s.id, _app_hash(v_token), 'display', 'screen');
  return jsonb_build_object('display_token', v_token);
end $$;

-- What a display-only screen shows (polled about once a second). Never the whole question list, and
-- the right answer and the vote counts only once the organizer reveals the question.
create or replace function live_display(p_code text, p_display_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype; q jsonb; v_people int; v_voted int; v_open boolean;
begin
  select * into s from live_sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  if not _live_has_key(s, p_display_token, 'display') then raise exception 'not_owner'; end if;
  q := s.questions -> s.qindex;
  v_open := s.phase in ('question', 'reveal');
  select count(*) into v_people from live_people where session_id = s.id;
  select count(*) into v_voted from live_votes where session_id = s.id and qindex = s.qindex;
  return jsonb_strip_nulls(jsonb_build_object('code', s.code, 'title', s.title, 'require_name', s.require_name,
    'phase', s.phase, 'qindex', s.qindex, 'version', s.version, 'total', jsonb_array_length(s.questions),
    'people', v_people, 'voted', v_voted,
    'question', case when v_open then jsonb_build_object('q', q->'q', 'choices', q->'choices') end,
    'poll', case when v_open then jsonb_typeof(q->'answer') <> 'number' end,
    'answer', case when s.phase = 'reveal' then q->'answer' end,
    'counts', case when s.phase = 'reveal' then _live_counts(s.id, s.qindex, jsonb_array_length(q->'choices')) end,
    'names', case when s.require_name then (select coalesce(jsonb_agg(name order by joined_at desc), '[]'::jsonb)
                                               from (select name, joined_at from live_people where session_id = s.id order by joined_at desc limit 60) x) end));
end $$;

-- ---------------------------------------------------------------- admin (shared admin password)

create or replace function live_admin_list(p_password text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password);
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  return jsonb_build_object('sessions', coalesce((
    select jsonb_agg(jsonb_build_object('code', s.code, 'title', s.title, 'phase', s.phase, 'qindex', s.qindex,
      'total', jsonb_array_length(s.questions), 'require_name', s.require_name,
      'people', (select count(*) from live_people p where p.session_id = s.id),
      'created_at', s.created_at, 'updated_at', s.updated_at) order by s.updated_at desc)
    from live_sessions s), '[]'::jsonb));
end $$;

-- An organizer key for the admin (one per session, replaced each time); the organizer keeps theirs.
create or replace function live_admin_grant(p_password text, p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password); v_id uuid; v_token text := _app_token();
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  select id into v_id from live_sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('error', 'session_not_found'); end if;
  delete from live_keys where session_id = v_id and kind = 'owner' and label = 'admin';
  insert into live_keys (session_id, key_hash, kind, label) values (v_id, _app_hash(v_token), 'owner', 'admin');
  return jsonb_build_object('owner_token', v_token);
end $$;

create or replace function live_admin_delete(p_password text, p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password);
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  delete from live_sessions where code = upper(btrim(coalesce(p_code, '')));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function _live_has_key(live_sessions, text, text), live_display_link(text, text), live_display(text, text),
  live_admin_list(text), live_admin_grant(text, text), live_admin_delete(text, text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function live_display_link(text, text), live_display(text, text), '
        || 'live_admin_list(text), live_admin_grant(text, text), live_admin_delete(text, text) to %I', r);
    end if;
  end loop;
end $$;
