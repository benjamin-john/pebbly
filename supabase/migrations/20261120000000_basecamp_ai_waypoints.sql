-- Basecamp: waypoints made by "Analyze this area" are marked as from AI (bc_waypoints.ai), so the page can show them as
-- AI's and "Only mine" hides them. The person who added them still owns them (edit/delete). Safe to re-run.

alter table bc_waypoints add column if not exists ai boolean not null default false;

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
    insert into bc_waypoints (id, session_id, member_id, by_name, name, icon, note, lat, lng, ai)
    values (v_id, s.id, m.id, m.name, v_name, v_icon, v_note, v_lat, v_lng, coalesce(p_wp ->> 'ai', '') = 'true');
  else
    if w.session_id <> s.id then raise exception 'invalid_id'; end if;
    if not (coalesce(w.member_id = m.id, false) or _doc_is_owner(s.owner_hash, s.admin_hash, p_owner_token)) then raise exception 'not_allowed'; end if;
    update bc_waypoints set name = v_name, icon = v_icon, note = v_note, lat = v_lat, lng = v_lng, updated_at = now() where id = v_id;
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

select _lock_wrap_all();
