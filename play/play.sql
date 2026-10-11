-- Pebbly: play together. Run once in the Supabase SQL Editor. Safe to re-run.
--
-- Lets a game (Qwixx, Farkle, Score Keeper, Darts, Name Game) be shared between phones.
-- The host gets a short code; others join with it. Each game is one JSON document with a
-- version number: a phone sends its change along with the version it started from, and if
-- someone else got there first it gets the latest copy back to merge with and try again.
-- Every phone that joins gets a private key (stored hashed) that lets it save changes.
-- Games nobody has touched for 3 days are deleted automatically.

create table if not exists play_games (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  kind       text not null,
  state      jsonb not null default '{}'::jsonb,
  version    int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists play_members (
  game_id   uuid not null references play_games(id) on delete cascade,
  member_id text not null,
  name      text not null,
  key_hash  text not null,
  joined_at timestamptz not null default now(),
  primary key (game_id, member_id)
);

alter table play_games   enable row level security;
alter table play_members enable row level security;
revoke all on play_games, play_members from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on play_games, play_members from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on play_games, play_members from authenticated'; end if;
end $$;

-- ------------------------------------------------------------------ helpers

create or replace function _play_hash(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex');
$$;

create or replace function _play_token() returns text
language sql volatile set search_path = public, pg_temp as $$
  select encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex');
$$;

-- 5 characters, no look-alikes (no 0/O, 1/I/L).
create or replace function _play_new_code() returns text
language plpgsql volatile set search_path = public, pg_temp as $$
declare a constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; c text; b bytea; i int;
begin
  loop
    b := uuid_send(gen_random_uuid()); c := '';
    for i in 0..4 loop c := c || substr(a, (get_byte(b, i) % length(a)) + 1, 1); end loop;
    exit when not exists (select 1 from play_games where code = c);
  end loop;
  return c;
end $$;

create or replace function _play_check(p_kind text, p_member text, p_name text, p_state jsonb) returns void
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_kind is not null and p_kind not in ('qwixx', 'farkle', 'score', 'darts', 'namegame') then raise exception 'invalid_kind'; end if;
  if p_member is not null and p_member !~ '^[A-Za-z0-9_-]{4,40}$' then raise exception 'invalid_member'; end if;
  if p_name is not null and char_length(btrim(p_name)) not between 1 and 40 then raise exception 'invalid_name'; end if;
  if p_state is not null and (jsonb_typeof(p_state) <> 'object' or octet_length(p_state::text) > 300000) then raise exception 'invalid_state'; end if;
end $$;

create or replace function _play_members(p_game uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', member_id, 'name', name) order by joined_at), '[]'::jsonb)
    from play_members where game_id = p_game;
$$;

-- --------------------------------------------------------------- functions

-- Host starts a shared game. Returns the code and the host's private key.
create or replace function play_create(p_kind text, p_member text, p_name text, p_state jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_code text := _play_new_code(); v_token text := _play_token();
begin
  perform _play_check(p_kind, p_member, p_name, p_state);
  delete from play_games where updated_at < now() - interval '3 days';
  insert into play_games (code, kind, state) values (v_code, p_kind, p_state) returning id into v_id;
  insert into play_members (game_id, member_id, name, key_hash) values (v_id, p_member, btrim(p_name), _play_hash(v_token));
  return jsonb_build_object('code', v_code, 'token', v_token, 'version', 1);
end $$;

-- Join with a code. Joining as an existing member id (e.g. the same person on a new phone)
-- takes that seat over with a new key.
create or replace function play_join(p_code text, p_member text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g play_games%rowtype; v_token text := _play_token();
begin
  perform _play_check(null, p_member, p_name, null);
  select * into g from play_games where code = upper(btrim(coalesce(p_code, '')));
  if not found then raise exception 'game_not_found'; end if;
  if not exists (select 1 from play_members where game_id = g.id and member_id = p_member)
     and (select count(*) from play_members where game_id = g.id) >= 30 then raise exception 'game_full'; end if;
  insert into play_members (game_id, member_id, name, key_hash) values (g.id, p_member, btrim(p_name), _play_hash(v_token))
  on conflict (game_id, member_id) do update set name = excluded.name, key_hash = excluded.key_hash;
  update play_games set updated_at = now() where id = g.id;
  return jsonb_build_object('token', v_token, 'kind', g.kind, 'version', g.version, 'state', g.state, 'members', _play_members(g.id));
end $$;

-- Latest copy of the game. With p_since, the state is left out if nothing changed.
create or replace function play_get(p_code text, p_since int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g play_games%rowtype;
begin
  select * into g from play_games where code = upper(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  return jsonb_build_object('kind', g.kind, 'version', g.version, 'members', _play_members(g.id))
      || case when g.version > coalesce(p_since, 0) then jsonb_build_object('state', g.state) else '{}'::jsonb end;
end $$;

-- Save a change. If the game moved on since p_expected, nothing is saved and the latest
-- copy comes back as {conflict: true, version, state} so the phone can merge and retry.
create or replace function play_push(p_code text, p_member text, p_token text, p_expected int, p_state jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g play_games%rowtype;
begin
  perform _play_check(null, null, null, p_state);
  select * into g from play_games where code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found then raise exception 'game_not_found'; end if;
  if not exists (select 1 from play_members where game_id = g.id and member_id = p_member and key_hash = _play_hash(p_token)) then
    raise exception 'not_member';
  end if;
  if g.version <> p_expected then
    return jsonb_build_object('conflict', true, 'version', g.version, 'state', g.state);
  end if;
  update play_games set state = p_state, version = version + 1, updated_at = now() where id = g.id;
  return jsonb_build_object('version', g.version + 1);
end $$;

-- Leave a game (frees the seat; the player stays in the game for the others).
create or replace function play_leave(p_code text, p_member text, p_token text)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  delete from play_members m using play_games g
   where g.id = m.game_id and g.code = upper(btrim(coalesce(p_code, '')))
     and m.member_id = p_member and m.key_hash = _play_hash(p_token);
end $$;

-- ------------------------------------------------------------------ grants

revoke all on function _play_hash(text), _play_token(), _play_new_code(), _play_check(text, text, text, jsonb), _play_members(uuid) from public;
revoke all on function play_create(text, text, text, jsonb), play_join(text, text, text), play_get(text, int),
  play_push(text, text, text, int, jsonb), play_leave(text, text, text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _play_hash(text), _play_token(), _play_new_code(), _play_check(text, text, text, jsonb), _play_members(uuid) from %I', r);
      execute format('grant execute on function play_create(text, text, text, jsonb), play_join(text, text, text), play_get(text, int),
        play_push(text, text, text, int, jsonb), play_leave(text, text, text) to %I', r);
    end if;
  end loop;
end $$;
