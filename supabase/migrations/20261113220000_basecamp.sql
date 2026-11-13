-- Basecamp (/basecamp/): a live group map with waypoints and trails. Safe to re-run.
--
--  * bc_sessions: one map per link (8-character code), with a host key (owner_hash) and an admin
--    key (admin_hash, from /admin/). Sessions are never deleted on their own: only the host
--    (bc_host 'delete') or the admin removes one.
--  * bc_members: each phone that joins (hashed per-phone key) with its latest location.
--  * bc_waypoints / bc_trails / bc_points: pins and recorded trails. Ids of waypoints and trails are
--    made by the phone (uuids), so a phone with no signal can keep working and send them later.
--  * bc_sync is the one call a phone makes every few seconds: it sends its location and any new trail
--    points, and gets everyone's locations, the waypoints and trails (only when `rev` changed) and
--    trail points newer than the ones it has (`p_since`).
--  * Passwords: the guest functions are wrapped like the other Plan apps (app 'basecamp').

create table if not exists bc_sessions (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  owner_hash text not null,
  admin_hash text,
  rev        int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bc_members (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references bc_sessions(id) on delete cascade,
  key_hash   text not null,
  name       text not null,
  color      text not null,
  lat        double precision,
  lng        double precision,
  acc        real,
  heading    real,
  speed      real,
  pos_at     timestamptz,
  joined_at  timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  unique (session_id, key_hash)
);

create table if not exists bc_waypoints (
  id         uuid primary key,
  session_id uuid not null references bc_sessions(id) on delete cascade,
  member_id  uuid references bc_members(id) on delete set null,
  by_name    text not null default '',
  name       text not null default '',
  icon       text not null default '📍',
  note       text not null default '',
  lat        double precision not null,
  lng        double precision not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bc_waypoints_session on bc_waypoints (session_id);

create table if not exists bc_trails (
  id         uuid primary key,
  session_id uuid not null references bc_sessions(id) on delete cascade,
  member_id  uuid references bc_members(id) on delete set null,
  by_name    text not null default '',
  color      text not null,
  started_at timestamptz not null default now()
);
create index if not exists bc_trails_session on bc_trails (session_id);

create table if not exists bc_points (
  id         bigint generated always as identity primary key,
  session_id uuid not null references bc_sessions(id) on delete cascade,
  trail_id   uuid not null references bc_trails(id) on delete cascade,
  lat        double precision not null,
  lng        double precision not null,
  at         timestamptz not null
);
create index if not exists bc_points_session on bc_points (session_id, id);
create index if not exists bc_points_trail on bc_points (trail_id);

do $$
declare t text; r text;
begin
  foreach t in array array['bc_sessions', 'bc_members', 'bc_waypoints', 'bc_trails', 'bc_points'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public', t);
    for r in select unnest(array['anon', 'authenticated']) loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on %I from %I', t, r); end if;
    end loop;
  end loop;
end $$;

-- ------------------------------------------------------------------ helpers

create or replace function _bc_session(p_code text) returns bc_sessions
language sql stable security definer set search_path = public, pg_temp as $$
  select * from bc_sessions where code = lower(btrim(coalesce(p_code, '')));
$$;

create or replace function _bc_member(p_session uuid, p_member text) returns bc_members
language sql stable security definer set search_path = public, pg_temp as $$
  select * from bc_members where session_id = p_session and coalesce(p_member, '') <> '' and key_hash = _app_hash(p_member);
$$;

-- A number from a JSON object, or null if it's missing or outside [p_min, p_max].
create or replace function _bc_num(p jsonb, p_key text, p_min double precision, p_max double precision) returns double precision
language plpgsql immutable set search_path = public, pg_temp as $$
declare v double precision;
begin
  if p is null or jsonb_typeof(p -> p_key) <> 'number' then return null; end if;
  v := (p ->> p_key)::double precision;
  if v < p_min or v > p_max then return null; end if;
  return v;
end $$;

-- A phone's timestamp (ms) if it's within the last two days and not in the future, otherwise now.
create or replace function _bc_time(p jsonb, p_key text) returns timestamptz
language plpgsql stable set search_path = public, pg_temp as $$
declare v double precision := _bc_num(p, p_key, 0, 1e14); t timestamptz;
begin
  if v is null then return now(); end if;
  t := to_timestamp(v / 1000.0);
  if t > now() + interval '1 minute' or t < now() - interval '2 days' then return now(); end if;
  return least(t, now());
end $$;

create or replace function _bc_uuid(p text) returns uuid
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p is null or p !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'invalid_id'; end if;
  return p::uuid;
end $$;

create or replace function _bc_color(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when p ~ '^#[0-9A-Fa-f]{6}$' then upper(p) end;
$$;

-- The first color of the palette nobody in the session has yet.
create or replace function _bc_free_color(p_session uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select c from unnest(array['#E4572E', '#2E86DE', '#F4B400', '#8E44AD', '#16A085', '#E84393',
                                                '#6D4C41', '#00ACC1', '#7CB342', '#FF7043', '#3949AB', '#C0CA33']) with ordinality as p(c, i)
                   where c not in (select color from bc_members where session_id = p_session) order by i limit 1), '#E4572E');
$$;

create or replace function _bc_bump(p_session uuid) returns void
language sql volatile security definer set search_path = public, pg_temp as $$
  update bc_sessions set rev = rev + 1, updated_at = now() where id = p_session;
$$;

-- ------------------------------------------------------------------ start / join

-- Start a map. The person starting it joins it too. Returns the code, the host key and their member key.
create or replace function bc_create(p_name text, p_member_name text, p_color text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_code text; v_token text := _app_token(); v_mkey text := _app_token(); v_sid uuid; v_mid uuid; v_color text;
  v_name text := _app_text(p_name, 60); v_who text := _app_text(p_member_name, 30);
begin
  if v_name = '' then raise exception 'invalid_name'; end if;
  if v_who = '' then raise exception 'invalid_member_name'; end if;
  loop
    v_code := _app_code();
    exit when not exists (select 1 from bc_sessions where code = v_code);
  end loop;
  insert into bc_sessions (code, name, owner_hash) values (v_code, v_name, _app_hash(v_token)) returning id into v_sid;
  v_color := coalesce(_bc_color(p_color), _bc_free_color(v_sid));
  insert into bc_members (session_id, key_hash, name, color) values (v_sid, _app_hash(v_mkey), v_who, v_color) returning id into v_mid;
  return jsonb_build_object('code', v_code, 'owner_token', v_token, 'member_id', v_mid, 'member_key', v_mkey, 'color', v_color);
end $$;

create or replace function bc_join(p_code text, p_name text, p_color text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); v_mkey text := _app_token(); v_mid uuid; v_color text;
  v_who text := _app_text(p_name, 30);
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  if v_who = '' then raise exception 'invalid_member_name'; end if;
  perform 1 from bc_sessions where id = s.id for update;
  if (select count(*) from bc_members where session_id = s.id) >= 60 then raise exception 'too_many_people'; end if;
  v_color := coalesce(_bc_color(p_color), _bc_free_color(s.id));
  insert into bc_members (session_id, key_hash, name, color) values (s.id, _app_hash(v_mkey), v_who, v_color) returning id into v_mid;
  perform _bc_bump(s.id);
  return jsonb_build_object('member_id', v_mid, 'member_key', v_mkey, 'color', v_color);
end $$;

-- Change your own name or color.
create or replace function bc_me_update(p_code text, p_member text, p_name text, p_color text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; v_who text := _app_text(p_name, 30);
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  if v_who = '' then v_who := m.name; end if;
  update bc_members set name = v_who, color = coalesce(_bc_color(p_color), color) where id = m.id;
  update bc_waypoints set by_name = v_who where member_id = m.id;
  update bc_trails set by_name = v_who, color = coalesce(_bc_color(p_color), color) where member_id = m.id;
  perform _bc_bump(s.id);
  return jsonb_build_object('ok', true);
end $$;

-- Take someone off the map (yourself, or anyone if you're the host). Their waypoints and trails stay.
create or replace function bc_remove_member(p_code text, p_member text, p_owner_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; v_id uuid := _bc_uuid(p_id);
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if not (_doc_is_owner(s.owner_hash, s.admin_hash, p_owner_token) or coalesce(m.id = v_id, false)) then raise exception 'not_allowed'; end if;
  delete from bc_members where id = v_id and session_id = s.id;
  perform _bc_bump(s.id);
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ the regular call

-- p_pos: {"lat", "lng", "acc" (m), "heading" (degrees, optional), "speed" (m/s, optional), "t" (ms)}
--        or {"off": true} to hide your location.
-- p_points: [{"i": trail uuid, "a": lat, "o": lng, "t": ms}, ...] new trail points (up to 1000).
-- Returns null if there's no such map. "me" is null if p_member isn't (or is no longer) on it.
create or replace function bc_sync(p_code text, p_member text default null, p_owner_token text default null,
  p_pos jsonb default null, p_points jsonb default null, p_rev int default 0, p_since bigint default 0) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; v_owner boolean;
  v_lat double precision; v_lng double precision; v_t timestamptz; p jsonb; v_tid uuid; v_tm uuid; v_new boolean := false;
  v_rev int; v_out jsonb; v_pts jsonb; v_n int; v_full boolean := false;
begin
  if s.id is null then return null; end if;
  v_owner := _doc_is_owner(s.owner_hash, s.admin_hash, p_owner_token);
  m := _bc_member(s.id, p_member);

  if m.id is not null then
    if p_pos is not null and jsonb_typeof(p_pos) = 'object' then
      if coalesce(p_pos ->> 'off', '') = 'true' then
        update bc_members set lat = null, lng = null, acc = null, heading = null, speed = null, pos_at = null, last_seen = now() where id = m.id;
      else
        v_lat := _bc_num(p_pos, 'lat', -90, 90); v_lng := _bc_num(p_pos, 'lng', -180, 180); v_t := _bc_time(p_pos, 't');
        if v_lat is not null and v_lng is not null and (m.pos_at is null or v_t >= m.pos_at) then
          update bc_members set lat = v_lat, lng = v_lng, acc = _bc_num(p_pos, 'acc', 0, 100000),
            heading = _bc_num(p_pos, 'heading', 0, 360), speed = _bc_num(p_pos, 'speed', 0, 1000), pos_at = v_t, last_seen = now()
           where id = m.id;
        else
          update bc_members set last_seen = now() where id = m.id;
        end if;
      end if;
    else
      update bc_members set last_seen = now() where id = m.id;
    end if;

    if p_points is not null and jsonb_typeof(p_points) = 'array' and jsonb_array_length(p_points) > 0 then
      if jsonb_array_length(p_points) > 1000 then raise exception 'too_many_points'; end if;
      -- one writer at a time per map, so point ids show up in order for the phones reading them
      perform pg_advisory_xact_lock(hashtextextended(s.id::text, 0));
      v_full := (select count(*) from bc_points where session_id = s.id) >= 400000;
      if not v_full then
        for p in select * from jsonb_array_elements(p_points) loop
          v_lat := _bc_num(p, 'a', -90, 90); v_lng := _bc_num(p, 'o', -180, 180);
          if v_lat is null or v_lng is null then continue; end if;
          v_tid := _bc_uuid(p ->> 'i');
          select member_id into v_tm from bc_trails where id = v_tid and session_id = s.id;
          if not found then
            if exists (select 1 from bc_trails where id = v_tid) then continue; end if;          -- someone else's map
            if (select count(*) from bc_trails where session_id = s.id) >= 2000 then continue; end if;
            insert into bc_trails (id, session_id, member_id, by_name, color, started_at)
            values (v_tid, s.id, m.id, m.name, m.color, _bc_time(p, 't'));
            v_new := true; v_tm := m.id;
          end if;
          if v_tm is distinct from m.id then continue; end if;                                    -- only your own trails
          insert into bc_points (session_id, trail_id, lat, lng, at) values (s.id, v_tid, v_lat, v_lng, _bc_time(p, 't'));
        end loop;
      end if;
      if v_new then perform _bc_bump(s.id); end if;
    end if;
  end if;

  select rev into v_rev from bc_sessions where id = s.id;     -- read before the lists (a change in between is picked up next time)
  v_out := jsonb_build_object(
    'session', jsonb_build_object('code', s.code, 'name', s.name, 'created_at', s.created_at),
    'is_owner', v_owner, 'rev', v_rev, 'now', floor(extract(epoch from now()) * 1000), 'full', v_full,
    'me', case when m.id is not null then jsonb_build_object('id', m.id) end,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'color', x.color,
        'lat', x.lat, 'lng', x.lng, 'acc', x.acc, 'heading', x.heading, 'speed', x.speed,
        'pos_at', case when x.pos_at is not null then floor(extract(epoch from x.pos_at) * 1000) end,
        'seen', floor(extract(epoch from x.last_seen) * 1000)) order by x.joined_at)
      from bc_members x where x.session_id = s.id), '[]'::jsonb));
  if v_rev is distinct from p_rev then
    v_out := v_out || jsonb_build_object(
      'waypoints', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'member', w.member_id, 'by', w.by_name, 'name', w.name,
          'icon', w.icon, 'note', w.note, 'lat', w.lat, 'lng', w.lng,
          'at', floor(extract(epoch from w.created_at) * 1000), 'edited', floor(extract(epoch from w.updated_at) * 1000)) order by w.created_at)
        from bc_waypoints w where w.session_id = s.id), '[]'::jsonb),
      'trails', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'member', t.member_id, 'by', t.by_name, 'color', t.color,
          'at', floor(extract(epoch from t.started_at) * 1000)) order by t.started_at)
        from bc_trails t where t.session_id = s.id), '[]'::jsonb));
  end if;
  select coalesce(jsonb_agg(jsonb_build_array(q.id, q.trail_id, q.lat, q.lng, floor(extract(epoch from q.at) * 1000)) order by q.id), '[]'::jsonb), count(*)
    into v_pts, v_n
    from (select * from bc_points where session_id = s.id and id > coalesce(p_since, 0) order by id limit 5000) q;
  return v_out || jsonb_build_object('points', v_pts, 'more', v_n >= 5000);
end $$;

-- ------------------------------------------------------------------ waypoints and trails

-- Add a waypoint (new id) or change one (yours, or anyone's if you're the host).
-- p_wp: {"name", "icon", "note", "lat", "lng"}
create or replace function bc_waypoint_save(p_code text, p_member text, p_owner_token text, p_id text, p_wp jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; v_id uuid := _bc_uuid(p_id); w bc_waypoints%rowtype;
  v_lat double precision := _bc_num(p_wp, 'lat', -90, 90); v_lng double precision := _bc_num(p_wp, 'lng', -180, 180);
  v_name text := _app_text(p_wp ->> 'name', 60); v_icon text := left(btrim(coalesce(p_wp ->> 'icon', '')), 16);
  v_note text := left(btrim(coalesce(p_wp ->> 'note', '')), 500);
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  if v_lat is null or v_lng is null then raise exception 'invalid_place'; end if;
  if v_icon = '' then v_icon := '📍'; end if;
  select * into w from bc_waypoints where id = v_id;
  if w.id is null then
    if (select count(*) from bc_waypoints where session_id = s.id) >= 1000 then raise exception 'too_many_waypoints'; end if;
    insert into bc_waypoints (id, session_id, member_id, by_name, name, icon, note, lat, lng)
    values (v_id, s.id, m.id, m.name, v_name, v_icon, v_note, v_lat, v_lng);
  else
    if w.session_id <> s.id then raise exception 'invalid_id'; end if;
    if not (coalesce(w.member_id = m.id, false) or _doc_is_owner(s.owner_hash, s.admin_hash, p_owner_token)) then raise exception 'not_allowed'; end if;
    update bc_waypoints set name = v_name, icon = v_icon, note = v_note, lat = v_lat, lng = v_lng, updated_at = now() where id = v_id;
  end if;
  perform _bc_bump(s.id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function bc_waypoint_delete(p_code text, p_member text, p_owner_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; w bc_waypoints%rowtype;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  select * into w from bc_waypoints where id = _bc_uuid(p_id) and session_id = s.id;
  if w.id is null then return jsonb_build_object('ok', true); end if;          -- already gone
  if not (coalesce(w.member_id = m.id, false) or _doc_is_owner(s.owner_hash, s.admin_hash, p_owner_token)) then raise exception 'not_allowed'; end if;
  delete from bc_waypoints where id = w.id;
  perform _bc_bump(s.id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function bc_trail_delete(p_code text, p_member text, p_owner_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; t bc_trails%rowtype;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  select * into t from bc_trails where id = _bc_uuid(p_id) and session_id = s.id;
  if t.id is null then return jsonb_build_object('ok', true); end if;
  if not (coalesce(t.member_id = m.id, false) or _doc_is_owner(s.owner_hash, s.admin_hash, p_owner_token)) then raise exception 'not_allowed'; end if;
  delete from bc_trails where id = t.id;
  perform _bc_bump(s.id);
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ host

-- p_action: 'rename' (p_value = new name), 'clear_trails', 'clear_waypoints', 'clear_places' (everyone's
-- current location), 'delete' (the whole map).
create or replace function bc_host(p_code text, p_owner_token text, p_action text, p_value text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); v_name text := _app_text(p_value, 60);
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  if not _doc_is_owner(s.owner_hash, s.admin_hash, p_owner_token) then raise exception 'not_owner'; end if;
  if p_action = 'rename' then
    if v_name = '' then raise exception 'invalid_name'; end if;
    update bc_sessions set name = v_name where id = s.id;
  elsif p_action = 'clear_trails' then
    delete from bc_trails where session_id = s.id;
  elsif p_action = 'clear_waypoints' then
    delete from bc_waypoints where session_id = s.id;
  elsif p_action = 'clear_places' then
    update bc_members set lat = null, lng = null, acc = null, heading = null, speed = null, pos_at = null where session_id = s.id;
  elsif p_action = 'delete' then
    delete from bc_sessions where id = s.id;
    delete from plan_locks where app = 'basecamp' and code = s.code;
    return jsonb_build_object('ok', true);
  else
    raise exception 'invalid_action';
  end if;
  perform _bc_bump(s.id);
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ admin (/admin/)

create or replace function bc_admin_list(p_password text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password);
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  return jsonb_build_object('maps', coalesce((
    select jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name, 'created_at', s.created_at,
      'updated_at', greatest(s.updated_at, (select max(last_seen) from bc_members m where m.session_id = s.id)),
      'people', (select count(*) from bc_members m where m.session_id = s.id),
      'waypoints', (select count(*) from bc_waypoints w where w.session_id = s.id),
      'trails', (select count(*) from bc_trails t where t.session_id = s.id)) order by s.created_at desc)
    from bc_sessions s), '[]'::jsonb));
end $$;

create or replace function bc_admin_grant(p_password text, p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password); v_token text := _app_token();
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  update bc_sessions set admin_hash = _app_hash(v_token) where code = lower(btrim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('error', 'map_not_found'); end if;
  return jsonb_build_object('owner_token', v_token);
end $$;

create or replace function bc_admin_delete(p_password text, p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password); v_n int;
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  delete from bc_sessions where code = lower(btrim(coalesce(p_code, '')));
  get diagnostics v_n = row_count;
  delete from plan_locks where app = 'basecamp' and code = lower(btrim(coalesce(p_code, '')));
  return jsonb_build_object('deleted', v_n);
end $$;

-- ------------------------------------------------------------------ passwords

alter table plan_locks drop constraint if exists plan_locks_app_check;
alter table plan_locks add constraint plan_locks_app_check check (app in ('rsvp', 'poll', 'wdw', 'doc', 'santa', 'basecamp'));

-- Is p_token the host's key? (latest version, with Basecamp added)
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
  elsif p_app = 'basecamp' then
    return exists (select 1 from bc_sessions where code = _lock_code(p_code) and _doc_is_owner(owner_hash, admin_hash, p_token));
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

create or replace function _lock_wrap_all() returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare w text[];
begin
  foreach w slice 1 in array array[
    ['rsvp', 'rsvp_get'], ['rsvp', 'rsvp_respond'], ['rsvp', 'rsvp_post'], ['rsvp', 'rsvp_delete_post'],
    ['rsvp', 'rsvp_item_add'], ['rsvp', 'rsvp_item_edit'], ['rsvp', 'rsvp_item_remove'], ['rsvp', 'rsvp_item_claim'],
    ['poll', 'poll_get'], ['poll', 'poll_vote'], ['poll', 'poll_add_option'], ['poll', 'poll_edit_option'],
    ['poll', 'poll_remove_option'],
    ['wdw', 'wdw_get'], ['wdw', 'get_event'], ['wdw', 'save_response'], ['wdw', 'delete_response'],
    ['doc', 'doc_get'], ['doc', 'doc_push'],
    ['santa', 'santa_get'], ['santa', 'santa_claim'], ['santa', 'santa_unclaim'], ['santa', 'santa_join'], ['santa', 'santa_set_wish'],
    ['basecamp', 'bc_sync'], ['basecamp', 'bc_join'], ['basecamp', 'bc_me_update'], ['basecamp', 'bc_remove_member'],
    ['basecamp', 'bc_waypoint_save'], ['basecamp', 'bc_waypoint_delete'], ['basecamp', 'bc_trail_delete']
  ] loop
    perform _lock_wrap(w[1], w[2]);
  end loop;
end $$;

-- ------------------------------------------------------------------ grants

revoke all on function _bc_session(text), _bc_member(uuid, text), _bc_num(jsonb, text, double precision, double precision),
  _bc_time(jsonb, text), _bc_uuid(text), _bc_color(text), _bc_free_color(uuid), _bc_bump(uuid),
  bc_create(text, text, text), bc_host(text, text, text, text),
  bc_admin_list(text), bc_admin_grant(text, text), bc_admin_delete(text, text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _bc_session(text), _bc_member(uuid, text), _bc_num(jsonb, text, double precision, double precision), '
                  || '_bc_time(jsonb, text), _bc_uuid(text), _bc_color(text), _bc_free_color(uuid), _bc_bump(uuid) from %I', r);
      execute format('grant execute on function bc_create(text, text, text), bc_host(text, text, text, text), '
                  || 'bc_admin_list(text), bc_admin_grant(text, text), bc_admin_delete(text, text) to %I', r);
    end if;
  end loop;
end $$;

-- the guest functions are only callable through their password wrappers (gated_bc_*)
select _lock_wrap_all();
