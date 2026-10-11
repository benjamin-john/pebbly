-- RSVP update 3: guest list includes first and last name (for the download). Safe to re-run.

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
           'note', g.note, 'answers', g.answers,
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
             'id', g.id, 'name', g.name, 'status', g.status, 'plus_ones', g.plus_ones, 'note', g.note,
             'first_name', coalesce(g.first_name, split_part(g.name, ' ', 1)),
             'last_name', coalesce(g.last_name, nullif(btrim(substr(g.name, char_length(split_part(g.name, ' ', 1)) + 1)), '')),
             'mine', g.participant = v_pid,
             'answers', case when v_owner then g.answers end,
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
           'claims', (select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'mine', c.participant = v_pid)
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
      'bring_list', e.bring_list, 'rsvp_lock', e.rsvp_lock, 'questions', e.questions, 'links', e.links),
    'is_owner', v_owner,
    'me', v_me,
    'counts', v_counts,
    'guests', v_guests,
    'posts', v_posts,
    'items', v_items);
end $$;
