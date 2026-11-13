// Basecamp (/basecamp/): two phones on one map. Starting a map, joining from the link, live dots
// (positions moved with Playwright geolocation), distance in the People list, jump to a person,
// waypoints (Pin at my spot, long-press, edit, someone else can't edit, host can delete), hiding other
// people's waypoints and trails, recording a trail (auto-stop when leaving the screen), map types
// (Map/Satellite/Topo, all map servers stubbed), heading-up mode from a fake compass, offline area
// download (tiles end up in Cache Storage) and reopening with no signal, password, host tools, admin.
// Setup: sh tests/setup_db.sh basecamp; serve the repo root on port 8791 (python3 -m http.server 8791), then:
//   NODE_PATH=$(npm root -g) node tests/basecamp_test.js
// Optional: DB=<name> PORT=<port> SHOTS=<folder for screenshots>
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const zlib = require('zlib');
const DB = process.env.DB || 'basecamp', PORT = process.env.PORT || 8791, BASE = 'http://localhost:' + PORT + '/basecamp/', SHOTS = process.env.SHOTS;
let pass = 0, fail = 0;
const check = (ok, m) => { if (ok) pass++; else { fail++; console.log('FAIL', m); } };
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name + '.png' }); };
async function until(p, fn, arg, ms) { try { await p.waitForFunction(fn, arg, { timeout: ms || 8000 }); return true; } catch (e) { return false; } }

function png(r, g, b) {
  const w = 256, h = 256, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  const crc = buf => { let x = 0xffffffff; for (const v of buf) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const SAT = png(74, 112, 64), TOPO = png(232, 226, 204);
const hits = { sat: 0, topo: 0, vec: 0 };
let offline = false;
async function stubMaps(ctx) {
  await ctx.route('https://basemap.nationalmap.gov/**', r => {
    if (offline) return r.abort('internetdisconnected');
    const sat = r.request().url().includes('Imagery'); hits[sat ? 'sat' : 'topo']++;
    r.fulfill({ status: 200, contentType: 'image/png', body: sat ? SAT : TOPO });
  });
  await ctx.route('https://tiles.openfreemap.org/**', r => {
    if (offline) return r.abort('internetdisconnected');
    const u = r.request().url();
    if (u.includes('/styles/')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 8,
      sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sprite: 'https://tiles.openfreemap.org/sprites/ofm/ofm',
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f2efe6' } },
        { id: 'pl', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', layout: { 'text-field': '{name}', 'text-font': ['Noto Sans Regular'] } }] }) });
    if (u.endsWith('/planet')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tiles: ['https://tiles.openfreemap.org/planet/v1/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 }) });
    if (u.includes('/planet/')) { hits.vec++; return r.fulfill({ status: 200, contentType: 'application/x-protobuf', body: Buffer.alloc(0) }); }
    return r.fulfill({ status: 404, body: '' });
  });
  await ctx.route('https://static.cloudflareinsights.com/**', r => r.abort());
}
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

(async () => {
  const browser = await chromium.launch({ args: GL });
  const mk = async (lat, lng) => {
    const p = await phone(browser, devices, DB, { geolocation: { latitude: lat, longitude: lng, accuracy: 6 }, permissions: ['geolocation'] });
    await stubMaps(p.context()); return p;
  };
  const ben = await mk(45.05, -93.2), amy = await mk(45.052, -93.198);

  // ---- start a map
  await ben.goto(BASE);
  await ben.click('#createForm [type=submit]');
  check((await ben.textContent('#formErr')).includes('name'), 'asks for a map name');
  await ben.fill('[name=name]', 'Deer camp'); await ben.fill('[name=who]', 'Ben');
  await ben.click('#createForm [type=submit]');
  await ben.waitForSelector('#map canvas');
  const code = new URL(ben.url()).searchParams.get('m');
  check(/^[a-z0-9]{8}$/.test(code || ''), 'map code in the link: ' + code);
  check(await until(ben, () => __bc.state() && __bc.state().members[0] && __bc.state().members[0].lat === 45.05), 'Ben’s location reaches the server');
  check(await until(ben, () => document.querySelector('.pm.me .lbl') && document.querySelector('.pm.me .lbl').textContent === 'You'), 'Ben sees his own dot');
  check(hits.sat > 0, 'satellite is the default map type');
  await shot(ben, 'map');

  // ---- Amy joins
  await amy.goto(BASE + '?m=' + code);
  await amy.waitForSelector('#joinForm');
  check((await amy.textContent('h1')) === 'Deer camp', 'join screen shows the map name');
  await amy.fill('#joinForm [name=who]', 'Amy');
  await amy.click('#joinForm [type=submit]');
  await amy.waitForSelector('#map canvas');
  check(await until(ben, () => __bc.state().members.length === 2 && __bc.state().members[1].lat != null, null, 10000), 'Ben sees Amy');
  check(await until(ben, () => [...document.querySelectorAll('.pm .lbl')].some(e => e.textContent.startsWith('Amy'))), 'Amy’s dot is on Ben’s map');
  check(await until(amy, () => /2 people/.test(document.querySelector('#sync').textContent)), 'Amy’s header counts 2 people');

  // People list: distance + direction, jump to a person
  await ben.click('#peopleBtn');
  await ben.waitForSelector('#plist [data-person]');
  const row = await ben.textContent('#plist li:nth-child(2)');
  check(/Amy/.test(row) && /yd/.test(row) && /NE/.test(row), 'People list shows Amy’s distance and direction: ' + row);
  await ben.click('#plist li:nth-child(2) .row');
  await ben.waitForTimeout(1200);
  const c1 = await ben.evaluate(() => __bc.map().getCenter());
  check(Math.abs(c1.lat - 45.052) < 0.0005 && Math.abs(c1.lng + 93.198) < 0.0005, 'tapping Amy flies to her');

  // Amy moves
  await amy.context().setGeolocation({ latitude: 45.053, longitude: -93.198, accuracy: 5 });
  check(await until(ben, () => { const a = __bc.state().members[1]; return a.lat === 45.053; }, null, 12000), 'Amy’s move shows on Ben’s phone');

  // ---- waypoints
  await ben.click('#pinBtn');
  await ben.waitForSelector('#wpForm');
  check((await ben.textContent('#wpWhere')).includes('At your location'), 'Pin starts at my spot');
  await ben.click('#wpForm .icons label:nth-child(3)');   // 🦌
  await ben.fill('#wpForm [name=name]', 'Big buck');
  await ben.fill('#wpForm [name=note]', 'Saw him at dawn');
  await ben.click('#wpForm [type=submit]');
  check(await until(amy, () => [...document.querySelectorAll('.wp .lbl')].some(e => e.textContent === 'Big buck'), null, 10000), 'Amy sees Ben’s waypoint');
  // long-press on Amy's map adds one there
  const box = await amy.locator('#map canvas').boundingBox();
  await amy.evaluate(([x, y]) => {
    const el = document.querySelector('.maplibregl-canvas-container');
    const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true }));
  }, [box.x + 100, box.y + 300]);
  await amy.waitForTimeout(800);
  check(await amy.isVisible('#wpForm'), 'long-press opens a new waypoint');
  await amy.fill('#wpForm [name=name]', 'Truck');
  await amy.click('#wpForm .icons label:nth-child(2)');
  await amy.click('#wpForm [type=submit]');
  check(await until(ben, () => __bc.state().waypoints.some(w => w.name === 'Truck'), null, 10000), 'Ben gets Amy’s waypoint');
  // Amy can't edit Ben's; she sees distance
  await amy.evaluate(() => { const w = __bc.state().waypoints.find(x => x.name === 'Big buck'); document.querySelectorAll('.wp').forEach(e => { if (e.textContent.includes('Big buck')) e.click(); }); });
  await amy.waitForSelector('#wGo');
  check(!(await amy.isVisible('#wEdit')), 'Amy can’t edit Ben’s waypoint');
  check(/Saw him at dawn/.test(await amy.textContent('dialog.sheet')) && /of you/.test(await amy.textContent('dialog.sheet')), 'waypoint sheet shows note and distance');
  await amy.click('dialog.sheet [data-close]');
  // Ben (host) edits Amy's
  await ben.evaluate(() => document.querySelectorAll('.wp').forEach(e => { if (e.textContent.includes('Truck')) e.click(); }));
  await ben.waitForSelector('#wEdit');
  await ben.click('#wEdit');
  await ben.fill('#wpForm [name=name]', 'Truck (Amy)');
  await ben.click('#wpForm [type=submit]');
  check(await until(amy, () => __bc.state().waypoints.some(w => w.name === 'Truck (Amy)'), null, 10000), 'host can edit anyone’s waypoint');
  // hide others' waypoints on Amy's phone
  await amy.click('#showBtn');
  await amy.uncheck('[data-ui=othersWp]');
  check(await until(amy, () => ![...document.querySelectorAll('.wp .lbl')].some(e => e.textContent === 'Big buck') && [...document.querySelectorAll('.wp .lbl')].some(e => e.textContent === 'Truck (Amy)')), 'hiding other people’s waypoints keeps mine');
  await amy.check('[data-ui=othersWp]');
  await amy.click('dialog.sheet [data-close]');

  // ---- trails
  await amy.click('#trailBtn');
  check(await amy.evaluate(() => !!__bc.rec()), 'trail recording starts');
  for (let i = 1; i <= 4; i++) { await amy.context().setGeolocation({ latitude: 45.053 + i * 0.0002, longitude: -93.198 + i * 0.0001, accuracy: 5 }); await amy.waitForTimeout(400); }
  check(/Stop · \d+ yd/.test(await amy.textContent('#trailBtn')), 'trail button shows distance: ' + await amy.textContent('#trailBtn'));
  check(await until(ben, () => Object.values(__bc.state().pts).some(a => a.length >= 4), null, 12000), 'Ben receives Amy’s trail points');
  check(await until(ben, () => __bc.drawnTrails() === 1), 'Ben’s map draws Amy’s trail');
  await shot(ben, 'trail');
  // leaving the screen stops it
  await amy.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  check(await amy.evaluate(() => !__bc.rec()), 'leaving the screen stops the trail');
  await amy.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  check(await until(amy, () => /trail stopped/.test(document.querySelector('#notes').textContent)), 'coming back says the trail stopped');
  // Ben hides others' trails
  await ben.click('#showBtn');
  check(/Amy · \d+ yd/.test(await ben.textContent('#tlist')), 'trail list shows Amy’s trail');
  await ben.uncheck('[data-ui=othersTrails]');
  check(await ben.evaluate(() => __bc.drawnTrails() === 0), 'hiding other people’s trails');
  await ben.check('[data-ui=othersTrails]');
  await ben.click('dialog.sheet [data-close]');

  // ---- map types
  await ben.click('.layers [data-layer=topo]');
  check(await until(ben, () => true) && (await ben.waitForTimeout(1500), hits.topo > 0), 'Topo loads USGS topo tiles');
  await ben.click('.layers [data-layer=map]');
  await ben.waitForTimeout(2000);
  check(hits.vec > 0, 'Map loads OpenFreeMap tiles');
  check(await ben.evaluate(() => !!__bc.map().getSource('trails')), 'trails stay after switching map type');
  await ben.click('.layers [data-layer=sat]');

  // ---- heading-up
  await ben.click('#compass');
  check(await ben.evaluate(() => __bc.mode()) === 'heading', 'compass button turns on heading-up');
  await ben.evaluate(() => { for (let i = 0; i < 8; i++) __bc.orient({ type: 'deviceorientationabsolute', absolute: true, alpha: 270 }); });   // facing east
  await ben.waitForTimeout(300);
  const b = await ben.evaluate(() => __bc.map().getBearing());
  check(Math.abs(b - 90) < 3, 'map turns to face east: ' + b);
  check(await until(ben, () => { const s = __bc.state().members[0]; return s.heading != null && Math.abs(s.heading - 90) < 3; }, null, 10000), 'Ben’s direction is shared');
  check(await until(amy, () => { const c = [...document.querySelectorAll('.pm')].find(e => e.textContent.includes('Ben')); return c && c.querySelector('.cone').style.display !== 'none'; }, null, 10000), 'Amy sees Ben’s direction cone');
  await ben.click('#compass');
  await ben.waitForTimeout(500);
  check(Math.abs(await ben.evaluate(() => __bc.map().getBearing())) < 1, 'north-up again');

  // ---- offline download
  await ben.evaluate(() => __bc.map().jumpTo({ center: [-93.199, 45.051], zoom: 16 }));
  await ben.click('#moreBtn'); await ben.click('#mOffline');
  await ben.waitForSelector('#aEst');
  check(/MB|KB/.test(await ben.textContent('#aEst')), 'offline estimate: ' + await ben.textContent('#aEst'));
  await ben.click('[data-det=normal]');
  await ben.click('#aGo');
  check(await until(ben, () => /works offline/.test(document.querySelector('#aProgT').textContent), null, 60000), 'download finishes: ' + await ben.textContent('#aProgT'));
  const nCached = await ben.evaluate(() => caches.open('pebbly-maps').then(c => c.keys()).then(k => k.filter(r => r.url.includes('bc.tiles/sat/')).length));
  const plan = await ben.evaluate(() => __bc.areas()[0]);
  check(nCached > 10 && plan.tiles > 10, 'satellite tiles saved: ' + nCached + ' of plan ' + plan.tiles);
  check(/Deer camp/.test(await ben.textContent('#areaList')), 'saved area listed');
  await shot(ben, 'offline');
  await ben.click('dialog.sheet [data-close]');

  // reopen with no signal: tiles from the phone, the map from what it saw last
  await ben.evaluate(() => new Promise(r => setTimeout(r, 100)));
  await ben.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });   // snapshot timer starts
  await ben.waitForTimeout(16000);
  offline = true;
  await ben.context().route('https://xujtuijpbwujduuzlwat.supabase.co/**', r => r.abort('internetdisconnected'));
  const before = hits.sat;
  await ben.reload();
  check(await until(ben, () => document.querySelector('#sync') && /No signal/.test(document.querySelector('#sync').textContent), null, 15000), 'opens with no signal');
  check(await ben.evaluate(() => __bc.state().waypoints.length) >= 2, 'waypoints shown from last time');
  await ben.waitForTimeout(2500);
  check(hits.sat === before, 'no tile requests reached the network');
  const shown = await ben.evaluate(() => __bc.fromPhone());
  check(shown > 0, 'satellite tiles drawn from the phone: ' + shown);
  // pin while offline: queued, sent when signal returns
  await ben.click('#pinBtn'); await ben.fill('#wpForm [name=name]', 'Offline pin'); await ben.click('#wpForm [type=submit]');
  check((await ben.evaluate(() => __bc.queue().ops.length)) === 1, 'offline pin waits to be sent');
  await ben.context().unroute('https://xujtuijpbwujduuzlwat.supabase.co/**');
  offline = false;
  check(await until(amy, () => __bc.state().waypoints.some(w => w.name === 'Offline pin'), null, 15000), 'offline pin arrives when the signal is back');

  // ---- host tools: password, clear, delete area
  await ben.click('#moreBtn');
  check(await ben.isVisible('#hLock'), 'host tools for Ben');
  await ben.click('#hLock');
  await ben.waitForSelector('.pl-dlg [type=submit]:not([disabled])');
  await ben.fill('.pl-dlg [name=pw]', 'antlers');
  await ben.click('.pl-dlg [type=submit]');
  await ben.waitForTimeout(800);
  const carl = await mk(45.05, -93.2);
  await carl.goto(BASE + '?m=' + code);
  await carl.waitForSelector('.pl-gate');
  check(true, 'password screen for a new phone');
  await carl.fill('.pl-form [name=pw]', 'antlers'); await carl.click('.pl-form [type=submit]');
  await carl.waitForSelector('#joinForm');
  check(true, 'password lets them in');
  check(await until(ben, () => /live/.test(document.querySelector('#sync').textContent) && !document.querySelector('.pl-gate'), null, 8000), 'host keeps going after adding a password');
  await amy.waitForSelector('.pl-gate', { timeout: 10000 });
  check(true, 'Amy (already on the map) is asked for the new password');
  await amy.fill('.pl-form [name=pw]', 'antlers'); await amy.click('.pl-form [type=submit]');
  await amy.waitForSelector('#map canvas');
  check(await until(amy, () => /live/.test(document.querySelector('#sync').textContent), null, 10000), 'Amy is back on the map without joining again');
  await amy.click('#moreBtn');
  check(!(await amy.isVisible('#hLock')), 'no host tools for Amy');
  await amy.click('dialog.sheet [data-close]');
  await ben.evaluate(() => window.confirm = () => true);
  await ben.click('#moreBtn'); await ben.click('#hClearT');
  check(await until(amy, () => __bc.state().trails.length === 0, null, 10000), 'host clears all trails');
  await ben.click('#moreBtn'); await ben.click('#mOffline');
  await ben.click('[data-adel]');
  check(await until(ben, () => !document.querySelector('[data-adel]')), 'saved area deleted');
  const left = await ben.evaluate(() => caches.open('pebbly-maps').then(c => c.keys()).then(k => k.filter(r => r.url.includes('bc.tiles/sat/')).length));
  check(left === 0, 'its tiles are gone: ' + left);
  await ben.click('dialog.sheet [data-close]');

  // dark mode screenshot
  await amy.emulateMedia({ colorScheme: 'dark' });
  await amy.click('#peopleBtn'); await shot(amy, 'people-dark'); await amy.click('dialog.sheet [data-close]');

  // Amy leaves
  await amy.evaluate(() => window.confirm = () => true);
  await amy.click('#moreBtn'); await amy.click('#mLeave');
  check(await until(ben, () => __bc.state().members.length === 1, null, 10000), 'Amy left the map');

  [ben, amy, carl].forEach((p, i) => check(!p.errs.length, 'page errors on phone ' + i + ': ' + p.errs.join(' | ')));
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
