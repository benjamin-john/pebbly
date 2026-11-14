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
const { spawnSync } = require('child_process');
// what the OwnTracks receiver (supabase/functions/owntracks) does with one report: bc_owntracks as service_role
function owntracks(token, body) {
  const lit = (x) => "'" + String(x).replace(/'/g, "''") + "'";
  const r = spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', process.env.DB || 'basecamp', '-At', '-v', 'ON_ERROR_STOP=1'],
    { input: `set role service_role;\nselect bc_owntracks(${lit(token)}, ${lit(JSON.stringify(body))}::jsonb)->>'status';`, encoding: 'utf8' });
  return r.stdout.trim().split('\n').pop();
}
// as if Basecamp last sent this person's location more than 30 seconds ago (they left the screen)
function leftScreen(name) {
  spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', process.env.DB || 'basecamp', '-At'],
    { input: `update bc_members set web_at = now() - interval '31 seconds' where name = '${name}';`, encoding: 'utf8' });
}
async function setVisible(p, on) {
  await p.evaluate(v => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v ? 'visible' : 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }, on);
}
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
// Minnesota photos stand-in: noisy (so it isn't mistaken for a blank piece, which is ~5 KB); blank outside Minnesota
function noisePng(n) {
  const w = n, h = n, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (Math.random() * 256) | 0;
  const t = []; for (let k = 0; k < 256; k++) { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[k] = c >>> 0; }
  const crc = buf => { let x = 0xffffffff; for (const v of buf) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const MNPHOTO = noisePng(64), BLANK = png(255, 255, 255);
const hits = { sat: 0, topo: 0, vec: 0, pad: 0, mn: 0, mnblank: 0 };
// stand-in for USGS PAD-US: one state wildlife area around the test spot, one county park inside it
const PAD = { type: 'FeatureCollection', features: [
  { type: 'Feature', id: 11, properties: { OBJECTID: 11, Unit_Nm: 'Test Lake State Wildlife Management Area', Pub_Access: 'RA', MngNm_Desc: 'State Fish and Wildlife', MngTp_Desc: 'State', DesTp_Desc: 'State Conservation Area', GIS_Acres: 640 },
    geometry: { type: 'Polygon', coordinates: [[[-93.21, 45.04], [-93.19, 45.04], [-93.19, 45.06], [-93.21, 45.06], [-93.21, 45.04]]] } },
  { type: 'Feature', id: 12, properties: { OBJECTID: 12, Unit_Nm: 'Pine Grove County Park', Pub_Access: 'OA', MngNm_Desc: 'County Land', MngTp_Desc: 'Local Government', DesTp_Desc: 'Local Park', GIS_Acres: 40 },
    geometry: { type: 'Polygon', coordinates: [[[-93.2095, 45.0405], [-93.2075, 45.0405], [-93.2075, 45.0425], [-93.2095, 45.0425], [-93.2095, 45.0405]]] } },
  // closed to the public: must never show (the stand-in ignores the query's filter, like a square saved before it)
  { type: 'Feature', id: 13, properties: { OBJECTID: 13, Unit_Nm: 'Closed Research Station', Pub_Access: 'XA', MngNm_Desc: 'State Land Board', MngTp_Desc: 'State', DesTp_Desc: 'Research Area', GIS_Acres: 20 },
    geometry: { type: 'Polygon', coordinates: [[[-93.2050, 45.0450], [-93.2030, 45.0450], [-93.2030, 45.0470], [-93.2050, 45.0470], [-93.2050, 45.0450]]] } }] };
let offline = false;
async function stubMaps(ctx) {
  await ctx.route('https://imageserver.gisdata.mn.gov/**', r => {
    if (offline) return r.abort('internetdisconnected');
    const q = new URL(r.request().url()).searchParams, bb = (q.get('BBOX') || '').split(',').map(Number);
    const lng = ((bb[0] + bb[2]) / 2) / 20037508.34 * 180;
    const inMn = q.get('LAYERS') === 'fsa2025' && q.get('SRS') === 'EPSG:3857' && lng < -92.8;   // pretend the state line is at -92.8
    hits[inMn ? 'mn' : 'mnblank']++;
    r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: inMn ? MNPHOTO : BLANK });
  });
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
    if (u.endsWith('/planet')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tiles: ['/planet/v1/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 }) });
    if (/\/planet\/v1\/\d+\/\d+\/\d+\.pbf$/.test(u)) { hits.vec++; return r.fulfill({ status: 200, contentType: 'application/x-protobuf', body: Buffer.alloc(0) }); }
    return r.fulfill({ status: 404, body: '' });
  });
  await ctx.route('https://static.cloudflareinsights.com/**', r => r.abort());
  await ctx.route('https://services.arcgis.com/**', r => {
    if (offline) return r.abort('internetdisconnected');
    hits.pad++;
    const q = new URL(r.request().url()).searchParams;
    const ok = q.get('f') === 'geojson' && /Private/.test(q.get('where') || '') && /Pub_Access <> 'XA'/.test(q.get('where') || '') && q.get('inSR') === '4326';
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(ok ? PAD : { error: 'bad query' }) });
  });
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
  check(hits.mn > 0, 'satellite is the default map type, from Minnesota’s photos when zoomed in in Minnesota');
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
  check(Math.abs(c1.lat - 45.052) < 0.0005 && Math.abs(c1.lng + 93.198) < 0.0005, 'tapping Amy flies to her ' + JSON.stringify(c1) + ' follow=' + await ben.evaluate(() => document.querySelector('#meBtn').getAttribute('aria-pressed')) + ' sheet=' + await ben.evaluate(() => !!document.querySelector('dialog.sheet')));

  // Amy moves
  await amy.context().setGeolocation({ latitude: 45.053, longitude: -93.198, accuracy: 5 });
  check(await until(ben, () => { const a = __bc.state().members[1]; return a.lat === 45.053; }, null, 12000), 'Amy’s move shows on Ben’s phone');
  // tapping Amy's dot: her sheet has Open in Google Maps at her spot
  await ben.evaluate(() => [...document.querySelectorAll('.pm')].find(e => e.textContent.includes('Amy')).click());
  await ben.waitForSelector('dialog.sheet [data-gmaps]');
  const pq = new URL(await ben.getAttribute('dialog.sheet [data-gmaps]', 'href')).searchParams.get('query').split(',').map(Number);
  check(Math.abs(pq[0] - 45.053) < 1e-5 && Math.abs(pq[1] + 93.198) < 1e-5, 'person: Open in Google Maps at their spot');
  await ben.click('dialog.sheet [data-close]');

  // ---- waypoints
  await ben.click('#pinBtn');
  await ben.waitForSelector('#wpForm');
  check((await ben.textContent('#wpWhere')).includes('At your location'), 'Pin starts at my spot');
  await ben.click('#wpForm .icons label:nth-child(3)');   // 🦌 (shown in the list; the map shows a red dot)
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
  check(await amy.isVisible('#spAdd') && /of you/.test(await amy.textContent('dialog.sheet')), 'long-press shows the spot, with distance');
  const spotLink = await amy.getAttribute('dialog.sheet [data-gmaps]', 'href');
  const ll = await amy.evaluate(([x, y]) => { const m = __bc.map(), r = m.getCanvas().getBoundingClientRect(); return m.unproject([x - r.left, y - r.top]); }, [box.x + 100, box.y + 300]);
  const q = new URL(spotLink).searchParams.get('query').split(',').map(Number);
  check(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/.test(spotLink) && Math.abs(q[0] - ll.lat) < 1e-4 && Math.abs(q[1] - ll.lng) < 1e-4, 'Open in Google Maps points at that spot');
  await amy.click('#spAdd');
  check(await amy.isVisible('#wpForm'), 'Add a waypoint here opens the waypoint form');
  await amy.fill('#wpForm [name=name]', 'Truck');
  await amy.click('#wpForm .icons label:nth-child(2)');
  await amy.click('#wpForm [type=submit]');
  check(await until(ben, () => __bc.state().waypoints.some(w => w.name === 'Truck'), null, 10000), 'Ben gets Amy’s waypoint');
  // Amy can't edit Ben's; she sees distance
  await amy.evaluate(() => { const w = __bc.state().waypoints.find(x => x.name === 'Big buck'); document.querySelectorAll('.wp').forEach(e => { if (e.textContent.includes('Big buck')) e.click(); }); });
  await amy.waitForSelector('#wGo');
  check(!(await amy.isVisible('#wEdit')), 'Amy can’t edit Ben’s waypoint');
  check(/Saw him at dawn/.test(await amy.textContent('dialog.sheet')) && /of you/.test(await amy.textContent('dialog.sheet')), 'waypoint sheet shows note and distance');
  const wq = new URL(await amy.getAttribute('dialog.sheet [data-gmaps]', 'href')).searchParams.get('query').split(',').map(Number);
  const buck = await amy.evaluate(() => __bc.state().waypoints.find(x => x.name === 'Big buck'));
  check(Math.abs(wq[0] - buck.lat) < 1e-5 && Math.abs(wq[1] - buck.lng) < 1e-5, 'waypoint: Open in Google Maps at its spot');
  await amy.click('dialog.sheet [data-close]');
  // Ben (host) edits Amy's
  await ben.evaluate(() => document.querySelectorAll('.wp').forEach(e => { if (e.textContent.includes('Truck')) e.click(); }));
  await ben.waitForSelector('#wEdit');
  await ben.click('#wEdit');
  await ben.fill('#wpForm [name=name]', 'Truck (Amy)');
  await ben.click('#wpForm [type=submit]');
  check(await until(amy, () => __bc.state().waypoints.some(w => w.name === 'Truck (Amy)'), null, 10000), 'host can edit anyone’s waypoint');
  check(await amy.evaluate(() => { const r = document.querySelector('.wp .wd').getBoundingClientRect(); return r.width <= 20 && !document.querySelector('.wp .pin'); }), 'waypoints are small red dots');
  // every dot (people and waypoints) sits exactly on its spot, at any zoom
  for (const z of [17, 14, 11, 8]) {
    const off = await amy.evaluate(z => {
      const m = __bc.map(); m.jumpTo({ zoom: z }); const box = m.getContainer().getBoundingClientRect(); let worst = 0;
      const S = __bc.state();
      const spots = [...document.querySelectorAll('.wp')].map((el, i) => [el.querySelector('.wd'), S.waypoints.find(w => el.textContent.includes(w.name))]);
      spots.forEach(([el, w]) => {
        if (!w) return; const r = el.getBoundingClientRect(), p = m.project([w.lng, w.lat]);
        worst = Math.max(worst, Math.hypot(r.left + r.width / 2 - box.left - p.x, r.top + r.height / 2 - box.top - p.y));
      });
      document.querySelectorAll('.pm').forEach(el => {
        const name = el.querySelector('.lbl').textContent; const mem = S.members.find(x => name.startsWith(x.name));
        if (!mem || mem.lat == null) return; const d = el.querySelector('.dot').getBoundingClientRect(), p = m.project([mem.lng, mem.lat]);
        worst = Math.max(worst, Math.hypot(d.left + d.width / 2 - box.left - p.x, d.top + d.height / 2 - box.top - p.y));
      });
      return worst;
    }, z);
    check(off < 3, 'markers on their exact spot at zoom ' + z + ' (off by ' + off.toFixed(1) + ' px)');
  }
  await amy.evaluate(() => __bc.map().jumpTo({ zoom: 16 }));
  // the Waypoints list: closest first, show/hide each, all, only mine, tap to go there
  await amy.click('#wpsBtn');
  await amy.waitForSelector('#wlist [data-wgo]');
  await shot(amy, 'wplist');
  const names = await amy.$$eval('#wlist .tx b', e => e.map(x => x.textContent));
  check(names.length === 2 && /2 of 2 shown/.test(await amy.textContent('#wlist')), 'Waypoints list: ' + names);
  check(/yd/.test(await amy.textContent('#wlist li')), 'list shows distance');
  await amy.click('[data-all=mine]');
  check(await until(amy, () => ![...document.querySelectorAll('.wp .lbl')].some(e => e.textContent === 'Big buck') && [...document.querySelectorAll('.wp .lbl')].some(e => e.textContent === 'Truck (Amy)')), 'Only mine hides Ben’s');
  await amy.click('[data-all=hide]');
  check(await until(amy, () => !document.querySelector('.wp')), 'Hide all');
  check(/0 of 2 shown/.test(await amy.textContent('#wlist')), 'count updates');
  const buckId = await amy.evaluate(() => __bc.state().waypoints.find(w => w.name === 'Big buck').id);
  await amy.check(`[data-wvis="${buckId}"]`);
  check(await until(amy, () => document.querySelectorAll('.wp').length === 1), 'one turned back on');
  await amy.click('[data-all=show]');
  check(await until(amy, () => document.querySelectorAll('.wp').length === 2), 'Show all');
  await amy.click('[data-all=hide]');
  await amy.click(`[data-wgo="${buckId}"]`);
  await amy.waitForTimeout(1200);
  const cw = await amy.evaluate(() => __bc.map().getCenter());
  const bw = await amy.evaluate(id => __bc.state().waypoints.find(w => w.id === id), buckId);
  check(Math.abs(cw.lat - bw.lat) < 0.0003 && Math.abs(cw.lng - bw.lng) < 0.0003, 'tapping a waypoint flies there');
  check(await until(amy, () => document.querySelectorAll('.wp').length === 1), 'and shows it');
  await amy.click('#wpsBtn'); await amy.click('[data-all=show]'); await amy.click('dialog.sheet [data-close]');
  await amy.waitForTimeout(500); await shot(amy, 'dots');
  // labels hide when zoomed out
  await amy.evaluate(() => __bc.map().jumpTo({ zoom: 12 }));
  check(await amy.evaluate(() => getComputedStyle(document.querySelector('.wp .lbl')).display === 'none'), 'names hide when zoomed out');
  await amy.evaluate(() => __bc.map().jumpTo({ zoom: 16 }));

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
  // Trails tab: when it was recorded, show/hide each, only mine, tap to go there, delete
  await ben.click('#wpsBtn'); await ben.click('[data-tab=tr]');
  await ben.waitForSelector('#wlist [data-tgo]');
  await shot(ben, 'trails');
  const trow = await ben.textContent('#wlist li');
  check(/Amy · \d+ yd/.test(trow) && /\d{1,2}:\d\d/.test(trow) && /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(trow), 'trail list shows who, length and when: ' + trow);
  check(!(await ben.$('#wlist [data-tdel]')) === false, 'host can delete Amy’s trail');
  await ben.click('[data-all=mine]');
  check(await until(ben, () => __bc.drawnTrails() === 0), 'Only mine hides Amy’s trail');
  await ben.click('[data-all=show]');
  check(await until(ben, () => __bc.drawnTrails() === 1), 'Show all');
  await ben.uncheck('#wlist [data-tvis]');
  check(await until(ben, () => __bc.drawnTrails() === 0), 'hide one trail');
  await ben.click('#wlist [data-tgo]');
  check(await until(ben, () => __bc.drawnTrails() === 1), 'going to a trail shows it');
  await ben.click('#wpsBtn');
  check(await ben.isVisible('[data-tab=tr][aria-pressed=true]'), 'Saved opens on the last tab');
  await ben.click('[data-tab=wp]'); await ben.waitForSelector('#wlist [data-wgo]');
  await ben.click('dialog.sheet [data-close]');

  // ---- map types
  await ben.click('.layers [data-layer=topo]');
  check(await until(ben, () => true) && (await ben.waitForTimeout(1500), hits.topo > 0), 'Topo loads USGS topo tiles');
  // an older version saved empty pieces in offline downloads: those must not make the map white
  const seeded = await ben.evaluate(() => caches.open('pebbly-maps').then(c => {
    const m = __bc.map(), b = m.getBounds(), keys = [];
    __bc.areaTiles([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], 6, 14, (z, x, y) => keys.push(__bc.tileKey('m~openmaptiles', z, x, y)));
    return Promise.all(keys.map(k => c.put(k, new Response(new ArrayBuffer(0))))).then(() => keys.length);
  }));
  await ben.click('.layers [data-layer=map]');
  await ben.waitForTimeout(2000);
  check(seeded > 0 && hits.vec > 0, 'Map loads OpenFreeMap tiles (real addresses), even over empty saved pieces: ' + hits.vec);
  check(await ben.evaluate(() => !!__bc.map().getSource('trails')), 'trails stay after switching map type');
  await ben.click('.layers [data-layer=sat]');

  // ---- outside Minnesota's photos: USGS instead, and blank pieces aren't kept
  const satBefore = hits.sat;
  await ben.evaluate(() => __bc.map().jumpTo({ center: [-92.6, 45.05], zoom: 16 }));
  check(await until(ben, () => true) && (await ben.waitForTimeout(2500), hits.mnblank > 0 && hits.sat > satBefore), 'past the state line: USGS photos (' + hits.mnblank + ' blank, ' + (hits.sat - satBefore) + ' USGS)');
  check(await ben.evaluate(() => caches.open('pebbly-maps-seen').then(c => c.keys()).then(k => Promise.all(k.filter(r => r.url.includes('bc.tiles/mn/')).map(r => caches.match(r).then(x => x.blob()))))
    .then(bs => bs.every(b => b.size > 6000))), 'no blank Minnesota pieces saved');
  await ben.evaluate(() => __bc.map().jumpTo({ center: [-93.2, 45.05], zoom: 16 }));

  // ---- public land
  await ben.evaluate(() => __bc.map().jumpTo({ center: [-93.2, 45.05], zoom: 14 }));
  check(await ben.isHidden('#padLegend'), 'public land is off at first');
  await ben.click('#moreBtn');
  check(/Show public land/.test(await ben.textContent('#mPad')), 'public land toggle is in the menu');
  await ben.click('#mPad');
  check(await until(ben, () => __bc.padShown() === 2, null, 8000), 'public land shows the areas in view, without the closed one');
  check(/Federal/.test(await ben.textContent('#padLegend')) && /State/.test(await ben.textContent('#padLegend')), 'legend shows the colors');
  await ben.waitForTimeout(500);
  const parkPt = await ben.evaluate(() => { const m = __bc.map(); const p = m.project([-93.2085, 45.0415]); return [p.x, p.y]; });
  const mapBox = await ben.locator('#map canvas').boundingBox();
  await ben.mouse.click(mapBox.x + parkPt[0], mapBox.y + parkPt[1]);
  await ben.waitForSelector('dialog.sheet .facts2');
  const land = await ben.textContent('dialog.sheet');
  check(/Pine Grove County Park/.test(land.split('Also here')[0]) && /Also here: Test Lake State Wildlife/.test(land), 'tapping shows the smallest area first, then the one around it');
  check(/Restricted access/.test(land) && /Open access/.test(land) && /DNR/.test(land), 'shows access and the check-the-rules note');
  await ben.click('dialog.sheet [data-close]');
  await ben.evaluate(() => __bc.map().jumpTo({ zoom: 7 }));
  check(await until(ben, () => __bc.padShown() === 0 && /Zoom in/.test(document.querySelector('#padLegend').textContent)), 'zoomed far out: asks to zoom in');
  await ben.evaluate(() => __bc.map().jumpTo({ zoom: 14 }));
  check(await until(ben, () => __bc.padShown() === 2), 'back when zoomed in');
  await shot(ben, 'publand');

  // ---- heading-up
  await ben.waitForTimeout(800);
  await ben.click('#compass');
  check(await until(ben, () => __bc.mode() === 'heading', null, 3000), 'compass button turns on heading-up');
  await ben.evaluate(() => { window.__fakeCompass = setInterval(() => __bc.orient({ type: 'deviceorientationabsolute', absolute: true, alpha: 270 }), 150); });   // facing east, like a real compass (keeps sending)
  await ben.waitForTimeout(300);
  const b = await ben.evaluate(() => __bc.map().getBearing());
  check(Math.abs(b - 90) < 3, 'map turns to face east: ' + b);
  check(await until(ben, () => { const s = __bc.state().members[0]; return s.heading != null && Math.abs(s.heading - 90) < 3; }, null, 10000), 'Ben’s direction is shared');
  check(await until(amy, () => { const c = [...document.querySelectorAll('.pm')].find(e => e.textContent.includes('Ben')); return c && c.querySelector('.cone').style.display !== 'none'; }, null, 10000), 'Amy sees Ben’s direction cone');
  await ben.click('#compass');
  await ben.waitForTimeout(500);
  await ben.evaluate(() => clearInterval(window.__fakeCompass));
  check(Math.abs(await ben.evaluate(() => __bc.map().getBearing())) < 1, 'north-up again');

  // ---- battery saver, and slowing down when nobody moves
  check(await ben.evaluate(() => __bc.syncEvery()) === 3000, 'checks in every 3 seconds normally');
  await ben.click('#moreBtn'); await ben.click('#mSaver');
  check(await ben.evaluate(() => __bc.syncEvery()) === 15000 && /battery saver/.test(await ben.textContent('#sync')), 'battery saver: every 15 seconds');
  await ben.click('#moreBtn');
  check(/Battery saver is on/.test(await ben.textContent('#mSaver')), 'menu says it’s on');
  await ben.click('#mSaver');
  check(await ben.evaluate(() => __bc.syncEvery()) === 3000, 'battery saver off');
  await ben.evaluate(() => __bc.idleNow());
  check(await ben.evaluate(() => __bc.syncEvery()) === 10000, 'nobody moving for 2 minutes: every 10 seconds');
  await amy.context().setGeolocation({ latitude: 45.0545, longitude: -93.1975, accuracy: 5 });
  check(await until(ben, () => __bc.syncEvery() === 3000, null, 15000), 'someone moves: back to every 3 seconds');

  // ---- offline download
  await ben.evaluate(() => __bc.map().jumpTo({ center: [-93.199, 45.051], zoom: 16 }));
  await ben.click('#moreBtn'); await ben.click('#mOffline');
  await ben.waitForSelector('#aEst');
  check(/MB|KB/.test(await ben.textContent('#aEst')), 'offline estimate: ' + await ben.textContent('#aEst'));
  await ben.click('[data-det=normal]');
  await ben.click('#aGo');
  check(await until(ben, () => /works offline/.test(document.querySelector('#aProgT').textContent), null, 60000), 'download finishes: ' + await ben.textContent('#aProgT'));
  const nCached = await ben.evaluate(() => caches.open('pebbly-maps').then(c => c.keys()).then(k => k.filter(r => /bc\.tiles\/(sat|mn)\//.test(r.url)).length));
  const plan = await ben.evaluate(() => __bc.areas()[0]);
  check(nCached > 10 && plan.tiles > 10, 'satellite tiles saved: ' + nCached + ' of plan ' + plan.tiles);
  check(/Deer camp/.test(await ben.textContent('#areaList')), 'saved area listed');
  // space used: downloaded vs recently viewed, and clearing recently viewed
  check(await until(ben, () => /Downloaded areas/.test(document.querySelector('#storeInfo').textContent) && /of up to 10,000/.test(document.querySelector('#storeInfo').textContent)), 'shows space used');
  const seenN = await ben.evaluate(() => caches.open('pebbly-maps-seen').then(c => c.keys()).then(k => k.length));
  check(seenN > 0 && (await ben.textContent('#storeInfo')).includes(seenN.toLocaleString('en-US') + ' of up to'), 'recently viewed count: ' + seenN);
  await ben.evaluate(() => window.confirm = () => true);
  await ben.click('#clearSeen');
  await until(ben, () => !document.querySelector('#clearSeen') || !document.querySelector('#clearSeen').disabled, null, 8000);
  await ben.waitForTimeout(500);
  const after = await ben.evaluate(() => { const m = document.querySelector('#storeInfo').textContent.match(/([\d,]+) of up to/); return m ? +m[1].replace(/,/g, '') : -1; });
  check(after >= 0 && after < seenN / 2, 'Clear recently viewed empties it (' + seenN + ' → ' + after + '; the map behind may save a few again right away)');
  check(await ben.evaluate(() => caches.open('pebbly-maps').then(c => c.keys()).then(k => k.some(r => /bc\.tiles\/(sat|mn)\//.test(r.url)))), 'downloaded areas stay');
  await shot(ben, 'offline');
  await ben.click('dialog.sheet [data-close]');

  // reopen with no signal: tiles from the phone, the map from what it saw last
  await ben.evaluate(() => new Promise(r => setTimeout(r, 100)));
  await ben.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });   // snapshot timer starts
  await ben.waitForTimeout(16000);
  offline = true;
  await ben.context().route('https://xujtuijpbwujduuzlwat.supabase.co/**', r => r.abort('internetdisconnected'));
  const before = hits.sat + hits.mn;
  await ben.reload();
  check(await until(ben, () => document.querySelector('#sync') && /No signal/.test(document.querySelector('#sync').textContent), null, 15000), 'opens with no signal');
  check(await ben.evaluate(() => __bc.state().waypoints.length) >= 2, 'waypoints shown from last time');
  await ben.waitForTimeout(2500);
  check(hits.sat + hits.mn === before, 'no tile requests reached the network');
  const shown = await ben.evaluate(() => __bc.fromPhone());
  check(shown > 0, 'satellite tiles drawn from the phone: ' + shown);
  check(await until(ben, () => __bc.padShown() === 2, null, 8000), 'public land shown offline from the download');
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
  // delete one trail of your own
  await amy.click('#trailBtn');
  for (let i = 1; i <= 3; i++) { await amy.context().setGeolocation({ latitude: 45.06 + i * 0.0002, longitude: -93.19, accuracy: 5 }); await amy.waitForTimeout(400); }
  await amy.click('#trailBtn');
  check(await until(ben, () => __bc.state().trails.length === 1, null, 10000), 'new trail arrives');
  await amy.evaluate(() => window.confirm = () => true);
  await amy.click('#wpsBtn'); await amy.click('[data-tab=tr]');
  await amy.click('#wlist [data-tdel]');
  check(await until(ben, () => __bc.state().trails.length === 0, null, 10000), 'deleting one trail removes it for everyone');
  await amy.click('dialog.sheet [data-close]');
  await ben.click('#moreBtn'); await ben.click('#mOffline');
  await ben.click('[data-adel]');
  check(await until(ben, () => !document.querySelector('[data-adel]')), 'saved area deleted');
  const left = await ben.evaluate(() => caches.open('pebbly-maps').then(c => c.keys()).then(k => k.filter(r => /bc\.tiles\/(sat|mn)\//.test(r.url)).length));
  check(left === 0, 'its tiles are gone: ' + left);
  await ben.click('dialog.sheet [data-close]');

  // ---- sharing with the screen off (OwnTracks)
  await amy.click('#moreBtn');
  check(/pocket/.test(await amy.textContent('#mOt')), 'menu offers screen-off sharing');
  await amy.click('#mOt');
  await amy.waitForSelector('#otGo');
  check(/Play Store/.test(await amy.textContent('dialog.sheet')), 'links to OwnTracks in the Play Store');
  await amy.check('#otTrail');
  await amy.evaluate(() => { window.__opened = []; const a = document.getElementById('otGo'); a.addEventListener('click', () => {}, true); });
  await shot(amy, 'owntracks');
  await amy.click('#otGo');
  check(await until(amy, () => /^owntracks:\/\/\/config\?inline=/.test(document.getElementById('otGo') ? document.getElementById('otGo').getAttribute('href') : '')), 'setup link made');
  const cfg = await amy.evaluate(() => JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(document.getElementById('otGo').getAttribute('href').split('inline=')[1]))))));
  const otKey = new URL(cfg.url).searchParams.get('k');
  check(cfg._type === 'configuration' && cfg.mode === 3 && /\/functions\/v1\/owntracks\?k=/.test(cfg.url) && /^[0-9a-f]{64}$/.test(otKey) && cfg.tid === 'AM',
    'OwnTracks settings: HTTP mode to the receiver with a personal key, tracker id ' + cfg.tid);
  check(cfg.cmd === true && cfg.remoteConfiguration === true, 'remote commands allowed (so Pebbly can slow it down or switch it off)');
  const otUntil = await amy.evaluate(() => __bc.state().me.ot_until);
  check(otUntil > Date.now() + 71 * 3600e3 && otUntil < Date.now() + 73 * 3600e3, 'shares for 3 days by default');
  const tNow = Math.floor(Date.now() / 1000);
  // Amy still has Basecamp open: her OwnTracks reports are ignored (Basecamp's GPS wins, no double trail)
  await amy.click('dialog.sheet [data-close]').catch(() => {});
  await amy.waitForTimeout(3500);
  check(owntracks(otKey, { _type: 'location', lat: 45.07, lon: -93.21, acc: 10, tst: tNow, vel: 0 }) === 'app', 'while Basecamp is open, its location wins over OwnTracks');
  // Amy leaves the screen: OwnTracks takes over
  await setVisible(amy, false);
  leftScreen('Amy');
  check(owntracks(otKey, { _type: 'location', lat: 45.07, lon: -93.21, acc: 10, tst: tNow, vel: 0 }) === 'ok', 'after leaving the screen, OwnTracks reports are taken');
  check(await until(ben, () => { const a = __bc.state().members.find(m => m.name === 'Amy'); return a && a.lat === 45.07 && a.ot; }, null, 10000), 'Ben sees Amy’s OwnTracks location');
  await ben.click('#peopleBtn');
  check(await until(ben, () => /📡/.test(document.querySelector('#plist').textContent)), 'People list marks screen-off sharing');
  await ben.click('dialog.sheet [data-close]');
  owntracks(otKey, { _type: 'location', lat: 45.0710, lon: -93.21, acc: 10, tst: tNow + 30 });
  check(await until(ben, () => __bc.state().trails.some(t => t.by === 'Amy') && Object.values(__bc.state().pts).some(a => a.length === 2), null, 10000), 'screen-off trail recorded');
  // no word from OwnTracks for over an hour: flagged in red on the map and in People
  spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', process.env.DB || 'basecamp', '-At'],
    { input: `update bc_members set ot_at = now() - interval '75 minutes', pos_at = now() - interval '75 minutes' where name = 'Amy';`, encoding: 'utf8' });
  check(await until(ben, () => { const e = [...document.querySelectorAll('.pm')].find(x => x.textContent.includes('Amy')); return e && e.classList.contains('lost') && /⚠/.test(e.textContent); }, null, 10000), 'Amy flagged red on the map');
  await ben.click('#peopleBtn');
  check(await until(ben, () => /No word from OwnTracks for 1 hr/.test(document.querySelector('#plist').textContent) && document.querySelector('#plist .sw.lost')), 'and in People, with what it may mean');
  await shot(ben, 'lost');
  await ben.click('dialog.sheet [data-close]');
  owntracks(otKey, { _type: 'location', lat: 45.0712, lon: -93.21, acc: 10, tst: Math.floor(Date.now() / 1000) });
  check(await until(ben, () => { const e = [...document.querySelectorAll('.pm')].find(x => x.textContent.includes('Amy')); return e && !e.classList.contains('lost'); }, null, 10000), 'a new report clears the flag');
  // hiding in Basecamp also hides OwnTracks reports; sharing again lets them through
  await setVisible(amy, true);
  await amy.click('#moreBtn'); await amy.click('#mHide');
  check(await until(ben, () => __bc.state().members.find(m => m.name === 'Amy').lat == null, null, 10000), 'hidden');
  check(owntracks(otKey, { _type: 'location', lat: 45.08, lon: -93.21, acc: 10, tst: tNow + 60 }) === 'hidden', 'OwnTracks reports ignored while hidden');
  await amy.click('[data-act=share-on]');
  await amy.waitForTimeout(3500);
  check(owntracks(otKey, { _type: 'location', lat: 45.09, lon: -93.21, acc: 10, tst: Math.floor(Date.now() / 1000) + 5 }) === 'app', 'sharing again (Basecamp open): Basecamp’s location');
  await setVisible(amy, false); leftScreen('Amy');
  check(owntracks(otKey, { _type: 'location', lat: 45.09, lon: -93.21, acc: 10, tst: Math.floor(Date.now() / 1000) + 6 }) === 'ok', 'and OwnTracks again once off the screen');
  await setVisible(amy, true);
  // stop
  await amy.evaluate(() => window.confirm = () => true);
  await amy.click('#moreBtn');
  check(/On, through the OwnTracks app/.test(await amy.textContent('#mOt')), 'menu says it’s on');
  await amy.click('#mOt');
  check(/On until/.test(await amy.textContent('dialog.sheet')) && /switched to Quiet automatically/.test(await amy.textContent('dialog.sheet')), 'shows when it ends');
  await amy.click('[data-ext=week]');
  check(await until(amy, () => { const u = __bc.state().me.ot_until; return u > Date.now() + 6.9 * 864e5 && u < Date.now() + 7.1 * 864e5; }), 'extended to a week');
  await amy.waitForSelector('[data-ext=forever]');
  await amy.click('[data-ext=forever]');
  check(await until(amy, () => __bc.state().me.ot_until === null && /until you stop it/.test(document.querySelector('dialog.sheet').textContent)), 'Until I stop: no end time');
  check(/One map at a time/.test(await amy.textContent('dialog.sheet')), 'explains one map at a time');
  await amy.waitForSelector('#otStop');
  await amy.click('#otStop');
  await amy.waitForTimeout(500);
  check(owntracks(otKey, { _type: 'location', lat: 45.1, lon: -93.21, acc: 10, tst: Math.floor(Date.now() / 1000) + 10 }) === 'unknown', 'after Stop, the old key is refused');

  // dark mode screenshot
  await amy.emulateMedia({ colorScheme: 'dark' });
  await amy.click('#peopleBtn'); await shot(amy, 'people-dark'); await amy.click('dialog.sheet [data-close]');

  // Amy sets up OwnTracks again ("Until I stop"), then leaves the map: her phone is told to go Quiet
  await amy.emulateMedia({ colorScheme: 'light' });
  await amy.click('#moreBtn'); await amy.click('#mOt');
  await amy.click('[data-dur=forever]');
  check(/keeps going until you tap Stop/.test(await amy.textContent('#otDurHint')), 'Until I stop explained');
  await amy.click('#otGo');
  await until(amy, () => /^owntracks:/.test(document.getElementById('otGo').getAttribute('href')));
  const key2 = await amy.evaluate(() => new URL(JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(document.getElementById('otGo').getAttribute('href').split('inline=')[1]))))).url).searchParams.get('k'));
  check(await amy.evaluate(() => __bc.state().me.ot_until) === null, 'set up with no end time');
  await amy.click('dialog.sheet [data-close]');
  await amy.evaluate(() => window.confirm = () => true);
  await amy.click('#moreBtn'); await amy.click('#mLeave');
  check(await until(ben, () => __bc.state().members.length === 1, null, 10000), 'Amy left the map');
  check(owntracks(key2, { _type: 'location', lat: 45.1, lon: -93.21, acc: 10 }) === 'unknown', 'after leaving, her OwnTracks gets “go Quiet”');

  [ben, amy, carl].forEach((p, i) => check(!p.errs.length, 'page errors on phone ' + i + ': ' + p.errs.join(' | ')));
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
