-- Which day works?: the organizer's final pick. Run once in the Supabase SQL Editor, after
-- organizer.sql. Safe to re-run.
--
-- Adds events.final_start: the first day of the chosen date (the event's number of days runs
-- from there). wdw_get now returns it, and wdw_set_final lets the organizer set or clear it.

alter table events add column if not exists final_start date;

-- Same as before, plus event.final_start.
create or replace function wdw_get(p_code text, p_participant text default null, p_owner_token text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e events%rowtype; v_owner boolean;
begin
  select * into e from events where code = lower(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  v_owner := _wdw_is_owner(e.id, p_owner_token);
  return jsonb_build_object(
    'event', jsonb_build_object('code', e.code, 'name', e.name, 'description', e.description,
                                'num_days', e.num_days, 'earliest', e.earliest, 'latest', e.latest,
                                'final_start', e.final_start),
    'is_owner', v_owner,
    'responses', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'id', case when v_owner then r.id end,
               'name', r.name, 'note', r.note, 'picks', r.picks,
               'mine', coalesce(r.participant_id = p_participant, false),
               'updated_at', r.updated_at)) order by r.updated_at, r.id)
        from responses r where r.event_id = e.id), '[]'::jsonb));
end $$;

-- Organizer: set the final date (its first day), or pass null to clear it.
create or replace function wdw_set_final(p_code text, p_owner_token text, p_start date)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_id uuid := _wdw_event_id(p_code);
begin
  if v_id is null then raise exception 'event_not_found'; end if;
  if not _wdw_is_owner(v_id, p_owner_token) then raise exception 'not_owner'; end if;
  update events set final_start = p_start where id = v_id;
end $$;

revoke all on function wdw_set_final(text, text, date) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function wdw_get(text, text, text), wdw_set_final(text, text, date) to %I', r);
    end if;
  end loop;
end $$;
