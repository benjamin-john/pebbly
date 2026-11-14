-- Basecamp: "Ask for location". Safe to re-run.
--
-- A person on a map can ask someone else on it to share where they are. That person gets a 🔔 notification (and a
-- phone alert, if they turned those on) saying who's asking; tapping it opens the map, which shares their location
-- while it's open. (A browser can't read the phone's location from an alert by itself; the person has to open it.)
--
--  * notifications.recipient: a notification meant for one person (their bc_members id). notify_feed and the phone
--    alert sender only give it to that person: for Basecamp, feeds are role 'guest' with the member key, and the
--    member id is worked out from that key (_notify_member), never taken from the phone.
--  * bc_ask: at most one ask per person to the same person every 2 minutes.

insert into notify_types (type, app, audience, label, sort) values
  ('basecamp.ask', 'basecamp', 'guest', 'Someone asks where you are', 1)
on conflict (type) do update set app = excluded.app, audience = excluded.audience, label = excluded.label, sort = excluded.sort;

alter table notifications add column if not exists recipient uuid;
create index if not exists notifications_recipient on notifications(recipient) where recipient is not null;

-- The one person a feed entry is (for apps that send to one person: Basecamp), from its key. Null otherwise.
create or replace function _notify_member(p_app text, p_event uuid, p_key text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_app = 'basecamp' and coalesce(p_key, '') <> '' then
    (select id from bc_members where session_id = p_event and key_hash = _app_hash(p_key)) end;
$$;

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
    select id into v_id from plan_docs d where code = v_code and kind = 'signup';
    if v_id is null then return null; end if;
    -- hosts only (nothing goes to guests yet)
    return case when p_role = 'host' and exists (select 1 from plan_docs d where d.id = v_id and _doc_is_owner(d.owner_hash, d.admin_hash, p_key)) then v_id end;
  elsif p_app = 'santa' then
    select id into v_id from santa_groups where code = v_code;
    if v_id is null then return null; end if;
    if p_role = 'host' then
      return case when exists (select 1 from santa_groups g where g.id = v_id and _doc_is_owner(g.owner_hash, g.admin_hash, p_key)) then v_id end;
    end if;
    if not exists (select 1 from santa_people where group_id = v_id and claim_hash = _app_hash(p_key)) then return null; end if;
  elsif p_app = 'bracket' then
    -- a shared ("play together") bracket: every phone in it, by its member key
    select id into v_id from play_games where code = upper(v_code) and kind = 'bracket';
    if v_id is null or p_role <> 'guest' then return null; end if;
    if not exists (select 1 from play_members where game_id = v_id and key_hash = _play_hash(p_key)) then return null; end if;
  elsif p_app = 'basecamp' then
    -- Basecamp: only things meant for one person on the map (by their member key)
    select id into v_id from bc_sessions where code = v_code;
    if v_id is null or p_role <> 'guest' then return null; end if;
    if not exists (select 1 from bc_members where session_id = v_id and key_hash = _app_hash(p_key)) then return null; end if;
  else
    return null;
  end if;
  -- guests of a password-protected event need its key (the Sign-up Sheet's password is the 'doc' one)
  select key into v_lock from plan_locks where app = case p_app when 'signup' then 'doc' else p_app end and code = v_code;
  if found and coalesce(p_lock, '') <> v_lock then return null; end if;
  return v_id;
end $$;

create or replace function _notify_title(p_app text, p_event uuid, out o_code text, out o_title text, out o_emoji text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_app = 'rsvp' then select code, title, emoji into o_code, o_title, o_emoji from rsvp_events where id = p_event;
  elsif p_app = 'wdw' then select code, name, '📅' into o_code, o_title, o_emoji from events where id = p_event;
  elsif p_app = 'poll' then select code, name, '🗳️' into o_code, o_title, o_emoji from polls where id = p_event;
  elsif p_app = 'signup' then select code, coalesce(nullif(state->>'title', ''), 'Sign-up Sheet'), '📋' into o_code, o_title, o_emoji from plan_docs where id = p_event;
  elsif p_app = 'santa' then select code, name, '🎁' into o_code, o_title, o_emoji from santa_groups where id = p_event;
  elsif p_app = 'basecamp' then select code, name, '⛺' into o_code, o_title, o_emoji from bc_sessions where id = p_event;
  elsif p_app = 'bracket' then select code, coalesce(nullif(state->>'title', ''), 'Bracket'), '🏆' into o_code, o_title, o_emoji from play_games where id = p_event;
  end if;
end $$;

create or replace function notify_feed(p_feeds jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f jsonb; v_id uuid; v_who text; t record; v_out jsonb := '[]'::jsonb; v_head jsonb; v_member uuid;
begin
  if p_feeds is null or jsonb_typeof(p_feeds) <> 'array' or jsonb_array_length(p_feeds) > 40 then raise exception 'invalid_feeds'; end if;
  for f in select value from jsonb_array_elements(p_feeds) loop
    if jsonb_typeof(f) <> 'object' then raise exception 'invalid_feeds'; end if;
    v_head := jsonb_build_object('app', f->>'app', 'code', f->>'code', 'role', f->>'role');
    v_id := _notify_event(f->>'app', f->>'code', f->>'role', f->>'key', f->>'lock');
    if v_id is null then v_out := v_out || jsonb_build_array(v_head || '{"ok":false}'::jsonb); continue; end if;
    v_who := _notify_who(f->>'role', f->>'key');
    v_member := _notify_member(f->>'app', v_id, f->>'key');
    select * into t from _notify_title(f->>'app', v_id);
    v_out := v_out || jsonb_build_array(v_head || jsonb_build_object('ok', true, 'title', t.o_title, 'emoji', t.o_emoji,
      'off', coalesce((select jsonb_agg(o.type order by o.type) from notify_off o
                        where o.app = f->>'app' and o.event_id = v_id and o.who_hash = v_who), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'type', n.type, 'name', n.name,
                                  'detail', n.detail, 'at', n.created_at) order by n.id desc)
        from (select * from notifications n
               where n.app = f->>'app' and n.event_id = v_id and n.audience = f->>'role'
                 and (n.actor is null or n.actor <> coalesce(f->>'pid', ''))
                 and (n.recipient is null or n.recipient = v_member)
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
     and (n.recipient is null or n.recipient::text = t.pid)
     and not exists (select 1 from notify_off o where o.app = n.app and o.event_id = n.event_id and o.who_hash = t.who_hash and o.type = n.type)
     and not (t.role = 'guest' and exists (select 1 from push_targets h where h.sub_id = t.sub_id and h.app = t.app
                                             and h.event_id = t.event_id and h.role = 'host'));
  return v_out;
end $$;

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
    values (v_sub, f->>'app', v_id, f->>'role', _notify_who(f->>'role', f->>'key'),
            -- Basecamp: the person's member id (checked from their key), so alerts meant for one person reach only them
            coalesce(_notify_member(f->>'app', v_id, f->>'key')::text, left(coalesce(f->>'pid', ''), 200)))
    on conflict do nothing;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'events', v_n);
end $$;

-- Ask someone on the map (p_id: their member id) to share where they are. Returns {"ok", "alerts": they get phone alerts,
-- "recent": already asked in the last 2 minutes (nothing new sent)}.
create or replace function bc_ask(p_code text, p_member text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s bc_sessions%rowtype := _bc_session(p_code); m bc_members%rowtype; v_to bc_members%rowtype; v_alerts boolean;
begin
  if s.id is null then raise exception 'map_not_found'; end if;
  m := _bc_member(s.id, p_member);
  if m.id is null then raise exception 'not_member'; end if;
  select * into v_to from bc_members where id = _bc_uuid(p_id) and session_id = s.id;
  if v_to.id is null then raise exception 'not_member'; end if;
  if v_to.id = m.id then raise exception 'invalid_id'; end if;
  v_alerts := exists (select 1 from push_targets where app = 'basecamp' and event_id = s.id and role = 'guest' and pid = v_to.id::text);
  if exists (select 1 from notifications where app = 'basecamp' and event_id = s.id and type = 'basecamp.ask'
               and actor = m.id::text and recipient = v_to.id and created_at > now() - interval '2 minutes') then
    return jsonb_build_object('ok', true, 'alerts', v_alerts, 'recent', true);
  end if;
  insert into notifications (app, event_id, type, audience, actor, ref, recipient, name, detail)
  values ('basecamp', s.id, 'basecamp.ask', 'guest', m.id::text, v_to.id, v_to.id, m.name, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'alerts', v_alerts, 'recent', false);
end $$;

create or replace function _lock_wrap_all() returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare w text[];
begin
  foreach w slice 1 in array array[
    ['rsvp', 'rsvp_get'], ['rsvp', 'rsvp_respond'], ['rsvp', 'rsvp_post'], ['rsvp', 'rsvp_delete_post'],
    ['rsvp', 'rsvp_item_add'], ['rsvp', 'rsvp_item_edit'], ['rsvp', 'rsvp_item_remove'], ['rsvp', 'rsvp_item_claim'],
    ['poll', 'poll_get'], ['poll', 'poll_vote'], ['poll', 'poll_add_option'], ['poll', 'poll_edit_option'],
    ['poll', 'poll_remove_option'],
    ['wdw', 'wdw_get'], ['wdw', 'get_event'], ['wdw', 'save_response'], ['wdw', 'delete_response'],
    ['doc', 'doc_get'], ['doc', 'doc_push'],
    ['santa', 'santa_get'], ['santa', 'santa_claim'], ['santa', 'santa_unclaim'], ['santa', 'santa_join'], ['santa', 'santa_set_wish'],
    ['basecamp', 'bc_sync'], ['basecamp', 'bc_join'], ['basecamp', 'bc_me_update'], ['basecamp', 'bc_remove_member'],
    ['basecamp', 'bc_waypoint_save'], ['basecamp', 'bc_waypoint_delete'], ['basecamp', 'bc_trail_delete'],
    ['basecamp', 'bc_ot_link'], ['basecamp', 'bc_ot_set'], ['basecamp', 'bc_ot_stop'], ['basecamp', 'bc_ot_extend'], ['basecamp', 'bc_ask']
  ] loop
    perform _lock_wrap(w[1], w[2]);
  end loop;
end $$;

revoke all on function _notify_member(text, uuid, text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _notify_member(text, uuid, text) from %I', r);
    end if;
  end loop;
end $$;

-- bc_ask is a guest function behind the password wrappers (gated_bc_ask)
select _lock_wrap_all();
