-- Baby Names (/babynames/): two people swipe through names and see the ones they both like. Each
-- shortlist is a shared document (plan_docs, doc.js) of a new kind, 'names'. Safe to re-run.

alter table plan_docs drop constraint if exists plan_docs_kind_check;
alter table plan_docs add constraint plan_docs_kind_check check (kind in ('bill', 'signup', 'list', 'names'));

-- Same as before, with 'names' allowed.
create or replace function doc_create(p_kind text, p_state jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_code text; v_token text := _app_token();
begin
  if p_kind not in ('bill', 'signup', 'list', 'names') then raise exception 'invalid_kind'; end if;
  perform _doc_check(p_state);
  delete from plan_docs where updated_at < now() - interval '400 days';
  loop
    v_code := _app_code();
    exit when not exists (select 1 from plan_docs where code = v_code);
  end loop;
  insert into plan_docs (code, kind, owner_hash, state) values (v_code, p_kind, _app_hash(v_token), p_state);
  return jsonb_build_object('code', v_code, 'owner_token', v_token, 'version', 1);
end $$;

revoke all on function doc_create(text, jsonb) from public;
do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function doc_create(text, jsonb) to %I', r);
    end if;
  end loop;
end $$;
