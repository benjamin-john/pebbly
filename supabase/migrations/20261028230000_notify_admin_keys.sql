-- Notifications: admin "open as host" keys count as host keys after all. Safe to re-run.
-- Ben is both the admin and an organizer, and admin keys only exist for events someone chose to open,
-- so leaving them out meant an organizer whose phone held the admin key heard nothing.
-- Same as 20261028120000_notifications.sql, without the label checks.

create or replace function _notify_event(p_app text, p_code text, p_role text, p_key text, p_lock text)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_code text := lower(btrim(coalesce(p_code, ''))); v_lock text;
begin
  if coalesce(p_key, '') = '' or char_length(p_key) > 200 or p_role not in ('host', 'guest') then return null; end if;
  if p_app = 'rsvp' then
    select id into v_id from rsvp_events where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then return case when _rsvp_is_owner(v_id, p_key) then v_id end; end if;
    if not exists (select 1 from rsvp_guests where event_id = v_id and participant = p_key) then return null; end if;
  elsif p_app = 'wdw' then
    select id into v_id from events where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then return case when _wdw_is_owner(v_id, p_key) then v_id end; end if;
    if not exists (select 1 from responses where event_id = v_id and participant_id = p_key) then return null; end if;
  else
    return null;
  end if;
  select key into v_lock from plan_locks where app = p_app and code = v_code;
  if found and coalesce(p_lock, '') <> v_lock then return null; end if;
  return v_id;
end $$;

revoke all on function _notify_event(text, text, text, text, text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _notify_event(text, text, text, text, text) from %I', r);
    end if;
  end loop;
end $$;
