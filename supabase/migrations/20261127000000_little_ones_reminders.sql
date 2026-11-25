-- Little Ones: feed reminders. Safe to re-run.
--
-- Settings are shared, in the space's document: state.lo.remind = { on, every (hours after the last feed started, 1–8),
-- lead (minutes early, 0–60), repeat (minutes between repeats while nobody logs a feed: 0 = once, else up to 3 more),
-- night (only between from and to, hours 0–23 in tz), from, to, tz (the phone's IANA time zone) }.
-- Every minute lo_remind_tick() (pg_cron) adds a 'little.feed_due' notification when one is due; the usual trigger
-- turns it into phone alerts. Each phone chooses whether it gets them (notify_off, like any other kind).
-- A feed that is still running holds reminders back; a new feed or bottle clears the waiting ones from the bell.

insert into notify_types (type, app, audience, label, sort) values
  ('little.feed_due', 'little', 'guest', 'Feed reminders', 4)
on conflict (type) do update set app = excluded.app, audience = excluded.audience, label = excluded.label, sort = excluded.sort;

-- Whether hour-of-day p_h (0–24, fractional) is inside from..to (wrapping past midnight when from > to).
create or replace function _lo_in_window(p_h numeric, p_from int, p_to int) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select case when p_from = p_to then true
              when p_from < p_to then p_h >= p_from and p_h < p_to
              else p_h >= p_from or p_h < p_to end;
$$;

create or replace function lo_remind_tick(p_now timestamptz default now()) returns int
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d record; r jsonb; v_last record; v_now bigint := (extract(epoch from p_now) * 1000)::bigint;
        v_due bigint; v_sent int; v_rep int; v_n int := 0; v_tz text; v_local timestamp; v_h numeric;
begin
  for d in select id, state from plan_docs
            where kind = 'names' and state->'lo'->'remind'->>'on' = 'true' and jsonb_typeof(state->'lo'->'born') = 'number' loop
    r := d.state->'lo'->'remind';
    -- a feed going on right now: nothing to remind
    if exists (select 1 from lo_entries where doc_id = d.id and kind = 'feed' and not deleted and end_at is null
                 and at > v_now - 4 * 3600000) then continue; end if;
    select id, at into v_last from lo_entries where doc_id = d.id and kind in ('feed', 'bottle') and not deleted
     order by at desc limit 1;
    if v_last.id is null then continue; end if;
    v_due := v_last.at + round(least(greatest(coalesce(_lo_num(r->>'every'), 3), 1), 8) * 3600000)::bigint
           - least(greatest(coalesce(_lo_num(r->>'lead'), 0), 0), 60)::bigint * 60000;
    if v_now < v_due or v_now > v_due + 3 * 3600000 then continue; end if;   -- not yet, or long past (logging stopped)
    v_rep := least(greatest(coalesce(_lo_num(r->>'repeat'), 0), 0), 120)::int;
    select count(*) into v_sent from notifications where app = 'little' and event_id = d.id and type = 'little.feed_due'
       and detail->>'entry' = v_last.id;
    if v_sent >= (case when v_rep > 0 then 4 else 1 end) then continue; end if;
    if v_sent > 0 and v_now < v_due + v_sent::bigint * v_rep * 60000 then continue; end if;
    if coalesce(r->>'night', '') = 'true' then
      v_tz := coalesce(nullif(r->>'tz', ''), 'UTC');
      if not exists (select 1 from pg_timezone_names where name = v_tz) then v_tz := 'UTC'; end if;
      v_local := p_now at time zone v_tz;
      v_h := extract(hour from v_local) + extract(minute from v_local) / 60;
      if not _lo_in_window(v_h, coalesce(_lo_num(r->>'from'), 21)::int % 24, coalesce(_lo_num(r->>'to'), 7)::int % 24) then continue; end if;
    end if;
    perform _notify_add('little', d.id, 'little.feed_due', null, null, coalesce(nullif(d.state->'lo'->>'baby', ''), 'Baby'),
      jsonb_build_object('entry', v_last.id, 'last', v_last.at, 'n', v_sent + 1));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- A number from settings text, or null (never an error).
create or replace function _lo_num(p text) returns numeric
language sql immutable set search_path = public, pg_temp as $$
  select case when p ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then p::numeric end;
$$;

-- Same as 20261125000000_little_ones.sql, plus: a new feed or bottle clears waiting feed reminders.
create or replace function _notify_little() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_state jsonb; v_name text; v_p jsonb;
begin
  if new.deleted then
    if new.kind in ('water', 'contraction') then
      delete from notifications where app = 'little' and event_id = new.doc_id and detail->>'entry' = new.id;
    end if;
    return null;
  end if;
  if new.kind in ('feed', 'bottle') and (tg_op = 'INSERT' or old.deleted) then
    delete from notifications where app = 'little' and event_id = new.doc_id and type = 'little.feed_due'
       and (detail->>'last')::bigint < new.at;
    return null;
  end if;
  if new.kind not in ('water', 'contraction') then return null; end if;
  select state into v_state from plan_docs where id = new.doc_id;
  v_name := coalesce(nullif(v_state->'p'->>new.who, ''), 'Someone');
  if new.kind = 'water' then
    if tg_op = 'INSERT' or old.deleted then
      perform _notify_add('little', new.doc_id, 'little.water', new.pid, null, v_name, jsonb_build_object('entry', new.id));
    end if;
    return null;
  end if;
  -- the first contraction after two quiet hours
  if (tg_op = 'INSERT' or old.deleted) and not exists (
        select 1 from lo_entries where doc_id = new.doc_id and kind = 'contraction' and not deleted and id <> new.id
           and at between new.at - 2 * 3600000 and new.at + 60000) then
    perform _notify_add('little', new.doc_id, 'little.contractions', new.pid, null, v_name, jsonb_build_object('entry', new.id));
  end if;
  if new.end_at is not null and not exists (
        select 1 from notifications where app = 'little' and event_id = new.doc_id and type = 'little.pattern'
           and created_at > now() - interval '3 hours') then
    v_p := _lo_pattern(new.doc_id, new.at, coalesce(v_state->'lo'->>'rule', '511'));
    if v_p is not null then
      perform _notify_add('little', new.doc_id, 'little.pattern', null, null, v_name, v_p || jsonb_build_object('entry', new.id));
    end if;
  end if;
  return null;
end $$;

revoke all on function _lo_in_window(numeric, int, int), lo_remind_tick(timestamptz), _lo_num(text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _lo_in_window(numeric, int, int), lo_remind_tick(timestamptz), _lo_num(text) from %I', r);
    end if;
  end loop;
end $$;

-- Run it every minute (pg_cron, where the database has it; the test database doesn't).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('little-ones-reminders', '* * * * *', 'select public.lo_remind_tick()');
  end if;
end $$;
