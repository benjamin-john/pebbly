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
| `index.html` | Homepage: "Yours" (every event/list/map on this phone, from each app's saved recent list; `MINE` table), then "Plan" and "Play" lists of app cards. Add new apps here (and to `MINE` + nav.js `OPEN` if they have shareable sessions). |
| `<app>/index.html` | Each app is one self-contained HTML file (inline CSS and JS, no build step). |
| `nav.js` | In the installed app, adds the "← Pebbly" home bar; also asks for persistent storage, and notes when an event/list/map is opened (`pebbly_home_opened`; reopening one removed from "Yours" brings it back, `pebbly_home_hidden`). Include in every app's `<head>`. Test: `tests/home_test.js`. |
| `theme.js` | Applies the homepage's Theme switch (Auto/Light/Dark) before the page draws. |
| `keepawake.js` | `keepAwake(true/false)`: Screen Wake Lock while a game is on screen. |
| `play/sync.js`, `play/play.sql` | "Play together": share any game between phones with a 5-letter code. |
| `doc.js` | Shared documents for Sign-up Sheet, Split the Bill, Shared List (doc_* functions): open/change/merge, host keys. Keep lists as objects keyed by id. |
| `lock.js` | Optional passwords for the Plan apps (gate screen, host's 🔒 Password dialog, key storage). |
| `basecamp/` | Basecamp: live group map with waypoints, trails and offline maps (see "Basecamp" below). |
| `admin/` | One admin page for every app with an admin mode (shared admin password): a section per app (list, open as host, delete). Add new apps' admin functions to `APPS` there. Shared documents and Secret Santa use `doc_admin_*` / `santa_admin_*`: their admin key is `admin_hash` (host checks go through `_doc_is_owner`). Baby Names is list-and-delete only (private; `doc_admin_grant` refuses it). |
| `notify.js`, `notifications/` | The 🔔 bell (homepage, RSVP, Which Day Works?, Poll, Sign-up Sheet, Secret Santa; Bracket alerts) and its settings page. See "Notifications" below. |
| `backup.js`, `backup/` | Backup & restore: a six-word key keeps an encrypted copy of the phone's Pebbly data in the database. See "Backups" below. |
| `migrate.js` | Merges saved data forwarded from benjamin-john.com (RSVP/Poll/Which Day Works? only). |
| `sw.js` | Service worker (registered by the homepage and `nav.js`): network-first with `cache: 'no-cache'` (updates show right away); saves every page in `PAGES` plus shared files and Google Fonts up front and refreshes them daily, so all of Pebbly opens offline. |
| `manifest.webmanifest`, `icons/` | Installable app (PWA). Shortcuts list in the manifest. |
| `supabase/migrations/` | Database changes; applied automatically on push to `main` (see below). |
| `supabase/functions/` | Edge Functions (`notify-push`: phone alerts; `owntracks`: Basecamp screen-off sharing). Deployed by `.github/workflows/deploy-functions.yml` (needs the `SUPABASE_ACCESS_TOKEN` repo secret; see `supabase/README.md`). |
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
2. Anything the app keeps in localStorage under a `pebbly_` name is backed up (`backup.js`); add in-progress game
   state or per-phone keys to `SKIP` there (undo stacks ending `_undo` are skipped already).
   Add a card to `index.html` (Plan or Play), a row to README.md, its folder to `PAGES` in `sw.js`
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
After a win it shows the fewest possible moves: `fewest()` (exact A*, run in a Blob worker built from its own
source) stops at a memory cap; big puzzles (e.g. 8 colors, 1 empty rod) then show the computer's best instead.
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
  baseline and are reference only. Poll's original setup was never saved either; `poll/schema_snapshot.sql`
  records it (dumped 2026-10-29; tests load it through `tests/poll_fixture.sql`). The shared admin-password setup
  (`_admin_check`, `admin_config`) was never saved to the repo; to change it, ask Ben for a dump
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
- **Baby Names** (`/babynames/`, doc kind `names`): one shared document per couple; votes are compact
  (`votes.a/b[key] = 0` for no, 1–5 stars). Names are keyed by `key()` (lower case, letters only). The built-in
  catalog (US SSA data, nicknames from the `nicknames-curated` package) is inline in the page; the document only holds
  names the couple added, extra nicknames, AI lists, order, comments. New names (typed or from AI) match an existing
  row by name, then by nickname (`findMatch`). Test: `tests/babynames_test.js`.
- **Notifications** (`notifications`, `notify_types`, `notify_off`; `notify.js`): one table for every app. Rows are
  added by triggers on each app's tables (so app functions don't change), each for the event's hosts or for everyone
  who responded (`audience` 'host'/'guest'). Phones read only through `notify_feed` (one call for all their events:
  host key (admin "open as host" keys count too), or participant id that has responded plus the lock key if the event
  has a password). A refused event is asked about again after a day. The actor's participant id is stored so your own actions don't ring your bell, never returned.
  "Seen" is per phone (localStorage `pebbly_notify_seen`); turned-off kinds are per event and key on the server
  (`notify_set_off`), so later email/Web Push senders can respect them (`emailed_at`/`pushed_at` columns are for
  those). Pages register events with `PebblyNotify.feed(app, code, role, key, pid)` and place
  `<span data-pn-bell data-app data-code>`; the page reloads its data on the `pebbly-notify-new` event. A new kind is a
  `notify_types` row + trigger (new migration) and a `TYPES` entry in `notify.js` (wording, icon, section to scroll to,
  settings label). Quick repeat changes from the same person within 10 minutes merge into one item.
  Kinds so far: RSVP (new/changed RSVP, comment, someone offers to bring something → host; announcement → guests), Which Day Works? (new/changed days →
  organizer; final date → guests), Poll (winner → voters; someone adds a choice → host), Sign-up Sheet (someone signs up → host; it's a shared
  document, so the trigger compares `signups` before and after), Secret Santa (names drawn → people who picked their
  name; never says who has whom), Bracket (champion → every phone in a shared bracket except the one that recorded it;
  the page keeps `champ: {id, name, by}` in the shared game for this; phones are checked by their play_members key). Basecamp (someone asks where you are → just that person:
  `notifications.recipient` = their member id; feeds are role 'guest' with the member key, `_notify_member` works out the id
  from it for `notify_feed` and `push_targets.pid`; `bc_ask`, once per 2 min per pair, `20261117010000_basecamp_ask.sql`). `APPS` in notify.js has each app's page, link parameter and host-key storage
  (`_notify_title` in SQL has its name and emoji). A role with no kinds isn't followed. Tests: `tests/notify_test.js`,
  `tests/notify_apps_test.js`.
- **Phone alerts** (Web Push; `supabase/migrations/20261028180000_notify_push.sql`, `supabase/functions/notify-push/`):
  a phone turns them on from `/notifications/` (`PebblyNotify.push`), sending its push subscription and its events
  (`notify_push_sync`, again when they change and once a day); each becomes a `push_targets` row. A trigger on
  `notifications` calls the function through `pg_net` (only if that event has targets); the function claims waiting
  rows (`notify_push_queue`: same rules as the bell, items over an hour old are skipped), encrypts and sends them
  (`webpush.js`: WebCrypto only, RFC 8291/8292; checked against the RFC's test vector), and deletes subscriptions the
  push service says are gone. Its VAPID key pair is made on first use and kept in `push_config` (service role only).
  The push carries facts; `sw.js` imports `notify.js` for the wording (`alertView`), so alerts read like the bell.
  `notify_push_sync` only accepts real push-service addresses. `handler.js` has no Deno-only code, so
  `tests/push_test.js` runs it in Node with stand-ins for Supabase and the push service; its service-worker check
  needs `chromium.launch({ channel: 'chromium' })` (the headless shell always refuses notifications).
  After a guest replies to an RSVP, the page offers to turn alerts on (`offerAlerts`; "Not now" hides it for 30 days).
- **Backups** (`backups` table, `backup_*`; `backup.js`, `/backup/`): six words (BIP39 English list, inline; first four
  letters identify a word) → PBKDF2 (200k, SHA-256) → 64 bytes: the row id (hex) and an AES-GCM key. The words stay on
  the phone (`pebbly_backup`); the database holds only the id and ciphertext. Copies merge (`merge`: lists and objects
  added together; single values: this phone's when saving, the backup's when restoring, so a restored phone gets its
  old guest ids back); `version` catches two phones saving at once. nav.js loads backup.js on every page once a phone
  has a key; it saves on load, every minute while open and when leaving, only if something changed. Never back up
  admin passwords (they're in sessionStorage). Test: `tests/backup_test.js`.
- **Basecamp** (`/basecamp/`, `bc_*`, `supabase/migrations/20261113220000_basecamp.sql`): live group map. A phone joins
  (`bc_join`, hashed member key in `pebbly_basecamp_me`) and calls `bc_sync` every 3 s: its location and new trail points
  go up, everyone's locations come back, plus waypoints/trails when `rev` changed and trail points newer than `p_since`
  (point inserts take a per-map advisory lock so ids arrive in order). Waypoint and trail ids are made on the phone, and
  changes wait in `pebbly_basecamp_queue` when there's no signal. Maps are never deleted automatically (Ben's choice: keep
  people's waypoints); only the host (`bc_host`) or admin removes them. Browsers only share location while the page is on
  screen, so a trail stops when you leave the screen. Map: MapLibre GL JS, vendored in `basecamp/maplibre/` (offline).
  Layers: OpenFreeMap vector "liberty" (Map), USGS ImageryOnly (Satellite) and USGSTopo (Topo), all no-account. Every
  map request goes through the page's `bc://` protocol: tiles come from Cache Storage first (`pebbly-maps` for downloaded
  areas and style files, `pebbly-maps-seen` for the newest 10,000 viewed tiles; Offline maps shows both sizes and can clear the seen cache) under fixed keys `https://bc.tiles/<layer>/z/x/y`;
  missing photo tiles are cut from a parent tile. USGS ImageryOnly only has tiles to z16 (blurry closer in), so inside
  Minnesota (z>=12, `satLayer`) Satellite uses MnGeo's free WMS (`imageserver.gisdata.mn.gov`, layer `fsa2025`: USDA
  NAIP 2025, ~2 ft/px, 512px GetMap per tile, key `mn`); pieces under ~6 KB are blank (outside the photos) and fall
  back to USGS, never saved. USGS's own NAIP ImageServer is too slow (~20 s per image) to use live. Never save empty tiles (an empty saved tile is treated as missing and refetched; an
  early version saved empty ones and the street map showed white). Marker CSS must not set `position` on the marker root
  (it overrides MapLibre's absolute positioning and markers drift with zoom; the test checks every dot's pixel spot).
  Public land: USGS PAD-US feature service (`PADUS_Public_Access`, services.arcgis.com, public domain, CORS open), fetched as
  GeoJSON per z11 square (private land left out), cached like tiles (`https://bc.tiles/pad/11/x/y`, offline downloads too),
  colored by manager type (toggle in the ☰ More menu; the color key shows on the map while on); tapping shows name, manager, access. PAD-US marks MN WMAs "restricted", so never present
  access as hunting permission (the sheet says to check DNR rules). Its tile service only goes to ~z10, hence features.
  Screen-off sharing (`supabase/migrations/20261115000000_basecamp_owntracks.sql`, `supabase/functions/owntracks/`): the free
  OwnTracks app in HTTP mode POSTs reports to the `owntracks` Edge Function (no JWT; personal key `?k=` from
  `bc_ot_link`, hash in `bc_members.ot_hash`), which calls `bc_owntracks` (service role only) for each. Newer reports
  move the dot; `ot_trail` also records trails (new trail after 30 min, point per 10 m). "Hide my location" sets
  `bc_members.hidden`, which OwnTracks reports respect. While Basecamp itself sent the person's location in the last 30 s (`bc_members.web_at`,
  `20261115010000_basecamp_ot_prefer_app.sql`), OwnTracks reports are dropped (dot and trail), so the app's GPS wins. The setup link is `owntracks:///config?inline=<base64 config>`
  (or a .otrc file; it allows remote commands: `cmd`, `remoteConfiguration`). `bc_owntracks` returns `{status, reply}` and the
  receiver sends `reply` (OwnTracks commands) back: after `ot_until` (picked at setup: today / 3 days / a week;
  `bc_ot_extend`; "Until I stop" = p_minutes 0 = `ot_until` null, `20261116010000_basecamp_ot_forever.sql`) or for unknown keys (left the map, taken off, map deleted) → setConfiguration monitoring -1 (Quiet); while nobody has had the map open for
  12 hours (`20261116020000_basecamp_ot_slow_12h.sql`; was 30 min) (`bc_sessions.viewed_at`, touched by `bc_sync`) → "report less" once; someone looks → normal settings at the
  next report (Move mode restored from the report's `m`). OwnTracks only hears replies to its own reports.
  (`20261116000000_basecamp_ot_limits.sql`.)
  One OwnTracks setup per phone feeds every map it's turned on in (`20261117000000_basecamp_ot_devices.sql`): `bc_ot_devices`
  (hashed key, pace, mode) ← `bc_members.ot_device`; the phone keeps its key in `pebbly_basecamp_otdev` (not backed up) and
  other maps join with `bc_ot_link(..., p_device)`. Each report goes to every attached map (`_bc_ot_apply`); a map leaves
  when its `ot_until` passes or on Stop/leave/delete; Quiet only when none is left (the device row is then deleted);
  pace is normal if any of its maps was viewed in 12 h.
  Tests: `tests/owntracks_test.js` (handler in Node), Basecamp test (flow via psql as service_role).
  Trail hand-off (`20261117020000_basecamp_trail_handoff.sql`): with screen-off sharing on, starting the Trail button tells the
  server the trail id (`bc_ot_follow` → `bc_members.ot_follow`); OwnTracks reports then add to that trail (Basecamp's own
  points still win while on screen), leaving the screen doesn't stop it, and `me.ot_follow` makes a reopened map resume
  it (`resumeTrail`). Stop clears it; 30 min without reports ends it. Ben doesn't want automatic trails: the old "record my
  trail while the screen is off" option (`ot_trail`) is gone from the page and switched off (`20261117030000`); the server
  still supports it. Trail points are drawn in time order.
  Someone with screen-off sharing on whose OwnTracks and Basecamp have both been silent for over an hour (`lost()`) shows a
  red ring and "No word from OwnTracks" in People.
  Waypoint and person sheets have "Open in Google Maps" (`gmapsUrl`: google.com/maps/search/?api=1&query=lat,lng, opens the
  app on phones); long-pressing the map opens a spot sheet (distance, Add a waypoint here, Google Maps, Copy coordinates).
  "Ask for location" (person sheet → `bc_ask`): the person gets a 🔔/phone alert; opening it opens the map, which shares while
  open (a browser can't read location from an alert). Basecamp has a bell in its header and registers the phone with
  `PebblyNotify.feed('basecamp', code, 'guest', memberKey, memberId)`.
  Zoom: a slim + / − column (`.zoomfab`) on the right just above the location button, for one-handed use.
  Sync cadence (`syncEvery`): 3 s, 15 s with Battery saver (`pebbly_basecamp_ui.saver`), 10 s when nobody moved >10 m for 2 min.
  The Saved sheet (Waypoints / Trails tabs) hides items per phone (`pebbly_basecamp_ui.hidden`). `sw.js` must not delete `pebbly-maps*` caches. The last data seen is
  kept for opening with no signal. Heading-up uses GPS heading when moving, else `deviceorientationabsolute` (iPhone:
  `webkitCompassHeading` after a tap). Test: `tests/basecamp_test.js` (map servers stubbed; WebGL via SwiftShader flags).
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
