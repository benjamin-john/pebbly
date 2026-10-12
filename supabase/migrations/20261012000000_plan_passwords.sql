-- Optional passwords for the Plan apps (RSVP, Poll, Which Day Works?). Safe to re-run.
--
-- How it works:
--  * plan_locks holds one row per protected event/poll: a bcrypt hash of the password and a random
--    "key". Guests trade the password for the key once (lock_open, rate limited); their phone keeps
--    the key and sends it with every call. Changing the password makes a new key, so everyone has to
--    enter the new one.
--  * Every function a guest can call with just the code gets a wrapper gated_<name>(same arguments,
--    p_key) that checks the key and then calls the original. The originals are no longer callable by
--    the browser (anon/authenticated), so the password can't be skipped.
--  * Hosts manage it with lock_set / lock_owner (checked against the app's own owner key).
--
-- When a later migration changes one of the wrapped functions, end it with
--   select _lock_wrap_all();
-- (rebuilds the wrappers to match), and never grant execute on the originals to anon/authenticated.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists plan_locks (
  app        text not null check (app in ('rsvp', 'poll', 'wdw')),
  code       text not null,
  pass_hash  text not null,
  key        text not null,
  fails      int  not null default 0,
  fail_start timestamptz,
  updated_at timestamptz not null default now(),
  primary key (app, code)
);
alter table plan_locks enable row level security;
revoke all on plan_locks from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on plan_locks from %I', r); end if;
  end loop;
end $$;

create or replace function _lock_code(p_code text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select lower(btrim(coalesce(p_code, '')));
$$;

-- Raises password_required unless the event is unprotected or p_key matches.
create or replace function _lock_gate(p_app text, p_code text, p_key text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_key text;
begin
  select key into v_key from plan_locks where app = p_app and code = _lock_code(p_code);
  if found and coalesce(p_key, '') <> v_key then raise exception 'password_required'; end if;
end $$;

-- Is p_token the host's key for this event/poll?
create or replace function _lock_is_owner(p_app text, p_code text, p_token text) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if coalesce(p_token, '') = '' then return false; end if;
  if p_app = 'rsvp' then
    select id into v_id from rsvp_events where code = _lock_code(p_code);
    return v_id is not null and _rsvp_is_owner(v_id, p_token);
  elsif p_app = 'wdw' then
    v_id := _wdw_event_id(p_code);
    return v_id is not null and _wdw_is_owner(v_id, p_token);
  elsif p_app = 'poll' then
    -- Poll's tables aren't in this repo, so ask Poll itself: delete the poll with this key inside a
    -- savepoint, confirm it's gone, then roll the delete back. Nothing is changed.
    begin
      perform poll_delete(p_code, p_token);
      begin
        if poll_get(p_code, null, null) is not null then raise exception 'lock_probe_still_there'; end if;
      exception when others then
        if sqlerrm = 'lock_probe_still_there' then raise; end if;   -- not_found errors mean it was deleted
      end;
      raise exception 'lock_probe_owner';
    exception when others then
      return sqlerrm = 'lock_probe_owner';
    end;
  end if;
  return false;
end $$;

-- Guest: trade the password for the key. {"key": null} when the event has no password.
-- Returns {"error": ...} instead of raising so the failed-attempt counter is kept.
create or replace function lock_open(p_app text, p_code text, p_password text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare l plan_locks%rowtype;
begin
  select * into l from plan_locks where app = p_app and code = _lock_code(p_code) for update;
  if not found then return jsonb_build_object('key', null); end if;
  if l.fail_start is null or l.fail_start < now() - interval '15 minutes' then
    l.fails := 0; l.fail_start := null;
  end if;
  if l.fails >= 10 then return jsonb_build_object('error', 'too_many_attempts'); end if;
  if extensions.crypt(btrim(coalesce(p_password, '')), l.pass_hash) = l.pass_hash then
    update plan_locks set fails = 0, fail_start = null where app = l.app and code = l.code;
    return jsonb_build_object('key', l.key);
  end if;
  update plan_locks set fails = l.fails + 1, fail_start = coalesce(l.fail_start, now())
   where app = l.app and code = l.code;
  return jsonb_build_object('error', 'wrong_password');
end $$;

-- Host: is it protected, and the key (so the host's phone never has to type the password).
create or replace function lock_owner(p_app text, p_code text, p_owner_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_key text;
begin
  if not _lock_is_owner(p_app, p_code, p_owner_token) then return jsonb_build_object('error', 'not_owner'); end if;
  select key into v_key from plan_locks where app = p_app and code = _lock_code(p_code);
  return jsonb_build_object('locked', v_key is not null, 'key', v_key);
end $$;

-- Host: set or change the password, or pass null/'' to remove it.
create or replace function lock_set(p_app text, p_code text, p_owner_token text, p_password text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_pw text := btrim(coalesce(p_password, '')); v_key text;
begin
  if not _lock_is_owner(p_app, p_code, p_owner_token) then return jsonb_build_object('error', 'not_owner'); end if;
  if v_pw = '' then
    delete from plan_locks where app = p_app and code = _lock_code(p_code);
    return jsonb_build_object('locked', false, 'key', null);
  end if;
  if char_length(v_pw) > 100 then return jsonb_build_object('error', 'password_too_long'); end if;
  v_key := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into plan_locks (app, code, pass_hash, key)
  values (p_app, _lock_code(p_code), extensions.crypt(v_pw, extensions.gen_salt('bf', 8)), v_key)
  on conflict (app, code) do update
    set pass_hash = excluded.pass_hash, key = excluded.key, fails = 0, fail_start = null, updated_at = now();
  return jsonb_build_object('locked', true, 'key', v_key);
end $$;

-- Builds gated_<p_fn>(same arguments, p_key text default null) and takes the original away from
-- the browser. Re-runnable; rebuilds the wrapper if the original's arguments changed.
create or replace function _lock_wrap(p_app text, p_fn text) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare f record; o regprocedure; v_call text; v_body text; r text;
begin
  for o in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'gated_' || p_fn loop
    execute format('drop function %s', o);
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = p_fn) <> 1 then
    raise exception '_lock_wrap: expected exactly one function named %', p_fn;
  end if;
  select p.oid::regprocedure as sig, p.proargnames as names, p.proargmodes as modes, p.proretset as rset,
         pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as res
    into f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = p_fn;
  if f.modes is not null or f.rset or not ('p_code' = any (f.names)) then
    raise exception '_lock_wrap: % needs plain input arguments including p_code', p_fn;
  end if;
  select string_agg(format('%I => %I', a, a), ', ') into v_call from unnest(f.names) a;
  v_body := format('begin perform _lock_gate(%L, p_code, p_key); %s end',
    p_app, case when f.res = 'void' then format('perform %I(%s);', p_fn, v_call)
                else format('return %I(%s);', p_fn, v_call) end);
  execute format('create function %I(%s, p_key text default null) returns %s language plpgsql volatile '
              || 'security definer set search_path = public, pg_temp as %L',
                 'gated_' || p_fn, f.args, f.res, v_body);
  execute format('revoke all on function %s from public', f.sig);
  execute format('revoke all on function %s from public', ('gated_' || p_fn)::regproc::regprocedure);
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function %s from %I', f.sig, r);
      execute format('grant execute on function %s to %I', ('gated_' || p_fn)::regproc::regprocedure, r);
    end if;
  end loop;
end $$;

-- The guest-callable functions of each app (host-only ones already need the host's key).
create or replace function _lock_wrap_all() returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare w text[];
begin
  foreach w slice 1 in array array[
    ['rsvp', 'rsvp_get'], ['rsvp', 'rsvp_respond'], ['rsvp', 'rsvp_post'], ['rsvp', 'rsvp_delete_post'],
    ['rsvp', 'rsvp_item_add'], ['rsvp', 'rsvp_item_edit'], ['rsvp', 'rsvp_item_remove'], ['rsvp', 'rsvp_item_claim'],
    ['poll', 'poll_get'], ['poll', 'poll_vote'], ['poll', 'poll_add_option'], ['poll', 'poll_edit_option'],
    ['poll', 'poll_remove_option'],
    ['wdw', 'wdw_get'], ['wdw', 'get_event'], ['wdw', 'save_response'], ['wdw', 'delete_response']
  ] loop
    perform _lock_wrap(w[1], w[2]);
  end loop;
end $$;

select _lock_wrap_all();

revoke all on function _lock_code(text), _lock_gate(text, text, text), _lock_is_owner(text, text, text),
  _lock_wrap(text, text), _lock_wrap_all(), lock_open(text, text, text), lock_owner(text, text, text),
  lock_set(text, text, text, text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function lock_open(text, text, text), lock_owner(text, text, text), '
                  || 'lock_set(text, text, text, text) to %I', r);
    end if;
  end loop;
end $$;
