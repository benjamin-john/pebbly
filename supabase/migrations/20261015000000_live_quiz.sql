-- Live Quiz (/live/): a Kahoot/Slido-style quiz or poll for a room. Safe to re-run.
--
-- The presenter's screen (usually on a projector) shows one question at a time; everyone answers on
-- their own phone after scanning a QR code or typing pebbly.dev/live and a 5-letter code. Built for a
-- room full of phones: each answer is its own row (no shared document to fight over), phones only
-- ever receive the current question, and the right answer is sent only once the presenter reveals it.
-- A question without a right answer is a plain poll question. Sessions are deleted 7 days after the
-- last change.

create table if not exists live_sessions (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  owner_hash   text not null,
  title        text not null,
  require_name boolean not null default false,
  questions    jsonb not null,                -- [{q, choices: [..], answer: index | null}]
  phase        text not null default 'lobby' check (phase in ('lobby', 'question', 'reveal', 'done')),
  qindex       int not null default 0,
  version      int not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create table if not exists live_people (
  session_id uuid not null references live_sessions(id) on delete cascade,
  pid_hash   text not null,
  name       text not null default '',
  joined_at  timestamptz not null default now(),
  primary key (session_id, pid_hash)
);
create table if not exists live_votes (
  session_id uuid not null references live_sessions(id) on delete cascade,
  qindex     int not null,
  pid_hash   text not null,
  choice     int not null,
  voted_at   timestamptz not null default now(),
  primary key (session_id, qindex, pid_hash)
);
alter table live_sessions enable row level security;
alter table live_people enable row level security;
alter table live_votes enable row level security;
revoke all on live_sessions, live_people, live_votes from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on live_sessions, live_people, live_votes from %I', r);
    end if;
  end loop;
end $$;

-- 5 letters/digits without look-alikes, upper case (easy to read off a projector and type).
create or replace function _live_code() returns text
language plpgsql volatile set search_path = public, pg_temp as $$
declare a constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; c text; b bytea; i int;
begin
  loop
    b := uuid_send(gen_random_uuid()); c := '';
    for i in 0..4 loop c := c || substr(a, (get_byte(b, i) % length(a)) + 1, 1); end loop;
    exit when not exists (select 1 from live_sessions where code = c);
  end loop;
  return c;
end $$;

-- Checks and tidies the questions: 1–100 questions, 2–6 choices each, answer an index or null (poll).
create or replace function _live_questions(p jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare q jsonb; out jsonb := '[]'::jsonb; v_q text; v_ch jsonb; c jsonb; v_c text; v_ans int; n int;
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) not between 1 and 100 then raise exception 'invalid_questions'; end if;
  for q in select * from jsonb_array_elements(p) loop
    v_q := btrim(coalesce(q->>'q', ''));
    if v_q = '' or char_length(v_q) > 300 then raise exception 'invalid_question'; end if;
    if jsonb_typeof(q->'choices') <> 'array' then raise exception 'invalid_choices'; end if;
    v_ch := '[]'::jsonb;
    for c in select * from jsonb_array_elements(q->'choices') loop
      v_c := btrim(coalesce(c #>> '{}', ''));
      if v_c = '' or char_length(v_c) > 120 then raise exception 'invalid_choices'; end if;
      v_ch := v_ch || jsonb_build_array(v_c);
    end loop;
    n := jsonb_array_length(v_ch);
    if n not between 2 and 6 then raise exception 'invalid_choices'; end if;
    v_ans := case when jsonb_typeof(q->'answer') = 'number' then (q->>'answer')::int end;
    if v_ans is not null and (v_ans < 0 or v_ans >= n) then raise exception 'invalid_answer'; end if;
    out := out || jsonb_build_array(jsonb_build_object('q', v_q, 'choices', v_ch, 'answer', v_ans));
  end loop;
  return out;
end $$;

create or replace function _live_owner(p_code text, p_owner_token text) returns live_sessions
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype;
begin
  select * into s from live_sessions where code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found then raise exception 'session_not_found'; end if;
  if coalesce(p_owner_token, '') = '' or _app_hash(p_owner_token) <> s.owner_hash then raise exception 'not_owner'; end if;
  return s;
end $$;

-- Vote counts for one question: [n0, n1, …] (one number per choice).
create or replace function _live_counts(p_session uuid, p_qindex int, p_n int) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(coalesce(v.n, 0) order by i), '[]'::jsonb)
    from generate_series(0, greatest(p_n, 1) - 1) i
    left join (select choice, count(*) n from live_votes where session_id = p_session and qindex = p_qindex group by choice) v
      on v.choice = i;
$$;

-- ---------------------------------------------------------------- presenter

create or replace function live_create(p_title text, p_questions jsonb, p_require_name boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_code text := _live_code(); v_token text := _app_token(); v_title text := _app_text(p_title, 80);
begin
  if v_title = '' then raise exception 'invalid_title'; end if;
  delete from live_sessions where updated_at < now() - interval '7 days';
  insert into live_sessions (code, owner_hash, title, require_name, questions)
  values (v_code, _app_hash(v_token), v_title, coalesce(p_require_name, false), _live_questions(p_questions));
  return jsonb_build_object('code', v_code, 'owner_token', v_token);
end $$;

-- Change title, questions or the name setting. Questions can only change before the quiz starts or
-- after it ends (answers already given refer to question numbers).
create or replace function live_update(p_code text, p_owner_token text, p_title text, p_questions jsonb, p_require_name boolean)
returns void language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype := _live_owner(p_code, p_owner_token); v_q jsonb := _live_questions(p_questions);
begin
  if _app_text(p_title, 80) = '' then raise exception 'invalid_title'; end if;
  if s.phase in ('question', 'reveal') and v_q <> s.questions then raise exception 'quiz_running'; end if;
  update live_sessions set title = _app_text(p_title, 80), questions = v_q, require_name = coalesce(p_require_name, false),
    version = version + 1, updated_at = now() where id = s.id;
end $$;

-- Move the quiz along. p_action: 'start' (first question), 'reveal', 'next', 'back' (previous
-- question, shown revealed), 'goto' (p_qindex, open for answers), 'end', 'restart' (clears answers).
create or replace function live_control(p_code text, p_owner_token text, p_action text, p_qindex int default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype := _live_owner(p_code, p_owner_token); n int; v_phase text; v_q int;
begin
  n := jsonb_array_length(s.questions);
  v_phase := s.phase; v_q := s.qindex;
  if p_action = 'start' then v_phase := 'question'; v_q := 0;
  elsif p_action = 'reveal' then if s.phase <> 'question' then raise exception 'not_open'; end if; v_phase := 'reveal';
  elsif p_action = 'next' then
    if s.phase = 'lobby' then v_phase := 'question'; v_q := 0;
    elsif s.qindex + 1 >= n then v_phase := 'done';
    else v_phase := 'question'; v_q := s.qindex + 1; end if;
  elsif p_action = 'back' then v_phase := 'reveal'; v_q := greatest(s.qindex - 1, 0);
  elsif p_action = 'goto' then
    if p_qindex is null or p_qindex < 0 or p_qindex >= n then raise exception 'invalid_qindex'; end if;
    v_phase := 'question'; v_q := p_qindex;
  elsif p_action = 'end' then v_phase := 'done';
  elsif p_action = 'restart' then
    delete from live_votes where session_id = s.id;
    v_phase := 'lobby'; v_q := 0;
  else raise exception 'invalid_action';
  end if;
  update live_sessions set phase = v_phase, qindex = v_q, version = version + 1, updated_at = now() where id = s.id;
  return jsonb_build_object('phase', v_phase, 'qindex', v_q, 'version', s.version + 1);
end $$;

-- Everything the presenter's screen needs (polled about once a second).
create or replace function live_host(p_code text, p_owner_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype; q jsonb; v_people int; v_voted int;
begin
  select * into s from live_sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  if coalesce(p_owner_token, '') = '' or _app_hash(p_owner_token) <> s.owner_hash then raise exception 'not_owner'; end if;
  q := s.questions -> s.qindex;
  select count(*) into v_people from live_people where session_id = s.id;
  select count(*) into v_voted from live_votes where session_id = s.id and qindex = s.qindex;
  return jsonb_build_object('code', s.code, 'title', s.title, 'require_name', s.require_name, 'questions', s.questions,
    'phase', s.phase, 'qindex', s.qindex, 'version', s.version, 'total', jsonb_array_length(s.questions),
    'people', v_people, 'voted', v_voted,
    'counts', _live_counts(s.id, s.qindex, jsonb_array_length(q->'choices')),
    'names', case when s.require_name then (select coalesce(jsonb_agg(name order by joined_at desc), '[]'::jsonb)
                                               from (select name, joined_at from live_people where session_id = s.id order by joined_at desc limit 60) x) end);
end $$;

-- Results for the end screen and the download: every person's answer to every question.
-- With names on, each person is listed by name; without, people are numbered (Person 1, …).
create or replace function live_results(p_code text, p_owner_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype;
begin
  select * into s from live_sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then raise exception 'session_not_found'; end if;
  if coalesce(p_owner_token, '') = '' or _app_hash(p_owner_token) <> s.owner_hash then raise exception 'not_owner'; end if;
  return jsonb_build_object('title', s.title, 'require_name', s.require_name, 'questions', s.questions,
    'counts', (select coalesce(jsonb_agg(_live_counts(s.id, i - 1, jsonb_array_length(s.questions -> (i - 1) -> 'choices')) order by i), '[]'::jsonb)
                 from generate_series(1, jsonb_array_length(s.questions)) i),
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
                 'name', case when s.require_name then p.name else 'Person ' || p.n end,
                 'answers', (select coalesce(jsonb_object_agg(v.qindex::text, v.choice), '{}'::jsonb)
                               from live_votes v where v.session_id = s.id and v.pid_hash = p.pid_hash)) order by p.n), '[]'::jsonb)
               from (select *, row_number() over (order by joined_at) n from live_people where session_id = s.id) p));
end $$;

create or replace function live_delete(p_code text, p_owner_token text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype := _live_owner(p_code, p_owner_token);
begin
  delete from live_sessions where id = s.id;
end $$;

-- ---------------------------------------------------------------- audience

-- Join (or rejoin) from a phone. p_participant: the phone's private random id.
create or replace function live_join(p_code text, p_participant text, p_name text default '') returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype; v_name text := _app_text(p_name, 40);
begin
  select * into s from live_sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then raise exception 'session_not_found'; end if;
  if coalesce(p_participant, '') !~ '^[A-Za-z0-9_-]{8,80}$' then raise exception 'invalid_participant'; end if;
  if s.require_name and v_name = '' then raise exception 'name_required'; end if;
  if (select count(*) from live_people where session_id = s.id) >= 1000
     and not exists (select 1 from live_people where session_id = s.id and pid_hash = _app_hash(p_participant)) then
    raise exception 'session_full';
  end if;
  insert into live_people (session_id, pid_hash, name) values (s.id, _app_hash(p_participant), v_name)
  on conflict (session_id, pid_hash) do update set name = case when excluded.name <> '' then excluded.name else live_people.name end;
  return jsonb_build_object('ok', true);
end $$;

-- What a phone shows (polled every couple of seconds). The right answer and the vote counts are
-- only included once the presenter reveals the question.
create or replace function live_state(p_code text, p_participant text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype; q jsonb; v_mine int; v_joined boolean; v_hash text := _app_hash(p_participant); v_name text;
begin
  select * into s from live_sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then return null; end if;
  select true, name into v_joined, v_name from live_people where session_id = s.id and pid_hash = v_hash;
  q := s.questions -> s.qindex;
  if s.phase in ('question', 'reveal') then
    select choice into v_mine from live_votes where session_id = s.id and qindex = s.qindex and pid_hash = v_hash;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('code', s.code, 'title', s.title, 'require_name', s.require_name,
    'joined', coalesce(v_joined, false), 'name', v_name,
    'phase', s.phase, 'qindex', s.qindex, 'total', jsonb_array_length(s.questions), 'version', s.version,
    'question', case when s.phase in ('question', 'reveal') then jsonb_build_object('q', q->'q', 'choices', q->'choices') end,
    'mine', v_mine,
    'answer', case when s.phase = 'reveal' then q->'answer' end,
    'poll', case when s.phase in ('question', 'reveal') then jsonb_typeof(q->'answer') <> 'number' end,
    'counts', case when s.phase = 'reveal' then _live_counts(s.id, s.qindex, jsonb_array_length(q->'choices')) end,
    'score', case when s.phase in ('reveal', 'done') and v_joined then
      (select count(*) from live_votes v where v.session_id = s.id and v.pid_hash = v_hash
         and (s.questions -> v.qindex ->> 'answer')::int = v.choice
         and (v.qindex < s.qindex or (v.qindex = s.qindex and s.phase in ('reveal', 'done')) or s.phase = 'done')) end,
    'scored', case when s.phase in ('reveal', 'done') then
      (select count(*) from generate_series(0, case when s.phase = 'done' then jsonb_array_length(s.questions) - 1 else s.qindex end) i
        where jsonb_typeof(s.questions -> i -> 'answer') = 'number') end));
end $$;

-- Answer the open question (can be changed until the presenter reveals it).
create or replace function live_vote(p_code text, p_participant text, p_qindex int, p_choice int) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype; v_hash text := _app_hash(p_participant);
begin
  select * into s from live_sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then raise exception 'session_not_found'; end if;
  if not exists (select 1 from live_people where session_id = s.id and pid_hash = v_hash) then raise exception 'not_joined'; end if;
  if s.phase <> 'question' or s.qindex <> p_qindex then raise exception 'voting_closed'; end if;
  if p_choice is null or p_choice < 0 or p_choice >= jsonb_array_length(s.questions -> s.qindex -> 'choices') then raise exception 'invalid_choice'; end if;
  insert into live_votes (session_id, qindex, pid_hash, choice) values (s.id, p_qindex, v_hash, p_choice)
  on conflict (session_id, qindex, pid_hash) do update set choice = excluded.choice, voted_at = now();
end $$;

-- ---------------------------------------------------------------- grants

revoke all on function _live_code(), _live_questions(jsonb), _live_owner(text, text), _live_counts(uuid, int, int),
  live_create(text, jsonb, boolean), live_update(text, text, text, jsonb, boolean), live_control(text, text, text, int),
  live_host(text, text), live_results(text, text), live_delete(text, text),
  live_join(text, text, text), live_state(text, text), live_vote(text, text, int, int) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function live_create(text, jsonb, boolean), live_update(text, text, text, jsonb, boolean), '
        || 'live_control(text, text, text, int), live_host(text, text), live_results(text, text), live_delete(text, text), '
        || 'live_join(text, text, text), live_state(text, text), live_vote(text, text, int, int) to %I', r);
    end if;
  end loop;
end $$;
