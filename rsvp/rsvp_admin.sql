-- RSVP app: admin functions. Run after schema.sql.
-- Needs admin.sql from Which day works? (it defines _admin_check and the admin password).
-- Uses the same password and the same failed-attempt lockout. Safe to re-run.
--
-- Admin functions never raise on a bad password: they return {"error": "..."} so the
-- failed-attempt counter written by _admin_check is kept (an exception would roll it back).

-- Calls the shared _admin_check(password) and turns its answer into
-- null (password OK) or an error code. Written to cope with whichever return type
-- _admin_check has (boolean, text, json/jsonb or void).
create or replace function _rsvp_admin_ok(p_password text) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_type text; v_res text; j jsonb;
begin
  select format_type(p.prorettype, null) into v_type
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname = '_admin_check' and n.nspname = 'public' and p.pronargs = 1
   limit 1;
  if v_type is null then return 'admin_not_configured'; end if;

  if v_type = 'void' then
    execute 'select public._admin_check($1)' using p_password;
    return null;
  end if;
  execute 'select public._admin_check($1)::text' into v_res using p_password;

  if v_type = 'boolean' then
    return case when v_res = 'true' then null else 'wrong_password' end;
  elsif v_type in ('json', 'jsonb') then
    if v_res is null then return null; end if;
    j := v_res::jsonb;
    if jsonb_typeof(j) = 'boolean' then return case when j = 'true'::jsonb then null else 'wrong_password' end; end if;
    if jsonb_typeof(j) = 'string' then return nullif(nullif(j #>> '{}', ''), 'ok'); end if;
    if jsonb_typeof(j) <> 'object' then return null; end if;
    if j ? 'error' and coalesce(j->>'error', '') <> '' then return j->>'error'; end if;
    if j ? 'ok' and (j->>'ok') <> 'true' then return 'wrong_password'; end if;
    return null;
  else
    -- text-like: empty / 'ok' means fine, anything else is an error code
    return nullif(nullif(btrim(coalesce(v_res, '')), ''), 'ok');
  end if;
end $$;

create or replace function rsvp_admin_list(p_password text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password);
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  return jsonb_build_object('events', coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', e.code, 'title', e.title, 'host_name', e.host_name, 'event_date', e.event_date,
      'start_time', to_char(e.start_time, 'HH24:MI'), 'created_at', e.created_at,
      'going', (select coalesce(sum(1 + plus_ones), 0) from rsvp_guests g where g.event_id = e.id and g.status = 'going'),
      'replies', (select count(*) from rsvp_guests g where g.event_id = e.id),
      'comments', (select count(*) from rsvp_posts p where p.event_id = e.id and p.kind = 'comment'))
      order by e.created_at desc)
    from rsvp_events e), '[]'::jsonb));
end $$;

-- Gives the admin a host key for one event (one 'admin' key per event, replaced each time),
-- so the real host keeps theirs.
create or replace function rsvp_admin_grant(p_password text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password); v_id uuid; v_token text;
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  select id into v_id from rsvp_events where code = lower(btrim(p_code));
  if not found then return jsonb_build_object('error', 'event_not_found'); end if;
  v_token := _rsvp_token();
  delete from rsvp_owner_keys where event_id = v_id and label = 'admin';
  insert into rsvp_owner_keys (event_id, key_hash, label) values (v_id, _rsvp_hash(v_token), 'admin');
  return jsonb_build_object('owner_token', v_token);
end $$;

create or replace function rsvp_admin_delete(p_password text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password);
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  delete from rsvp_events where code = lower(btrim(p_code));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function _rsvp_admin_ok(text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _rsvp_admin_ok(text) from %I', r);
      execute format('grant execute on function rsvp_admin_list(text), rsvp_admin_grant(text, text), rsvp_admin_delete(text, text) to %I', r);
    end if;
  end loop;
end $$;
