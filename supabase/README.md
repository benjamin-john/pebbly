# Database changes

The Supabase project is linked to this repo (Supabase dashboard → Project Settings → Integrations →
GitHub) with these settings:

- Supabase directory: `.` (the repo root, which holds this `supabase/` folder)
- Production branch: `main`
- Deploy to production: **on**
- Automatic branching (preview databases per pull request): **off**

Any new file in `supabase/migrations/` is run against the live database when it reaches `main`.
Supabase records each file it has run, so nothing runs twice.

## Adding a change

1. Add a new file: `supabase/migrations/YYYYMMDDHHMMSS_short_description.sql`
   (the timestamp sets the order; use the current UTC time).
2. Write it so it's safe to run more than once where you can: `create table if not exists`,
   `create or replace function`, `add column if not exists`, and grants in a `do $$ … $$` block
   like the existing scripts.
3. Test it against a local Postgres before merging (see the existing scripts for the pattern).
4. Push or merge to `main`. Check the integration's status on the commit in GitHub (or the
   Supabase dashboard → Branches / Integrations log) to confirm it applied.

Never put secrets (service-role key, database password) in a migration.

## Edge Functions

`supabase/functions/notify-push/` sends phone alerts (Web Push). It isn't deployed by the
integration above but by `.github/workflows/deploy-functions.yml`, whenever the folder changes on
`main` (or by hand: Actions tab → "Deploy Supabase functions" → Run workflow). It needs no secrets of
its own: it makes and keeps its sender key pair in the database (`push_config`) and uses the service
key Supabase gives every function. The workflow needs one GitHub secret, set up once:

1. Supabase dashboard → your account (top right) → **Access Tokens** → **Generate new token**
   (name it "GitHub deploy"), and copy it.
2. GitHub, in a phone browser (the GitHub app can't do this; use the browser's "Desktop site" if
   the page is cramped): the pebbly repo → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**. Name `SUPABASE_ACCESS_TOKEN`, value: the token. Save.
3. Actions tab → **Deploy Supabase functions** → **Run workflow** (or re-run the failed run).
4. In Pebbly: homepage → Notifications → **Turn on phone alerts** → **Send a test alert**.

If alerts don't arrive: Supabase dashboard → Edge Functions → notify-push → Logs. The database
calls the function through the `pg_net` extension (Database → Extensions should show it on).

## History

`20261011000000_baseline.sql` is a no-op that marks where automatic history begins. Everything
before it was applied by hand and is kept for reference:

- `rsvp/schema.sql`, `rsvp/rsvp_admin.sql`, `rsvp/update_*.sql`
- `whichdayworks/schema_snapshot.sql` (record of the live setup), `whichdayworks/organizer.sql`,
  `whichdayworks/final_date.sql`
- `play/play.sql`

Preview branches (a fresh database per pull request) won't have that hand-made schema, so keep
automatic branching off unless a full baseline is added later (e.g. from `supabase db dump`).
