// Network first, so updates show up right away; the cached copy is only used offline.
// Only same-origin GETs are touched — Supabase calls go straight to the network.
// GitHub Pages lets browsers reuse a page for 10 minutes; cache: 'no-cache' makes every load
// check for a newer version first (an unchanged file is a quick "not modified" reply).
const CACHE = 'pebbly-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || Response.error()))
  );
});
