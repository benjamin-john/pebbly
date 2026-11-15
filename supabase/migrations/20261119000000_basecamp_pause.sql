-- Basecamp: the host can pause tracking on a map (and resume it). Safe to re-run.
-- While paused nobody's location is shared or stored (Basecamp or OwnTracks), no trail points are recorded, and asking
-- for someone's location is refused; waypoints, trails and the map itself stay. Pausing also takes everyone's screen-off
-- sharing off this map, so OwnTracks goes Quiet unless that phone shares with another map.

alter table bc_sessions add column if not exists paused_at timestamptz;

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
  elsif p_action = 'pause' then
    -- nobody's location is shared until the host resumes; waypoints and trails stay. Screen-off sharing leaves this map
    -- (OwnTracks goes Quiet at its next report unless the phone shares with another map).
    update bc_sessions set paused_at = coalesce(paused_at, now()) where id = s.id;
    update bc_members set lat = null, lng = null, acc = null, heading = null, speed = null, pos_at = null,
      ot_device = null, ot_prev = null, ot_follow = null, ot_trail = false, ot_trail_id = null where session_id = s.id;
  elsif p_action = 'resume' then
    update bc_sessions set paused_at = null where id = s.id;
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

  if m.id is not null and s.paused_at is not null then
    update bc_members set last_seen = now() where id = m.id;                    -- paused: no locations, no trail points
  elsif m.id is not null then
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
    'session', jsonb_build_object('code', s.code, 'name', s.name, 'created_at', s.created_at,
      'paused', case when s.paused_at is not null then floor(extract(epoch from s.paused_at) * 1000) end),
    'is_owner', v_owner, 'rev', v_rev, 'now', floor(extract(epoch from now()) * 1000), 'full', v_full,
    'me', case when m.id is not null then jsonb_build_object('id', m.id, 'ot', m.ot_device is not null, 'ot_trail', m.ot_trail,
      'ot_until', case when m.ot_until is not null then floor(extract(epoch from m.ot_until) * 1000) end, 'ot_v', m.ot_v,
      'ot_follow', case when m.ot_device is not null then m.ot_follow end,
      'ot_at', case when m.ot_device is not null and m.ot_at is not null then floor(extract(epoch from m.ot_at) * 1000) end,
      'ot_pending', m.ot_device is not null and exists (select 1 from bc_ot_devices dv where dv.id = m.ot_device and dv.last_at is null)) end,
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

create or replace function bc_ot_link(p_code text, p_member text, p_trail boolean default false, p_minutes int default 4320, p_device text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; d bc_ot_devices%rowtype; v_token text;
  v_until timestamptz := case when p_minutes <= 0 then null else now() + make_interval(mins => greatest(30, least(coalesce(p_minutes, 4320), 10080))) end;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  if s.paused_at is not null then raise exception 'map_paused'; end if;
  if coalesce(p_device, '') <> '' and char_length(p_device) <= 200 then
    select * into d from bc_ot_devices where key_hash = _app_hash(p_device);
  end if;
  if d.id is null then
    v_token := _app_token();
    insert into bc_ot_devices (key_hash) values (_app_hash(v_token)) returning * into d;
  else
    v_token := p_device;
  end if;
  -- a new setup only counts once OwnTracks reports with it; until then the one OwnTracks is using keeps working
  update bc_members set ot_prev = case
      when d.last_at is not null then null
      when ot_device is not null and ot_device <> d.id and exists (select 1 from bc_ot_devices o where o.id = bc_members.ot_device and o.last_at is not null) then ot_device
      else ot_prev end
   where id = m.id;
  update bc_members set ot_device = d.id, ot_hash = null, ot_trail = coalesce(p_trail, false), ot_trail_id = null,
    ot_until = v_until, ot_v = 2 where id = m.id;
  return jsonb_build_object('token', v_token, 'joined', v_token = p_device,
    'tid', upper(left(regexp_replace(m.name, '[^A-Za-z0-9]', '', 'g') || 'XX', 2)),
    'until', case when v_until is not null then floor(extract(epoch from v_until) * 1000) end);
end $$;

create or replace function bc_ask(p_code text, p_member text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; v_to bc_members%rowtype; v_alerts boolean;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  if s.paused_at is not null then raise exception 'map_paused'; end if;
  select * into v_to from bc_members where id = _bc_uuid(p_id) and session_id = s.id;
  if v_to.id is null then raise exception 'not_member'; end if;
  if v_to.id = m.id then raise exception 'invalid_id'; end if;
  v_alerts := exists (select 1 from push_targets where app = 'basecamp' and event_id = s.id and role = 'guest' and pid = v_to.id::text);
  if exists (select 1 from notifications where app = 'basecamp' and event_id = s.id and type = 'basecamp.ask'
               and actor = m.id::text and recipient = v_to.id and created_at > now() - interval '2 minutes') then
    return jsonb_build_object('ok', true, 'alerts', v_alerts, 'recent', true);
  end if;
  insert into notifications (app, event_id, type, audience, actor, ref, recipient, name, detail)
  values ('basecamp', s.id, 'basecamp.ask', 'guest', m.id::text, v_to.id, v_to.id, m.name, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'alerts', v_alerts, 'recent', false);
end $$;

create or replace function _bc_ot_apply(p_member uuid, p_body jsonb) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare m bc_members%rowtype; v_lat double precision; v_lng double precision; v_t timestamptz; v_vel double precision;
  v_llat double precision; v_llng double precision; v_lat_at timestamptz; v_tid uuid; v_new boolean := false; v_status text;
begin
  select * into m from bc_members where id = p_member;
  if m.id is null then return 'ignored'; end if;
  if exists (select 1 from bc_sessions where id = m.session_id and paused_at is not null) then return 'ignored'; end if;
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
  -- carrying on a trail started in Basecamp (Trail button, then the screen went off): add to that same trail
  if m.ot_follow is not null and coalesce(_bc_num(p_body, 'acc', 0, 100000), 0) <= 50 then
    perform pg_advisory_xact_lock(hashtextextended(m.session_id::text, 0));
    select p.lat, p.lng, p.at into v_llat, v_llng, v_lat_at from bc_points p where p.trail_id = m.ot_follow order by p.at desc, p.id desc limit 1;
    if v_lat_at is not null and v_t > v_lat_at + interval '30 minutes' then
      update bc_members set ot_follow = null where id = m.id;               -- a long break: that trail is over
      m.ot_follow := null;
    else
      if not exists (select 1 from bc_trails where id = m.ot_follow) then
        if exists (select 1 from bc_trails where id = m.ot_follow) then return v_status; end if;
        insert into bc_trails (id, session_id, member_id, by_name, color, started_at) values (m.ot_follow, m.session_id, m.id, m.name, m.color, v_t)
        on conflict (id) do nothing;
        perform _bc_bump(m.session_id);
      end if;
      if (select member_id from bc_trails where id = m.ot_follow) is distinct from m.id then return v_status; end if;
      if v_lat_at is null or v_t > v_lat_at and
         6371000 * 2 * asin(least(1, sqrt(power(sin(radians(v_lat - v_llat) / 2), 2) +
           cos(radians(v_lat)) * cos(radians(v_llat)) * power(sin(radians(v_lng - v_llng) / 2), 2)))) >= 10 then
        if (select count(*) from bc_points where session_id = m.session_id) < 400000 then
          insert into bc_points (session_id, trail_id, lat, lng, at) values (m.session_id, m.ot_follow, v_lat, v_lng, v_t);
        end if;
      end if;
      return v_status;
    end if;
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

select _lock_wrap_all();
