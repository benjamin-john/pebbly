-- RSVP: names for plus-ones (optional) and a note on a bring-list claim ("I'll bring pumpkin pie").
-- New functions rather than new arguments, so pages from before this change keep working and the page
-- can tell when this hasn't been applied yet. Re-runnable.

alter table rsvp_guests add column if not exists plus_names jsonb not null default '[]'::jsonb;
alter table rsvp_claims add column if not exists note text;

-- The plus-ones' names that still count: none for "can't go", and at most plus_ones of them
-- (the guest or the host may have lowered the number since).
create or replace function _rsvp_plus_names(g rsvp_guests) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce((select jsonb_agg(x order by n) from jsonb_array_elements_text(g.plus_names) with ordinality t(x, n)
                    where n <= g.plus_ones and g.status <> 'no' and jsonb_typeof(g.plus_names) = 'array'), '[]'::jsonb)
$$;

-- Saved right after rsvp_respond. Blank names are dropped (the guest skipped them); extra names past
-- the number of plus-ones are ignored.
create or replace function rsvp_plus_names(p_code text, p_participant text, p_owner_token text, p_names jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e rsvp_events; g rsvp_guests; v_names jsonb := '[]'::jsonb; v text;
begin
  select * into e from rsvp_events where code = lower(btrim(p_code));
  if not found then raise exception 'event_not_found'; end if;
  if coalesce(p_participant, '') = '' or char_length(p_participant) > 64 then raise exception 'invalid_participant'; end if;
  if _rsvp_closed(e) and not _rsvp_is_owner(e.id, p_owner_token) then raise exception 'rsvp_closed'; end if;
  select * into g from rsvp_guests where event_id = e.id and participant = p_participant for update;
  if not found then raise exception 'guest_not_found'; end if;
  if p_names is not null and jsonb_typeof(p_names) <> 'array' then raise exception 'invalid_plus_names'; end if;
  for v in select _rsvp_clean(x) from jsonb_array_elements_text(coalesce(p_names, '[]'::jsonb)) x loop
    if v = '' then continue; end if;
    if char_length(v) > 40 then raise exception 'plus_name_too_long'; end if;
    if jsonb_array_length(v_names) < g.plus_ones then v_names := v_names || to_jsonb(v); end if;
  end loop;
  if v_names is distinct from g.plus_names then
    update rsvp_guests set plus_names = v_names, updated_at = now() where id = g.id;
  end if;
end $$;

-- A short note on your own claim, e.g. which pie. Empty clears it.
create or replace function rsvp_claim_note(p_code text, p_participant text, p_item uuid, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_note text := _rsvp_text(p_note);
begin
  select id into v_id from rsvp_events where code = lower(btrim(p_code));
  if not found then raise exception 'event_not_found'; end if;
  if coalesce(p_participant, '') = '' or char_length(p_participant) > 64 then raise exception 'invalid_participant'; end if;
  if not exists (select 1 from rsvp_items where id = p_item and event_id = v_id) then raise exception 'item_not_found'; end if;
  if char_length(v_note) > 80 then raise exception 'claim_note_too_long'; end if;
  update rsvp_claims set note = nullif(v_note, '') where item_id = p_item and participant = p_participant;
  if not found then raise exception 'not_claimed'; end if;
end $$;

create or replace function rsvp_get(p_code text, p_participant text, p_owner_token text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  e rsvp_events;
  v_owner boolean;
  v_pid text := coalesce(p_participant, '');
  v_me jsonb; v_guests jsonb; v_counts jsonb; v_posts jsonb; v_items jsonb;
begin
  select * into e from rsvp_events where code = lower(btrim(p_code));
  if not found then return null; end if;
  v_owner := _rsvp_is_owner(e.id, p_owner_token);

  select jsonb_build_object('id', g.id, 'name', g.name, 'status', g.status, 'plus_ones', g.plus_ones,
           'plus_names', _rsvp_plus_names(g), 'note', g.note, 'answers', g.answers, 'phone', coalesce(g.phone, ''),
           'first_name', coalesce(g.first_name, split_part(g.name, ' ', 1)),
           'last_name', coalesce(g.last_name, nullif(btrim(substr(g.name, char_length(split_part(g.name, ' ', 1)) + 1)), '')))
    into v_me from rsvp_guests g where g.event_id = e.id and g.participant = v_pid and v_pid <> '';

  if v_owner or not e.hide_count then
    select jsonb_build_object(
      'going', coalesce(sum(case when status = 'going' then 1 + plus_ones end), 0),
      'going_plus', coalesce(sum(case when status = 'going' then plus_ones end), 0),
      'maybe', coalesce(sum(case when status = 'maybe' then 1 + plus_ones end), 0),
      'no', count(*) filter (where status = 'no'))
      into v_counts from rsvp_guests where event_id = e.id;
  end if;

  if v_owner or not e.hide_guests then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', g.id, 'name', g.name, 'status', g.status, 'plus_ones', g.plus_ones, 'plus_names', _rsvp_plus_names(g), 'note', g.note,
             'first_name', coalesce(g.first_name, split_part(g.name, ' ', 1)),
             'last_name', coalesce(g.last_name, nullif(btrim(substr(g.name, char_length(split_part(g.name, ' ', 1)) + 1)), '')),
             'mine', g.participant = v_pid,
             'answers', case when v_owner then g.answers end,
             'phone', case when v_owner then coalesce(g.phone, '') end,
             'replied_at', case when v_owner then g.created_at end,
             'updated_at', case when v_owner then g.updated_at end) order by g.created_at), '[]'::jsonb)
      into v_guests from rsvp_guests g where g.event_id = e.id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'kind', p.kind, 'name', p.name, 'body', p.body, 'created_at', p.created_at,
           'mine', p.participant is not null and p.participant = v_pid) order by p.created_at), '[]'::jsonb)
    into v_posts from rsvp_posts p where p.event_id = e.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'label', i.label, 'needed', i.needed, 'by_host', i.by_host, 'added_by', i.added_by_name,
           'mine_added', i.added_by_pid is not null and i.added_by_pid = v_pid,
           'claims', (select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'mine', c.participant = v_pid, 'note', coalesce(c.note, ''))
                       order by c.created_at), '[]'::jsonb) from rsvp_claims c where c.item_id = i.id))
           order by i.created_at), '[]'::jsonb)
    into v_items from rsvp_items i where i.event_id = e.id;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'code', e.code, 'title', e.title, 'host_name', e.host_name, 'description', e.description,
      'location', e.location, 'event_date', e.event_date, 'end_date', e.end_date, 'start_time', to_char(e.start_time, 'HH24:MI'),
      'end_time', to_char(e.end_time, 'HH24:MI'), 'tz', e.tz, 'theme', e.theme, 'emoji', e.emoji,
      'max_plus_ones', e.max_plus_ones, 'rsvp_by', e.rsvp_by, 'rsvp_closed', _rsvp_closed(e),
      'hide_guests', e.hide_guests, 'hide_count', e.hide_count, 'guests_add_items', e.guests_add_items,
      'bring_list', e.bring_list, 'rsvp_lock', e.rsvp_lock, 'require_phone', e.require_phone,
      'questions', e.questions, 'links', e.links,
      'host_phone', coalesce(e.host_phone, ''), 'host_email', coalesce(e.host_email, '')),
    'is_owner', v_owner,
    'extras', true,  -- tells the page rsvp_plus_names and rsvp_claim_note exist
    'me', v_me,
    'counts', v_counts,
    'guests', v_guests,
    'posts', v_posts,
    'items', v_items);
end $$;

revoke all on function _rsvp_plus_names(rsvp_guests) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _rsvp_plus_names(rsvp_guests) from %I', r);
    end if;
  end loop;
end $$;

create or replace function _lock_wrap_all() returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare w text[];
begin
  foreach w slice 1 in array array[
    ['rsvp', 'rsvp_get'], ['rsvp', 'rsvp_respond'], ['rsvp', 'rsvp_post'], ['rsvp', 'rsvp_delete_post'],
    ['rsvp', 'rsvp_item_add'], ['rsvp', 'rsvp_item_edit'], ['rsvp', 'rsvp_item_remove'], ['rsvp', 'rsvp_item_claim'],
    ['rsvp', 'rsvp_plus_names'], ['rsvp', 'rsvp_claim_note'],
    ['poll', 'poll_get'], ['poll', 'poll_vote'], ['poll', 'poll_add_option'], ['poll', 'poll_edit_option'],
    ['poll', 'poll_remove_option'],
    ['wdw', 'wdw_get'], ['wdw', 'get_event'], ['wdw', 'save_response'], ['wdw', 'delete_response'],
    ['doc', 'doc_get'], ['doc', 'doc_push'],
    ['santa', 'santa_get'], ['santa', 'santa_claim'], ['santa', 'santa_unclaim'], ['santa', 'santa_join'], ['santa', 'santa_set_wish'],
    ['basecamp', 'bc_sync'], ['basecamp', 'bc_join'], ['basecamp', 'bc_me_update'], ['basecamp', 'bc_remove_member'],
    ['basecamp', 'bc_waypoint_save'], ['basecamp', 'bc_waypoint_delete'], ['basecamp', 'bc_trail_delete'],
    ['basecamp', 'bc_ot_link'], ['basecamp', 'bc_ot_set'], ['basecamp', 'bc_ot_stop'], ['basecamp', 'bc_ot_extend'], ['basecamp', 'bc_ask'], ['basecamp', 'bc_ot_follow']
  ] loop
    perform _lock_wrap(w[1], w[2]);
  end loop;
end $$;

-- rsvp_plus_names and rsvp_claim_note are guest functions behind the password wrappers
-- (never executable directly by anon/authenticated); rsvp_get is rebuilt too.
select _lock_wrap_all();
