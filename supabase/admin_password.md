# Admin password (shared by every app's admin mode and /admin/)

Checked by `public._admin_check(p_password)`, which was set up by hand long ago (the script was never
saved). Its live definition, dumped from Supabase:

```sql
CREATE OR REPLACE FUNCTION public._admin_check(p_password text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_hash  text;
  v_fails int;
begin
  select password_hash into v_hash from public.admin_config where id;
  if v_hash is null then
    return 'admin_not_configured';
  end if;

  delete from public.admin_attempts where at < now() - interval '1 day';
  select count(*) into v_fails from public.admin_attempts where at > now() - interval '15 minutes';
  if v_fails >= 8 then
    return 'too_many_attempts';
  end if;

  if p_password is null or p_password = '' or crypt(p_password, v_hash) <> v_hash then
    insert into public.admin_attempts default values;
    perform pg_sleep(0.5);               -- slows down guessing
    return 'wrong_password';
  end if;

  delete from public.admin_attempts where true;   -- a correct password resets the counter
  return 'ok';
end;
$function$;
```

- `admin_config` has one row (a boolean `id` column, true) with `password_hash`, a bcrypt hash.
- `admin_attempts` logs failed tries: 8 wrong in 15 minutes locks admin for 15 minutes.

## Changing the password

Supabase → SQL Editor → New query, then run (new password between the quotes):

```sql
update public.admin_config set password_hash = extensions.crypt('your new password', extensions.gen_salt('bf')) where id;
```

It should report 1 row. Then delete that query from the SQL Editor history (the password is visible in it).
Never commit the password itself to this repo.
