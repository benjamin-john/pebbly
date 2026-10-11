-- RSVP update 2: multi-day, link buttons, first/last names, optional bring list,
-- unlimited bring items, soft RSVP date, reply times. Safe to re-run.

-- columns added after the first version (safe on new and existing databases)
alter table rsvp_events add column if not exists end_date   date;                      -- last day of a multi-day event
alter table rsvp_events add column if not exists links      jsonb not null default '[]'::jsonb; -- [{"label":"Registry","url":"https://..."}]
alter table rsvp_events add column if not exists bring_list boolean not null default true;
alter table rsvp_events add column if not exists rsvp_lock  boolean not null default true; -- false = the RSVP date is only a reminder
alter table rsvp_guests add column if not exists first_name text;
alter table rsvp_guests add column if not exists last_name  text;

drop function if exists rsvp_respond(text, text, text, text, text, int, text, jsonb);

create or replace function _rsvp_event_fields(p jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_title text := _rsvp_clean(p->>'title');
  v_host  text := _rsvp_clean(p->>'host_name');
  v_desc  text := _rsvp_text(p->>'description');
  v_loc   text := _rsvp_clean(p->>'location');
  v_tz    text := coalesce(nullif(btrim(p->>'tz'), ''), 'UTC');
  v_theme text := coalesce(nullif(btrim(p->>'theme'), ''), 'sunset');
  v_emoji text := coalesce(nullif(btrim(p->>'emoji'), ''), '🎉');
  v_plus  int;
  v_date date; v_end_date date; v_start time; v_end time; v_by date;
  v_qs jsonb := '[]'::jsonb; q jsonb; v_qt text; v_qid text;
  v_links jsonb := '[]'::jsonb; l jsonb; v_ll text; v_lu text;
begin
  if v_title = '' or char_length(v_title) > 120 then raise exception 'invalid_title'; end if;
  if char_length(v_host) > 40 then raise exception 'invalid_host'; end if;
  if char_length(v_desc) > 4000 then raise exception 'description_too_long'; end if;
  if char_length(v_loc) > 200 then raise exception 'location_too_long'; end if;
  if v_theme !~ '^[a-z]{1,20}$' then v_theme := 'sunset'; end if;
  if char_length(v_emoji) > 16 then raise exception 'invalid_emoji'; end if;
  begin
    perform now() at time zone v_tz;
  exception when others then v_tz := 'UTC';
  end;
  begin
    v_date  := nullif(btrim(p->>'event_date'), '')::date;
    v_end_date := nullif(btrim(p->>'end_date'), '')::date;
    v_start := nullif(btrim(p->>'start_time'), '')::time;
    v_end   := nullif(btrim(p->>'end_time'), '')::time;
    v_by    := nullif(btrim(p->>'rsvp_by'), '')::date;
    v_plus  := coalesce(nullif(btrim(p->>'max_plus_ones'), '')::int, 0);
  exception when others then raise exception 'invalid_date';
  end;
  if v_date is null then v_start := null; v_end_date := null; end if;
  if v_end_date is not null and v_end_date < v_date then raise exception 'invalid_end_date'; end if;
  if v_end_date = v_date or v_end_date > v_date + 366 then v_end_date := null; end if;
  if v_start is null and v_end_date is null then v_end := null; end if;
  if v_plus < 0 or v_plus > 10 then raise exception 'invalid_plus_ones'; end if;
  if jsonb_typeof(p->'questions') = 'array' then
    for q in select * from jsonb_array_elements(p->'questions') loop
      v_qt  := _rsvp_clean(q->>'text');
      v_qid := btrim(coalesce(q->>'id', ''));
      continue when v_qt = '';
      if char_length(v_qt) > 120 then raise exception 'question_too_long'; end if;
      if v_qid !~ '^[a-z0-9]{1,12}$' then raise exception 'invalid_question'; end if;
      v_qs := v_qs || jsonb_build_array(jsonb_build_object('id', v_qid, 'text', v_qt));
    end loop;
  end if;
  if jsonb_array_length(v_qs) > 3 then raise exception 'too_many_questions'; end if;
  if jsonb_typeof(p->'links') = 'array' then
    for l in select * from jsonb_array_elements(p->'links') loop
      v_ll := _rsvp_clean(l->>'label');
      v_lu := btrim(coalesce(l->>'url', ''));
      continue when v_ll = '' and v_lu = '';
      if v_lu !~* '^https?://' and v_lu <> '' then v_lu := 'https://' || v_lu; end if;
      if v_ll = '' or char_length(v_ll) > 40 then raise exception 'invalid_link_label'; end if;
      if v_lu !~* '^https?://[^\s<>"]+\.[^\s<>"]+$' or char_length(v_lu) > 500 then raise exception 'invalid_link_url'; end if;
      v_links := v_links || jsonb_build_array(jsonb_build_object('label', v_ll, 'url', v_lu));
    end loop;
  end if;
  if jsonb_array_length(v_links) > 5 then raise exception 'too_many_links'; end if;
  return jsonb_build_object(
    'title', v_title, 'host_name', v_host, 'description', v_desc, 'location', v_loc,
    'event_date', v_date, 'end_date', v_end_date, 'start_time', to_char(v_start, 'HH24:MI'), 'end_time', to_char(v_end, 'HH24:MI'),
    'tz', v_tz, 'theme', v_theme, 'emoji', v_emoji, 'max_plus_ones', v_plus, 'rsvp_by', v_by,
    'hide_guests', coalesce((p->>'hide_guests')::boolean, false),
    'hide_count',  coalesce((p->>'hide_count')::boolean, false),
    'guests_add_items', coalesce((p->>'guests_add_items')::boolean, true),
    'bring_list', coalesce((p->>'bring_list')::boolean, true),
    'rsvp_lock', coalesce((p->>'rsvp_lock')::boolean, true),
    'questions', v_qs, 'links', v_links);
end $$;

create or replace function _rsvp_closed(e rsvp_events) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select e.rsvp_lock and e.rsvp_by is not null and now() >= ((e.rsvp_by + 1)::timestamp at time zone e.tz);
$$;

create or replace function rsvp_create(p_event jsonb, p_items text[] default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f jsonb := _rsvp_event_fields(p_event);
  v_code text := _rsvp_new_code();
  v_token text := _rsvp_token();
  v_id uuid; v_label text; v_n int := 0;
begin
  insert into rsvp_events (code, title, host_name, description, location, event_date, end_date, start_time, end_time, tz,
    theme, emoji, max_plus_ones, rsvp_by, hide_guests, hide_count, guests_add_items, bring_list, rsvp_lock, questions, links)
  values (v_code, f->>'title', f->>'host_name', f->>'description', f->>'location', (f->>'event_date')::date,
    (f->>'end_date')::date, (f->>'start_time')::time, (f->>'end_time')::time, f->>'tz', f->>'theme', f->>'emoji',
    (f->>'max_plus_ones')::int, (f->>'rsvp_by')::date, (f->>'hide_guests')::boolean, (f->>'hide_count')::boolean,
    (f->>'guests_add_items')::boolean, (f->>'bring_list')::boolean, (f->>'rsvp_lock')::boolean, f->'questions', f->'links')
  returning id into v_id;
  insert into rsvp_owner_keys (event_id, key_hash, label) values (v_id, _rsvp_hash(v_token), 'host');
  if p_items is not null and (f->>'bring_list')::boolean then
    foreach v_label in array p_items loop
      v_label := _rsvp_clean(v_label);
      continue when v_label = '' or exists (select 1 from rsvp_items where event_id = v_id and lower(label) = lower(v_label));
      if char_length(v_label) > 80 then raise exception 'invalid_item'; end if;
      v_n := v_n + 1;
      if v_n > 40 then raise exception 'too_many_items'; end if;
      insert into rsvp_items (event_id, label, needed, by_host) values (v_id, v_label, 1, true);
    end loop;
  end if;
  return jsonb_build_object('code', v_code, 'owner_token', v_token);
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

create or replace function rsvp_respond(p_code text, p_participant text, p_owner_token text, p_first_name text,
  p_last_name text, p_status text, p_plus_ones int, p_note text, p_answers jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e rsvp_events;
  v_first text := _rsvp_clean(p_first_name);
  v_last text := _rsvp_clean(p_last_name);
  v_name text := v_first || ' ' || v_last;
  v_note text := _rsvp_text(p_note);
  v_plus int := coalesce(p_plus_ones, 0);
  v_ans jsonb := '{}'::jsonb; q jsonb; v_a text;
begin
  select * into e from rsvp_events where code = lower(btrim(p_code)) for update;
  if not found then raise exception 'event_not_found'; end if;
  if coalesce(p_participant, '') = '' or char_length(p_participant) > 64 then raise exception 'invalid_participant'; end if;
  if _rsvp_closed(e) and not _rsvp_is_owner(e.id, p_owner_token) then raise exception 'rsvp_closed'; end if;
  if v_first = '' or v_last = '' or char_length(v_first) > 30 or char_length(v_last) > 30 then raise exception 'invalid_full_name'; end if;
  if p_status not in ('going', 'maybe', 'no') then raise exception 'invalid_status'; end if;
  if char_length(v_note) > 200 then raise exception 'note_too_long'; end if;
  if p_status = 'no' then v_plus := 0; end if;
  if v_plus < 0 or v_plus > e.max_plus_ones then raise exception 'too_many_plus_ones'; end if;
  for q in select * from jsonb_array_elements(e.questions) loop
    v_a := _rsvp_text(p_answers->>(q->>'id'));
    if char_length(v_a) > 300 then raise exception 'answer_too_long'; end if;
    if v_a <> '' then v_ans := v_ans || jsonb_build_object(q->>'id', v_a); end if;
  end loop;
  if not exists (select 1 from rsvp_guests where event_id = e.id and participant = p_participant)
     and (select count(*) from rsvp_guests where event_id = e.id) >= 300 then
    raise exception 'event_full';
  end if;
  insert into rsvp_guests (event_id, participant, name, first_name, last_name, status, plus_ones, note, answers)
  values (e.id, p_participant, v_name, v_first, v_last, p_status, v_plus, v_note, v_ans)
  on conflict (event_id, participant) do update
    set name = excluded.name, first_name = excluded.first_name, last_name = excluded.last_name, status = excluded.status, plus_ones = excluded.plus_ones,
        note = excluded.note, answers = excluded.answers, updated_at = now();
  -- keep the name on bring-list claims in step
  update rsvp_claims set name = v_name where event_id = e.id and participant = p_participant;
end $$;

create or replace function rsvp_update_event(p_code text, p_owner_token text, p_event jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e rsvp_events;
  f jsonb := _rsvp_event_fields(p_event);
begin
  select * into e from rsvp_events where code = lower(btrim(p_code)) for update;
  if not found then raise exception 'event_not_found'; end if;
  if not _rsvp_is_owner(e.id, p_owner_token) then raise exception 'not_owner'; end if;
  if (f->>'max_plus_ones')::int < e.max_plus_ones then
    update rsvp_guests set plus_ones = (f->>'max_plus_ones')::int
     where event_id = e.id and plus_ones > (f->>'max_plus_ones')::int;
  end if;
  update rsvp_events set
    title = f->>'title', host_name = f->>'host_name', description = f->>'description', location = f->>'location',
    event_date = (f->>'event_date')::date, end_date = (f->>'end_date')::date, start_time = (f->>'start_time')::time, end_time = (f->>'end_time')::time,
    tz = f->>'tz', theme = f->>'theme', emoji = f->>'emoji', max_plus_ones = (f->>'max_plus_ones')::int,
    rsvp_by = (f->>'rsvp_by')::date, hide_guests = (f->>'hide_guests')::boolean, hide_count = (f->>'hide_count')::boolean,
    guests_add_items = (f->>'guests_add_items')::boolean, bring_list = (f->>'bring_list')::boolean,
    rsvp_lock = (f->>'rsvp_lock')::boolean, questions = f->'questions', links = f->'links', updated_at = now()
  where id = e.id;
end $$;

create or replace function rsvp_post(p_code text, p_participant text, p_owner_token text, p_name text, p_kind text, p_body text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_name text := _rsvp_clean(p_name);
  v_body text := _rsvp_text(p_body);
begin
  select id into v_id from rsvp_events where code = lower(btrim(p_code)) for update;
  if not found then raise exception 'event_not_found'; end if;
  if coalesce(p_participant, '') = '' or char_length(p_participant) > 64 then raise exception 'invalid_participant'; end if;
  if p_kind = 'announce' then
    if not _rsvp_is_owner(v_id, p_owner_token) then raise exception 'not_owner'; end if;
    if v_body = '' or char_length(v_body) > 1000 then raise exception 'invalid_announcement'; end if;
    if (select count(*) from rsvp_posts where event_id = v_id and kind = 'announce') >= 50 then raise exception 'too_many_posts'; end if;
  elsif p_kind = 'comment' then
    if v_name = '' or char_length(v_name) > 64 then raise exception 'invalid_name'; end if;
    if v_body = '' or char_length(v_body) > 500 then raise exception 'invalid_comment'; end if;
    if (select count(*) from rsvp_posts where event_id = v_id and kind = 'comment') >= 300 then raise exception 'too_many_posts'; end if;
  else
    raise exception 'invalid_kind';
  end if;
  insert into rsvp_posts (event_id, kind, participant, name, body) values (v_id, p_kind, p_participant, v_name, v_body);
end $$;

create or replace function rsvp_item_add(p_code text, p_participant text, p_owner_token text, p_name text, p_label text, p_needed int)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e rsvp_events;
  v_owner boolean;
  v_label text := _rsvp_clean(p_label);
  v_name text := _rsvp_clean(p_name);
  v_item uuid;
begin
  select * into e from rsvp_events where code = lower(btrim(p_code)) for update;
  if not found then raise exception 'event_not_found'; end if;
  if coalesce(p_participant, '') = '' or char_length(p_participant) > 64 then raise exception 'invalid_participant'; end if;
  v_owner := _rsvp_is_owner(e.id, p_owner_token);
  if not e.bring_list then raise exception 'bring_list_off'; end if;
  if not v_owner and not e.guests_add_items then raise exception 'items_host_only'; end if;
  if v_label = '' or char_length(v_label) > 80 then raise exception 'invalid_item'; end if;
  if exists (select 1 from rsvp_items where event_id = e.id and lower(label) = lower(v_label)) then raise exception 'duplicate_item'; end if;
  if (select count(*) from rsvp_items where event_id = e.id) >= 40 then raise exception 'too_many_items'; end if;
  if v_owner then
    -- needed: 1-20 people, or 0 = unlimited
    if coalesce(p_needed, 1) < 0 or coalesce(p_needed, 1) > 20 then raise exception 'invalid_needed'; end if;
    insert into rsvp_items (event_id, label, needed, by_host, added_by_pid, added_by_name)
    values (e.id, v_label, coalesce(p_needed, 1), true, p_participant, nullif(v_name, ''));
  else
    -- a guest adding an item is saying "I'll bring this": it is claimed by them at once
    if v_name = '' or char_length(v_name) > 64 then raise exception 'invalid_name'; end if;
    insert into rsvp_items (event_id, label, needed, by_host, added_by_pid, added_by_name)
    values (e.id, v_label, 1, false, p_participant, v_name) returning id into v_item;
    insert into rsvp_claims (item_id, event_id, participant, name) values (v_item, e.id, p_participant, v_name);
  end if;
end $$;

create or replace function rsvp_item_edit(p_code text, p_participant text, p_owner_token text, p_item uuid, p_label text, p_needed int)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid; i rsvp_items; v_owner boolean;
  v_label text := _rsvp_clean(p_label);
begin
  select id into v_id from rsvp_events where code = lower(btrim(p_code)) for update;
  if not found then raise exception 'event_not_found'; end if;
  select * into i from rsvp_items where id = p_item and event_id = v_id;
  if not found then raise exception 'item_not_found'; end if;
  v_owner := _rsvp_is_owner(v_id, p_owner_token);
  if not (v_owner or (i.added_by_pid is not null and i.added_by_pid = coalesce(p_participant, ''))) then raise exception 'not_allowed'; end if;
  if v_label = '' or char_length(v_label) > 80 then raise exception 'invalid_item'; end if;
  if exists (select 1 from rsvp_items where event_id = v_id and id <> i.id and lower(label) = lower(v_label)) then raise exception 'duplicate_item'; end if;
  if v_owner and p_needed is not null then
    if p_needed < 0 or p_needed > 20 then raise exception 'invalid_needed'; end if;
  end if;
  update rsvp_items set label = v_label, needed = case when v_owner and p_needed is not null then p_needed else needed end
   where id = i.id;
end $$;

create or replace function rsvp_item_claim(p_code text, p_participant text, p_name text, p_item uuid, p_claim boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; i rsvp_items; v_name text := _rsvp_clean(p_name);
begin
  select id into v_id from rsvp_events where code = lower(btrim(p_code));
  if not found then raise exception 'event_not_found'; end if;
  if coalesce(p_participant, '') = '' or char_length(p_participant) > 64 then raise exception 'invalid_participant'; end if;
  select * into i from rsvp_items where id = p_item and event_id = v_id for update;
  if not found then raise exception 'item_not_found'; end if;
  if p_claim and not (select bring_list from rsvp_events where id = v_id) then raise exception 'bring_list_off'; end if;
  if not p_claim then
    delete from rsvp_claims where item_id = i.id and participant = p_participant;
    return;
  end if;
  if v_name = '' or char_length(v_name) > 64 then raise exception 'invalid_name'; end if;
  if exists (select 1 from rsvp_claims where item_id = i.id and participant = p_participant) then
    update rsvp_claims set name = v_name where item_id = i.id and participant = p_participant;
    return;
  end if;
  if i.needed > 0 and (select count(*) from rsvp_claims where item_id = i.id) >= i.needed then raise exception 'item_taken'; end if;
  insert into rsvp_claims (item_id, event_id, participant, name) values (i.id, v_id, p_participant, v_name);
end $$;

revoke all on function _rsvp_event_fields(jsonb), _rsvp_closed(rsvp_events) from public, anon, authenticated;
grant execute on function rsvp_respond(text, text, text, text, text, text, int, text, jsonb) to anon, authenticated;
