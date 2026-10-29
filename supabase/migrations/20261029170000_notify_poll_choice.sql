-- Notifications: Poll hosts hear when someone adds a choice (their own additions aren't counted).
-- Removing the choice removes the notification. Safe to re-run.

insert into notify_types (type, app, audience, label, sort) values
  ('poll.option', 'poll', 'host', 'Someone adds a choice', 1)
on conflict (type) do update set app = excluded.app, audience = excluded.audience, label = excluded.label, sort = excluded.sort;

create or replace function _notify_poll_option() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    delete from notifications where app = 'poll' and type = 'poll.option' and ref = old.id;
    return null;
  end if;
  if new.is_owner_added then return null; end if;
  perform _notify_add('poll', new.poll_id, 'poll.option', new.added_by_pid, new.id, coalesce(new.added_by_name, ''),
    jsonb_build_object('label', left(new.label, 80)));
  return null;
end $$;

drop trigger if exists notify_poll_option on poll_options;
create trigger notify_poll_option after insert or delete on poll_options for each row execute function _notify_poll_option();

revoke all on function _notify_poll_option() from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _notify_poll_option() from %I', r);
    end if;
  end loop;
end $$;
