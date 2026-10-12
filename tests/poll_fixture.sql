-- Test-only stand-in for the live Poll functions (the real ones were never saved to this repo).
-- Same names, arguments and errors as the page uses (p_options is jsonb here because the psql bridge
-- passes arrays as JSON); options and votes are kept simple (no names).
-- Load after tests/wdw_fixture.sql (roles). Never run this in Supabase.
create table if not exists polls (code text primary key, owner_hash text not null, name text not null,
  description text not null default '', allow_down boolean, anonymous boolean, allow_custom boolean, single_vote boolean,
  winner_option_id uuid, winner_method text);
create table if not exists poll_options (id uuid primary key default gen_random_uuid(),
  code text not null references polls on delete cascade, label text not null, by_owner boolean not null default false);
create table if not exists poll_votes (option_id uuid references poll_options on delete cascade, pid text, value int,
  primary key (option_id, pid));
alter table polls enable row level security; alter table poll_options enable row level security; alter table poll_votes enable row level security;

create or replace function poll_create(p_name text, p_description text, p_allow_down boolean, p_anonymous boolean,
  p_allow_custom boolean, p_options jsonb, p_single_vote boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c text := substr(md5(random()::text), 1, 8); t text := md5(random()::text) || md5(random()::text); l text;
begin
  insert into polls values (c, encode(sha256(t::bytea), 'hex'), p_name, coalesce(p_description, ''), p_allow_down, p_anonymous,
    p_allow_custom, p_single_vote);
  for l in select jsonb_array_elements_text(coalesce(p_options, '[]')) loop insert into poll_options (code, label, by_owner) values (c, l, true); end loop;
  return jsonb_build_object('code', c, 'owner_token', t);
end $$;

create or replace function poll_get(p_code text, p_participant text, p_owner_token text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p polls%rowtype;
begin
  select * into p from polls where code = lower(btrim(p_code));
  if not found then return null; end if;
  return jsonb_build_object('poll', jsonb_build_object('code', p.code, 'name', p.name, 'description', p.description,
      'allow_down', p.allow_down, 'anonymous', p.anonymous, 'allow_custom', p.allow_custom, 'single_vote', p.single_vote,
      'winner_option_id', p.winner_option_id, 'winner_method', p.winner_method),
    'is_owner', coalesce(encode(sha256(p_owner_token::bytea), 'hex') = p.owner_hash, false), 'my_name', null,
    'options', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label, 'by_owner', o.by_owner,
        'up', (select count(*) from poll_votes v where v.option_id = o.id and v.value = 1),
        'down', (select count(*) from poll_votes v where v.option_id = o.id and v.value = -1),
        'mine', coalesce((select v.value from poll_votes v where v.option_id = o.id and v.pid = p_participant), 0),
        'mine_added', false, 'added_by', null, 'up_names', '[]'::jsonb, 'down_names', '[]'::jsonb))
      from poll_options o where o.code = p.code), '[]'::jsonb));
end $$;

create or replace function poll_delete(p_code text, p_owner_token text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from polls where code = lower(btrim(p_code))) then raise exception 'poll_not_found'; end if;
  delete from polls where code = lower(btrim(p_code)) and owner_hash = encode(sha256(coalesce(p_owner_token, '')::bytea), 'hex');
  if not found then raise exception 'not_owner'; end if;
end $$;

create or replace function poll_vote(p_code text, p_participant text, p_name text, p_option uuid, p_value int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from poll_options where id = p_option and code = lower(btrim(p_code))) then raise exception 'option_not_found'; end if;
  delete from poll_votes where option_id = p_option and pid = p_participant;
  if p_value <> 0 then insert into poll_votes values (p_option, p_participant, p_value); end if;
end $$;

create or replace function poll_add_option(p_code text, p_participant text, p_name text, p_owner_token text, p_label text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin insert into poll_options (code, label) values (lower(btrim(p_code)), p_label); end $$;

create or replace function poll_edit_option(p_code text, p_participant text, p_owner_token text, p_option uuid, p_label text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin update poll_options set label = p_label where id = p_option; end $$;

create or replace function poll_remove_option(p_code text, p_participant text, p_owner_token text, p_option uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin delete from poll_options where id = p_option; end $$;

do $$ declare r text; begin
  for r in select unnest(array['anon', 'authenticated']) loop
    execute format('grant execute on function poll_create(text, text, boolean, boolean, boolean, jsonb, boolean), '
      || 'poll_get(text, text, text), poll_delete(text, text), poll_vote(text, text, text, uuid, int), '
      || 'poll_add_option(text, text, text, text, text), poll_edit_option(text, text, text, uuid, text), '
      || 'poll_remove_option(text, text, text, uuid) to %I', r);
  end loop;
end $$;

-- Admin stand-ins (shared password check via _rsvp_admin_ok, like the real ones).
create or replace function poll_admin_list(p_password text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password);
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  return jsonb_build_object('polls', coalesce((select jsonb_agg(jsonb_build_object('code', p.code, 'name', p.name, 'created_at', now(),
    'options', (select count(*) from poll_options o where o.code = p.code), 'voters', 0)) from polls p), '[]'::jsonb));
end $$;
create or replace function poll_admin_grant(p_password text, p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password); t text := md5(random()::text) || md5(random()::text);
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  update polls set owner_hash = encode(sha256(t::bytea), 'hex') where code = lower(btrim(p_code));
  return jsonb_build_object('owner_token', t);
end $$;
create or replace function poll_admin_delete(p_password text, p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_err text := _rsvp_admin_ok(p_password);
begin
  if v_err is not null then return jsonb_build_object('error', v_err); end if;
  delete from polls where code = lower(btrim(p_code));
  return jsonb_build_object('ok', true);
end $$;
do $$ declare r text; begin
  for r in select unnest(array['anon', 'authenticated']) loop
    execute format('grant execute on function poll_admin_list(text), poll_admin_grant(text, text), poll_admin_delete(text, text) to %I', r);
  end loop;
end $$;
