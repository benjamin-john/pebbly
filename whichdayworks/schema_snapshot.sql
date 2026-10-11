-- Which day works?: snapshot of the live Supabase setup, taken 2026-10-11.
-- The original schema.sql and admin.sql were run in the Supabase SQL Editor but never saved
-- to the repo. This is a record of the functions as they exist in the database, plus the
-- table columns. It is for reference; the functions re-run safely (create or replace) but the
-- tables and _admin_check aren't recreated here. Changes go in update files such as organizer.sql.
--
-- Tables (columns as reported by information_schema; only this app's tables listed):
--   admin_attempts: id bigint, at timestamp with time zone
--   admin_config: id boolean, password_hash text, updated_at timestamp with time zone
--   events: id uuid, code text, name text, description text, num_days integer, earliest date, latest date, created_at timestamp with time zone
--   responses: id uuid, event_id uuid, participant_id text, name text, note text, picks jsonb, updated_at timestamp with time zone

CREATE OR REPLACE FUNCTION public.admin_delete_event(p_password text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_status  text;
  v_deleted int;
begin
  v_status := public._admin_check(p_password);
  if v_status <> 'ok' then
    return jsonb_build_object('error', v_status);
  end if;

  delete from public.events where code = lower(btrim(coalesce(p_code, '')));
  get diagnostics v_deleted = row_count;      -- its responses are removed automatically
  return jsonb_build_object('deleted', v_deleted);
end;
$function$;


CREATE OR REPLACE FUNCTION public.admin_list_events(p_password text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_status text;
begin
  v_status := public._admin_check(p_password);
  if v_status <> 'ok' then
    return jsonb_build_object('error', v_status);
  end if;

  return jsonb_build_object('events', coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'code', e.code,
               'name', e.name,
               'description', e.description,
               'num_days', e.num_days,
               'earliest', e.earliest,
               'latest', e.latest,
               'created_at', e.created_at,
               'responses', (select count(*) from public.responses r where r.event_id = e.id),
               'last_response', (select max(r.updated_at) from public.responses r where r.event_id = e.id)
             )
             order by e.created_at desc
           )
    from public.events e
  ), '[]'::jsonb));
end;
$function$;


CREATE OR REPLACE FUNCTION public.create_event(p_name text, p_description text DEFAULT ''::text, p_num_days integer DEFAULT 1, p_earliest date DEFAULT NULL::date, p_latest date DEFAULT NULL::date)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  v_code  text;
  v_bytes bytea;
  v_try   int := 0;
  i       int;
begin
  p_name        := btrim(coalesce(p_name, ''));
  p_description := btrim(coalesce(p_description, ''));
  p_num_days    := coalesce(p_num_days, 1);

  if char_length(p_name) not between 1 and 120 then raise exception 'invalid_name'; end if;
  if char_length(p_description) > 2000          then raise exception 'invalid_description'; end if;
  if p_num_days not between 1 and 14            then raise exception 'invalid_num_days'; end if;
  if p_earliest is not null and p_latest is not null then
    if p_earliest > p_latest                          then raise exception 'invalid_range'; end if;
    if (p_latest - p_earliest) + 1 < p_num_days       then raise exception 'range_too_short'; end if;
    if (p_latest - p_earliest) > 730                  then raise exception 'range_too_long'; end if;
  end if;

  loop
    v_try   := v_try + 1;
    v_bytes := uuid_send(gen_random_uuid());   -- strong random bytes
    v_code  := '';
    for i in 0..7 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
    end loop;

    begin
      insert into public.events (code, name, description, num_days, earliest, latest)
      values (v_code, p_name, p_description, p_num_days, p_earliest, p_latest);
      return v_code;
    exception when unique_violation then
      if v_try >= 8 then raise; end if;
    end;
  end loop;
end;
$function$;


CREATE OR REPLACE FUNCTION public.delete_response(p_code text, p_participant text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  delete from public.responses r
   using public.events e
   where e.id = r.event_id
     and e.code = lower(btrim(coalesce(p_code, '')))
     and r.participant_id = p_participant;
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_event(p_code text, p_participant text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e public.events%rowtype;
begin
  select * into e from public.events where code = lower(btrim(coalesce(p_code, '')));
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'code', e.code,
      'name', e.name,
      'description', e.description,
      'num_days', e.num_days,
      'earliest', e.earliest,
      'latest', e.latest
    ),
    'responses', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'name', r.name,
                 'note', r.note,
                 'picks', r.picks,
                 'mine', coalesce(r.participant_id = p_participant, false),
                 'updated_at', r.updated_at
               )
               order by r.updated_at, r.id
             )
      from public.responses r
      where r.event_id = e.id
    ), '[]'::jsonb)
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.save_response(p_code text, p_participant text, p_name text, p_note text, p_picks jsonb, p_replace boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e          public.events%rowtype;
  v_name     text;
  v_note     text;
  v_clean    jsonb := '{}'::jsonb;
  v_conflict uuid;
  v_existing uuid;
  k          text;
  v          jsonb;
begin
  select * into e from public.events where code = lower(btrim(coalesce(p_code, '')));
  if not found then raise exception 'event_not_found'; end if;

  v_name := btrim(coalesce(p_name, ''));
  v_note := left(btrim(coalesce(p_note, '')), 300);

  if char_length(v_name) not between 1 and 60 then raise exception 'invalid_name'; end if;
  if p_participant is null or char_length(p_participant) not between 8 and 64 then
    raise exception 'invalid_participant';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'object' then raise exception 'invalid_picks'; end if;
  if (select count(*) from jsonb_object_keys(p_picks)) > 800 then raise exception 'invalid_picks'; end if;

  for k, v in select key, value from jsonb_each(p_picks) loop
    if k !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid_picks'; end if;
    perform k::date;  -- rejects impossible dates such as 2026-02-31
    if jsonb_typeof(v) <> 'object'
       or coalesce(v->>'s', '') not in ('preferred', 'second', 'not_ideal', 'unavailable') then
      raise exception 'invalid_picks';
    end if;
    v_clean := v_clean || jsonb_build_object(
      k,
      jsonb_strip_nulls(jsonb_build_object(
        's', v->>'s',
        'n', nullif(left(btrim(coalesce(v->>'n', '')), 120), '')
      ))
    );
  end loop;

  select id into v_existing
    from public.responses
   where event_id = e.id and participant_id = p_participant;

  if v_existing is null
     and (select count(*) from public.responses where event_id = e.id) >= 60 then
    raise exception 'event_full';
  end if;

  -- Someone else already answered under this name on this event.
  select id into v_conflict
    from public.responses
   where event_id = e.id
     and lower(name) = lower(v_name)
     and participant_id <> p_participant
   limit 1;

  if v_conflict is not null then
    if coalesce(p_replace, false) then
      delete from public.responses where id = v_conflict;
    else
      raise exception 'name_taken';
    end if;
  end if;

  insert into public.responses (event_id, participant_id, name, note, picks, updated_at)
  values (e.id, p_participant, v_name, v_note, v_clean, now())
  on conflict (event_id, participant_id)
  do update set name = excluded.name,
                note = excluded.note,
                picks = excluded.picks,
                updated_at = now();
end;
$function$;
