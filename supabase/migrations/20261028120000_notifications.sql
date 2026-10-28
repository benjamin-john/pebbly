-- Notifications (the 🔔 bell, notify.js). Safe to re-run.
--
-- How it works:
--  * notifications holds one row per thing worth telling someone about, for any app. Each row is for
--    the event's hosts ('host') or for everyone who responded ('guest'). Rows are added by triggers
--    on each app's own tables, so every way in (password wrappers, admin, …) is covered and none of
--    the app functions change.
--  * notify_types lists every kind of notification (who it's for; the wording is in notify.js). Adding a kind for a new app
--    is a row here plus a trigger.
--  * The browser reads through notify_feed only. A phone sends the events it's part of, each with
--    its host key (role 'host') or its participant id (role 'guest', which must have responded).
--    Guests of a password-protected event also send the event's lock key. Who did it (actor) is
--    stored so a phone's own actions don't ring its bell, but it's never returned.
--  * notify_off holds the kinds someone turned off (settings page), per event and per host key or
--    guest id (stored hashed). Turning a kind off hides it; it is still recorded.
--  * "Seen" is kept on each phone (localStorage), not here.
--  * emailed_at / pushed_at are for the later email and Web Push senders.
--
-- notify_feed isn't one of the password wrappers (_lock_wrap_all): it reads many events at once and
-- checks the lock key itself for guests. Hosts don't need one (their host key is enough).

-- ------------------------------------------------------------------ tables

create table if not exists notify_types (
  type     text primary key,                        -- '<app>.<kind>'
  app      text not null,
  audience text not null check (audience in ('host', 'guest')),
  label    text not null,                           -- shown on the settings page
  sort     int  not null default 0
);

insert into notify_types (type, app, audience, label, sort) values
  ('rsvp.rsvp_new',         'rsvp', 'host',  'New RSVPs', 1),
  ('rsvp.rsvp_changed',     'rsvp', 'host',  'Changed answers', 2),
  ('rsvp.comment',          'rsvp', 'host',  'New comments', 3),
  ('rsvp.announce',         'rsvp', 'guest', 'Announcements from the host', 4),
  ('wdw.response_new',      'wdw',  'host',  'Someone added their days', 1),
  ('wdw.response_changed',  'wdw',  'host',  'Someone changed their days', 2),
  ('wdw.final_date',        'wdw',  'guest', 'The organizer picked the date', 3)
on conflict (type) do update set app = excluded.app, audience = excluded.audience, label = excluded.label, sort = excluded.sort;

create table if not exists notifications (
  id         bigint generated always as identity primary key,
  app        text not null,
  event_id   uuid not null,
  type       text not null references notify_types(type) on delete cascade,
  audience   text not null check (audience in ('host', 'guest')),
  actor      text,                                  -- participant id of whoever did it; never returned
  ref        uuid,                                  -- the row it's about (guest, post, response)
  name       text not null default '',
  detail     jsonb not null default '{}'::jsonb,   -- e.g. {"status":"going","plus":1}, {"snippet":"…"}
  created_at timestamptz not null default now(),
  emailed_at timestamptz,
  pushed_at  timestamptz
);
create index if not exists notifications_event on notifications(app, event_id, id);
create index if not exists notifications_ref on notifications(ref) where ref is not null;

create table if not exists notify_off (
  app        text not null,
  event_id   uuid not null,
  who_hash   text not null,                         -- sha256 of role + ':' + host key or participant id
  type       text not null references notify_types(type) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (app, event_id, who_hash, type)
);

alter table notify_types  enable row level security;
alter table notifications enable row level security;
alter table notify_off    enable row level security;
revoke all on notify_types, notifications, notify_off from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on notify_types, notifications, notify_off from %I', r);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------------ helpers

create or replace function _notify_who(p_role text, p_key text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(coalesce(p_role, '') || ':' || coalesce(p_key, ''), 'UTF8')), 'hex');
$$;

-- The event a feed entry may read, or null. Hosts need a host key (not an admin's "open as host"
-- key, so the admin's bell doesn't fill up with everyone's events); guests must have responded
-- (and, if the event has a password, send its lock key).
create or replace function _notify_event(p_app text, p_code text, p_role text, p_key text, p_lock text)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_code text := lower(btrim(coalesce(p_code, ''))); v_lock text;
begin
  if coalesce(p_key, '') = '' or char_length(p_key) > 200 or p_role not in ('host', 'guest') then return null; end if;
  if p_app = 'rsvp' then
    select id into v_id from rsvp_events where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then
      return case when exists (select 1 from rsvp_owner_keys where event_id = v_id and key_hash = _rsvp_hash(p_key) and label <> 'admin') then v_id end;
    end if;
    if not exists (select 1 from rsvp_guests where event_id = v_id and participant = p_key) then return null; end if;
  elsif p_app = 'wdw' then
    select id into v_id from events where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then
      return case when exists (select 1 from wdw_owner_keys where event_id = v_id and key_hash = _wdw_hash(p_key) and label <> 'admin') then v_id end;
    end if;
    if not exists (select 1 from responses where event_id = v_id and participant_id = p_key) then return null; end if;
  else
    return null;
  end if;
  select key into v_lock from plan_locks where app = p_app and code = v_code;
  if found and coalesce(p_lock, '') <> v_lock then return null; end if;
  return v_id;
end $$;

-- Adds a notification and keeps each event to its newest 200 (and 90 days).
create or replace function _notify_add(p_app text, p_event uuid, p_type text, p_actor text, p_ref uuid, p_name text, p_detail jsonb)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_aud text; v_cut bigint;
begin
  select audience into v_aud from notify_types where type = p_type;
  if v_aud is null then return; end if;
  insert into notifications (app, event_id, type, audience, actor, ref, name, detail)
  values (p_app, p_event, p_type, v_aud, p_actor, p_ref, left(coalesce(p_name, ''), 80), coalesce(p_detail, '{}'::jsonb));
  select id into v_cut from notifications where app = p_app and event_id = p_event order by id desc offset 200 limit 1;
  delete from notifications where app = p_app and event_id = p_event
    and (created_at < now() - interval '90 days' or (v_cut is not null and id <= v_cut));
end $$;

-- A reply (or change of reply) within 10 minutes of the last one from the same person replaces it,
-- so a few quick edits show as one. Returns the replaced row's type and detail (null if none).
create or replace function _notify_take_recent(p_app text, p_ref uuid, p_types text[], out o_type text, out o_detail jsonb)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  select id, type, detail into v_id, o_type, o_detail from notifications
   where app = p_app and ref = p_ref and type = any(p_types) and created_at > now() - interval '10 minutes'
   order by id desc limit 1;
  if v_id is not null then delete from notifications where id = v_id; end if;
end $$;

-- ------------------------------------------------------------------ RSVP

create or replace function _notify_rsvp_guest() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_type text := 'rsvp.rsvp_new'; v_from text; r record;
begin
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status and new.plus_ones is not distinct from old.plus_ones then return null; end if;
    v_type := 'rsvp.rsvp_changed'; v_from := old.status;
  end if;
  select * into r from _notify_take_recent('rsvp', new.id, array['rsvp.rsvp_new', 'rsvp.rsvp_changed']);
  if r.o_type = 'rsvp.rsvp_new' then
    v_type := 'rsvp.rsvp_new'; v_from := null;
  elsif r.o_type = 'rsvp.rsvp_changed' then
    v_from := coalesce(r.o_detail->>'from', v_from);
    -- changed and changed back: nothing to tell
    if v_from = new.status and (r.o_detail->>'plus_from')::int is not distinct from new.plus_ones then return null; end if;
  end if;
  perform _notify_add('rsvp', new.event_id, v_type, new.participant, new.id, new.name,
    jsonb_strip_nulls(jsonb_build_object('status', new.status, 'plus', new.plus_ones, 'from', v_from,
      'plus_from', case when v_type = 'rsvp.rsvp_changed' then coalesce((r.o_detail->>'plus_from')::int, old.plus_ones) end)));
  return null;
end $$;

create or replace function _notify_rsvp_post() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    delete from notifications where app = 'rsvp' and ref = old.id;
    return null;
  end if;
  perform _notify_add('rsvp', new.event_id, case when new.kind = 'comment' then 'rsvp.comment' else 'rsvp.announce' end,
    new.participant, new.id, new.name, jsonb_build_object('snippet', left(new.body, 140)));
  return null;
end $$;

create or replace function _notify_rsvp_event() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from notifications where app = 'rsvp' and event_id = old.id;
  delete from notify_off where app = 'rsvp' and event_id = old.id;
  return null;
end $$;

drop trigger if exists notify_rsvp_guest on rsvp_guests;
create trigger notify_rsvp_guest after insert or update on rsvp_guests for each row execute function _notify_rsvp_guest();
drop trigger if exists notify_rsvp_post on rsvp_posts;
create trigger notify_rsvp_post after insert or delete on rsvp_posts for each row execute function _notify_rsvp_post();
drop trigger if exists notify_rsvp_event on rsvp_events;
create trigger notify_rsvp_event after delete on rsvp_events for each row execute function _notify_rsvp_event();

-- ------------------------------------------------------------------ Which Day Works?

create or replace function _notify_wdw_response() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_type text := 'wdw.response_new'; r record;
begin
  if tg_op = 'UPDATE' then
    if new.picks is not distinct from old.picks then return null; end if;
    v_type := 'wdw.response_changed';
  end if;
  select * into r from _notify_take_recent('wdw', new.id, array['wdw.response_new', 'wdw.response_changed']);
  if r.o_type = 'wdw.response_new' then v_type := 'wdw.response_new'; end if;
  perform _notify_add('wdw', new.event_id, v_type, new.participant_id, new.id, new.name, '{}'::jsonb);
  return null;
end $$;

create or replace function _notify_wdw_event() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    delete from notifications where app = 'wdw' and event_id = old.id;
    delete from notify_off where app = 'wdw' and event_id = old.id;
    return null;
  end if;
  if new.final_start is not distinct from old.final_start then return null; end if;
  delete from notifications where app = 'wdw' and event_id = new.id and type = 'wdw.final_date';
  if new.final_start is not null then
    perform _notify_add('wdw', new.id, 'wdw.final_date', null, null, new.name,
      jsonb_build_object('date', new.final_start, 'days', new.num_days));
  end if;
  return null;
end $$;

drop trigger if exists notify_wdw_response on responses;
create trigger notify_wdw_response after insert or update on responses for each row execute function _notify_wdw_response();
drop trigger if exists notify_wdw_event on events;
create trigger notify_wdw_event after update of final_start or delete on events for each row execute function _notify_wdw_event();

-- ------------------------------------------------------------------ browser functions

-- p_feeds: [{"app":"rsvp","code":"…","role":"host"|"guest","key":"<host key or participant id>",
--            "pid":"<this phone's participant id, to leave out its own actions>","lock":"<lock key>"}]
-- Returns one entry per feed, in order: {"app","code","role","ok":true,"title","emoji","off":[types],
--   "items":[{"id","type","name","detail","at"}] (newest 30)} or {"app","code","role","ok":false}.
create or replace function notify_feed(p_feeds jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f jsonb; v_id uuid; v_who text; v_title text; v_emoji text; v_out jsonb := '[]'::jsonb; v_head jsonb;
begin
  if p_feeds is null or jsonb_typeof(p_feeds) <> 'array' or jsonb_array_length(p_feeds) > 40 then raise exception 'invalid_feeds'; end if;
  for f in select value from jsonb_array_elements(p_feeds) loop
    if jsonb_typeof(f) <> 'object' then raise exception 'invalid_feeds'; end if;
    v_head := jsonb_build_object('app', f->>'app', 'code', f->>'code', 'role', f->>'role');
    v_id := _notify_event(f->>'app', f->>'code', f->>'role', f->>'key', f->>'lock');
    if v_id is null then v_out := v_out || jsonb_build_array(v_head || '{"ok":false}'::jsonb); continue; end if;
    v_who := _notify_who(f->>'role', f->>'key');
    if f->>'app' = 'rsvp' then select title, emoji into v_title, v_emoji from rsvp_events where id = v_id;
    else select name, '📅' into v_title, v_emoji from events where id = v_id; end if;
    v_out := v_out || jsonb_build_array(v_head || jsonb_build_object('ok', true, 'title', v_title, 'emoji', v_emoji,
      'off', coalesce((select jsonb_agg(o.type order by o.type) from notify_off o
                        where o.app = f->>'app' and o.event_id = v_id and o.who_hash = v_who), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'type', n.type, 'name', n.name,
                                  'detail', n.detail, 'at', n.created_at) order by n.id desc)
        from (select * from notifications n
               where n.app = f->>'app' and n.event_id = v_id and n.audience = f->>'role'
                 and (n.actor is null or n.actor <> coalesce(f->>'pid', ''))
                 and not exists (select 1 from notify_off o where o.app = n.app and o.event_id = n.event_id
                                   and o.who_hash = v_who and o.type = n.type)
               order by n.id desc limit 30) n), '[]'::jsonb)));
  end loop;
  return v_out;
end $$;

-- Settings: p_feeds like notify_feed, each with "off": [types to turn off] (replaces the old list).
-- Returns [{"app","code","role","ok"}].
create or replace function notify_set_off(p_feeds jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare f jsonb; v_id uuid; v_who text; v_out jsonb := '[]'::jsonb;
begin
  if p_feeds is null or jsonb_typeof(p_feeds) <> 'array' or jsonb_array_length(p_feeds) > 40 then raise exception 'invalid_feeds'; end if;
  for f in select value from jsonb_array_elements(p_feeds) loop
    if jsonb_typeof(f) <> 'object' or jsonb_typeof(coalesce(f->'off', '[]'::jsonb)) <> 'array' then raise exception 'invalid_feeds'; end if;
    v_id := _notify_event(f->>'app', f->>'code', f->>'role', f->>'key', f->>'lock');
    if v_id is not null then
      v_who := _notify_who(f->>'role', f->>'key');
      delete from notify_off where app = f->>'app' and event_id = v_id and who_hash = v_who;
      insert into notify_off (app, event_id, who_hash, type)
      select distinct f->>'app', v_id, v_who, t.type
        from jsonb_array_elements_text(coalesce(f->'off', '[]'::jsonb)) x(v)
        join notify_types t on t.type = x.v and t.app = f->>'app' and t.audience = f->>'role';
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('app', f->>'app', 'code', f->>'code', 'role', f->>'role', 'ok', v_id is not null));
  end loop;
  return v_out;
end $$;

revoke all on function _notify_who(text, text), _notify_event(text, text, text, text, text),
  _notify_add(text, uuid, text, text, uuid, text, jsonb), _notify_take_recent(text, uuid, text[]),
  _notify_rsvp_guest(), _notify_rsvp_post(), _notify_rsvp_event(), _notify_wdw_response(), _notify_wdw_event(),
  notify_feed(jsonb), notify_set_off(jsonb) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _notify_who(text, text), _notify_event(text, text, text, text, text), '
                  || '_notify_add(text, uuid, text, text, uuid, text, jsonb), _notify_take_recent(text, uuid, text[]), '
                  || '_notify_rsvp_guest(), _notify_rsvp_post(), _notify_rsvp_event(), _notify_wdw_response(), _notify_wdw_event() from %I', r);
      execute format('grant execute on function notify_feed(jsonb), notify_set_off(jsonb) to %I', r);
    end if;
  end loop;
end $$;
