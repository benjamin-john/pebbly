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
| `theme.js` | Applies the homepage's Theme switch (Auto/Light/Dark) before the page draws. |
| `keepawake.js` | `keepAwake(true/false)`: Screen Wake Lock while a game is on screen. |
| `play/sync.js`, `play/play.sql` | "Play together": share any game between phones with a 5-letter code. |
| `doc.js` | Shared documents for Sign-up Sheet, Split the Bill, Shared List (doc_* functions): open/change/merge, host keys. Keep lists as objects keyed by id. |
| `lock.js` | Optional passwords for the Plan apps (gate screen, host's 🔒 Password dialog, key storage). |
| `admin/` | One admin page for every app with an admin mode (shared admin password): a section per app (list, open as host, delete). Add new apps' admin functions to `APPS` there. |
| `migrate.js` | Merges saved data forwarded from benjamin-john.com (RSVP/Poll/Which Day Works? only). |
| `sw.js` | Service worker (registered by the homepage and `nav.js`): network-first with `cache: 'no-cache'` (updates show right away); saves every page in `PAGES` plus shared files and Google Fonts up front and refreshes them daily, so all of Pebbly opens offline. |
| `manifest.webmanifest`, `icons/` | Installable app (PWA). Shortcuts list in the manifest. |
| `supabase/migrations/` | Database changes; applied automatically on push to `main` (see below). |
| `tests/` | Playwright helpers and one test per app (`<app>_test.js`); `setup_db.sh` builds a test database. |

## Design conventions (match these in every app)

- Fonts: Bricolage Grotesque (headings, 800) + Figtree (body), from Google Fonts.
- Colors (CSS variables on `:root`): `--bg #F4F6F5`, `--surface #FFF`, `--ink #1F2A27`,
  `--muted #5D6B66`, `--line #DDE4E1`, `--brand #2F7A63` (green), `--brand-ink #FFF`, `--brand-t #E6F2ED`.
  Dark mode (`--bg #141A18`, `--surface #1D2522`, `--brand #6CC4A4`, …) follows the phone unless the
  Theme switch at the bottom of the homepage says Light or Dark (`theme.js`, first script after the
  charset meta, sets `<html data-theme>` from localStorage `pebbly_theme`). So the dark colors go in
  `@media (prefers-color-scheme:dark){ :root:not([data-theme=light]){… color-scheme:dark} }` and again in
  `:root[data-theme=dark]{… color-scheme:dark}`, plus `:root[data-theme=light]{color-scheme:light}`.
  The games, homepage and install page support dark mode; RSVP/Poll/Which Day Works? are light only.
- `<meta name="theme-color" content="#2F7A63">`, favicon `/icons/favicon.png`, and
  `<meta name="robots" content="noindex, nofollow">` on every page: Pebbly is for friends and family,
  not search engines (don't add a robots.txt that blocks crawling, or Google can't see the tag).
- Every page ends with the Cloudflare Web Analytics snippet just before `</body>` (copy it from any
  page; free, no cookies, dashboard in Ben's Cloudflare account under Web Analytics).
- Cards: white surface, 1px `--line` border, 14–16px radius. Buttons: 52px tall green primary, ghost
  (outlined) and plain variants. Tap targets ≥ 44px. Always include `[hidden]{display:none !important}`
  (button `display` rules otherwise override `hidden`).
- Mobile first: works at 360px wide, 16px side padding. Plain, friendly wording; no jargon.
- Remembered player names are shared across games in localStorage `pebbly_score_memory` (`{players:[], games:[]}`).
- Game setup screens: Players list (↑ ↓ ✕, chips of remembered names), options, Start. Games keep
  their state in localStorage, have Undo (snapshot stack), and call `keepAwake(true)` while playing.

### Adding a new app

1. `<name>/index.html`, self-contained, using the conventions above. In `<head>`:
   `<script src="/theme.js"></script>` (right after the charset meta, if it has dark mode),
   `<script src="/keepawake.js"></script>` (games), `<script src="/play/sync.js"></script>` (if it
   supports playing together), `<script src="/nav.js"></script>`.
2. Add a card to `index.html` (Plan or Play), a row to README.md, its folder to `PAGES` in `sw.js`
   (and any new shared file to `FILES`; `tests/sw_test.js` checks), and optionally a manifest shortcut
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
(e.g. which card is shown) out of the shared game object.
Codebreaker, Dots and Boxes, Gomoku and Mancala share one setup pattern: "Each other" or "🤖 Computer" (Easy/Hard; the
computer is a player with `bot: true`, never offered for shared games), and a shared game can start with just the
host, others joining as players (Dots: until the first line). Their tests: `tests/{codebreaker,dots,gomoku,mancala}_test.js`. Codebreaker keeps
secrets in the shared game (lightly scrambled, never shown), so it's a family game, not a secure one.
Color Stack (`/colorstack/`) is a solo puzzle (no players, no play together); its solver checks that deals can be
finished and gives hints (`tests/colorstack_test.js`).
Word Dash (`/worddash/`) races all phones on one word at once (no turns): each phone only writes its own
`boards[pid]`, and the winner (earliest solve time) and round end are worked out from the boards, never stored,
so simultaneous pushes merge cleanly. Answer words are a curated common list; guesses check a larger list
(MIT `word-list` package), both inline in the page (`tests/worddash_test.js`). `PebblySync.canAct(pid)` / `hasPhone(pid)` /
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
  `_admin_check` has since been dumped: see `supabase/admin_password.md` (also how Ben changes the password).
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
- **RSVP invite list** (`rsvp_invites`, `rsvp_invite_*`): host-only, added from Android's Contact Picker
  (`navigator.contacts.select`; Chrome on Android only, so there's also "Add by hand"). The page matches
  RSVPs to invites (confirmed `guest_id`, any shared phone number, or the identical name) and suggests
  similar names for the host to confirm. Adding anyone with a number turns on "Require a phone number".
- **Secret Santa** (`santa_*`): the draw and pairs live only in the database; `santa_get` returns just
  the calling phone's match (by its participant id). Never add a function that returns all pairs.
- **Live Quiz** (`live_*`, `/live/`): built for a room of phones, so each answer is its own row in
  `live_votes` (no shared document). Phones poll `live_state` (~2 s), the presenter `live_host` (~1 s);
  the right answer and counts reach phones only after reveal. `live_control` takes `p_version` so two
  screens pressing Next at once count once.
  Attendees use `/join/` (code box + answering only; old `/live/?c=` links forward there). Organizer
  link `?c=&o=`, display-only screen `?c=&d=` (`live_display`, answer only after reveal), admin at
  `/live/?admin` (shared admin password; `live_admin_*`). Extra organizer/display keys live in `live_keys`.
- The free project is kept awake by `.github/workflows/keepalive.yml` (pings every 3 days).

## Testing (do this before pushing)

Chromium + Playwright are preinstalled (`NODE_PATH=$(npm root -g)`, no `playwright install`). Serve
the repo with `python3 -m http.server <port>` and drive a Pixel 7 viewport.

- Unit-ish checks: expose pure functions on `window` for tests only if needed; fixed dice by
  overriding `crypto.getRandomValues` in an init script with a queue.
- `sh tests/setup_db.sh <db>` starts the test Postgres (if needed) and builds a database with every
  schema and migration loaded (`nomigrations` as a second argument skips the migrations). Each app test's
  header says which port to serve on and which database it uses.
- Database functions: start a throwaway Postgres 16 (`/usr/lib/postgresql/16/bin/initdb` as user
  `postgres`, in a folder under `/tmp` owned by `postgres`), create roles `anon`/`authenticated`, load
  the relevant scripts (for Which Day Works?: `tests/wdw_fixture.sql`, then
  `whichdayworks/schema_snapshot.sql`, `organizer.sql`, `final_date.sql`), apply the new script twice
  (must be re-runnable), and call functions as `set role anon`.
- End to end against that database: `tests/pg_bridge.js` routes the page's RPC calls to it via psql
  (`phone(browser, devices, db)` gives a page; use several for multi-phone "play together" tests).
- Screenshot the result on a phone viewport (light and dark) and look at it before pushing.
- `tests/rsvp_test.js`: RSVP checks (see its header); `tests/rsvp_contact_test.js`: host phone/email.
  `tests/rsvp_invites_test.js`: invite list (stubbed contact picker).
- `tests/lock_test.js`: passwords in all three Plan apps (see its header; Poll uses the stand-in
  `tests/poll_fixture.sql`).

## Gotchas learned the hard way

- Full-screen game layouts: size with the measured height (`--app-h` from `innerHeight` /
  `visualViewport`), not `100dvh`; some Android installs report 100dvh including the status bar.
  Don't use `viewport-fit=cover`.
- GitHub Pages lets browsers cache pages for 10 minutes; `sw.js` fetches with `cache: 'no-cache'` so
  the installed app updates immediately. Bump `CACHE` in `sw.js` only if cached files must be dropped.
- Playwright's `route()` and offline switch don't apply to requests made by the service worker, so app
  tests use `serviceWorkers: 'block'` (pg_bridge does); `tests/sw_test.js` tests offline by stopping its server.
- Firefox shows a prompt for persistent storage; only request it there from the installed app.
- In fixed-position headers, account for the "← Pebbly" bar (`nav.js` pads `body`).
