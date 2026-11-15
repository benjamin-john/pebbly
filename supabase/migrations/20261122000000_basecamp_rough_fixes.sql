-- Basecamp: ignore rough locations (phones sometimes report a cell-tower guess, e.g. ±800 m, far from the person) while
-- a good one (±100 m or better) from the last 30 minutes is on the map: the dot stays at the good, older spot. Applies to
-- Basecamp's own updates and to OwnTracks reports. Safe to re-run.

create or replace function _bc_rough(p_acc double precision, p_old_acc double precision, p_old_at timestamptz) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select coalesce(p_acc > 100 and p_old_acc <= 100 and p_old_at > now() - interval '30 minutes', false);
$$;

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
        if v_lat is not null and v_lng is not null and (m.pos_at is null or v_t >= m.pos_at)
           and not _bc_rough(_bc_num(p_pos, 'acc', 0, 100000), m.acc, m.pos_at) then
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
      'waypoints', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'member', w.member_id, 'by', w.by_name, 'ai', w.ai, 'name', w.name,
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
  if _bc_rough(_bc_num(p_body, 'acc', 0, 100000), m.acc, m.pos_at) then
    v_status := 'rough';                                                      -- keep the better, older spot
  elsif m.pos_at is null or v_t >= m.pos_at then
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
