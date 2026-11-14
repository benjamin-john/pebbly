-- Basecamp + OwnTracks: "Until I stop" (no end time). p_minutes 0 means no end time (ot_until null; bc_owntracks only
-- ends sharing when ot_until is set and past). Links made before 20261116000000 were given an end time there, so null
-- now always means "until I stop". Safe to re-run.

create or replace function bc_ot_link(p_code text, p_member text, p_trail boolean default false, p_minutes int default 4320) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; v_token text := _app_token();
  -- p_minutes 0 (or less): until they stop (no end time)
  v_until timestamptz := case when p_minutes <= 0 then null else now() + make_interval(mins => greatest(30, least(coalesce(p_minutes, 4320), 10080))) end;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  update bc_members set ot_hash = _app_hash(v_token), ot_trail = coalesce(p_trail, false), ot_trail_id = null,
    ot_until = v_until, ot_pace = 'normal', ot_mode = 1, ot_v = 2 where id = m.id;
  return jsonb_build_object('token', v_token, 'tid', upper(left(regexp_replace(m.name, '[^A-Za-z0-9]', '', 'g') || 'XX', 2)),
    'until', case when v_until is not null then floor(extract(epoch from v_until) * 1000) end);
end $$;

create or replace function bc_ot_extend(p_code text, p_member text, p_minutes int) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype;
  -- p_minutes 0 (or less): until they stop (no end time)
  v_until timestamptz := case when p_minutes <= 0 then null else now() + make_interval(mins => greatest(30, least(coalesce(p_minutes, 4320), 10080))) end;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  if m.ot_hash is null then raise exception 'not_sharing'; end if;
  update bc_members set ot_until = v_until where id = m.id;
  return jsonb_build_object('until', case when v_until is not null then floor(extract(epoch from v_until) * 1000) end);
end $$;

-- guest functions behind the password wrappers (gated_bc_*), rebuilt to match
select _lock_wrap_all();
