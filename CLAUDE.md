# Pebbly: guide for working on this repo

Pebbly (https://pebbly.dev) is Ben's collection of small, free web apps for planning get-togethers
and playing games. It's a static site on GitHub Pages (this repo, branch `main`) with a Supabase
database for the apps that share data between people. See README.md for the app list.

## Working with Ben

- Ben mostly uses Android (Chrome) and has Pebbly installed as a home-screen app. He works from the
  GitHub mobile app and a phone browser, so give steps that work on a phone.
- Explain changes in plain language (what changed, how to use it, anything he must do). Keep it
  short; no code in explanations unless asked.
- In this repo, commit and push directly to `main` once a change is tested (that's how every change
  has been made). GitHub Pages publishes in a minute or two.
- The old site, `benjamin-john/benjamin-john.github.io` (benjamin-john.com), publishes from `master`.
  Its `rsvp/`, `poll/` and `whichdayworks/` now only forward to pebbly.dev (keeping `?…` and carrying
  saved browser data once; see `migrate.js`). Don't build new things there.
- Ask before anything hard to undo (deleting data, changing existing database tables destructively).

## Layout

| Path | What |
|---|---|
| `index.html` | Homepage: "Plan" and "Play" lists of app cards. Add new apps here. |
| `<app>/index.html` | Each app is one self-contained HTML file (inline CSS and JS, no build step). |
| `nav.js` | In the installed app, adds the "← Pebbly" home bar; also asks for persistent storage. Include in every app's `<head>`. |
| `keepawake.js` | `keepAwake(true/false)`: Screen Wake Lock while a game is on screen. |
| `play/sync.js`, `play/play.sql` | "Play together": share any game between phones with a 5-letter code. |
| `lock.js` | Optional passwords for the Plan apps (gate screen, host's 🔒 Password dialog, key storage). |
| `migrate.js` | Merges saved data forwarded from benjamin-john.com (RSVP/Poll/Which Day Works? only). |
| `sw.js` | Service worker: network-first with `cache: 'no-cache'` (updates show right away), offline fallback. |
| `manifest.webmanifest`, `icons/` | Installable app (PWA). Shortcuts list in the manifest. |
| `supabase/migrations/` | Database changes; applied automatically on push to `main` (see below). |
| `tests/` | Playwright helpers and the RSVP test. |

## Design conventions (match these in every app)

- Fonts: Bricolage Grotesque (headings, 800) + Figtree (body), from Google Fonts.
- Colors (CSS variables on `:root`): `--bg #F4F6F5`, `--surface #FFF`, `--ink #1F2A27`,
  `--muted #5D6B66`, `--line #DDE4E1`, `--brand #2F7A63` (green), `--brand-ink #FFF`, `--brand-t #E6F2ED`.
  Dark mode under `@media (prefers-color-scheme: dark)` (`--bg #141A18`, `--surface #1D2522`,
  `--brand #6CC4A4`, …). The games and homepage support dark mode; RSVP/Poll/Which Day Works? are light only.
- `<meta name="theme-color" content="#2F7A63">`, favicon `/icons/favicon.png`, and
  `<meta name="robots" content="noindex, nofollow">` on every page: Pebbly is for friends and family,
  not search engines (don't add a robots.txt that blocks crawling, or Google can't see the tag).
- Cards: white surface, 1px `--line` border, 14–16px radius. Buttons: 52px tall green primary, ghost
  (outlined) and plain variants. Tap targets ≥ 44px. Always include `[hidden]{display:none !important}`
  (button `display` rules otherwise override `hidden`).
- Mobile first: works at 360px wide, 16px side padding. Plain, friendly wording; no jargon.
- Remembered player names are shared across games in localStorage `pebbly_score_memory` (`{players:[], games:[]}`).
- Game setup screens: Players list (↑ ↓ ✕, chips of remembered names), options, Start. Games keep
  their state in localStorage, have Undo (snapshot stack), and call `keepAwake(true)` while playing.

### Adding a new app

1. `<name>/index.html`, self-contained, using the conventions above. In `<head>`:
   `<script src="/keepawake.js"></script>` (games), `<script src="/play/sync.js"></script>` (if it
   supports playing together), `<script src="/nav.js"></script>`.
2. Add a card to `index.html` (Plan or Play), a row to README.md, and optionally a manifest shortcut
   (Android shows the first four).
3. Test (below), then commit and push to `main`.

## Play together (`play/`)

A shared game is one JSON document with a version number in `play_games`; phones are `play_members`
with hashed per-phone keys. `sync.js` pushes the whole game after each change (`play_push` with the
version it started from), polls every 1.5 s, and on a conflict merges its own changes (a diff against
the last server copy) onto the latest copy. Comparisons ignore key order (Postgres jsonb reorders keys).
A game hooks in with one call:

```js
sync = PebblySync.wire('<kind>', { setupEl, joinEl, badgeEl, names, getGame, setGame, clearUndo,
  render, showPlay, players, addPlayer, onRemote });
// after building a new game locally:  sync.started(sync.shared() ? myPlayer : null);
// in save():                          if (sync) sync.push();
```

New kinds must be added to the list in `_play_check` (in a new migration). Kwiks (`/kwiks/`) keeps the internal kind and storage names `qwixx` / `pebbly_qwixx2*` so saved and
shared games keep working (`/qwixx/` forwards to `/kwiks/`). Keep per-phone UI state
(e.g. which card is shown) out of the shared game object. `PebblySync.canAct(pid)` / `hasPhone(pid)` /
`me()` / `isHost()` drive turn guards ("Waiting for Amy…" with a "play for them" override).

## Supabase

- Project URL and publishable key are in each app's `config.js` and in `play/sync.js` (the
  publishable key is public by design). Never commit the secret/service-role key or DB password.
- Pattern: tables have RLS on and all grants revoked from `anon`/`authenticated`; the browser only
  calls `security definer` functions (`set search_path = public, pg_temp`) that validate input and check
  keys. Owner/organizer/player keys are random tokens stored as sha256 hashes. Grant `execute` on
  public functions to `anon` and `authenticated` in a `do $$ … $$` block (see existing scripts).
- Errors: functions `raise exception 'short_code'`; pages map codes to friendly text. Admin
  functions return `{"error": …}` instead of raising so the failed-attempt counter isn't rolled back.
- **Database changes**: add `supabase/migrations/YYYYMMDDHHMMSS_name.sql` (UTC timestamp, idempotent
  where possible). The GitHub integration (Deploy to production on, branching off) applies it when it
  reaches `main`. The scripts in `rsvp/`, `whichdayworks/`, `play/` were applied by hand before the
  baseline and are reference only. Poll's original setup and the shared admin-password setup
  (`_admin_check`, `admin_config`) were never saved to the repo; to change them, ask Ben for a dump
  (Supabase SQL Editor: `select pg_get_functiondef(…)`) first, as done for Which Day Works?.
- Pages should keep working before a migration is applied (fall back to old functions or show a
  clear message), since deploys of the site and the database aren't simultaneous.
- **Passwords** (`supabase/migrations/20261012000000_plan_passwords.sql`, `lock.js`): RSVP, Poll and
  Which Day Works? can be password protected. Every guest-callable function (list in `_lock_wrap_all`)
  has a wrapper `gated_<name>(same args, p_key)`; the originals are not executable by anon/authenticated.
  Pages call through `PebblyLock.call` (falls back to the originals if the wrappers don't exist yet).
  If a migration changes or adds a guest-callable function, end it with `select _lock_wrap_all();`
  (add new ones to its list) and **never grant execute on the originals** to anon/authenticated. The
  old reference scripts (`rsvp/*.sql`, `whichdayworks/*.sql`, `play/play.sql`) contain such grants:
  don't re-run them in Supabase. Poll's owner check works by deleting the poll inside a rolled-back
  savepoint, because Poll's tables aren't in the repo.
- The free project is kept awake by `.github/workflows/keepalive.yml` (pings every 3 days).

## Testing (do this before pushing)

Chromium + Playwright are preinstalled (`NODE_PATH=$(npm root -g)`, no `playwright install`). Serve
the repo with `python3 -m http.server <port>` and drive a Pixel 7 viewport.

- Unit-ish checks: expose pure functions on `window` for tests only if needed; fixed dice by
  overriding `crypto.getRandomValues` in an init script with a queue.
- Database functions: start a throwaway Postgres 16 (`/usr/lib/postgresql/16/bin/initdb` as user
  `postgres`, in a folder under `/tmp` owned by `postgres`), create roles `anon`/`authenticated`, load
  the relevant scripts (for Which Day Works?: `tests/wdw_fixture.sql`, then
  `whichdayworks/schema_snapshot.sql`, `organizer.sql`, `final_date.sql`), apply the new script twice
  (must be re-runnable), and call functions as `set role anon`.
- End to end against that database: `tests/pg_bridge.js` routes the page's RPC calls to it via psql
  (`phone(browser, devices, db)` gives a page; use several for multi-phone "play together" tests).
- Screenshot the result on a phone viewport (light and dark) and look at it before pushing.
- `tests/rsvp_test.js`: RSVP checks (see its header).
- `tests/lock_test.js`: passwords in all three Plan apps (see its header; Poll uses the stand-in
  `tests/poll_fixture.sql`).

## Gotchas learned the hard way

- Full-screen game layouts: size with the measured height (`--app-h` from `innerHeight` /
  `visualViewport`), not `100dvh`; some Android installs report 100dvh including the status bar.
  Don't use `viewport-fit=cover`.
- GitHub Pages lets browsers cache pages for 10 minutes; `sw.js` fetches with `cache: 'no-cache'` so
  the installed app updates immediately. Bump `CACHE` in `sw.js` only if cached files must be dropped.
- Firefox shows a prompt for persistent storage; only request it there from the installed app.
- In fixed-position headers, account for the "← Pebbly" bar (`nav.js` pads `body`).
