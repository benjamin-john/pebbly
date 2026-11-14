-- Basecamp + OwnTracks: the "nobody's watching" slow-down now waits 12 hours without anyone opening the map (was 30
-- minutes), so phones keep reporting normally through a whole hunting day. Same function otherwise. Safe to re-run.

create or replace function bc_owntracks(p_token text, p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare m bc_members%rowtype; v_lat double precision; v_lng double precision; v_t timestamptz; v_vel double precision;
  v_llat double precision; v_llng double precision; v_lat_at timestamptz; v_tid uuid; v_new boolean := false;
  v_status text; v_pace text; v_reply jsonb := '[]'::jsonb; v_mode int;
begin
  if coalesce(p_token, '') = '' or char_length(p_token) > 200 then return jsonb_build_object('status', 'unknown', 'reply', _bc_ot_cmd('quiet')); end if;
  select * into m from bc_members where ot_hash = _app_hash(p_token);
  -- unknown key (stopped, taken off the map, map deleted): tell OwnTracks to go quiet
  if m.id is null then return jsonb_build_object('status', 'unknown', 'reply', _bc_ot_cmd('quiet')); end if;
  if m.ot_until is not null and m.ot_until < now() then
    update bc_members set ot_hash = null, ot_trail = false, ot_trail_id = null, ot_pace = null where id = m.id;
    return jsonb_build_object('status', 'ended', 'reply', _bc_ot_cmd('quiet'));
  end if;
  update bc_members set ot_at = now() where id = m.id;
  -- how often it should report: normally while someone has looked at the map in the last 12 hours, slowly otherwise
  v_pace := case when exists (select 1 from bc_sessions where id = m.session_id and viewed_at > now() - interval '12 hours') then 'normal' else 'slow' end;
  v_mode := case when coalesce(p_body ->> 'm', '') = '2' then 2 when coalesce(p_body ->> 'm', '') = '1' then 1 end;
  if coalesce(m.ot_pace, 'normal') = 'normal' and v_mode is not null and v_mode is distinct from m.ot_mode then
    update bc_members set ot_mode = v_mode where id = m.id; m.ot_mode := v_mode;
  end if;
  if v_pace is distinct from coalesce(m.ot_pace, 'normal') then
    update bc_members set ot_pace = v_pace where id = m.id;
    v_reply := _bc_ot_cmd(v_pace, m.ot_mode);
  end if;

  if p_body is null or jsonb_typeof(p_body) <> 'object' or coalesce(p_body ->> '_type', '') <> 'location' then return jsonb_build_object('status', 'ignored', 'reply', v_reply); end if;
  v_lat := _bc_num(p_body, 'lat', -90, 90); v_lng := _bc_num(p_body, 'lon', -180, 180);
  if v_lat is null or v_lng is null then return jsonb_build_object('status', 'ignored', 'reply', v_reply); end if;
  if m.hidden then return jsonb_build_object('status', 'hidden', 'reply', v_reply); end if;
  if m.web_at is not null and m.web_at > now() - interval '30 seconds' then return jsonb_build_object('status', 'app', 'reply', v_reply); end if;
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
  return jsonb_build_object('status', v_status, 'reply', v_reply);
end $$;
