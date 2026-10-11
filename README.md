# Pebbly

Static site served by GitHub Pages at https://pebbly.dev.

| Path | App |
|---|---|
| `/` | Homepage linking to every app |
| `/rsvp/` | Event invites and RSVPs (Supabase) |
| `/whichdayworks/` | Find a date that works for everyone (Supabase) |
| `/poll/` | Group polls (Supabase) |
| `/qwixx/` | Qwixx dice roller |
| `/namegame/` | The Name Game |

- Any folder with an `index.html` becomes a page (`poll/index.html` → `https://pebbly.dev/poll/`).
  When adding an app, also add a link to it on the homepage `index.html`.
- `CNAME` holds the custom domain. Don't delete it.
- `.nojekyll` tells Pages to serve files as-is (no Jekyll build).
- The Supabase apps read their project URL and publishable key from each folder's `config.js`.
  The `.sql` files in `rsvp/` are the database schema and migrations.
- `tests/rsvp_test.js` is a Playwright check for the RSVP app (see the comments at its top).
