-- Basecamp + OwnTracks: so a forgotten phone doesn't keep reporting forever. Safe to re-run.
--
--  * Screen-off sharing has an end time (bc_members.ot_until; picked at setup, extendable with bc_ot_extend). After
--    it, or after Stop / being taken off the map / the map being deleted, the next report gets a reply telling OwnTracks
--    to switch to Quiet mode, so it stops sending. (OwnTracks only hears replies to its own reports; the setup link
--    turns remote commands on: "cmd" and "remoteConfiguration". Links made before that (ot_v null) can't be switched
--    off from here; Basecamp asks those people to set up again.)
--  * While nobody has had the map open for 30 minutes (bc_sessions.viewed_at, kept by bc_sync), reports get a reply
--    slowing OwnTracks down (about every half mile / half hour). When someone opens the map again, each phone's next
--    report gets the normal settings back (Move mode if that's what it was in, from the report's "m").
--  * bc_owntracks now returns {"status", "reply"}: the receiver sends "reply" (a list of OwnTracks commands) back.

alter table bc_members add column if not exists ot_until timestamptz;
alter table bc_members add column if not exists ot_pace text;          -- what we last told the phone: 'normal' / 'slow'
alter table bc_members add column if not exists ot_mode int;           -- 1 significant, 2 move: its mode when last normal
alter table bc_members add column if not exists ot_v int;              -- 2: set up with remote commands allowed
alter table bc_sessions add column if not exists viewed_at timestamptz;
update bc_members set ot_until = now() + interval '3 days' where ot_hash is not null and ot_until is null;

create or replace function _bc_ot_cmd(p_pace text, p_mode int default 1) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_array(jsonb_build_object('_type', 'cmd', 'action', 'setConfiguration', 'configuration',
    case p_pace
      when 'quiet' then jsonb_build_object('_type', 'configuration', 'monitoring', -1)
      when 'slow'  then jsonb_build_object('_type', 'configuration', 'monitoring', 1, 'locatorDisplacement', 800, 'locatorInterval', 1800)
      else jsonb_build_object('_type', 'configuration', 'monitoring', case when p_mode = 2 then 2 else 1 end,
             'locatorDisplacement', 20, 'locatorInterval', 60, 'moveModeLocatorInterval', 10)
    end));
$$;

-- a new personal key (replaces an older one). p_minutes: how long to share (default 3 days, up to 1 week).
drop function if exists bc_ot_link(text, text, boolean);
create or replace function bc_ot_link(p_code text, p_member text, p_trail boolean default false, p_minutes int default 4320) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; v_token text := _app_token();
  v_until timestamptz := now() + make_interval(mins => greatest(30, least(coalesce(p_minutes, 4320), 10080)));
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  update bc_members set ot_hash = _app_hash(v_token), ot_trail = coalesce(p_trail, false), ot_trail_id = null,
    ot_until = v_until, ot_pace = 'normal', ot_mode = 1, ot_v = 2 where id = m.id;
  return jsonb_build_object('token', v_token, 'tid', upper(left(regexp_replace(m.name, '[^A-Za-z0-9]', '', 'g') || 'XX', 2)),
    'until', floor(extract(epoch from v_until) * 1000));
end $$;

create or replace function bc_ot_extend(p_code text, p_member text, p_minutes int) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype;
  v_until timestamptz := now() + make_interval(mins => greatest(30, least(coalesce(p_minutes, 4320), 10080)));
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  if m.ot_hash is null then raise exception 'not_sharing'; end if;
  update bc_members set ot_until = v_until where id = m.id;
  return jsonb_build_object('until', floor(extract(epoch from v_until) * 1000));
end $$;

-- One report from OwnTracks. Returns {"status": 'unknown'|'ended'|'ignored'|'hidden'|'app'|'old'|'ok', "reply": [...]}.
drop function if exists bc_owntracks(text, jsonb);
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
  -- how often it should report: normally while someone has looked at the map in the last 30 minutes, slowly otherwise
  v_pace := case when exists (select 1 from bc_sessions where id = m.session_id and viewed_at > now() - interval '30 minutes') then 'normal' else 'slow' end;
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

-- bc_sync: the same, plus "someone is looking" (viewed_at) and the OwnTracks end time / version / slow flag.
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
    'me', case when m.id is not null then jsonb_build_object('id', m.id, 'ot', m.ot_hash is not null, 'ot_trail', m.ot_trail,
      'ot_until', case when m.ot_until is not null then floor(extract(epoch from m.ot_until) * 1000) end, 'ot_v', m.ot_v) end,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'color', x.color,
        'lat', x.lat, 'lng', x.lng, 'acc', x.acc, 'heading', x.heading, 'speed', x.speed,
        'pos_at', case when x.pos_at is not null then floor(extract(epoch from x.pos_at) * 1000) end,
        'seen', floor(extract(epoch from x.last_seen) * 1000), 'ot', x.ot_hash is not null,
        'ot_at', case when x.ot_at is not null then floor(extract(epoch from x.ot_at) * 1000) end,
        'ot_slow', x.ot_hash is not null and x.ot_pace = 'slow') order by x.joined_at)
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

revoke all on function bc_owntracks(text, jsonb), _bc_ot_cmd(text, int) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function bc_owntracks(text, jsonb), _bc_ot_cmd(text, int) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function bc_owntracks(text, jsonb) to service_role';
  end if;
end $$;

-- guest functions behind the password wrappers (gated_bc_*), rebuilt to match
select _lock_wrap_all();
