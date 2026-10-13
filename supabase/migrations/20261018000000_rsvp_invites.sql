-- RSVP: the host's invite list (host-only). Safe to re-run.
-- The host picks people from their phone's contacts (or types them in). The page matches RSVPs to
-- invites by phone number (any of the invite's numbers) or by a link the host confirmed (guest_id),
-- so the host can see who hasn't replied and text them a reminder. Guests never see this list.

create table if not exists rsvp_invites (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references rsvp_events(id) on delete cascade,
  name       text not null,
  phones     text[] not null default '{}',   -- normalized like rsvp_guests.phone; the first one gets texts
  guest_id   uuid references rsvp_guests(id) on delete set null, -- host confirmed "this RSVP is them"
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists rsvp_invites_event on rsvp_invites(event_id);
alter table rsvp_invites enable row level security;
revoke all on rsvp_invites from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on rsvp_invites from %I', r); end if;
  end loop;
end $$;

create or replace function _rsvp_owned_event(p_code text, p_owner_token text) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  select id into v_id from rsvp_events where code = lower(btrim(coalesce(p_code, '')));
  if v_id is null then raise exception 'event_not_found'; end if;
  if not _rsvp_is_owner(v_id, p_owner_token) then raise exception 'not_owner'; end if;
  return v_id;
end $$;

create or replace function rsvp_invites(p_code text, p_owner_token text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_id uuid := _rsvp_owned_event(p_code, p_owner_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'phones', to_jsonb(i.phones),
      'guest_id', i.guest_id, 'created_at', i.created_at) order by i.created_at, i.id)
    from rsvp_invites i where i.event_id = v_id), '[]'::jsonb);
end $$;

-- p_people: [{"name": "Amy Lee", "phones": ["(612) 555-0123", ...]}, ...]. People already on the list
-- (a shared number, or the same name when neither has a number) are skipped. Adding anyone with a
-- number turns on "Require a phone number" so their RSVP can be matched.
create or replace function rsvp_invite_add(p_code text, p_owner_token text, p_people jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := _rsvp_owned_event(p_code, p_owner_token);
  p jsonb; t jsonb; v_name text; v_ph text; v_phones text[];
  v_added int := 0; v_skipped int := 0; v_any_phone boolean := false;
begin
  if jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) > 500 then raise exception 'invalid_invites'; end if;
  for p in select * from jsonb_array_elements(p_people) loop
    v_name := left(_rsvp_clean(p->>'name'), 80);
    v_phones := '{}';
    if jsonb_typeof(p->'phones') = 'array' then
      for t in select * from jsonb_array_elements(p->'phones') loop
        v_ph := _rsvp_phone(t #>> '{}');
        continue when length(regexp_replace(v_ph, '\D', '', 'g')) not between 7 and 15 or v_ph = any(v_phones);
        v_phones := v_phones || v_ph;
        exit when cardinality(v_phones) >= 4;
      end loop;
    end if;
    if v_name = '' then v_name := coalesce(v_phones[1], ''); end if;
    if v_name = '' then v_skipped := v_skipped + 1; continue; end if;
    if exists (select 1 from rsvp_invites i where i.event_id = v_id
               and (i.phones && v_phones or (cardinality(v_phones) = 0 and cardinality(i.phones) = 0 and lower(i.name) = lower(v_name)))) then
      v_skipped := v_skipped + 1; continue;
    end if;
    if (select count(*) from rsvp_invites where event_id = v_id) >= 500 then raise exception 'too_many_invites'; end if;
    insert into rsvp_invites (event_id, name, phones) values (v_id, v_name, v_phones);
    v_added := v_added + 1;
    v_any_phone := v_any_phone or cardinality(v_phones) > 0;
  end loop;
  if v_any_phone then update rsvp_events set require_phone = true where id = v_id and not require_phone; end if;
  return jsonb_build_object('added', v_added, 'skipped', v_skipped);
end $$;

create or replace function rsvp_invite_remove(p_code text, p_owner_token text, p_invite uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := _rsvp_owned_event(p_code, p_owner_token);
begin
  delete from rsvp_invites where id = p_invite and event_id = v_id;
  if not found then raise exception 'invite_not_found'; end if;
end $$;

-- Confirms (p_guest) or clears (null) which RSVP belongs to an invite.
create or replace function rsvp_invite_link(p_code text, p_owner_token text, p_invite uuid, p_guest uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := _rsvp_owned_event(p_code, p_owner_token);
begin
  if p_guest is not null and not exists (select 1 from rsvp_guests where id = p_guest and event_id = v_id) then
    raise exception 'guest_not_found';
  end if;
  update rsvp_invites set guest_id = p_guest where id = p_invite and event_id = v_id;
  if not found then raise exception 'invite_not_found'; end if;
end $$;

revoke all on function _rsvp_owned_event(text, text), rsvp_invites(text, text), rsvp_invite_add(text, text, jsonb),
  rsvp_invite_remove(text, text, uuid), rsvp_invite_link(text, text, uuid, uuid) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _rsvp_owned_event(text, text) from %I', r);
      execute format('grant execute on function rsvp_invites(text, text), rsvp_invite_add(text, text, jsonb), '
                  || 'rsvp_invite_remove(text, text, uuid), rsvp_invite_link(text, text, uuid, uuid) to %I', r);
    end if;
  end loop;
end $$;
