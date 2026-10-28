-- Phone alerts (Web Push) for notifications. Safe to re-run.
--
-- How it works:
--  * A phone that turns on phone alerts sends its push subscription (an address at its browser's push
--    service plus two keys) and the events it's part of, the same list it sends notify_feed. Each valid
--    event becomes a push_targets row. The phone sends it again whenever its list changes.
--  * When a notification is added, a trigger asks the notify-push Edge Function (pg_net, sent after
--    the change commits) to send what's waiting, if anyone has alerts on for that event. The function
--    (supabase/functions/notify-push) claims the waiting items with notify_push_queue, encrypts and
--    sends each one, and reports dead subscriptions back. It works through the queue, so calling it
--    twice, or late, is harmless. The alert's wording is made on the phone (sw.js + notify.js).
--  * The same rules as the bell: kinds turned off (notify_off) aren't sent, your own actions aren't
--    sent to you, guest items aren't sent where the phone is the host.
--  * The function's VAPID key pair (its sender identity) is made by the function itself the first
--    time and kept in push_config. Only the service role can read it.
-- If pg_net isn't available (local tests), nothing is sent and nothing else changes.

do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net not available: phone alerts will not be sent from this database';
end $$;

-- ------------------------------------------------------------------ tables

create table if not exists push_subs (
  id         bigint generated always as identity primary key,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now(),
  synced_at  timestamptz not null default now(),
  last_ok    timestamptz
);

create table if not exists push_targets (
  sub_id   bigint not null references push_subs(id) on delete cascade,
  app      text not null,
  event_id uuid not null,
  role     text not null check (role in ('host', 'guest')),
  who_hash text not null,                           -- same as notify_off.who_hash
  pid      text not null default '',                -- this phone's participant id: its own actions aren't sent
  primary key (sub_id, app, event_id, role)
);
create index if not exists push_targets_event on push_targets(app, event_id);
create index if not exists notifications_unpushed on notifications(id) where pushed_at is null;

create table if not exists push_config (
  id          boolean primary key default true check (id),
  public_key  text not null,
  private_jwk jsonb not null,
  created_at  timestamptz not null default now()
);

alter table push_subs    enable row level security;
alter table push_targets enable row level security;
alter table push_config  enable row level security;
revoke all on push_subs, push_targets, push_config from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated', 'service_role']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on push_subs, push_targets, push_config from %I', r);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------------ the nudge

create or replace function _notify_push_kick() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from push_targets where app = new.app and event_id = new.event_id and role = new.audience) then
    begin
      perform net.http_post(url := 'https://xujtuijpbwujduuzlwat.supabase.co/functions/v1/notify-push',
                            body := '{}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb);
    exception when others then null;     -- never let an alert stop an RSVP
    end;
  end if;
  return null;
end $$;

drop trigger if exists notify_push_kick on notifications;
create trigger notify_push_kick after insert on notifications for each row execute function _notify_push_kick();

-- ------------------------------------------------------------------ phones (browser)

-- p_feeds: as notify_feed. Replaces this subscription's events. Returns {"ok": true, "events": n}.
create or replace function notify_push_sync(p_endpoint text, p_p256dh text, p_auth text, p_feeds jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_sub bigint; f jsonb; v_id uuid; v_n int := 0;
begin
  -- only real browser push services (so the sender can't be pointed anywhere else)
  if coalesce(p_endpoint, '') !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
     or char_length(p_endpoint) > 1000 then
    raise exception 'invalid_subscription';
  end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}={0,2}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,32}={0,2}$' then
    raise exception 'invalid_subscription';
  end if;
  if p_feeds is null or jsonb_typeof(p_feeds) <> 'array' or jsonb_array_length(p_feeds) > 40 then raise exception 'invalid_feeds'; end if;
  insert into push_subs (endpoint, p256dh, auth) values (p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, synced_at = now()
  returning id into v_sub;
  delete from push_targets where sub_id = v_sub;
  for f in select value from jsonb_array_elements(p_feeds) loop
    if jsonb_typeof(f) <> 'object' then raise exception 'invalid_feeds'; end if;
    v_id := _notify_event(f->>'app', f->>'code', f->>'role', f->>'key', f->>'lock');
    if v_id is null then continue; end if;
    insert into push_targets (sub_id, app, event_id, role, who_hash, pid)
    values (v_sub, f->>'app', v_id, f->>'role', _notify_who(f->>'role', f->>'key'), left(coalesce(f->>'pid', ''), 200))
    on conflict do nothing;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'events', v_n);
end $$;

create or replace function notify_push_remove(p_endpoint text) returns void
language sql volatile security definer set search_path = public, pg_temp as $$
  delete from push_subs where endpoint = p_endpoint;
$$;

-- ------------------------------------------------------------------ the sender (service role only)

-- Claims what's waiting and returns one entry per alert to send:
-- [{"endpoint","p256dh","auth","payload":{"app","code","title","emoji","type","name","detail","tag"}}]
create or replace function notify_push_queue() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_ids bigint[]; v_out jsonb;
begin
  -- anything older than an hour is stale: skip it
  update notifications set pushed_at = now() where pushed_at is null and created_at < now() - interval '1 hour';
  select array_agg(id) into v_ids from (
    select id from notifications where pushed_at is null order by id limit 200 for update skip locked) x;
  if v_ids is null then return '[]'::jsonb; end if;
  update notifications set pushed_at = now() where id = any(v_ids);
  select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
           'payload', jsonb_build_object('app', n.app, 'code', ev.code, 'title', ev.title, 'emoji', ev.emoji,
             'type', n.type, 'name', n.name, 'detail', n.detail,
             'tag', n.app || ':' || ev.code || ':' || coalesce(n.ref::text, n.type))) order by n.id), '[]'::jsonb)
    into v_out
    from notifications n
    join push_targets t on t.app = n.app and t.event_id = n.event_id and t.role = n.audience
    join push_subs s on s.id = t.sub_id
    cross join lateral (
      select e.code, e.title, e.emoji from rsvp_events e where n.app = 'rsvp' and e.id = n.event_id
      union all
      select e.code, e.name, '📅' from events e where n.app = 'wdw' and e.id = n.event_id) ev
   where n.id = any(v_ids)
     and (n.actor is null or n.actor <> t.pid)
     and not exists (select 1 from notify_off o where o.app = n.app and o.event_id = n.event_id and o.who_hash = t.who_hash and o.type = n.type)
     and not (t.role = 'guest' and exists (select 1 from push_targets h where h.sub_id = t.sub_id and h.app = t.app
                                             and h.event_id = t.event_id and h.role = 'host'));
  return v_out;
end $$;

-- After sending: p_gone are subscriptions the push service says no longer exist; p_ok were delivered.
create or replace function notify_push_result(p_gone text[], p_ok text[]) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  delete from push_subs where endpoint = any(coalesce(p_gone, '{}'));
  update push_subs set last_ok = now() where endpoint = any(coalesce(p_ok, '{}'));
end $$;

-- For "Send a test alert": the subscription's keys, or null.
create or replace function notify_push_sub(p_endpoint text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth) from push_subs where endpoint = p_endpoint;
$$;

create or replace function notify_push_vapid() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('publicKey', public_key, 'privateJwk', private_jwk) from push_config;
$$;

-- Keeps the first key pair ever saved (two first runs at once agree on one).
create or replace function notify_push_set_vapid(p_public text, p_private jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  insert into push_config (public_key, private_jwk) values (p_public, p_private) on conflict (id) do nothing;
  return notify_push_vapid();
end $$;

revoke all on function _notify_push_kick(), notify_push_sync(text, text, text, jsonb), notify_push_remove(text),
  notify_push_queue(), notify_push_result(text[], text[]), notify_push_sub(text), notify_push_vapid(),
  notify_push_set_vapid(text, jsonb) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _notify_push_kick(), notify_push_queue(), notify_push_result(text[], text[]), '
                  || 'notify_push_sub(text), notify_push_vapid(), notify_push_set_vapid(text, jsonb) from %I', r);
      execute format('grant execute on function notify_push_sync(text, text, text, jsonb), notify_push_remove(text) to %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function notify_push_queue(), notify_push_result(text[], text[]), notify_push_sub(text), '
         || 'notify_push_vapid(), notify_push_set_vapid(text, jsonb) to service_role';
  end if;
end $$;
