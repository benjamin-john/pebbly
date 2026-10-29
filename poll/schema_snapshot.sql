-- Poll: snapshot of the live Supabase setup, taken 2026-10-29 (read through the Supabase connector).
-- Poll's original setup was never saved to the repo; this is a record of its tables and functions as
-- they exist in the database. Reference only: it is not re-run in Supabase. Changes go in
-- supabase/migrations/. tests/poll_fixture.sql loads it for the test database.
-- The password wrappers (gated_poll_*) come from 20261012000000_plan_passwords.sql.

-- ------------------------------------------------------------------ tables

create table if not exists polls (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  owner_hash       text not null,
  name             text not null check (char_length(name) between 1 and 120),
  description      text not null default '' check (char_length(description) <= 2000),
  allow_down       boolean not null default false,
  anonymous        boolean not null default false,
  allow_custom     boolean not null default true,
  winner_option_id uuid,
  winner_method    text check (winner_method in ('picked', 'roulette')),
  created_at       timestamptz not null default now(),
  single_vote      boolean not null default false
);
create table if not exists poll_options (
  id             uuid primary key default gen_random_uuid(),
  poll_id        uuid not null references polls(id) on delete cascade,
  label          text not null check (char_length(label) between 1 and 80),
  added_by_pid   text,
  added_by_name  text,
  is_owner_added boolean not null default false,
  created_at     timestamptz not null default now()
);
create table if not exists poll_owner_keys (
  poll_id    uuid not null references polls(id) on delete cascade,
  key_hash   text not null,
  label      text not null default 'admin',
  created_at timestamptz not null default now(),
  primary key (poll_id, key_hash)
);
create table if not exists poll_voters (
  poll_id        uuid not null references polls(id) on delete cascade,
  participant_id text not null,
  name           text not null check (char_length(name) between 1 and 40),
  primary key (poll_id, participant_id)
);
create table if not exists poll_votes (
  option_id      uuid not null references poll_options(id) on delete cascade,
  poll_id        uuid not null references polls(id) on delete cascade,
  participant_id text not null check (char_length(participant_id) between 8 and 64),
  value          smallint not null check (value in (-1, 1)),
  updated_at     timestamptz not null default now(),
  primary key (option_id, participant_id)
);
alter table polls enable row level security;
alter table poll_options enable row level security;
alter table poll_owner_keys enable row level security;
alter table poll_voters enable row level security;
alter table poll_votes enable row level security;

-- ------------------------------------------------------------------ functions

CREATE OR REPLACE FUNCTION public._poll_hash(p_token text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$ select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex'); $function$
;

CREATE OR REPLACE FUNCTION public._poll_is_owner(p_poll_id uuid, p_owner_hash text, p_token text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_token is not null and (
    p_owner_hash = public._poll_hash(p_token)
    or exists (select 1 from public.poll_owner_keys k
                where k.poll_id = p_poll_id and k.key_hash = public._poll_hash(p_token)));
$function$
;

CREATE OR REPLACE FUNCTION public._poll_can_edit_option(p_poll polls, p_participant text, p_owner_token text, p_option uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public._poll_is_owner(p_poll.id, p_poll.owner_hash, p_owner_token)
      or exists (select 1 from public.poll_options o
                  where o.id = p_option and o.poll_id = p_poll.id
                    and o.added_by_pid is not null and o.added_by_pid = p_participant);
$function$
;

CREATE OR REPLACE FUNCTION public._poll_owner(p_code text, p_token text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;
begin
  select pl.id into v_id from public.polls pl
   where pl.code = lower(btrim(coalesce(p_code, ''))) and public._poll_is_owner(pl.id, pl.owner_hash, p_token);
  if v_id is null then raise exception 'not_owner'; end if;
  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_add_option(p_code text, p_participant text, p_name text, p_owner_token text, p_label text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  p       public.polls%rowtype;
  v_owner boolean;
  v_label text := btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g'));
begin
  select * into p from public.polls where code = lower(btrim(coalesce(p_code, '')));
  if not found then raise exception 'poll_not_found'; end if;
  v_owner := public._poll_is_owner(p.id, p.owner_hash, p_owner_token);
  if not v_owner and not p.allow_custom then raise exception 'custom_off'; end if;
  if char_length(v_label) not between 1 and 80 then raise exception 'invalid_option'; end if;
  if exists (select 1 from public.poll_options where poll_id = p.id and lower(label) = lower(v_label)) then raise exception 'duplicate_option'; end if;
  if (select count(*) from public.poll_options where poll_id = p.id) >= 40 then raise exception 'too_many_options'; end if;

  p_name := nullif(btrim(coalesce(p_name, '')), '');
  if not p.anonymous and not v_owner and p_name is null then raise exception 'invalid_name'; end if;
  if not p.anonymous and p_name is not null and p_participant is not null and char_length(p_participant) >= 8 then
    insert into public.poll_voters (poll_id, participant_id, name) values (p.id, p_participant, left(p_name, 40))
    on conflict (poll_id, participant_id) do update set name = excluded.name;
  end if;

  insert into public.poll_options (poll_id, label, added_by_pid, added_by_name, is_owner_added)
  values (p.id, v_label, p_participant, case when p.anonymous then null else left(p_name, 40) end, v_owner);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_admin_delete(p_password text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_status  text := public._admin_check(p_password);
  v_deleted int;
begin
  if v_status <> 'ok' then
    return jsonb_build_object('error', v_status);
  end if;

  delete from public.polls where code = lower(btrim(coalesce(p_code, '')));
  get diagnostics v_deleted = row_count;      -- options and votes go with it
  return jsonb_build_object('deleted', v_deleted);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_admin_grant(p_password text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_status text := public._admin_check(p_password);
  v_id     uuid;
  v_token  text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if v_status <> 'ok' then
    return jsonb_build_object('error', v_status);
  end if;

  select id into v_id from public.polls where code = lower(btrim(coalesce(p_code, '')));
  if v_id is null then
    return jsonb_build_object('error', 'poll_not_found');
  end if;

  delete from public.poll_owner_keys where poll_id = v_id and label = 'admin';   -- one admin key per poll
  insert into public.poll_owner_keys (poll_id, key_hash, label) values (v_id, public._poll_hash(v_token), 'admin');
  return jsonb_build_object('owner_token', v_token);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_admin_list(p_password text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_status text := public._admin_check(p_password);
begin
  if v_status <> 'ok' then
    return jsonb_build_object('error', v_status);
  end if;

  return jsonb_build_object('polls', coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'code', p.code,
               'name', p.name,
               'description', p.description,
               'allow_down', p.allow_down,
               'anonymous', p.anonymous,
               'allow_custom', p.allow_custom,
               'single_vote', p.single_vote,
               'created_at', p.created_at,
               'options', (select count(*) from public.poll_options o where o.poll_id = p.id),
               'voters',  (select count(distinct v.participant_id) from public.poll_votes v where v.poll_id = p.id),
               'last_vote', (select max(v.updated_at) from public.poll_votes v where v.poll_id = p.id),
               'winner', (select o.label from public.poll_options o where o.id = p.winner_option_id)
             )
             order by p.created_at desc
           )
    from public.polls p
  ), '[]'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_create(p_name text, p_description text DEFAULT ''::text, p_allow_down boolean DEFAULT false, p_anonymous boolean DEFAULT false, p_allow_custom boolean DEFAULT true, p_options text[] DEFAULT '{}'::text[], p_single_vote boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  v_code  text;
  v_bytes bytea;
  v_try   int := 0;
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_id    uuid;
  v_label text;
  v_n     int := 0;
  i       int;
begin
  p_name        := btrim(coalesce(p_name, ''));
  p_description := btrim(coalesce(p_description, ''));
  if char_length(p_name) not between 1 and 120 then raise exception 'invalid_name'; end if;
  if char_length(p_description) > 2000          then raise exception 'invalid_description'; end if;

  loop
    v_try   := v_try + 1;
    v_bytes := uuid_send(gen_random_uuid());
    v_code  := '';
    for i in 0..7 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
    end loop;
    begin
      insert into public.polls (code, owner_hash, name, description, allow_down, anonymous, allow_custom, single_vote)
      values (v_code, public._poll_hash(v_token), p_name, p_description,
              coalesce(p_allow_down, false) and not coalesce(p_single_vote, false),   -- one vote each means no down votes
              coalesce(p_anonymous, false), coalesce(p_allow_custom, true), coalesce(p_single_vote, false))
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_try >= 8 then raise; end if;
    end;
  end loop;

  foreach v_label in array coalesce(p_options, '{}') loop
    v_label := btrim(regexp_replace(coalesce(v_label, ''), '\s+', ' ', 'g'));
    continue when v_label = '';
    if char_length(v_label) > 80 then raise exception 'invalid_option'; end if;
    continue when exists (select 1 from public.poll_options where poll_id = v_id and lower(label) = lower(v_label));
    v_n := v_n + 1;
    if v_n > 40 then raise exception 'too_many_options'; end if;
    insert into public.poll_options (poll_id, label, is_owner_added) values (v_id, v_label, true);
  end loop;

  return jsonb_build_object('code', v_code, 'owner_token', v_token);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_delete(p_code text, p_owner_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid := public._poll_owner(p_code, p_owner_token);
begin
  delete from public.polls where id = v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_edit_option(p_code text, p_participant text, p_owner_token text, p_option uuid, p_label text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  p       public.polls%rowtype;
  v_label text := btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g'));
begin
  select * into p from public.polls where code = lower(btrim(coalesce(p_code, '')));
  if not found then raise exception 'poll_not_found'; end if;
  if not exists (select 1 from public.poll_options where id = p_option and poll_id = p.id) then raise exception 'option_not_found'; end if;
  if not public._poll_can_edit_option(p, p_participant, p_owner_token, p_option) then raise exception 'not_allowed'; end if;
  if char_length(v_label) not between 1 and 80 then raise exception 'invalid_option'; end if;
  if exists (select 1 from public.poll_options where poll_id = p.id and id <> p_option and lower(label) = lower(v_label)) then raise exception 'duplicate_option'; end if;
  update public.poll_options set label = v_label where id = p_option and poll_id = p.id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_get(p_code text, p_participant text DEFAULT NULL::text, p_owner_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  p       public.polls%rowtype;
  v_owner boolean;
  v_name  text;
begin
  select * into p from public.polls where code = lower(btrim(coalesce(p_code, '')));
  if not found then return null; end if;

  v_owner := public._poll_is_owner(p.id, p.owner_hash, p_owner_token);
  select name into v_name from public.poll_voters where poll_id = p.id and participant_id = p_participant;

  return jsonb_build_object(
    'poll', jsonb_build_object(
      'code', p.code, 'name', p.name, 'description', p.description,
      'allow_down', p.allow_down, 'anonymous', p.anonymous, 'allow_custom', p.allow_custom,
      'single_vote', p.single_vote,
      'winner_option_id', p.winner_option_id, 'winner_method', p.winner_method),
    'is_owner', v_owner,
    'my_name', v_name,
    'options', coalesce((
      select jsonb_agg(o_row order by o_row_created)
      from (
        select o.created_at as o_row_created,
          jsonb_build_object(
            'id', o.id,
            'label', o.label,
            'up',   (select count(*) from public.poll_votes v where v.option_id = o.id and v.value = 1),
            'down', (select count(*) from public.poll_votes v where v.option_id = o.id and v.value = -1),
            'mine', coalesce((select v.value from public.poll_votes v
                               where v.option_id = o.id and v.participant_id = p_participant), 0),
            'by_owner', o.is_owner_added,
            'mine_added', coalesce(o.added_by_pid = p_participant, false),
            'added_by', case when p.anonymous then null else o.added_by_name end,
            'up_names',   case when p.anonymous then '[]'::jsonb else coalesce((
                select jsonb_agg(vr.name order by vr.name) from public.poll_votes v
                  join public.poll_voters vr on vr.poll_id = v.poll_id and vr.participant_id = v.participant_id
                 where v.option_id = o.id and v.value = 1), '[]'::jsonb) end,
            'down_names', case when p.anonymous then '[]'::jsonb else coalesce((
                select jsonb_agg(vr.name order by vr.name) from public.poll_votes v
                  join public.poll_voters vr on vr.poll_id = v.poll_id and vr.participant_id = v.participant_id
                 where v.option_id = o.id and v.value = -1), '[]'::jsonb) end
          ) as o_row
        from public.poll_options o where o.poll_id = p.id
      ) q
    ), '[]'::jsonb)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_remove_option(p_code text, p_participant text, p_owner_token text, p_option uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p public.polls%rowtype;
begin
  select * into p from public.polls where code = lower(btrim(coalesce(p_code, '')));
  if not found then raise exception 'poll_not_found'; end if;
  if not public._poll_can_edit_option(p, p_participant, p_owner_token, p_option) then raise exception 'not_allowed'; end if;
  update public.polls set winner_option_id = null, winner_method = null
   where id = p.id and winner_option_id = p_option;
  delete from public.poll_options where id = p_option and poll_id = p.id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_set_winner(p_code text, p_owner_token text, p_option uuid, p_method text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid := public._poll_owner(p_code, p_owner_token);
begin
  if p_option is null then
    update public.polls set winner_option_id = null, winner_method = null where id = v_id;
    return;
  end if;
  if not exists (select 1 from public.poll_options where id = p_option and poll_id = v_id) then raise exception 'option_not_found'; end if;
  if p_method not in ('picked', 'roulette') then raise exception 'invalid_method'; end if;
  update public.polls set winner_option_id = p_option, winner_method = p_method where id = v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.poll_vote(p_code text, p_participant text, p_name text, p_option uuid, p_value integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  p public.polls%rowtype;
begin
  select * into p from public.polls where code = lower(btrim(coalesce(p_code, '')));
  if not found then raise exception 'poll_not_found'; end if;
  if p_participant is null or char_length(p_participant) not between 8 and 64 then raise exception 'invalid_participant'; end if;
  if p_value not in (-1, 0, 1) then raise exception 'invalid_vote'; end if;
  if p_value = -1 and not p.allow_down then raise exception 'downvotes_off'; end if;
  if not exists (select 1 from public.poll_options where id = p_option and poll_id = p.id) then raise exception 'option_not_found'; end if;

  if not p.anonymous then
    p_name := btrim(coalesce(p_name, ''));
    if char_length(p_name) not between 1 and 40 then raise exception 'invalid_name'; end if;
    insert into public.poll_voters (poll_id, participant_id, name) values (p.id, p_participant, p_name)
    on conflict (poll_id, participant_id) do update set name = excluded.name;
  end if;

  if p_value = 0 then
    delete from public.poll_votes where option_id = p_option and participant_id = p_participant;
    return;
  end if;

  -- One vote per person: voting for a choice moves the person's vote there.
  if p.single_vote then
    delete from public.poll_votes where poll_id = p.id and participant_id = p_participant and option_id <> p_option;
  end if;

  if not exists (select 1 from public.poll_votes where poll_id = p.id and participant_id = p_participant)
     and (select count(distinct participant_id) from public.poll_votes where poll_id = p.id) >= 300 then
    raise exception 'poll_full';
  end if;

  insert into public.poll_votes (option_id, poll_id, participant_id, value)
  values (p_option, p.id, p_participant, p_value)
  on conflict (option_id, participant_id) do update set value = excluded.value, updated_at = now();
end;
$function$
;
