-- Basecamp: everyone on a map gets their own color. A new person is given the first color nobody has (even if their phone
-- asked for one that's taken), "My name and color" refuses a color someone else has, and the palette is reordered so the
-- first colors handed out look clearly different (blue, red, green, yellow, purple…). Safe to re-run.

create or replace function _bc_free_color(p_session uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select c from unnest(array['#2E86DE', '#E4572E', '#16A085', '#F4B400', '#8E44AD', '#E84393', '#00ACC1', '#6D4C41', '#7CB342', '#3949AB', '#FF7043', '#C0CA33']) with ordinality as p(c, i)
                   where c not in (select color from bc_members where session_id = p_session) order by i limit 1), '#2E86DE');
$$;

create or replace function bc_join(p_code text, p_name text, p_color text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); v_mkey text := _app_token(); v_mid uuid; v_color text;
  v_who text := _app_text(p_name, 30);
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  if v_who = '' then raise exception 'invalid_member_name'; end if;
  perform 1 from bc_sessions where id = s.id for update;
  if (select count(*) from bc_members where session_id = s.id) >= 60 then raise exception 'too_many_people'; end if;
  v_color := _bc_color(p_color);
  if v_color is null or exists (select 1 from bc_members where session_id = s.id and color = v_color) then
    v_color := _bc_free_color(s.id);                   -- everyone gets their own color
  end if;
  insert into bc_members (session_id, key_hash, name, color) values (s.id, _app_hash(v_mkey), v_who, v_color) returning id into v_mid;
  perform _bc_bump(s.id);
  return jsonb_build_object('member_id', v_mid, 'member_key', v_mkey, 'color', v_color);
end $$;

create or replace function bc_me_update(p_code text, p_member text, p_name text, p_color text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; v_who text := _app_text(p_name, 30);
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  if v_who = '' then v_who := m.name; end if;
  if exists (select 1 from bc_members where session_id = s.id and id <> m.id and color = _bc_color(p_color)) then raise exception 'color_taken'; end if;
  update bc_members set name = v_who, color = coalesce(_bc_color(p_color), color) where id = m.id;
  update bc_waypoints set by_name = v_who where member_id = m.id;
  update bc_trails set by_name = v_who, color = coalesce(_bc_color(p_color), color) where member_id = m.id;
  perform _bc_bump(s.id);
  return jsonb_build_object('ok', true);
end $$;

select _lock_wrap_all();
