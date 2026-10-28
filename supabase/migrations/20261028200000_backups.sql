-- Backup & restore (/backup/, backup.js). Safe to re-run.
--
-- A phone that makes a backup key (six words) keeps an encrypted copy of its Pebbly data here and
-- updates it when the data changes. Both the row's id and the encryption key are worked out from the
-- six words on the phone (PBKDF2); the words never leave the phone and the database only ever sees
-- the id and ciphertext, so it can't read a backup. Whoever has the words can read, replace or
-- delete it. Phones sharing one key merge into the same copy; `version` stops two saves at once
-- overwriting each other (the second gets 'backup_conflict', merges and tries again).

create table if not exists backups (
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),
  blob       text not null,
  version    int  not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table backups enable row level security;
revoke all on backups from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on backups from %I', r); end if;
  end loop;
end $$;

-- {"blob", "version"} or null.
create or replace function backup_get(p_id text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('blob', blob, 'version', version) from backups where id = p_id;
$$;

-- Saves a new copy. p_version: the version this phone last read (0 for a new backup). Returns the new version.
create or replace function backup_put(p_id text, p_blob text, p_version int) returns int
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v int;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_backup'; end if;
  if coalesce(p_blob, '') !~ '^[A-Za-z0-9+/=]+$' or char_length(p_blob) > 400000 then raise exception 'backup_too_big'; end if;
  -- tidy up backups nobody has touched for two years
  delete from backups where updated_at < now() - interval '2 years';
  if coalesce(p_version, 0) = 0 then
    insert into backups (id, blob) values (p_id, p_blob) on conflict (id) do nothing;
    if not found then raise exception 'backup_conflict'; end if;
    return 1;
  end if;
  update backups set blob = p_blob, version = version + 1, updated_at = now()
   where id = p_id and version = p_version returning version into v;
  if v is null then raise exception 'backup_conflict'; end if;
  return v;
end $$;

create or replace function backup_delete(p_id text) returns void
language sql volatile security definer set search_path = public, pg_temp as $$
  delete from backups where id = p_id;
$$;

revoke all on function backup_get(text), backup_put(text, text, int), backup_delete(text) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function backup_get(text), backup_put(text, text, int), backup_delete(text) to %I', r);
    end if;
  end loop;
end $$;
