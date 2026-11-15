-- Basecamp + OwnTracks: setting OwnTracks up again no longer cuts off the setup it's still using. Safe to re-run.
--
-- Before, "Open OwnTracks setup again" made a new key and dropped the old one straight away. If OwnTracks didn't take
-- the new settings (the link didn't open, or Import wasn't tapped), every report with the old key was refused and the
-- person silently stopped sharing. Now the old setup keeps feeding the map (bc_members.ot_prev) until OwnTracks reports
-- with the new one. bc_sync tells the phone when OwnTracks last reported (me.ot_at) and whether the new setup is still
-- waiting for its first report (me.ot_pending), so the page only carries a trail on through OwnTracks when it's working.

alter table bc_members add column if not exists ot_prev uuid references bc_ot_devices(id) on delete set null;

create or replace function bc_owntracks(p_token text, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d bc_ot_devices%rowtype; v_pace text; v_mode int; v_reply jsonb := '[]'::jsonb; v_status text := 'ignored'; v_one text; r record;
begin
  if coalesce(p_token, '') = '' or char_length(p_token) > 200 then return jsonb_build_object('status', 'unknown', 'reply', _bc_ot_cmd('quiet')); end if;
  select * into d from bc_ot_devices where key_hash = _app_hash(p_token) for update;
  if d.id is null then return jsonb_build_object('status', 'unknown', 'reply', _bc_ot_cmd('quiet')); end if;
  -- maps whose end time has passed leave this setup
  update bc_members set ot_device = null, ot_prev = null, ot_trail = false, ot_trail_id = null
   where (ot_device = d.id or ot_prev = d.id) and ot_until is not null and ot_until < now();
  -- this setup is in use, so an older one it replaced on this phone isn't needed any more
  update bc_members set ot_prev = null where ot_device = d.id and ot_prev is not null;
  if not exists (select 1 from bc_members where ot_device = d.id or ot_prev = d.id) then
    delete from bc_ot_devices where id = d.id;                      -- nothing left to share with: go quiet
    return jsonb_build_object('status', 'ended', 'reply', _bc_ot_cmd('quiet'));
  end if;
  update bc_members set ot_at = now() where ot_device = d.id or ot_prev = d.id;
  -- report normally while anyone has opened any of its maps in the last 12 hours, otherwise less often
  v_pace := case when exists (select 1 from bc_members x join bc_sessions s on s.id = x.session_id
                              where (x.ot_device = d.id or x.ot_prev = d.id) and s.viewed_at > now() - interval '12 hours') then 'normal' else 'slow' end;
  v_mode := case when coalesce(p_body ->> 'm', '') = '2' then 2 when coalesce(p_body ->> 'm', '') = '1' then 1 end;
  if d.pace = 'normal' and v_mode is not null and v_mode <> d.mode then d.mode := v_mode; end if;
  if v_pace <> d.pace then v_reply := _bc_ot_cmd(v_pace, d.mode); end if;
  update bc_ot_devices set pace = v_pace, mode = d.mode, last_at = now() where id = d.id;
  for r in select id from bc_members where ot_device = d.id or ot_prev = d.id loop
    v_one := _bc_ot_apply(r.id, p_body);
    if v_one = 'ok' or v_status = 'ignored' or (v_status <> 'ok' and v_one = 'app') then v_status := v_one; end if;
  end loop;
  return jsonb_build_object('status', v_status, 'reply', v_reply);
end $$;

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

create or replace function bc_ot_stop(p_code text, p_member text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  update bc_members set ot_device = null, ot_hash = null, ot_at = null, ot_trail = false, ot_trail_id = null, ot_follow = null, ot_prev = null where id = m.id;
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

select _lock_wrap_all();
