-- Basecamp + OwnTracks: one OwnTracks setup per phone feeds every map that phone has turned it on for. Safe to re-run.
--
--  * bc_ot_devices: one row per phone's OwnTracks setup (the personal key in its address, hashed), with what OwnTracks was
--    last told ('normal' / 'slow') and its Move/Significant mode. bc_members.ot_device links each map's person to it.
--  * The phone remembers its key; turning screen-off sharing on in another map attaches that map (bc_ot_link with
--    p_device), so OwnTracks doesn't need setting up again.
--  * Each report goes to every attached map. A map leaves the setup when its end time passes, or after Stop / leaving /
--    being taken off / the map being deleted. OwnTracks is told to go Quiet only when no map is left, and to report
--    normally while anyone has opened ANY of its maps in the last 12 hours (otherwise "report less").
--  * Keys made before this (bc_members.ot_hash) become one-map setups, so they keep working.

create table if not exists bc_ot_devices (
  id         uuid primary key default gen_random_uuid(),
  key_hash   text not null unique,
  pace       text not null default 'normal',
  mode       int not null default 1,
  created_at timestamptz not null default now(),
  last_at    timestamptz
);
alter table bc_ot_devices enable row level security;
revoke all on bc_ot_devices from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on bc_ot_devices from %I', r); end if;
  end loop;
end $$;
alter table bc_members add column if not exists ot_device uuid references bc_ot_devices(id) on delete set null;
create index if not exists bc_members_ot_device on bc_members (ot_device) where ot_device is not null;

-- older one-map keys become setups of their own
insert into bc_ot_devices (key_hash, pace, mode)
  select ot_hash, coalesce(ot_pace, 'normal'), coalesce(ot_mode, 1) from bc_members where ot_hash is not null
  on conflict (key_hash) do nothing;
update bc_members m set ot_device = d.id, ot_hash = null from bc_ot_devices d where m.ot_hash is not null and d.key_hash = m.ot_hash;

-- Position (and trail, if on) from one OwnTracks report for one map's person. Returns 'ignored'|'hidden'|'app'|'old'|'ok'.
create or replace function _bc_ot_apply(p_member uuid, p_body jsonb) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare m bc_members%rowtype; v_lat double precision; v_lng double precision; v_t timestamptz; v_vel double precision;
  v_llat double precision; v_llng double precision; v_lat_at timestamptz; v_tid uuid; v_new boolean := false; v_status text;
begin
  select * into m from bc_members where id = p_member;
  if m.id is null then return 'ignored'; end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' or coalesce(p_body ->> '_type', '') <> 'location' then return 'ignored'; end if;
  v_lat := _bc_num(p_body, 'lat', -90, 90); v_lng := _bc_num(p_body, 'lon', -180, 180);
  if v_lat is null or v_lng is null then return 'ignored'; end if;
  if m.hidden then return 'hidden'; end if;
  if m.web_at is not null and m.web_at > now() - interval '30 seconds' then return 'app'; end if;    -- Basecamp is open: its GPS wins
  v_t := _bc_time(jsonb_build_object('t', _bc_num(p_body, 'tst', 0, 1e11) * 1000), 't');
  v_vel := _bc_num(p_body, 'vel', 0, 2000);                                    -- km/h
  if m.pos_at is null or v_t >= m.pos_at then
    update bc_members set lat = v_lat, lng = v_lng, acc = _bc_num(p_body, 'acc', 0, 100000),
      heading = case when coalesce(v_vel, 0) >= 4 then _bc_num(p_body, 'cog', 0, 360) end,
      speed = case when v_vel is not null then v_vel / 3.6 end, pos_at = v_t
     where id = m.id;
    v_status := 'ok';
  else
    v_status := 'old';
  end if;
  if m.ot_trail and coalesce(_bc_num(p_body, 'acc', 0, 100000), 0) <= 50 then
    perform pg_advisory_xact_lock(hashtextextended(m.session_id::text, 0));
    if m.ot_trail_id is not null then
      select p.lat, p.lng, p.at into v_llat, v_llng, v_lat_at from bc_points p where p.trail_id = m.ot_trail_id order by p.id desc limit 1;
    end if;
    if m.ot_trail_id is null or v_lat_at is null or v_t > v_lat_at + interval '30 minutes'
       or not exists (select 1 from bc_trails where id = m.ot_trail_id) then
      v_tid := gen_random_uuid(); v_new := true;
      insert into bc_trails (id, session_id, member_id, by_name, color, started_at) values (v_tid, m.session_id, m.id, m.name, m.color, v_t);
      update bc_members set ot_trail_id = v_tid where id = m.id;
    else
      v_tid := m.ot_trail_id;
    end if;
    if v_new or v_t > v_lat_at and
       6371000 * 2 * asin(least(1, sqrt(power(sin(radians(v_lat - v_llat) / 2), 2) +
         cos(radians(v_lat)) * cos(radians(v_llat)) * power(sin(radians(v_lng - v_llng) / 2), 2)))) >= 10 then
      if (select count(*) from bc_points where session_id = m.session_id) < 400000 then
        insert into bc_points (session_id, trail_id, lat, lng, at) values (m.session_id, v_tid, v_lat, v_lng, v_t);
      end if;
    end if;
    if v_new then perform _bc_bump(m.session_id); end if;
  end if;
  return v_status;
end $$;

-- One report from a phone's OwnTracks. Returns {"status", "reply"} (reply: OwnTracks commands for the receiver to send back).
create or replace function bc_owntracks(p_token text, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d bc_ot_devices%rowtype; v_pace text; v_mode int; v_reply jsonb := '[]'::jsonb; v_status text := 'ignored'; v_one text; r record;
begin
  if coalesce(p_token, '') = '' or char_length(p_token) > 200 then return jsonb_build_object('status', 'unknown', 'reply', _bc_ot_cmd('quiet')); end if;
  select * into d from bc_ot_devices where key_hash = _app_hash(p_token) for update;
  if d.id is null then return jsonb_build_object('status', 'unknown', 'reply', _bc_ot_cmd('quiet')); end if;
  -- maps whose end time has passed leave this setup
  update bc_members set ot_device = null, ot_trail = false, ot_trail_id = null
   where ot_device = d.id and ot_until is not null and ot_until < now();
  if not exists (select 1 from bc_members where ot_device = d.id) then
    delete from bc_ot_devices where id = d.id;                      -- nothing left to share with: go quiet
    return jsonb_build_object('status', 'ended', 'reply', _bc_ot_cmd('quiet'));
  end if;
  update bc_members set ot_at = now() where ot_device = d.id;
  -- report normally while anyone has opened any of its maps in the last 12 hours, otherwise less often
  v_pace := case when exists (select 1 from bc_members x join bc_sessions s on s.id = x.session_id
                              where x.ot_device = d.id and s.viewed_at > now() - interval '12 hours') then 'normal' else 'slow' end;
  v_mode := case when coalesce(p_body ->> 'm', '') = '2' then 2 when coalesce(p_body ->> 'm', '') = '1' then 1 end;
  if d.pace = 'normal' and v_mode is not null and v_mode <> d.mode then d.mode := v_mode; end if;
  if v_pace <> d.pace then v_reply := _bc_ot_cmd(v_pace, d.mode); end if;
  update bc_ot_devices set pace = v_pace, mode = d.mode, last_at = now() where id = d.id;
  for r in select id from bc_members where ot_device = d.id loop
    v_one := _bc_ot_apply(r.id, p_body);
    if v_one = 'ok' or v_status = 'ignored' or (v_status <> 'ok' and v_one = 'app') then v_status := v_one; end if;
  end loop;
  return jsonb_build_object('status', v_status, 'reply', v_reply);
end $$;

-- Turn screen-off sharing on for this map. p_device: the key of this phone's existing OwnTracks setup (if it has one), so
-- this map joins it; otherwise a new setup (and key) is made. p_minutes: how long (0 = until stopped; default 3 days).
drop function if exists bc_ot_link(text, text, boolean, int);
create or replace function bc_ot_link(p_code text, p_member text, p_trail boolean default false, p_minutes int default 4320, p_device text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; d bc_ot_devices%rowtype; v_token text;
  v_until timestamptz := case when p_minutes <= 0 then null else now() + make_interval(mins => greatest(30, least(coalesce(p_minutes, 4320), 10080))) end;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  if coalesce(p_device, '') <> '' and char_length(p_device) <= 200 then
    select * into d from bc_ot_devices where key_hash = _app_hash(p_device);
  end if;
  if d.id is null then
    v_token := _app_token();
    insert into bc_ot_devices (key_hash) values (_app_hash(v_token)) returning * into d;
  else
    v_token := p_device;
  end if;
  update bc_members set ot_device = d.id, ot_hash = null, ot_trail = coalesce(p_trail, false), ot_trail_id = null,
    ot_until = v_until, ot_v = 2 where id = m.id;
  return jsonb_build_object('token', v_token, 'joined', v_token = p_device,
    'tid', upper(left(regexp_replace(m.name, '[^A-Za-z0-9]', '', 'g') || 'XX', 2)),
    'until', case when v_until is not null then floor(extract(epoch from v_until) * 1000) end);
end $$;

create or replace function bc_ot_extend(p_code text, p_member text, p_minutes int) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype;
  v_until timestamptz := case when p_minutes <= 0 then null else now() + make_interval(mins => greatest(30, least(coalesce(p_minutes, 4320), 10080))) end;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  if m.ot_device is null then raise exception 'not_sharing'; end if;
  update bc_members set ot_until = v_until where id = m.id;
  return jsonb_build_object('until', case when v_until is not null then floor(extract(epoch from v_until) * 1000) end);
end $$;

-- Stop screen-off sharing for this map only (the phone keeps sharing with its other maps).
create or replace function bc_ot_stop(p_code text, p_member text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  update bc_members set ot_device = null, ot_hash = null, ot_at = null, ot_trail = false, ot_trail_id = null where id = m.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function bc_ot_set(p_code text, p_member text, p_trail boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  update bc_members set ot_trail = coalesce(p_trail, false), ot_trail_id = case when coalesce(p_trail, false) then ot_trail_id end where id = m.id;
  return jsonb_build_object('ok', true);
end $$;

-- bc_sync: "ot" now means "linked to a phone's OwnTracks setup"; "ot_slow" comes from that setup.
create or replace function bc_sync(p_code text, p_member text default null, p_owner_token text default null,
  p_pos jsonb default null, p_points jsonb default null, p_rev int default 0, p_since bigint default 0) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; v_owner boolean;
  v_lat double precision; v_lng double precision; v_t timestamptz; p jsonb; v_tid uuid; v_tm uuid; v_new boolean := false;
  v_rev int; v_out jsonb; v_pts jsonb; v_n int; v_full boolean := false;
begin
  if s.id is null then return null; end if;
  v_owner := _doc_is_owner(s.owner_hash, s.admin_hash, p_owner_token);
  update bc_sessions set viewed_at = now() where id = s.id and (viewed_at is null or viewed_at < now() - interval '1 minute');
  m := _bc_member(s.id, p_member);

  if m.id is not null then
    if p_pos is not null and jsonb_typeof(p_pos) = 'object' then
      if coalesce(p_pos ->> 'off', '') = 'true' then
        update bc_members set lat = null, lng = null, acc = null, heading = null, speed = null, pos_at = null, hidden = true, last_seen = now() where id = m.id;
      else
        v_lat := _bc_num(p_pos, 'lat', -90, 90); v_lng := _bc_num(p_pos, 'lng', -180, 180); v_t := _bc_time(p_pos, 't');
        if v_lat is not null and v_lng is not null then update bc_members set web_at = now() where id = m.id; end if;
        if v_lat is not null and v_lng is not null and (m.pos_at is null or v_t >= m.pos_at) then
          update bc_members set lat = v_lat, lng = v_lng, acc = _bc_num(p_pos, 'acc', 0, 100000),
            heading = _bc_num(p_pos, 'heading', 0, 360), speed = _bc_num(p_pos, 'speed', 0, 1000), pos_at = v_t, hidden = false, last_seen = now()
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
    'me', case when m.id is not null then jsonb_build_object('id', m.id, 'ot', m.ot_device is not null, 'ot_trail', m.ot_trail,
      'ot_until', case when m.ot_until is not null then floor(extract(epoch from m.ot_until) * 1000) end, 'ot_v', m.ot_v) end,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'color', x.color,
        'lat', x.lat, 'lng', x.lng, 'acc', x.acc, 'heading', x.heading, 'speed', x.speed,
        'pos_at', case when x.pos_at is not null then floor(extract(epoch from x.pos_at) * 1000) end,
        'seen', floor(extract(epoch from x.last_seen) * 1000), 'ot', x.ot_device is not null,
        'ot_at', case when x.ot_at is not null then floor(extract(epoch from x.ot_at) * 1000) end,
        'ot_slow', exists (select 1 from bc_ot_devices dv where dv.id = x.ot_device and dv.pace = 'slow')) order by x.joined_at)
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
    ['basecamp', 'bc_waypoint_save'], ['basecamp', 'bc_waypoint_delete'], ['basecamp', 'bc_trail_delete'],
    ['basecamp', 'bc_ot_link'], ['basecamp', 'bc_ot_set'], ['basecamp', 'bc_ot_stop'], ['basecamp', 'bc_ot_extend']
  ] loop
    perform _lock_wrap(w[1], w[2]);
  end loop;
end $$;

revoke all on function bc_owntracks(text, jsonb), _bc_ot_apply(uuid, jsonb) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function bc_owntracks(text, jsonb), _bc_ot_apply(uuid, jsonb) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function bc_owntracks(text, jsonb) to service_role';
  end if;
end $$;

-- guest functions behind the password wrappers (gated_bc_*), rebuilt to match
select _lock_wrap_all();
