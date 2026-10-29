-- Notifications: a shared bracket's champion, and RSVP bring-list volunteers. Safe to re-run.
--  * Bracket: everyone in a shared ("play together") bracket hears who won. The page works the champion
--    out and keeps it in the shared game as champ: { id, name, by } (by: the phone that recorded the
--    final, so it isn't told about its own result).
--  * RSVP: the host hears when someone offers to bring something (claims a bring-list item, or adds
--    one of their own, which claims it). Taking it back removes the notification.
-- _notify_event and _notify_title are 20261029120000_notify_more_apps.sql's plus Bracket.

insert into notify_types (type, app, audience, label, sort) values
  ('bracket.champion', 'bracket', 'guest', 'A winner is crowned', 1),
  ('rsvp.bring',       'rsvp',    'host',  'Someone offers to bring something', 4)
on conflict (type) do update set app = excluded.app, audience = excluded.audience, label = excluded.label, sort = excluded.sort;
update notify_types set sort = 5 where type = 'rsvp.announce';

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
  elsif p_app = 'bracket' then
    -- a shared ("play together") bracket: every phone in it, by its member key
    select id into v_id from play_games where code = upper(v_code) and kind = 'bracket';
    if v_id is null or p_role <> 'guest' then return null; end if;
    if not exists (select 1 from play_members where game_id = v_id and key_hash = _play_hash(p_key)) then return null; end if;
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
  elsif p_app = 'bracket' then select code, coalesce(nullif(state->>'title', ''), 'Bracket'), '🏆' into o_code, o_title, o_emoji from play_games where id = p_event;
  end if;
end $$;

-- ------------------------------------------------------------------ Bracket

create or replace function _notify_bracket() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_new text; v_old text;
begin
  if tg_op = 'DELETE' then
    if old.kind = 'bracket' then
      delete from notifications where app = 'bracket' and event_id = old.id;
      delete from notify_off where app = 'bracket' and event_id = old.id;
    end if;
    return null;
  end if;
  if new.kind <> 'bracket' then return null; end if;
  v_new := new.state->'champ'->>'id';
  v_old := old.state->'champ'->>'id';
  if v_new is not distinct from v_old then return null; end if;
  delete from notifications where app = 'bracket' and event_id = new.id and type = 'bracket.champion';
  if v_new is not null then
    perform _notify_add('bracket', new.id, 'bracket.champion', left(new.state->'champ'->>'by', 200), null,
      left(coalesce(new.state->'champ'->>'name', ''), 80), '{}'::jsonb);
  end if;
  return null;
end $$;

drop trigger if exists notify_bracket on play_games;
create trigger notify_bracket after update of state or delete on play_games for each row execute function _notify_bracket();

-- ------------------------------------------------------------------ RSVP bring list

create or replace function _notify_rsvp_claim() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    delete from notifications where app = 'rsvp' and type = 'rsvp.bring' and ref = old.item_id and actor = old.participant;
    return null;
  end if;
  perform _notify_add('rsvp', new.event_id, 'rsvp.bring', new.participant, new.item_id, new.name,
    jsonb_build_object('item', (select left(label, 80) from rsvp_items where id = new.item_id)));
  return null;
end $$;

drop trigger if exists notify_rsvp_claim on rsvp_claims;
create trigger notify_rsvp_claim after insert or delete on rsvp_claims for each row execute function _notify_rsvp_claim();

revoke all on function _notify_event(text, text, text, text, text), _notify_title(text, uuid), _notify_bracket(), _notify_rsvp_claim() from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _notify_event(text, text, text, text, text), _notify_title(text, uuid), '
                  || '_notify_bracket(), _notify_rsvp_claim() from %I', r);
    end if;
  end loop;
end $$;
