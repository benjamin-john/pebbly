-- "Play together" gains one more kind: codebreaker. Safe to re-run.

create or replace function _play_check(p_kind text, p_member text, p_name text, p_state jsonb) returns void
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_kind is not null and p_kind not in ('qwixx', 'farkle', 'score', 'darts', 'namegame', 'trivia', 'bracket',
                                           'dots', 'gomoku', 'mancala', 'codebreaker') then raise exception 'invalid_kind'; end if;
  if p_member is not null and p_member !~ '^[A-Za-z0-9_-]{4,40}$' then raise exception 'invalid_member'; end if;
  if p_name is not null and char_length(btrim(p_name)) not between 1 and 40 then raise exception 'invalid_name'; end if;
  if p_state is not null and (jsonb_typeof(p_state) <> 'object' or octet_length(p_state::text) > 300000) then raise exception 'invalid_state'; end if;
end $$;

revoke all on function _play_check(text, text, text, jsonb) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function _play_check(text, text, text, jsonb) from %I', r);
    end if;
  end loop;
end $$;
