-- Which day works?: organizer links. Run once in the Supabase SQL Editor. Safe to re-run.
--
-- Adds a private organizer key for each new event, like RSVP and Poll. The organizer can edit
-- the event details, remove someone's response and delete the event. Existing functions are
-- left as they are, so links already shared keep working; the page switches to the new wdw_*
-- functions below. Events made before this have no organizer until the admin opens one
-- with "Open as organizer" on the admin page (that gives the admin a key for it).

create table if not exists wdw_owner_keys (
  event_id   uuid not null references events(id) on delete cascade,
  key_hash   text not null,
  label      text not null default 'organizer',    -- 'organizer' or 'admin'
  created_at timestamptz not null default now(),
  primary key (event_id, key_hash)
);
alter table wdw_owner_keys enable row level security;
revoke all on wdw_owner_keys from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on wdw_owner_keys from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on wdw_owner_keys from authenticated'; end if;
end $$;

-- ------------------------------------------------------------------ helpers

create or replace function _wdw_hash(p_token text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;

-- 64 hex characters of randomness from two v4 UUIDs.
create or replace function _wdw_token() returns text
language sql volatile set search_path = public, pg_temp as $$
  select encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex');
$$;

create or replace function _wdw_is_owner(p_event uuid, p_token text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p_token, '') <> ''
     and exists (select 1 from wdw_owner_keys where event_id = p_event and key_hash = _wdw_hash(p_token));
$$;

create or replace function _wdw_event_id(p_code text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from events where code = lower(btrim(coalesce(p_code, '')));
$$;

-- --------------------------------------------------------------- functions

-- Same as create_event, and also returns a private organizer key.
create or replace function wdw_create(p_name text, p_description text default '', p_num_days int default 1,
                                      p_earliest date default null, p_latest date default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_code text; v_token text := _wdw_token();
begin
  v_code := public.create_event(p_name, p_description, p_num_days, p_earliest, p_latest);
  insert into wdw_owner_keys (event_id, key_hash, label) values (_wdw_event_id(v_code), _wdw_hash(v_token), 'organizer');
  return jsonb_build_object('code', v_code, 'owner_token', v_token);
end $$;

-- Same as get_event, plus is_owner. The organizer also gets each response's id (to remove it).
create or replace function wdw_get(p_code text, p_participant text default null, p_owner_token text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e events%rowtype; v_owner boolean;
begin
  select * into e from events where code = lower(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  v_owner := _wdw_is_owner(e.id, p_owner_token);
  return jsonb_build_object(
    'event', jsonb_build_object('code', e.code, 'name', e.name, 'description', e.description,
                                'num_days', e.num_days, 'earliest', e.earliest, 'latest', e.latest),
    'is_owner', v_owner,
    'responses', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'id', case when v_owner then r.id end,
               'name', r.name, 'note', r.note, 'picks', r.picks,
               'mine', coalesce(r.participant_id = p_participant, false),
               'updated_at', r.updated_at)) order by r.updated_at, r.id)
        from responses r where r.event_id = e.id), '[]'::jsonb));
end $$;

-- Organizer: change the name, details, number of days or date range (same rules as creating).
create or replace function wdw_update_event(p_code text, p_owner_token text, p_name text, p_description text,
                                            p_num_days int, p_earliest date, p_latest date)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_id uuid := _wdw_event_id(p_code);
begin
  if v_id is null then raise exception 'event_not_found'; end if;
  if not _wdw_is_owner(v_id, p_owner_token) then raise exception 'not_owner'; end if;
  p_name        := btrim(coalesce(p_name, ''));
  p_description := btrim(coalesce(p_description, ''));
  p_num_days    := coalesce(p_num_days, 1);
  if char_length(p_name) not between 1 and 120 then raise exception 'invalid_name'; end if;
  if char_length(p_description) > 2000          then raise exception 'invalid_description'; end if;
  if p_num_days not between 1 and 14            then raise exception 'invalid_num_days'; end if;
  if p_earliest is not null and p_latest is not null then
    if p_earliest > p_latest                    then raise exception 'invalid_range'; end if;
    if (p_latest - p_earliest) + 1 < p_num_days then raise exception 'range_too_short'; end if;
    if (p_latest - p_earliest) > 730            then raise exception 'range_too_long'; end if;
  end if;
  update events set name = p_name, description = p_description, num_days = p_num_days,
                    earliest = p_earliest, latest = p_latest
   where id = v_id;
end $$;

-- Organizer: remove one person's response.
create or replace function wdw_remove_response(p_code text, p_owner_token text, p_response uuid)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_id uuid := _wdw_event_id(p_code);
begin
  if v_id is null then raise exception 'event_not_found'; end if;
  if not _wdw_is_owner(v_id, p_owner_token) then raise exception 'not_owner'; end if;
  delete from responses where id = p_response and event_id = v_id;
end $$;

-- Organizer: delete the event and all its responses.
create or replace function wdw_delete_event(p_code text, p_owner_token text)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_id uuid := _wdw_event_id(p_code);
begin
  if v_id is null then raise exception 'event_not_found'; end if;
  if not _wdw_is_owner(v_id, p_owner_token) then raise exception 'not_owner'; end if;
  delete from events where id = v_id;   -- responses and keys go with it
end $$;

-- Admin: get an organizer key for any event (one 'admin' key per event, replaced each time,
-- so the real organizer keeps theirs). Returns {"error": ...} instead of raising, so failed
-- password attempts stay counted by _admin_check.
create or replace function wdw_admin_grant(p_password text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_status text; v_id uuid; v_token text;
begin
  v_status := public._admin_check(p_password);
  if v_status <> 'ok' then return jsonb_build_object('error', v_status); end if;
  v_id := _wdw_event_id(p_code);
  if v_id is null then return jsonb_build_object('error', 'event_not_found'); end if;
  v_token := _wdw_token();
  delete from wdw_owner_keys where event_id = v_id and label = 'admin';
  insert into wdw_owner_keys (event_id, key_hash, label) values (v_id, _wdw_hash(v_token), 'admin');
  return jsonb_build_object('owner_token', v_token);
end $$;

-- ------------------------------------------------------------------ grants

revoke all on function _wdw_hash(text), _wdw_token(), _wdw_is_owner(uuid, text), _wdw_event_id(text) from public;
revoke all on function wdw_create(text, text, int, date, date), wdw_get(text, text, text),
  wdw_update_event(text, text, text, text, int, date, date), wdw_remove_response(text, text, uuid),
  wdw_delete_event(text, text), wdw_admin_grant(text, text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _wdw_hash(text), _wdw_token(), _wdw_is_owner(uuid, text), _wdw_event_id(text) from %I', r);
      execute format('grant execute on function wdw_create(text, text, int, date, date), wdw_get(text, text, text),
        wdw_update_event(text, text, text, text, int, date, date), wdw_remove_response(text, text, uuid),
        wdw_delete_event(text, text), wdw_admin_grant(text, text) to %I', r);
    end if;
  end loop;
end $$;
