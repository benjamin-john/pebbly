-- Test-only additions to Poll's live setup (poll/schema_snapshot.sql, loaded just before this by
-- tests/setup_db.sh). Load after tests/wdw_fixture.sql (roles, _admin_check). Never run this in Supabase.

-- The psql bridge passes lists as JSON, so poll_create takes its options as jsonb here and hands them
-- on to the real function as text[].
alter function poll_create(text, text, boolean, boolean, boolean, text[], boolean) rename to _poll_create_live;
create or replace function poll_create(p_name text, p_description text default '', p_allow_down boolean default false,
  p_anonymous boolean default false, p_allow_custom boolean default true, p_options jsonb default '[]', p_single_vote boolean default false)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select _poll_create_live(p_name, p_description, p_allow_down, p_anonymous, p_allow_custom,
    array(select jsonb_array_elements_text(coalesce(p_options, '[]'))), p_single_vote);
$$;

-- As in the live project: the browser may call every poll_* function (the password migration then
-- takes the guest ones away again in favour of their gated_ wrappers).
do $$ declare r text; begin
  for r in select unnest(array['anon', 'authenticated']) loop
    execute format('revoke all on polls, poll_options, poll_owner_keys, poll_voters, poll_votes from %I', r);
    execute format('grant execute on function poll_create(text, text, boolean, boolean, boolean, jsonb, boolean), '
      || 'poll_get(text, text, text), poll_delete(text, text), poll_vote(text, text, text, uuid, integer), '
      || 'poll_add_option(text, text, text, text, text), poll_edit_option(text, text, text, uuid, text), '
      || 'poll_remove_option(text, text, text, uuid), poll_set_winner(text, text, uuid, text), '
      || 'poll_admin_list(text), poll_admin_grant(text, text), poll_admin_delete(text, text) to %I', r);
  end loop;
end $$;
