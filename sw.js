// Pebbly's offline helper (service worker).
//
// Network first, so updates show up right away; the saved copy is only used offline.
// GitHub Pages lets browsers reuse a page for 10 minutes; cache: 'no-cache' makes every load
// check for a newer version first (an unchanged file is a quick "not modified" reply).
//
// Every page in PAGES (and the shared files in FILES) is saved as soon as this helper starts, and
// refreshed about once a day, so all of Pebbly opens offline, even pages never opened before.
// Shared apps (RSVP, lists, …) still need the internet for their data. Add every new app to PAGES
// (tests/sw_test.js checks). Supabase calls are never touched. Google Fonts are kept in their own
// cache so pages look the same offline.
const CACHE = 'pebbly-v3';
const FONTS = 'pebbly-fonts';
const PAGES = ['/', '/install/',
  '/rsvp/', '/whichdayworks/', '/poll/', '/signup/', '/bill/', '/list/', '/santa/',
  '/bracket/', '/codebreaker/', '/colorstack/', '/darts/', '/dots/', '/farkle/', '/gomoku/', '/mancala/', '/timer/', '/kwiks/', '/namegame/', '/score/', '/teams/', '/trivia/', '/live/', '/join/', '/admin/',
  '/qwixx/'];
const FILES = ['/theme.js', '/nav.js', '/keepawake.js', '/play/sync.js', '/lock.js', '/doc.js', '/migrate.js',
  '/rsvp/config.js', '/poll/config.js', '/whichdayworks/config.js',
  '/manifest.webmanifest', '/icons/favicon.png', '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/maskable-192.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'];
const STAMP = '/__pebbly_saved_at';
const DAY = 24 * 60 * 60 * 1000;

// Save (or refresh) everything. One missing file doesn't stop the rest.
function saveAll() {
  return caches.open(CACHE).then(c => Promise.allSettled(PAGES.concat(FILES).map(url =>
    fetch(url, { cache: 'no-cache' }).then(res => { if (res.ok) return c.put(url, res); })
  )).then(() => c.put(STAMP, new Response(String(Date.now())))));
}
function refreshIfOld() {
  return caches.open(CACHE).then(c => c.match(STAMP)).then(r => r ? r.text() : '0')
    .then(t => { if (Date.now() - Number(t) > DAY) return saveAll(); }).catch(() => {});
}

self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(saveAll().catch(() => {})); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;

  // Google Fonts: use the saved copy right away, refresh it in the background.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(c => c.match(req).then(hit => {
      const fresh = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; });
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh;
    })));
    return;
  }
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') e.waitUntil(refreshIfOld());
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r ||
      (req.mode === 'navigate' ? caches.match('/') : null)).then(r => r || Response.error()))
  );
});
