-- Test-only stand-in for the live Which Day Works? tables and the shared admin check (password "secret").
-- Load before whichdayworks/schema_snapshot.sql when testing SQL locally. Never run this in Supabase.
do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$;
create table events (id uuid primary key default gen_random_uuid(), code text unique not null, name text not null,
  description text not null default '', num_days int not null default 1, earliest date, latest date, created_at timestamptz not null default now());
create table responses (id uuid primary key default gen_random_uuid(), event_id uuid not null references events(id) on delete cascade,
  participant_id text not null, name text not null, note text not null default '', picks jsonb not null default '{}', updated_at timestamptz not null default now(),
  unique (event_id, participant_id));
create table admin_attempts (id bigserial primary key, at timestamptz default now());
create function _admin_check(p_password text) returns text language plpgsql security definer as $$
begin if p_password = 'secret' then return 'ok'; end if; insert into admin_attempts default values; return 'wrong_password'; end $$;
