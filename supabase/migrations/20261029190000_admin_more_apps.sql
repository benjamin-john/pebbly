-- Admin for Split the Bill, Sign-up Sheet, Shared List, Baby Names and Secret Santa (/admin/). Safe to re-run.
--
-- These apps had one host key each (owner_hash), so "Open as host" from the admin page needs a second
-- one that leaves the real host's key working: admin_hash (one per document/group, replaced each time).
-- Every host check for them now accepts either key (_doc_is_owner). The functions below are their
-- latest versions with only that check changed.
-- Baby Names is private between two people: the admin can list and delete them, never open one
-- (doc_admin_grant refuses), and the list shows no names from inside.
-- Secret Santa: opening as host gives the organizer view, which never shows who has whom.

alter table plan_docs    add column if not exists admin_hash text;
alter table santa_groups add column if not exists admin_hash text;

create or replace function _doc_is_owner(p_owner_hash text, p_admin_hash text, p_token text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p_token, '') <> '' and _app_hash(p_token) in (p_owner_hash, coalesce(p_admin_hash, ''));
$$;

-- ------------------------------------------------------------------ host checks

create or replace function doc_get(p_code text, p_owner_token text default null, p_since int default 0) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d plan_docs%rowtype;
begin
  select * into d from plan_docs where code = lower(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  return jsonb_strip_nulls(jsonb_build_object('code', d.code, 'kind', d.kind, 'version', d.version,
    'is_owner', _doc_is_owner(d.owner_hash, d.admin_hash, p_owner_token),
    'updated_at', d.updated_at, 'state', case when d.version <> coalesce(p_since, 0) then d.state end));
end $$;

create or replace function doc_delete(p_code text, p_owner_token text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  delete from plan_docs where code = lower(btrim(coalesce(p_code, ''))) and _doc_is_owner(owner_hash, admin_hash, p_owner_token);
  if not found then
    if exists (select 1 from plan_docs where code = lower(btrim(coalesce(p_code, '')))) then raise exception 'not_owner'; end if;
    raise exception 'doc_not_found';
  end if;
end $$;

create or replace function _santa_owner(p_code text, p_owner_token text, p_lock boolean default true) returns santa_groups
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_group(p_code, p_lock);
begin
  if not _doc_is_owner(g.owner_hash, g.admin_hash, p_owner_token) then raise exception 'not_owner'; end if;
  return g;
end $$;

create or replace function santa_get(p_code text, p_participant text, p_owner_token text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype; v_owner boolean; v_me santa_people%rowtype; v_match santa_people%rowtype; v_hash text := _app_hash(p_participant);
begin
  select * into g from santa_groups where code = lower(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  v_owner := _doc_is_owner(g.owner_hash, g.admin_hash, p_owner_token);
  if coalesce(p_participant, '') <> '' then
    select * into v_me from santa_people where group_id = g.id and claim_hash = v_hash;
  end if;
  if v_me.id is not null and g.drawn_at is not null then
    select p.* into v_match from santa_pairs s join santa_people p on p.id = s.receiver where s.group_id = g.id and s.giver = v_me.id;
  end if;
  return jsonb_build_object(
    'group', jsonb_build_object('code', g.code, 'name', g.name, 'budget', g.budget, 'swap_date', g.swap_date, 'note', g.note,
                                'self_join', g.self_join, 'drawn', g.drawn_at is not null),
    'is_owner', v_owner,
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'claimed', p.claim_hash is not null,
                                  'mine', coalesce(p.id = v_me.id, false), 'has_wish', p.wish <> '') order by lower(p.name))
                          from santa_people p where p.group_id = g.id), '[]'::jsonb),
    'exclusions', case when v_owner then coalesce((select jsonb_agg(jsonb_build_array(a, b)) from santa_exclusions where group_id = g.id), '[]'::jsonb) end,
    'me', case when v_me.id is not null then jsonb_build_object('id', v_me.id, 'name', v_me.name, 'wish', v_me.wish) end,
    'match', case when v_match.id is not null then jsonb_build_object('name', v_match.name, 'wish', v_match.wish) end);
end $$;

-- Is p_token the host's key for this event/poll? (doc and santa now also accept the admin key)
create or replace function _lock_is_owner(p_app text, p_code text, p_token text) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if coalesce(p_token, '') = '' then return false; end if;
  if p_app = 'rsvp' then
    select id into v_id from rsvp_events where code = _lock_code(p_code);
    return v_id is not null and _rsvp_is_owner(v_id, p_token);
  elsif p_app = 'wdw' then
    v_id := _wdw_event_id(p_code);
    return v_id is not null and _wdw_is_owner(v_id, p_token);
  elsif p_app = 'doc' then
    return exists (select 1 from plan_docs where code = _lock_code(p_code) and _doc_is_owner(owner_hash, admin_hash, p_token));
  elsif p_app = 'santa' then
    return exists (select 1 from santa_groups where code = _lock_code(p_code) and _doc_is_owner(owner_hash, admin_hash, p_token));
  elsif p_app = 'poll' then
    -- Poll's owner check: delete the poll with this key inside a savepoint, confirm it's gone, then
    -- roll the delete back. Nothing is changed.
    begin
      perform poll_delete(p_code, p_token);
      begin
        if poll_get(p_code, null, null) is not null then raise exception 'lock_probe_still_there'; end if;
      exception when others then
        if sqlerrm = 'lock_probe_still_there' then raise; end if;   -- not_found errors mean it was deleted
      end;
      raise exception 'lock_probe_owner';
    exception when others then
      return sqlerrm = 'lock_probe_owner';
    end;
  end if;
  return false;
end $$;

-- Notifications: the same host check for Sign-up Sheets and Secret Santa.
create or replace function _notify_event(p_app text, p_code text, p_role text, p_key text, p_lock text)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_code text := lower(btrim(coalesce(p_code, ''))); v_lock text; v_hash text;
begin
  if coalesce(p_key, '') = '' or char_length(p_key) > 200 or p_role not in ('host', 'guest') then return null; end if;
  if p_app = 'rsvp' then
    select id into v_id from rsvp_events where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then return case when _rsvp_is_owner(v_id, p_key) then v_id end; end if;
    if not exists (select 1 from rsvp_guests where event_id = v_id and participant = p_key) then return null; end if;
  elsif p_app = 'wdw' then
    select id into v_id from events where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then return case when _wdw_is_owner(v_id, p_key) then v_id end; end if;
    if not exists (select 1 from responses where event_id = v_id and participant_id = p_key) then return null; end if;
  elsif p_app = 'poll' then
    select id, owner_hash into v_id, v_hash from polls where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then return case when _poll_is_owner(v_id, v_hash, p_key) then v_id end; end if;
    if not (exists (select 1 from poll_votes where poll_id = v_id and participant_id = p_key)
         or exists (select 1 from poll_voters where poll_id = v_id and participant_id = p_key)
         or exists (select 1 from poll_options where poll_id = v_id and added_by_pid = p_key)) then return null; end if;
  elsif p_app = 'signup' then
    select id into v_id from plan_docs d where code = v_code and kind = 'signup';
    if v_id is null then return null; end if;
    -- hosts only (nothing goes to guests yet)
    return case when p_role = 'host' and exists (select 1 from plan_docs d where d.id = v_id and _doc_is_owner(d.owner_hash, d.admin_hash, p_key)) then v_id end;
  elsif p_app = 'santa' then
    select id into v_id from santa_groups where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then
      return case when exists (select 1 from santa_groups g where g.id = v_id and _doc_is_owner(g.owner_hash, g.admin_hash, p_key)) then v_id end;
    end if;
    if not exists (select 1 from santa_people where group_id = v_id and claim_hash = _app_hash(p_key)) then return null; end if;
  elsif p_app = 'bracket' then
    -- a shared ("play together") bracket: every phone in it, by its member key
    select id into v_id from play_games where code = upper(v_code) and kind = 'bracket';
    if v_id is null or p_role <> 'guest' then return null; end if;
    if not exists (select 1 from play_members where game_id = v_id and key_hash = _play_hash(p_key)) then return null; end if;
  else
    return null;
  end if;
  -- guests of a password-protected event need its key (the Sign-up Sheet's password is the 'doc' one)
  select key into v_lock from plan_locks where app = case p_app when 'signup' then 'doc' else p_app end and code = v_code;
  if found and coalesce(p_lock, '') <> v_lock then return null; end if;
  return v_id;
end $$;


-- ------------------------------------------------------------------ admin

-- p_kind: 'bill', 'signup', 'list' or 'names'. Counts only, never what's inside (Baby Names: just the
-- two first names it was started with, to tell them apart).
create or replace function doc_admin_list(p_password text, p_kind text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password);
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  return jsonb_build_object('docs', coalesce((
    select jsonb_agg(jsonb_build_object('code', d.code, 'kind', d.kind, 'created_at', d.created_at, 'updated_at', d.updated_at,
      'title', case when d.kind = 'names' then concat_ws(' & ', nullif(d.state->'p'->>'a', ''), nullif(d.state->'p'->>'b', ''))
                    else d.state->>'title' end,
      'emoji', d.state->>'emoji',
      'people',   case when d.kind = 'bill' and jsonb_typeof(d.state->'people') = 'object' then (select count(*) from jsonb_object_keys(d.state->'people')) end,
      'expenses', case when d.kind = 'bill' and jsonb_typeof(d.state->'expenses') = 'object' then (select count(*) from jsonb_object_keys(d.state->'expenses')) end,
      'slots',    case when d.kind = 'signup' and jsonb_typeof(d.state->'slots') = 'object' then (select count(*) from jsonb_object_keys(d.state->'slots')) end,
      'signups',  case when d.kind = 'signup' and jsonb_typeof(d.state->'signups') = 'object' then (select count(*) from jsonb_object_keys(d.state->'signups')) end,
      'items',    case when d.kind = 'list' and jsonb_typeof(d.state->'items') = 'object' then (select count(*) from jsonb_object_keys(d.state->'items')) end,
      'added',    case when d.kind = 'names' and jsonb_typeof(d.state->'names') = 'object' then (select count(*) from jsonb_object_keys(d.state->'names')) end
    ) order by d.updated_at desc)
    from plan_docs d where d.kind = p_kind), '[]'::jsonb));
end $$;

-- A host key for the admin (replaced each time); the real host keeps theirs. Not for Baby Names.
create or replace function doc_admin_grant(p_password text, p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password); v_token text := _app_token(); v_kind text;
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  select kind into v_kind from plan_docs where code = lower(btrim(coalesce(p_code, '')));
  if v_kind is null then return jsonb_build_object('error', 'doc_not_found'); end if;
  if v_kind = 'names' then return jsonb_build_object('error', 'not_allowed'); end if;
  update plan_docs set admin_hash = _app_hash(v_token) where code = lower(btrim(coalesce(p_code, '')));
  return jsonb_build_object('owner_token', v_token, 'kind', v_kind);
end $$;

create or replace function doc_admin_delete(p_password text, p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password); v_n int;
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  delete from plan_docs where code = lower(btrim(coalesce(p_code, '')));
  get diagnostics v_n = row_count;
  return jsonb_build_object('deleted', v_n);
end $$;

create or replace function santa_admin_list(p_password text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password);
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  return jsonb_build_object('groups', coalesce((
    select jsonb_agg(jsonb_build_object('code', g.code, 'name', g.name, 'swap_date', g.swap_date, 'drawn', g.drawn_at is not null,
      'people', (select count(*) from santa_people p where p.group_id = g.id),
      'claimed', (select count(*) from santa_people p where p.group_id = g.id and p.claim_hash is not null),
      'created_at', g.created_at, 'updated_at', g.updated_at) order by g.updated_at desc)
    from santa_groups g), '[]'::jsonb));
end $$;

create or replace function santa_admin_grant(p_password text, p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password); v_token text := _app_token();
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  update santa_groups set admin_hash = _app_hash(v_token) where code = lower(btrim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('error', 'group_not_found'); end if;
  return jsonb_build_object('owner_token', v_token);
end $$;

create or replace function santa_admin_delete(p_password text, p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password); v_n int;
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  delete from santa_groups where code = lower(btrim(coalesce(p_code, '')));
  get diagnostics v_n = row_count;
  return jsonb_build_object('deleted', v_n);
end $$;

revoke all on function _doc_is_owner(text, text, text), doc_admin_list(text, text), doc_admin_grant(text, text), doc_admin_delete(text, text),
  santa_admin_list(text), santa_admin_grant(text, text), santa_admin_delete(text, text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _doc_is_owner(text, text, text) from %I', r);
      execute format('grant execute on function doc_admin_list(text, text), doc_admin_grant(text, text), doc_admin_delete(text, text), '
                  || 'santa_admin_list(text), santa_admin_grant(text, text), santa_admin_delete(text, text), doc_delete(text, text) to %I', r);
    end if;
  end loop;
end $$;

-- doc_get and santa_get are guest functions behind password wrappers: rebuild those to match.
select _lock_wrap_all();
