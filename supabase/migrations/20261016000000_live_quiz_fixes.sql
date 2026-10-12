-- Live Quiz fixes. Safe to re-run.
--  * Back from the results screen goes to the last question (it skipped one before).
--  * Optional p_version: if the laptop and the phone remote both press Next at the same moment, only
--    the first press counts (the second gets 'stale' and the page just refreshes).

drop function if exists live_control(text, text, text, int);

create or replace function live_control(p_code text, p_owner_token text, p_action text, p_qindex int default null,
  p_version int default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s live_sessions%rowtype := _live_owner(p_code, p_owner_token); n int; v_phase text; v_q int;
begin
  -- Two screens (laptop + phone remote) pressing at the same moment: only the first press counts.
  if p_version is not null and p_version <> s.version then raise exception 'stale'; end if;
  n := jsonb_array_length(s.questions);
  v_phase := s.phase; v_q := s.qindex;
  if p_action = 'start' then v_phase := 'question'; v_q := 0;
  elsif p_action = 'reveal' then if s.phase <> 'question' then raise exception 'not_open'; end if; v_phase := 'reveal';
  elsif p_action = 'next' then
    if s.phase = 'lobby' then v_phase := 'question'; v_q := 0;
    elsif s.qindex + 1 >= n then v_phase := 'done';
    else v_phase := 'question'; v_q := s.qindex + 1; end if;
  elsif p_action = 'back' then
    v_phase := 'reveal';
    v_q := case when s.phase = 'done' then s.qindex else greatest(s.qindex - 1, 0) end;   -- from results: the last question
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

revoke all on function live_control(text, text, text, int, int) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function live_control(text, text, text, int, int) to %I', r);
    end if;
  end loop;
end $$;
