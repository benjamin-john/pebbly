-- Notifications for three more apps. Safe to re-run.
--  * Poll: everyone who voted (or added a choice) hears when the host picks a winner or spins for one.
--    The host isn't told about their own pick.
--  * Sign-up Sheet: the host hears when someone puts their name down (and the item goes away again
--    if they take it off).
--  * Secret Santa: everyone who has picked their name hears when names are drawn. The alert never
--    says who anyone has; the page shows each phone its own match, as before.
-- Same pattern as 20261028120000_notifications.sql: triggers add the rows, notify_feed reads them.
-- _notify_title gives each app's event name and emoji (bell list, alerts) in one place.

insert into notify_types (type, app, audience, label, sort) values
  ('poll.winner',    'poll',   'guest', 'The winner is picked', 1),
  ('signup.signup',  'signup', 'host',  'Someone signs up', 1),
  ('santa.drawn',    'santa',  'guest', 'Names are drawn', 1)
on conflict (type) do update set app = excluded.app, audience = excluded.audience, label = excluded.label, sort = excluded.sort;

-- ------------------------------------------------------------------ who may read

create or replace function _notify_event(p_app text, p_code text, p_role text, p_key text, p_lock text)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_code text := lower(btrim(coalesce(p_code, ''))); v_lock text; v_hash text;
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
  elsif p_app = 'poll' then
    select id, owner_hash into v_id, v_hash from polls where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then return case when _poll_is_owner(v_id, v_hash, p_key) then v_id end; end if;
    if not (exists (select 1 from poll_votes where poll_id = v_id and participant_id = p_key)
         or exists (select 1 from poll_voters where poll_id = v_id and participant_id = p_key)
         or exists (select 1 from poll_options where poll_id = v_id and added_by_pid = p_key)) then return null; end if;
  elsif p_app = 'signup' then
    select id, owner_hash into v_id, v_hash from plan_docs where code = v_code and kind = 'signup';
    if v_id is null then return null; end if;
    -- hosts only (nothing goes to guests yet)
    return case when p_role = 'host' and v_hash = _app_hash(p_key) then v_id end;
  elsif p_app = 'santa' then
    select id, owner_hash into v_id, v_hash from santa_groups where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then return case when v_hash = _app_hash(p_key) then v_id end; end if;
    if not exists (select 1 from santa_people where group_id = v_id and claim_hash = _app_hash(p_key)) then return null; end if;
  else
    return null;
  end if;
  -- guests of a password-protected event need its key (the Sign-up Sheet's password is the 'doc' one)
  select key into v_lock from plan_locks where app = case p_app when 'signup' then 'doc' else p_app end and code = v_code;
  if found and coalesce(p_lock, '') <> v_lock then return null; end if;
  return v_id;
end $$;

-- An event's link code, name and emoji (for the bell list and phone alerts).
create or replace function _notify_title(p_app text, p_event uuid, out o_code text, out o_title text, out o_emoji text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_app = 'rsvp' then select code, title, emoji into o_code, o_title, o_emoji from rsvp_events where id = p_event;
  elsif p_app = 'wdw' then select code, name, '📅' into o_code, o_title, o_emoji from events where id = p_event;
  elsif p_app = 'poll' then select code, name, '🗳️' into o_code, o_title, o_emoji from polls where id = p_event;
  elsif p_app = 'signup' then select code, coalesce(nullif(state->>'title', ''), 'Sign-up Sheet'), '📋' into o_code, o_title, o_emoji from plan_docs where id = p_event;
  elsif p_app = 'santa' then select code, name, '🎁' into o_code, o_title, o_emoji from santa_groups where id = p_event;
  end if;
end $$;

-- ------------------------------------------------------------------ Poll

create or replace function _notify_poll() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    delete from notifications where app = 'poll' and event_id = old.id;
    delete from notify_off where app = 'poll' and event_id = old.id;
    return null;
  end if;
  if new.winner_option_id is not distinct from old.winner_option_id then return null; end if;
  delete from notifications where app = 'poll' and event_id = new.id and type = 'poll.winner';
  if new.winner_option_id is not null then
    perform _notify_add('poll', new.id, 'poll.winner', null, new.winner_option_id,
      (select label from poll_options where id = new.winner_option_id), jsonb_build_object('method', new.winner_method));
  end if;
  return null;
end $$;

drop trigger if exists notify_poll on polls;
create trigger notify_poll after update of winner_option_id or delete on polls for each row execute function _notify_poll();

-- ------------------------------------------------------------------ Sign-up Sheet

-- signups: { id: { slot, name, note, pid, at } }, slots: { id: { label, … } }
create or replace function _notify_signup() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text; e jsonb; v_old jsonb; v_new jsonb;
begin
  if (case when tg_op = 'DELETE' then old.kind else new.kind end) <> 'signup' then return null; end if;   -- bills, lists, …
  if tg_op = 'DELETE' then
    delete from notifications where app = 'signup' and event_id = old.id;
    delete from notify_off where app = 'signup' and event_id = old.id;
    return null;
  end if;
  v_new := case when jsonb_typeof(new.state->'signups') = 'object' then new.state->'signups' else '{}'::jsonb end;
  v_old := case when tg_op = 'UPDATE' and jsonb_typeof(old.state->'signups') = 'object' then old.state->'signups' else '{}'::jsonb end;
  if v_new = v_old then return null; end if;
  for k, e in select key, value from jsonb_each(v_new) loop
    continue when v_old ? k or jsonb_typeof(e) <> 'object';
    perform _notify_add('signup', new.id, 'signup.signup', left(e->>'pid', 200), null, left(coalesce(e->>'name', ''), 80),
      jsonb_build_object('entry', left(k, 40), 'slot', left(coalesce(new.state->'slots'->(e->>'slot')->>'label', ''), 80)));
  end loop;
  -- taken off again: so is the notification
  delete from notifications where app = 'signup' and event_id = new.id and type = 'signup.signup'
    and not (v_new ? (detail->>'entry'));
  return null;
end $$;

drop trigger if exists notify_signup on plan_docs;
create trigger notify_signup after insert or update of state or delete on plan_docs for each row execute function _notify_signup();

-- ------------------------------------------------------------------ Secret Santa

create or replace function _notify_santa() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    delete from notifications where app = 'santa' and event_id = old.id;
    delete from notify_off where app = 'santa' and event_id = old.id;
    return null;
  end if;
  if (new.drawn_at is null) = (old.drawn_at is null) then return null; end if;
  delete from notifications where app = 'santa' and event_id = new.id and type = 'santa.drawn';
  if new.drawn_at is not null then
    perform _notify_add('santa', new.id, 'santa.drawn', null, null, new.name, '{}'::jsonb);
  end if;
  return null;
end $$;

drop trigger if exists notify_santa on santa_groups;
create trigger notify_santa after update of drawn_at or delete on santa_groups for each row execute function _notify_santa();

-- ------------------------------------------------------------------ readers, now using _notify_title

create or replace function notify_feed(p_feeds jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f jsonb; v_id uuid; v_who text; t record; v_out jsonb := '[]'::jsonb; v_head jsonb;
begin
  if p_feeds is null or jsonb_typeof(p_feeds) <> 'array' or jsonb_array_length(p_feeds) > 40 then raise exception 'invalid_feeds'; end if;
  for f in select value from jsonb_array_elements(p_feeds) loop
    if jsonb_typeof(f) <> 'object' then raise exception 'invalid_feeds'; end if;
    v_head := jsonb_build_object('app', f->>'app', 'code', f->>'code', 'role', f->>'role');
    v_id := _notify_event(f->>'app', f->>'code', f->>'role', f->>'key', f->>'lock');
    if v_id is null then v_out := v_out || jsonb_build_array(v_head || '{"ok":false}'::jsonb); continue; end if;
    v_who := _notify_who(f->>'role', f->>'key');
    select * into t from _notify_title(f->>'app', v_id);
    v_out := v_out || jsonb_build_array(v_head || jsonb_build_object('ok', true, 'title', t.o_title, 'emoji', t.o_emoji,
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
           'payload', jsonb_build_object('app', n.app, 'code', ev.o_code, 'title', ev.o_title, 'emoji', ev.o_emoji,
             'type', n.type, 'name', n.name, 'detail', n.detail,
             'tag', n.app || ':' || ev.o_code || ':' || coalesce(n.ref::text, n.detail->>'entry', n.type))) order by n.id), '[]'::jsonb)
    into v_out
    from notifications n
    join push_targets t on t.app = n.app and t.event_id = n.event_id and t.role = n.audience
    join push_subs s on s.id = t.sub_id
    cross join lateral _notify_title(n.app, n.event_id) ev
   where n.id = any(v_ids)
     and ev.o_code is not null
     and (n.actor is null or n.actor <> t.pid)
     and not exists (select 1 from notify_off o where o.app = n.app and o.event_id = n.event_id and o.who_hash = t.who_hash and o.type = n.type)
     and not (t.role = 'guest' and exists (select 1 from push_targets h where h.sub_id = t.sub_id and h.app = t.app
                                             and h.event_id = t.event_id and h.role = 'host'));
  return v_out;
end $$;

revoke all on function _notify_event(text, text, text, text, text), _notify_title(text, uuid),
  _notify_poll(), _notify_signup(), _notify_santa(), notify_push_queue() from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _notify_event(text, text, text, text, text), _notify_title(text, uuid), '
                  || '_notify_poll(), _notify_signup(), _notify_santa(), notify_push_queue() from %I', r);
      execute format('grant execute on function notify_feed(jsonb) to %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function notify_push_queue() to service_role';
  end if;
end $$;
