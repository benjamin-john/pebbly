# Pebbly

Static site served by GitHub Pages at https://pebbly.dev.

| Path | App |
|---|---|
| `/` | Homepage linking to every app |
| `/rsvp/` | Event invites and RSVPs (Supabase) |
| `/whichdayworks/` | Find a date that works for everyone (Supabase) |
| `/poll/` | Group polls (Supabase) |
| `/score/` | Score Keeper: per-round scores for any game |
| `/darts/` | Darts Scorer: '01 (301/501/701/901, straight/double/master out, double in) and Cricket (standard or cut-throat) |
| `/qwixx/` | Qwixx: dice roller and/or score cards, 1+ players, rules enforced |
| `/namegame/` | The Name Game |
| `/install/` | How to add Pebbly to a phone or computer home screen |

- Any folder with an `index.html` becomes a page (`poll/index.html` → `https://pebbly.dev/poll/`).
  When adding an app, also add a link to it on the homepage `index.html`, and put
  `<script src="/nav.js"></script>` in its `<head>` for the "← Pebbly" home bar.
- `nav.js` shows that home bar only in the installed app, never in a normal browser tab.
  Add `?appnav` to a URL to preview it.
- `keepawake.js` keeps the screen on during games: call `keepAwake(true)` / `keepAwake(false)`.
- `CNAME` holds the custom domain. Don't delete it.
- `.nojekyll` tells Pages to serve files as-is (no Jekyll build).
- The Supabase apps read their project URL and publishable key from each folder's `config.js`.
  The `.sql` files in `rsvp/` are the database schema and migrations. For Which Day Works?,
  `whichdayworks/schema_snapshot.sql` records the live setup (the original scripts were never
  saved) and `whichdayworks/organizer.sql` adds organizer links.
- Installable app: `manifest.webmanifest` (name, icons, home-screen shortcuts), `icons/`, and `sw.js`
  (network-first service worker so pages still open offline). If you change cached files and they
  look stale, bump `CACHE` in `sw.js`.
- `tests/rsvp_test.js` is a Playwright check for the RSVP app (see the comments at its top).
