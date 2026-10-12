-- Backends for the new apps. Safe to re-run.
--
--  * Shared documents (Split the Bill, Sign-up Sheet, Shared List): one JSON document per link with a
--    version number, like "play together" but kept for a year after the last change and with a host
--    key. Anyone with the link can edit; the pages decide who sees which buttons. A push with an old
--    version gets the latest copy back to merge with (doc.js does that).
--  * Secret Santa: names, exclusions and the draw live in the database, and each phone only ever
--    sees its own match. Not even the organizer can see who has whom.
--  * "Play together" gains two kinds: trivia and bracket.
--  * Passwords (see 20261012000000_plan_passwords.sql) cover the new apps too.

-- ------------------------------------------------------------ play together kinds

create or replace function _play_check(p_kind text, p_member text, p_name text, p_state jsonb) returns void
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_kind is not null and p_kind not in ('qwixx', 'farkle', 'score', 'darts', 'namegame', 'trivia', 'bracket') then raise exception 'invalid_kind'; end if;
  if p_member is not null and p_member !~ '^[A-Za-z0-9_-]{4,40}$' then raise exception 'invalid_member'; end if;
  if p_name is not null and char_length(btrim(p_name)) not between 1 and 40 then raise exception 'invalid_name'; end if;
  if p_state is not null and (jsonb_typeof(p_state) <> 'object' or octet_length(p_state::text) > 300000) then raise exception 'invalid_state'; end if;
end $$;

-- ------------------------------------------------------------ shared helpers

create or replace function _app_hash(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex');
$$;

create or replace function _app_token() returns text
language sql volatile set search_path = public, pg_temp as $$
  select encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex');
$$;

-- 8 characters, lowercase letters and digits without look-alikes.
create or replace function _app_code() returns text
language plpgsql volatile set search_path = public, pg_temp as $$
declare a constant text := 'abcdefghjkmnpqrstuvwxyz23456789'; c text; b bytea; i int;
begin
  b := uuid_send(gen_random_uuid()); c := '';
  for i in 0..7 loop c := c || substr(a, (get_byte(b, i) % length(a)) + 1, 1); end loop;
  return c;
end $$;

create or replace function _app_text(p text, p_max int) returns text
language sql immutable set search_path = public, pg_temp as $$
  select left(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), p_max);
$$;

-- ------------------------------------------------------------ shared documents

create table if not exists plan_docs (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  kind       text not null check (kind in ('bill', 'signup', 'list')),
  owner_hash text not null,
  state      jsonb not null,
  version    int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table plan_docs enable row level security;
revoke all on plan_docs from public;

create or replace function _doc_check(p_state jsonb) returns void
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object' or octet_length(p_state::text) > 300000 then
    raise exception 'invalid_state';
  end if;
end $$;

-- Start a document. Returns its code and the host's key.
create or replace function doc_create(p_kind text, p_state jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_code text; v_token text := _app_token();
begin
  if p_kind not in ('bill', 'signup', 'list') then raise exception 'invalid_kind'; end if;
  perform _doc_check(p_state);
  delete from plan_docs where updated_at < now() - interval '400 days';
  loop
    v_code := _app_code();
    exit when not exists (select 1 from plan_docs where code = v_code);
  end loop;
  insert into plan_docs (code, kind, owner_hash, state) values (v_code, p_kind, _app_hash(v_token), p_state);
  return jsonb_build_object('code', v_code, 'owner_token', v_token, 'version', 1);
end $$;

-- Read a document. null if there's no such code. "state" is left out when p_since is already current.
create or replace function doc_get(p_code text, p_owner_token text default null, p_since int default 0) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d plan_docs%rowtype;
begin
  select * into d from plan_docs where code = lower(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  return jsonb_strip_nulls(jsonb_build_object('code', d.code, 'kind', d.kind, 'version', d.version,
    'is_owner', coalesce(p_owner_token, '') <> '' and _app_hash(p_owner_token) = d.owner_hash,
    'updated_at', d.updated_at, 'state', case when d.version <> coalesce(p_since, 0) then d.state end));
end $$;

-- Save a new copy made from version p_expected. If someone saved first, nothing is written and the
-- latest copy comes back ({"ok": false, "version", "state"}) to merge with.
create or replace function doc_push(p_code text, p_expected int, p_state jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d plan_docs%rowtype;
begin
  perform _doc_check(p_state);
  select * into d from plan_docs where code = lower(btrim(coalesce(p_code, ''))) for update;
  if not found then raise exception 'doc_not_found'; end if;
  if d.version <> p_expected then
    return jsonb_build_object('ok', false, 'version', d.version, 'state', d.state);
  end if;
  update plan_docs set state = p_state, version = d.version + 1, updated_at = now() where id = d.id;
  return jsonb_build_object('ok', true, 'version', d.version + 1);
end $$;

create or replace function doc_delete(p_code text, p_owner_token text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  delete from plan_docs where code = lower(btrim(coalesce(p_code, ''))) and owner_hash = _app_hash(p_owner_token);
  if not found then
    if exists (select 1 from plan_docs where code = lower(btrim(coalesce(p_code, '')))) then raise exception 'not_owner'; end if;
    raise exception 'doc_not_found';
  end if;
end $$;

-- ------------------------------------------------------------ secret santa

create table if not exists santa_groups (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  owner_hash text not null,
  name       text not null,
  budget     text not null default '',
  swap_date  date,
  note       text not null default '',
  self_join  boolean not null default true,
  drawn_at   timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists santa_people (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references santa_groups(id) on delete cascade,
  name       text not null,
  wish       text not null default '',
  claim_hash text,                       -- the phone that said "this is me"
  added_at   timestamptz not null default now()
);
create table if not exists santa_exclusions (
  group_id uuid not null references santa_groups(id) on delete cascade,
  a        uuid not null references santa_people(id) on delete cascade,
  b        uuid not null references santa_people(id) on delete cascade,
  primary key (group_id, a, b)
);
create table if not exists santa_pairs (
  group_id uuid not null references santa_groups(id) on delete cascade,
  giver    uuid not null references santa_people(id) on delete cascade,
  receiver uuid not null references santa_people(id) on delete cascade,
  primary key (group_id, giver)
);
alter table santa_groups enable row level security;
alter table santa_people enable row level security;
alter table santa_exclusions enable row level security;
alter table santa_pairs enable row level security;
revoke all on santa_groups, santa_people, santa_exclusions, santa_pairs from public;

do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on plan_docs, santa_groups, santa_people, santa_exclusions, santa_pairs from %I', r);
    end if;
  end loop;
end $$;

create or replace function _santa_group(p_code text, p_lock boolean default false) returns santa_groups
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype;
begin
  if p_lock then select * into g from santa_groups where code = lower(btrim(coalesce(p_code, ''))) for update;
  else select * into g from santa_groups where code = lower(btrim(coalesce(p_code, ''))); end if;
  if not found then raise exception 'group_not_found'; end if;
  return g;
end $$;

create or replace function _santa_owner(p_code text, p_owner_token text, p_lock boolean default true) returns santa_groups
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_group(p_code, p_lock);
begin
  if coalesce(p_owner_token, '') = '' or _app_hash(p_owner_token) <> g.owner_hash then raise exception 'not_owner'; end if;
  return g;
end $$;

create or replace function _santa_check_participant(p text) returns void
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if coalesce(p, '') !~ '^[A-Za-z0-9_-]{8,80}$' then raise exception 'invalid_participant'; end if;
end $$;

create or replace function _santa_add(p_group uuid, p_name text) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_name text := _app_text(p_name, 40); v_id uuid;
begin
  if v_name = '' then raise exception 'invalid_name'; end if;
  if exists (select 1 from santa_people where group_id = p_group and lower(name) = lower(v_name)) then raise exception 'name_taken'; end if;
  if (select count(*) from santa_people where group_id = p_group) >= 60 then raise exception 'too_many_people'; end if;
  insert into santa_people (group_id, name) values (p_group, v_name) returning id into v_id;
  return v_id;
end $$;

create or replace function santa_create(p_name text, p_budget text, p_swap_date date, p_note text, p_people jsonb default '[]'::jsonb,
  p_self_join boolean default true) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_code text; v_token text := _app_token(); v_id uuid; v_name text := _app_text(p_name, 80); n text;
begin
  if v_name = '' then raise exception 'invalid_title'; end if;
  if jsonb_typeof(coalesce(p_people, '[]'::jsonb)) <> 'array' then raise exception 'invalid_name'; end if;
  delete from santa_groups where updated_at < now() - interval '400 days';
  loop
    v_code := _app_code();
    exit when not exists (select 1 from santa_groups where code = v_code);
  end loop;
  insert into santa_groups (code, owner_hash, name, budget, swap_date, note, self_join)
  values (v_code, _app_hash(v_token), v_name, _app_text(p_budget, 40), p_swap_date, left(btrim(coalesce(p_note, '')), 1000), coalesce(p_self_join, true))
  returning id into v_id;
  for n in select jsonb_array_elements_text(coalesce(p_people, '[]'::jsonb)) loop
    if _app_text(n, 40) <> '' and not exists (select 1 from santa_people where group_id = v_id and lower(name) = lower(_app_text(n, 40))) then
      perform _santa_add(v_id, n);
    end if;
  end loop;
  return jsonb_build_object('code', v_code, 'owner_token', v_token);
end $$;

-- Everything this phone may see. p_participant is this phone's private id (kept in localStorage).
create or replace function santa_get(p_code text, p_participant text, p_owner_token text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype; v_owner boolean; v_me santa_people%rowtype; v_match santa_people%rowtype; v_hash text := _app_hash(p_participant);
begin
  select * into g from santa_groups where code = lower(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  v_owner := coalesce(p_owner_token, '') <> '' and _app_hash(p_owner_token) = g.owner_hash;
  if coalesce(p_participant, '') <> '' then
    select * into v_me from santa_people where group_id = g.id and claim_hash = v_hash;
  end if;
  if v_me.id is not null and g.drawn_at is not null then
    select p.* into v_match from santa_pairs s join santa_people p on p.id = s.receiver where s.group_id = g.id and s.giver = v_me.id;
  end if;
  return jsonb_build_object(
    'group', jsonb_build_object('code', g.code, 'name', g.name, 'budget', g.budget, 'swap_date', g.swap_date, 'note', g.note,
                                'self_join', g.self_join, 'drawn', g.drawn_at is not null),
    'is_owner', v_owner,
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'claimed', p.claim_hash is not null,
                                  'mine', coalesce(p.id = v_me.id, false), 'has_wish', p.wish <> '') order by lower(p.name))
                          from santa_people p where p.group_id = g.id), '[]'::jsonb),
    'exclusions', case when v_owner then coalesce((select jsonb_agg(jsonb_build_array(a, b)) from santa_exclusions where group_id = g.id), '[]'::jsonb) end,
    'me', case when v_me.id is not null then jsonb_build_object('id', v_me.id, 'name', v_me.name, 'wish', v_me.wish) end,
    'match', case when v_match.id is not null then jsonb_build_object('name', v_match.name, 'wish', v_match.wish) end);
end $$;

-- "This is me": tie a name to this phone. Fails if another phone already has it.
create or replace function santa_claim(p_code text, p_participant text, p_person uuid) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_group(p_code, true); v_hash text := _app_hash(p_participant); v_claim text;
begin
  perform _santa_check_participant(p_participant);
  select claim_hash into v_claim from santa_people where id = p_person and group_id = g.id for update;
  if not found then raise exception 'person_not_found'; end if;
  if v_claim = v_hash then return; end if;
  if v_claim is not null then raise exception 'already_claimed'; end if;
  update santa_people set claim_hash = null where group_id = g.id and claim_hash = v_hash;
  update santa_people set claim_hash = v_hash where id = p_person;
end $$;

-- "That's not me": let go of the name this phone picked (only before the draw).
create or replace function santa_unclaim(p_code text, p_participant text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_group(p_code, true);
begin
  if g.drawn_at is not null then raise exception 'already_drawn'; end if;
  update santa_people set claim_hash = null where group_id = g.id and claim_hash = _app_hash(p_participant);
end $$;

-- Add yourself (when the organizer allows it), before the draw. Claims the new name for this phone.
create or replace function santa_join(p_code text, p_participant text, p_name text) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_group(p_code, true); v_id uuid; v_hash text := _app_hash(p_participant);
begin
  perform _santa_check_participant(p_participant);
  if g.drawn_at is not null then raise exception 'already_drawn'; end if;
  if not g.self_join then raise exception 'join_closed'; end if;
  v_id := _santa_add(g.id, p_name);
  update santa_people set claim_hash = null where group_id = g.id and claim_hash = v_hash;
  update santa_people set claim_hash = v_hash where id = v_id;
  update santa_groups set updated_at = now() where id = g.id;
  return v_id;
end $$;

-- Your wish list (gift ideas, sizes, "no candles please"). Your Santa sees it.
create or replace function santa_set_wish(p_code text, p_participant text, p_wish text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_group(p_code);
begin
  if char_length(coalesce(p_wish, '')) > 1000 then raise exception 'wish_too_long'; end if;
  update santa_people set wish = btrim(coalesce(p_wish, '')) where group_id = g.id and claim_hash = _app_hash(p_participant);
  if not found then raise exception 'not_claimed'; end if;
end $$;

-- ---- organizer

create or replace function santa_update(p_code text, p_owner_token text, p_name text, p_budget text, p_swap_date date, p_note text,
  p_self_join boolean) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_owner(p_code, p_owner_token);
begin
  if _app_text(p_name, 80) = '' then raise exception 'invalid_title'; end if;
  update santa_groups set name = _app_text(p_name, 80), budget = _app_text(p_budget, 40), swap_date = p_swap_date,
    note = left(btrim(coalesce(p_note, '')), 1000), self_join = coalesce(p_self_join, true), updated_at = now() where id = g.id;
end $$;

create or replace function santa_add_person(p_code text, p_owner_token text, p_name text) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_owner(p_code, p_owner_token); v_id uuid;
begin
  if g.drawn_at is not null then raise exception 'already_drawn'; end if;
  v_id := _santa_add(g.id, p_name);
  update santa_groups set updated_at = now() where id = g.id;
  return v_id;
end $$;

create or replace function santa_remove_person(p_code text, p_owner_token text, p_person uuid) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_owner(p_code, p_owner_token);
begin
  if g.drawn_at is not null then raise exception 'already_drawn'; end if;
  delete from santa_people where id = p_person and group_id = g.id;
  if not found then raise exception 'person_not_found'; end if;
end $$;

-- Organizer: free up a name so the right person can pick it (someone tapped the wrong one).
create or replace function santa_reset_claim(p_code text, p_owner_token text, p_person uuid) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_owner(p_code, p_owner_token);
begin
  update santa_people set claim_hash = null where id = p_person and group_id = g.id;
  if not found then raise exception 'person_not_found'; end if;
end $$;

-- Pairs who shouldn't draw each other (either way), as [[id, id], ...]. Replaces the old list.
create or replace function santa_set_exclusions(p_code text, p_owner_token text, p_pairs jsonb) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_owner(p_code, p_owner_token); x jsonb; a uuid; b uuid;
begin
  if g.drawn_at is not null then raise exception 'already_drawn'; end if;
  if jsonb_typeof(coalesce(p_pairs, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_pairs, '[]'::jsonb)) > 200 then raise exception 'invalid_exclusions'; end if;
  delete from santa_exclusions where group_id = g.id;
  for x in select jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) loop
    a := (x->>0)::uuid; b := (x->>1)::uuid;
    if a = b or not exists (select 1 from santa_people where id = a and group_id = g.id)
              or not exists (select 1 from santa_people where id = b and group_id = g.id) then raise exception 'invalid_exclusions'; end if;
    insert into santa_exclusions (group_id, a, b) values (g.id, least(a, b), greatest(a, b)) on conflict do nothing;
  end loop;
end $$;

-- The draw. Prefers one big loop (A→B→C→…→A, so no two people simply swap gifts); falls back to
-- any arrangement that respects the exclusions. Nobody gets themselves.
create or replace function santa_draw(p_code text, p_owner_token text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_owner(p_code, p_owner_token);
  ids uuid[]; perm uuid[]; n int; tries int := 0; ok boolean; i int;
begin
  if g.drawn_at is not null then raise exception 'already_drawn'; end if;
  select array_agg(id) into ids from santa_people where group_id = g.id;
  n := coalesce(array_length(ids, 1), 0);
  if n < 3 then raise exception 'need_three'; end if;
  loop
    tries := tries + 1;
    if tries > 4000 then raise exception 'no_valid_draw'; end if;
    select array_agg(x order by random()) into ids from unnest(ids) x;
    if tries <= 2000 then
      perm := ids[2:n] || ids[1];                                   -- one loop through everyone
    else
      select array_agg(x order by random()) into perm from unnest(ids) x;   -- any arrangement
    end if;
    ok := true;
    for i in 1..n loop
      if ids[i] = perm[i] or exists (select 1 from santa_exclusions e where e.group_id = g.id
            and e.a = least(ids[i], perm[i]) and e.b = greatest(ids[i], perm[i])) then ok := false; exit; end if;
    end loop;
    exit when ok;
  end loop;
  delete from santa_pairs where group_id = g.id;
  for i in 1..n loop insert into santa_pairs (group_id, giver, receiver) values (g.id, ids[i], perm[i]); end loop;
  update santa_groups set drawn_at = now(), updated_at = now() where id = g.id;
end $$;

-- Undo the draw (to add someone or fix exclusions). Everyone's match is thrown away.
create or replace function santa_undraw(p_code text, p_owner_token text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_owner(p_code, p_owner_token);
begin
  delete from santa_pairs where group_id = g.id;
  update santa_groups set drawn_at = null, updated_at = now() where id = g.id;
end $$;

create or replace function santa_delete(p_code text, p_owner_token text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g santa_groups%rowtype := _santa_owner(p_code, p_owner_token);
begin
  delete from santa_groups where id = g.id;
end $$;

-- ------------------------------------------------------------ passwords for the new apps

alter table plan_locks drop constraint if exists plan_locks_app_check;
alter table plan_locks add constraint plan_locks_app_check check (app in ('rsvp', 'poll', 'wdw', 'doc', 'santa'));

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
  elsif p_app = 'doc' then
    return exists (select 1 from plan_docs where code = _lock_code(p_code) and owner_hash = _app_hash(p_token));
  elsif p_app = 'santa' then
    return exists (select 1 from santa_groups where code = _lock_code(p_code) and owner_hash = _app_hash(p_token));
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
    ['santa', 'santa_get'], ['santa', 'santa_claim'], ['santa', 'santa_unclaim'], ['santa', 'santa_join'], ['santa', 'santa_set_wish']
  ] loop
    perform _lock_wrap(w[1], w[2]);
  end loop;
end $$;

-- ------------------------------------------------------------ grants

revoke all on function _app_hash(text), _app_token(), _app_code(), _app_text(text, int), _doc_check(jsonb),
  _santa_group(text, boolean), _santa_owner(text, text, boolean), _santa_check_participant(text), _santa_add(uuid, text)
  from public;
revoke all on function doc_create(text, jsonb), doc_get(text, text, int), doc_push(text, int, jsonb), doc_delete(text, text),
  santa_create(text, text, date, text, jsonb, boolean), santa_get(text, text, text), santa_claim(text, text, uuid),
  santa_unclaim(text, text), santa_join(text, text, text), santa_set_wish(text, text, text),
  santa_update(text, text, text, text, date, text, boolean), santa_add_person(text, text, text),
  santa_remove_person(text, text, uuid), santa_reset_claim(text, text, uuid), santa_set_exclusions(text, text, jsonb),
  santa_draw(text, text), santa_undraw(text, text), santa_delete(text, text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      -- Host-only functions are granted directly; guest ones are reached through their gated_ wrappers.
      execute format('grant execute on function doc_create(text, jsonb), doc_delete(text, text), '
        || 'santa_create(text, text, date, text, jsonb, boolean), santa_update(text, text, text, text, date, text, boolean), '
        || 'santa_add_person(text, text, text), santa_remove_person(text, text, uuid), santa_reset_claim(text, text, uuid), '
        || 'santa_set_exclusions(text, text, jsonb), santa_draw(text, text), santa_undraw(text, text), santa_delete(text, text) to %I', r);
    end if;
  end loop;
end $$;

select _lock_wrap_all();
