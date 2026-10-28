# Pebbly

Static site served by GitHub Pages at https://pebbly.dev.

| Path | App |
|---|---|
| `/` | Homepage linking to every app |
| `/rsvp/` | Event invites and RSVPs (Supabase) |
| `/whichdayworks/` | Find a date that works for everyone (Supabase) |
| `/poll/` | Group polls (Supabase) |
| `/signup/` | Sign-up Sheet: slots people sign up for from a link, live (Supabase, doc.js) |
| `/bill/` | Split the Bill: shared expenses (equal or exact splits), balances and fewest payments to settle up (Supabase, doc.js) |
| `/list/` | Shared List: groceries/packing/to-do list everyone edits live, with sections (Supabase, doc.js) |
| `/babynames/` | Baby Names: two people swipe names (stars for likes), see the ones they both like, reorder and comment; 2,700+ built-in US names with nicknames and popularity, own suggestions, AI imports (Supabase, doc.js) |
| `/santa/` | Secret Santa: names, exclusions and a private draw; each phone sees only its own match (Supabase) |
| `/teams/` | Team Picker: random teams, pick someone, shuffle turn order |
| `/timer/` | Game Timer: turn clock (time bank or per turn) and countdown with buzzer |
| `/bracket/` | Bracket: knockout tournament (2–64, seeded byes, scores), shareable live with a code |
| `/live/` | Live Quiz: Kahoot/Slido-style quiz or poll for a room; projector view with QR join, phones answer, live percentages, optional names and CSV results (Supabase `live_*`) |
| `/join/` | Join page for Live Quiz: attendees enter the 5-letter code (or scan the QR) and answer; nothing else |
| `/trivia/` | Trivia: family quiz; sets made by hand or imported from AI-written JSON; one phone or everyone's phones |
| `/score/` | Score Keeper: per-round scores for any game |
| `/darts/` | Darts Scorer: '01 (301/501/701/901, straight/double/master out, double in) and Cricket (standard or cut-throat) |
| `/codebreaker/` | Codebreaker (Mastermind-style duel): each hides a color code, fewest guesses to crack the other's wins; a friend or the computer, play together |
| `/colorstack/` | Color Stack: solo bead-sorting puzzle (any rod with room, or same color only), hints from a built-in solver, best moves |
| `/dots/` | Dots and Boxes: 2–4 players or the computer, 3×3 to 6×6 boxes, play together |
| `/gomoku/` | Gomoku: five in a row on 13/15/19 boards, a friend or the computer, play together |
| `/mancala/` | Mancala (Kalah): sowing, captures and extra turns, a friend or the computer, play together |
| `/farkle/` | Farkle: dice roller and/or scoreboard, 1+ players, standard or continue-play, editable house rules |
| `/kwiks/` | Kwiks: color-row dice game, dice roller and/or score cards, 1+ players, rules enforced |
| `/worddash/` | Word Dash: guess the five-letter word in six; practice alone (stats, streaks) or race everyone's phones on the same word, no turns |
| `/namegame/` | The Name Game |
| `/admin/` | Admin: one sign-in to see, open as host, or delete everything in every app with an admin mode |
| `/backup/` | Backup & restore: a six-word key keeps an encrypted copy of this phone's host links, names and settings, to restore on another phone (see `backup.js`) |
| `/notifications/` | Notification settings: which kinds ring the 🔔 bell, for all events or one (see `notify.js`) |
| `/install/` | How to add Pebbly to a phone or computer home screen |

- Any folder with an `index.html` becomes a page (`poll/index.html` → `https://pebbly.dev/poll/`).
  When adding an app, also add a link to it on the homepage `index.html`, and put
  `<script src="/nav.js"></script>` in its `<head>` for the "← Pebbly" home bar.
- `nav.js` shows that home bar only in the installed app, never in a normal browser tab.
  Add `?appnav` to a URL to preview it.
- **Play together** (`play/`): any game can be shared between phones with a 5-letter code.
  `play/play.sql` (run once in Supabase) stores each shared game as one JSON document with a
  version number; `play/sync.js` pushes changes, polls every 1.5 s, and merges when two phones
  change things at once. A game page hooks in with `PebblySync.wire(kind, {...})` (see Kwiks).
- **Notifications** (`notify.js`, `supabase/migrations/20261028120000_notifications.sql`): a 🔔 bell on the
  homepage and in RSVP / Which Day Works?. Database triggers record new RSVPs, changed answers, comments,
  announcements, new or changed days and the final date; the bell checks every 30 s while a page is open.
  **Phone alerts** (Web Push) send the same things to a phone's lock screen, even with Pebbly closed: turned on
  per phone on `/notifications/`, sent by the `notify-push` Edge Function (`supabase/functions/`, deployed by
  `.github/workflows/deploy-functions.yml`; setup in `supabase/README.md`).
- `doc.js`: shared JSON documents (Sign-up Sheet, Split the Bill, Shared List) with versioned merges;
  see its header.
- `lock.js` + `supabase/migrations/20261012000000_plan_passwords.sql`: optional passwords for RSVP,
  Poll and Which Day Works? (set when creating, or with 🔒 Password in the host tools).
- `keepawake.js` keeps the screen on during games: call `keepAwake(true)` / `keepAwake(false)`.
- `CNAME` holds the custom domain. Don't delete it.
- `.nojekyll` tells Pages to serve files as-is (no Jekyll build).
- The Supabase apps read their project URL and publishable key from each folder's `config.js`.
  The `.sql` files in `rsvp/` are the database schema and migrations. For Which Day Works?,
  `whichdayworks/schema_snapshot.sql` records the live setup (the original scripts were never
  saved), `whichdayworks/organizer.sql` adds organizer links and `whichdayworks/final_date.sql`
  the organizer's final pick.
- **Database changes** go in `supabase/migrations/` and are applied automatically when they reach
  `main` (Supabase GitHub integration). See `supabase/README.md`.
- Installable app: `manifest.webmanifest` (name, icons, home-screen shortcuts), `icons/`, and `sw.js`
  (network-first service worker so pages still open offline). If you change cached files and they
  look stale, bump `CACHE` in `sw.js`.
- `tests/rsvp_test.js` is a Playwright check for the RSVP app (see the comments at its top).
