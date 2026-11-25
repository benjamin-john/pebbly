-- Little Ones (/littleones/): baby log (feeds, diapers, sleep, health), contraction timer and kick counter for a
-- couple. Safe to re-run.
--
-- It lives in the same shared space as their Baby Names shortlist (a plan_docs row of kind 'names'): one link,
-- one password, one host. Settings (due date, baby's name, birth time, units, contraction rule, hospital number)
-- are in that document's state under "lo". Every log entry is its own row here (lo_entries), so a year of feeds and
-- diapers never fills the shared document.
--
--  * lo_sync(code, since, changes, pid): sends this phone's new or changed entries and returns every entry changed
--    since `since` (a running number, seq). Entry ids are made on the phone. Deleting keeps a tombstone (deleted)
--    so other phones hear about it. Last change wins per entry. Behind the 'doc' password (gated_lo_sync).
--  * Notifications (app 'little', role 'guest': everyone with the link, by phone id): someone starts timing
--    contractions, contractions reach the chosen pattern (5-1-1 by default; at most once per 3 hours), water broke.

create table if not exists lo_entries (
  doc_id     uuid not null references plan_docs(id) on delete cascade,
  id         text not null,
  kind       text not null,
  at         bigint not null,                    -- start, ms since 1970
  end_at     bigint,                             -- end (ms); null while running or for one-moment things
  data       jsonb not null default '{}'::jsonb,
  who        text not null default '',           -- 'a' / 'b': which parent (as in Baby Names)
  pid        text,                               -- the phone that last changed it (its own alerts skip it); never returned
  deleted    boolean not null default false,
  seq        bigint not null,
  updated_at timestamptz not null default now(),
  primary key (doc_id, id)
);
create sequence if not exists lo_seq;
create index if not exists lo_entries_seq on lo_entries(doc_id, seq);
create index if not exists lo_entries_kind on lo_entries(doc_id, kind, at);
alter table lo_entries enable row level security;
revoke all on lo_entries from public;
revoke all on sequence lo_seq from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on lo_entries from %I', r);
      execute format('revoke all on sequence lo_seq from %I', r);
    end if;
  end loop;
end $$;

-- One entry from a phone: {id, k, at, end, d, by, del}.
create or replace function _lo_put(p_doc uuid, c jsonb, p_pid text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_id text; v_kind text; v_at bigint; v_end bigint; v_data jsonb; v_by text;
begin
  if jsonb_typeof(c) <> 'object' then raise exception 'invalid_entry'; end if;
  v_id := c->>'id';
  if coalesce(v_id, '') !~ '^[a-z0-9]{4,24}$' then raise exception 'invalid_entry'; end if;
  if coalesce((c->>'del')::boolean, false) then
    update lo_entries set deleted = true, data = '{}'::jsonb, pid = p_pid, seq = nextval('lo_seq'), updated_at = now()
     where doc_id = p_doc and id = v_id and not deleted;
    return;
  end if;
  v_kind := c->>'k';
  if v_kind is null or v_kind not in ('feed', 'bottle', 'pump', 'diaper', 'sleep', 'med', 'temp', 'growth', 'first',
                                      'note', 'kicks', 'contraction', 'water') then
    raise exception 'invalid_entry';
  end if;
  if jsonb_typeof(c->'at') <> 'number' then raise exception 'invalid_entry'; end if;
  v_at := (c->>'at')::numeric::bigint;
  if v_at < 1500000000000 or v_at > 4000000000000 then raise exception 'invalid_entry'; end if;
  if c->'end' is not null and jsonb_typeof(c->'end') = 'number' then
    v_end := (c->>'end')::numeric::bigint;
    if v_end < v_at or v_end > v_at + 7 * 86400000 then raise exception 'invalid_entry'; end if;
  end if;
  v_data := coalesce(c->'d', '{}'::jsonb);
  if jsonb_typeof(v_data) <> 'object' or octet_length(v_data::text) > 2000 then raise exception 'invalid_entry'; end if;
  v_by := coalesce(c->>'by', '');
  if v_by not in ('a', 'b', '') then raise exception 'invalid_entry'; end if;
  insert into lo_entries (doc_id, id, kind, at, end_at, data, who, pid, deleted, seq)
  values (p_doc, v_id, v_kind, v_at, v_end, v_data, v_by, p_pid, false, nextval('lo_seq'))
  on conflict (doc_id, id) do update
    set kind = excluded.kind, at = excluded.at, end_at = excluded.end_at, data = excluded.data, who = excluded.who,
        pid = excluded.pid, deleted = false, seq = excluded.seq, updated_at = now();
end $$;

create or replace function lo_sync(p_code text, p_since bigint default 0, p_changes jsonb default '[]'::jsonb,
                                   p_pid text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d plan_docs%rowtype; c jsonb; v_rows jsonb; v_max bigint; v_n int; v_pid text := left(nullif(btrim(coalesce(p_pid, '')), ''), 60);
begin
  select * into d from plan_docs where code = lower(btrim(coalesce(p_code, ''))) and kind = 'names';
  if not found then raise exception 'doc_not_found'; end if;
  if p_changes is null then p_changes := '[]'::jsonb; end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 200 then raise exception 'invalid_entry'; end if;
  if jsonb_array_length(p_changes) > 0 then
    -- one writer per space at a time, so seq numbers become visible in order (a phone never skips one)
    perform pg_advisory_xact_lock(hashtext('lo:' || d.id::text));
    for c in select value from jsonb_array_elements(p_changes) loop
      perform _lo_put(d.id, c, v_pid);
    end loop;
    if (select count(*) from lo_entries where doc_id = d.id) > 30000 then raise exception 'too_many_entries'; end if;
    -- keeps the space from being cleaned up as unused (doc_create removes ones untouched for 400 days)
    update plan_docs set updated_at = now() where id = d.id and updated_at < now() - interval '1 day';
  end if;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', e.id, 'k', e.kind, 'at', e.at, 'end', e.end_at,
           'd', e.data, 'by', e.who, 'del', case when e.deleted then true end, 'seq', e.seq)) order by e.seq), '[]'::jsonb),
         max(e.seq), count(*)
    into v_rows, v_max, v_n
    from (select * from lo_entries where doc_id = d.id and seq > coalesce(p_since, 0) order by seq limit 1000) e;
  return jsonb_build_object('seq', coalesce(v_max, greatest(coalesce(p_since, 0), 0)), 'entries', v_rows, 'more', v_n >= 1000);
end $$;

-- ------------------------------------------------------------------ notifications

insert into notify_types (type, app, audience, label, sort) values
  ('little.contractions', 'little', 'guest', 'Someone starts timing contractions', 1),
  ('little.pattern',      'little', 'guest', 'Contractions reach your pattern (like 5-1-1)', 2),
  ('little.water',        'little', 'guest', 'Water broke', 3)
on conflict (type) do update set app = excluded.app, audience = excluded.audience, label = excluded.label, sort = excluded.sort;

-- The rule ("511": every 5 minutes or closer, about a minute long, for an hour) is met by the contractions in the
-- hour up to p_at. Same test as the page's (pattern() in littleones/index.html). Returns null if not met.
create or replace function _lo_pattern(p_doc uuid, p_at bigint, p_rule text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_gap int := case p_rule when '411' then 4 when '311' then 3 else 5 end; v_n int; v_first bigint; v_last bigint; v_len numeric;
begin
  select count(*), min(at), max(at), avg(end_at - at) into v_n, v_first, v_last, v_len
    from lo_entries where doc_id = p_doc and kind = 'contraction' and not deleted and end_at is not null
     and at > p_at - 61 * 60000 and at <= p_at;
  if v_n < 3 or v_last - v_first < 55 * 60000 then return null; end if;
  if (v_last - v_first)::numeric / (v_n - 1) > v_gap * 60000 + 30000 or v_len < 50000 then return null; end if;
  return jsonb_build_object('rule', v_gap || '-1-1', 'apart', round((v_last - v_first)::numeric / (v_n - 1) / 60000, 1),
    'len', round(v_len / 1000), 'n', v_n);
end $$;

create or replace function _notify_little() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_state jsonb; v_name text; v_p jsonb;
begin
  if new.deleted then
    if new.kind in ('water', 'contraction') then
      delete from notifications where app = 'little' and event_id = new.doc_id and detail->>'entry' = new.id;
    end if;
    return null;
  end if;
  if new.kind not in ('water', 'contraction') then return null; end if;
  select state into v_state from plan_docs where id = new.doc_id;
  v_name := coalesce(nullif(v_state->'p'->>new.who, ''), 'Someone');
  if new.kind = 'water' then
    if tg_op = 'INSERT' or old.deleted then
      perform _notify_add('little', new.doc_id, 'little.water', new.pid, null, v_name, jsonb_build_object('entry', new.id));
    end if;
    return null;
  end if;
  -- the first contraction after two quiet hours
  if (tg_op = 'INSERT' or old.deleted) and not exists (
        select 1 from lo_entries where doc_id = new.doc_id and kind = 'contraction' and not deleted and id <> new.id
           and at between new.at - 2 * 3600000 and new.at + 60000) then
    perform _notify_add('little', new.doc_id, 'little.contractions', new.pid, null, v_name, jsonb_build_object('entry', new.id));
  end if;
  if new.end_at is not null and not exists (
        select 1 from notifications where app = 'little' and event_id = new.doc_id and type = 'little.pattern'
           and created_at > now() - interval '3 hours') then
    v_p := _lo_pattern(new.doc_id, new.at, coalesce(v_state->'lo'->>'rule', '511'));
    if v_p is not null then
      perform _notify_add('little', new.doc_id, 'little.pattern', null, null, v_name, v_p || jsonb_build_object('entry', new.id));
    end if;
  end if;
  return null;
end $$;

drop trigger if exists notify_little on lo_entries;
create trigger notify_little after insert or update on lo_entries for each row execute function _notify_little();

-- Same as 20261117010000_basecamp_ask.sql, plus Little Ones: anyone with the link (and the password, if it has one).
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
  elsif p_app = 'basecamp' then
    -- Basecamp: only things meant for one person on the map (by their member key)
    select id into v_id from bc_sessions where code = v_code;
    if v_id is null or p_role <> 'guest' then return null; end if;
    if not exists (select 1 from bc_members where session_id = v_id and key_hash = _app_hash(p_key)) then return null; end if;
  elsif p_app = 'little' then
    -- Little Ones: everyone with the link (key = the phone's own id); the password check is below
    select id into v_id from plan_docs where code = v_code and kind = 'names';
    if v_id is null or p_role <> 'guest' then return null; end if;
  else
    return null;
  end if;
  -- guests of a password-protected event need its key (Sign-up Sheet's and Little Ones' password is the 'doc' one)
  select key into v_lock from plan_locks where app = case when p_app in ('signup', 'little') then 'doc' else p_app end and code = v_code;
  if found and coalesce(p_lock, '') <> v_lock then return null; end if;
  return v_id;
end $$;

create or replace function _notify_title(p_app text, p_event uuid, out o_code text, out o_title text, out o_emoji text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_app = 'rsvp' then select code, title, emoji into o_code, o_title, o_emoji from rsvp_events where id = p_event;
  elsif p_app = 'wdw' then select code, name, '📅' into o_code, o_title, o_emoji from events where id = p_event;
  elsif p_app = 'poll' then select code, name, '🗳️' into o_code, o_title, o_emoji from polls where id = p_event;
  elsif p_app = 'signup' then select code, coalesce(nullif(state->>'title', ''), 'Sign-up Sheet'), '📋' into o_code, o_title, o_emoji from plan_docs where id = p_event;
  elsif p_app = 'santa' then select code, name, '🎁' into o_code, o_title, o_emoji from santa_groups where id = p_event;
  elsif p_app = 'basecamp' then select code, name, '⛺' into o_code, o_title, o_emoji from bc_sessions where id = p_event;
  elsif p_app = 'bracket' then select code, coalesce(nullif(state->>'title', ''), 'Bracket'), '🏆' into o_code, o_title, o_emoji from play_games where id = p_event;
  elsif p_app = 'little' then select code, coalesce(nullif(state->'lo'->>'baby', ''), 'Little Ones'), '👶' into o_code, o_title, o_emoji from plan_docs where id = p_event;
  end if;
end $$;

-- ------------------------------------------------------------------ grants and the password wrapper

revoke all on function _lo_put(uuid, jsonb, text), lo_sync(text, bigint, jsonb, text), _lo_pattern(uuid, bigint, text),
  _notify_little() from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _lo_put(uuid, jsonb, text), lo_sync(text, bigint, jsonb, text), '
                  || '_lo_pattern(uuid, bigint, text), _notify_little() from %I', r);
    end if;
  end loop;
end $$;

-- Same list as before, plus Little Ones' lo_sync (behind the Baby Names / Little Ones password).
create or replace function _lock_wrap_all() returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare w text[];
begin
  foreach w slice 1 in array array[
    ['rsvp', 'rsvp_get'], ['rsvp', 'rsvp_respond'], ['rsvp', 'rsvp_post'], ['rsvp', 'rsvp_delete_post'],
    ['rsvp', 'rsvp_item_add'], ['rsvp', 'rsvp_item_edit'], ['rsvp', 'rsvp_item_remove'], ['rsvp', 'rsvp_item_claim'],
    ['rsvp', 'rsvp_plus_names'], ['rsvp', 'rsvp_claim_note'],
    ['poll', 'poll_get'], ['poll', 'poll_vote'], ['poll', 'poll_add_option'], ['poll', 'poll_edit_option'],
    ['poll', 'poll_remove_option'],
    ['wdw', 'wdw_get'], ['wdw', 'get_event'], ['wdw', 'save_response'], ['wdw', 'delete_response'],
    ['doc', 'doc_get'], ['doc', 'doc_push'], ['doc', 'lo_sync'],
    ['santa', 'santa_get'], ['santa', 'santa_claim'], ['santa', 'santa_unclaim'], ['santa', 'santa_join'], ['santa', 'santa_set_wish'],
    ['basecamp', 'bc_sync'], ['basecamp', 'bc_join'], ['basecamp', 'bc_me_update'], ['basecamp', 'bc_remove_member'],
    ['basecamp', 'bc_waypoint_save'], ['basecamp', 'bc_waypoint_delete'], ['basecamp', 'bc_trail_delete'],
    ['basecamp', 'bc_ot_link'], ['basecamp', 'bc_ot_set'], ['basecamp', 'bc_ot_stop'], ['basecamp', 'bc_ot_extend'], ['basecamp', 'bc_ask'], ['basecamp', 'bc_ot_follow']
  ] loop
    perform _lock_wrap(w[1], w[2]);
  end loop;
end $$;

select _lock_wrap_all();
