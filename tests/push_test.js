// Phone alerts (Web Push): encryption, the notify-push Edge Function (run here in Node), the database rules,
// the settings page (with a stand-in for the browser's push service) and the service worker showing an alert.
//   sh tests/setup_db.sh push
//   python3 -m http.server 8796        (from the repo root)
//   NODE_PATH=$(npm root -g) node tests/push_test.js      (SHOTS=1 also saves screenshots to /tmp/push_*.png)
const { chromium, devices } = require('playwright');
const { spawnSync } = require('child_process');
const nodeCrypto = require('crypto');
const { rpc, phone } = require('./pg_bridge');
const B = 'http://localhost:8796', DB = 'push', SB = 'https://xujtuijpbwujduuzlwat.supabase.co';
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }
function sql(q) { return spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', DB, '-At', '-c', q], { encoding: 'utf8' }); }
function call(fn, args) { const r = rpc(DB, fn, args); if (r.status !== 200) throw new Error(fn + ': ' + r.body); return r.body ? JSON.parse(r.body) : null; }
// The function's database calls, as the service role.
function serviceRpc(fn, args) {
  const names = Object.keys(args || {}), vars = [], parts = [];
  names.forEach((n, i) => { const v = args[n];
    if (v === null || v === undefined) parts.push(`${n} => NULL`);
    else { vars.push('-v', `a${i}=${Array.isArray(v) ? '{' + v.map(x => '"' + x + '"').join(',') + '}' : typeof v === 'object' ? JSON.stringify(v) : String(v)}`); parts.push(`${n} => :'a${i}'`); } });
  const r = spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1', ...vars],
    { input: `set role service_role;\nselect coalesce(to_jsonb(public.${fn}(${parts.join(', ')}))::text, 'null');\n`, encoding: 'utf8' });
  if (r.status !== 0) return { status: 400, body: JSON.stringify({ message: r.stderr }) };
  return { status: 200, body: r.stdout.trim().split('\n').pop() };
}
const b64u = b => Buffer.from(b).toString('base64url'), unb64u = s => new Uint8Array(Buffer.from(s, 'base64url'));

// A stand-in phone push subscription (keys we hold, so we can read what's sent to it).
function fakeSub(n) {
  const ecdh = nodeCrypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return { ecdh, endpoint: 'https://fcm.googleapis.com/fcm/send/test-' + n + '-' + nodeCrypto.randomBytes(6).toString('hex'), p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth), authBytes: auth };
}
// RFC 8291 receiver side (WebCrypto), to read a pushed body.
async function decrypt(body, sub) {
  const salt = body.slice(0, 16), idlen = body[20], asPublic = body.slice(21, 21 + idlen), sealed = body.slice(21 + idlen);
  const shared = sub.ecdh.computeSecret(Buffer.from(asPublic));
  const hmac = async (k, d) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), d));
  const hkdf = async (s, ikm, info, len) => (await hmac(await hmac(s, ikm), Buffer.concat([Buffer.from(info), Buffer.from([1])]))).slice(0, len);
  const ikm = await hkdf(sub.authBytes, shared, Buffer.concat([Buffer.from('WebPush: info\0'), sub.ecdh.getPublicKey(), Buffer.from(asPublic)]), 32);
  const cek = await hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), sealed));
  return JSON.parse(Buffer.from(plain.slice(0, plain.lastIndexOf(2))).toString());
}

(async () => {
  const wp = await import('../supabase/functions/notify-push/webpush.js');
  const { handle } = await import('../supabase/functions/notify-push/handler.js');

  /* ---------------- encryption: RFC 8291 Appendix A, byte for byte */
  const asPub = unb64u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const vec = await wp.encrypt('When I grow up, I want to be a watermelon', 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', {
    asKeys: { publicKey: asPub, privateJwk: { kty: 'EC', crv: 'P-256', x: b64u(asPub.slice(1, 33)), y: b64u(asPub.slice(33)), d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' } },
    salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw') });
  check(b64u(vec) === 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN', 'RFC 8291 test vector');

  /* ---------------- the function, with stand-ins for Supabase and the push service */
  const pushed = [];          // { endpoint, headers, body }
  let goneEndpoint = null;
  const env = n => ({ SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' })[n];
  async function fakeFetch(url, opts) {
    url = String(url);
    if (url.startsWith(SB + '/rest/v1/rpc/')) {
      if (opts.headers.apikey !== 'test-service-key') check(false, 'function calls the database with the service key');
      const r = serviceRpc(url.split('/rpc/')[1], JSON.parse(opts.body || '{}'));
      return new Response(r.body, { status: r.status });
    }
    if (url.startsWith('https://fcm.googleapis.com/')) {
      pushed.push({ endpoint: url, headers: opts.headers, body: new Uint8Array(opts.body) });
      return new Response('', { status: url === goneEndpoint ? 410 : 201 });
    }
    throw new Error('unexpected fetch ' + url);
  }
  const fn = (method, body) => handle(new Request(SB + '/functions/v1/notify-push', { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), { env, fetch: fakeFetch });
  const sendWaiting = async () => { pushed.length = 0; return (await fn('POST', {})).json(); };

  const g1 = await (await fn('GET')).json(), g2 = await (await fn('GET')).json();
  check(/^[A-Za-z0-9_-]{87}$/.test(g1.publicKey) && g1.publicKey === g2.publicKey, 'GET gives a public key, made once and kept');
  check(/permission denied/.test(sql("set role anon; select notify_push_vapid()").stderr) && /permission denied/.test(sql("set role anon; select notify_push_queue()").stderr), 'phones can’t read the key or the queue');
  check(/permission denied/.test(sql("set role anon; select * from push_subs").stderr), 'phones can’t read subscriptions');
  const bad = (ep, k) => rpc(DB, 'notify_push_sync', { p_endpoint: ep, p_p256dh: k || fakeSub(0).p256dh, p_auth: fakeSub(0).auth, p_feeds: [] }).status !== 200;
  check(bad('https://evil.example/x') && bad('http://fcm.googleapis.com/x') && bad('https://fcm.googleapis.com.evil.example/x') && bad(fakeSub(0).endpoint, 'short'), 'only real push services and well-formed keys');
  check(!bad('https://web.push.apple.com/abc') && !bad('https://updates.push.services.mozilla.com/wpush/v2/abc'), 'Apple and Firefox push services allowed');

  /* ---------------- settings page: turn alerts on (stand-in push service in the page) */
  const ev = call('rsvp_create', { p_event: { title: 'Game Night', emoji: '🎲', tz: 'UTC', max_plus_ones: 2 } });
  const sub = fakeSub(1);
  const browser = await chromium.launch();
  const host = await phone(browser, devices, DB);
  let fnDown = false;
  await host.context().route(SB + '/functions/v1/notify-push', async route => {
    if (fnDown) return route.fulfill({ status: 404, body: '{"error":"not found"}' });
    const rq = route.request();
    const res = await handle(new Request(rq.url(), { method: rq.method(), headers: { 'Content-Type': 'application/json' }, body: rq.method() === 'POST' ? rq.postData() : undefined }), { env, fetch: fakeFetch });
    route.fulfill({ status: res.status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: await res.text() });
  });
  const stub = s => {
    // like a real browser, permission and subscription survive page loads
    const mk = () => ({ endpoint: s.endpoint, options: null, toJSON: () => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }),
      unsubscribe: () => { cur = null; localStorage.removeItem('__sub'); return Promise.resolve(true); } });
    let cur = localStorage.getItem('__sub') ? mk() : null;
    Object.defineProperty(Notification, 'permission', { get: () => localStorage.getItem('__perm') || 'default', configurable: true });
    Notification.requestPermission = () => { localStorage.setItem('__perm', 'granted'); return Promise.resolve('granted'); };
    const pm = {
      getSubscription: () => Promise.resolve(cur),
      subscribe: o => { cur = mk(); cur.options = { applicationServerKey: o.applicationServerKey }; localStorage.setItem('__sub', '1'); return Promise.resolve(cur); }
    };
    const reg = { pushManager: pm };
    Object.defineProperty(navigator, 'serviceWorker', { value: { register: () => Promise.resolve(reg), ready: Promise.resolve(reg), addEventListener() {} }, configurable: true });
  };
  await host.context().addInitScript(stub, { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth });
  await host.goto(B + '/rsvp/?e=' + ev.code + '&o=' + ev.owner_token);
  await host.waitForSelector('#host .host');
  await host.waitForFunction(() => { const b = document.querySelector('[data-pn-bell]'); return b && !b.hidden; });
  await host.click('.pn-bell');
  check(await host.locator('.pn-foot', { hasText: 'lock screen' }).count() === 1, 'bell list offers phone alerts');
  await host.click('.pn-foot');
  await host.waitForSelector('#alerts [data-alert=on]');
  if (process.env.SHOTS) await host.screenshot({ path: '/tmp/push_off.png' });
  fnDown = true;
  await host.click('[data-alert=on]');
  await host.waitForFunction(() => /set up on the server/.test(document.getElementById('alerts').textContent));
  check(true, 'sender not deployed yet: clear message');
  fnDown = false;
  await host.click('[data-alert=on]');
  await host.waitForSelector('#alerts [data-alert=test]');
  if (process.env.SHOTS) { await host.screenshot({ path: '/tmp/push_on.png' }); await host.emulateMedia({ colorScheme: 'dark' }); await host.screenshot({ path: '/tmp/push_on_dark.png' }); await host.emulateMedia({ colorScheme: 'light' }); }
  const mine = () => sql(`select count(*) from push_subs where endpoint = '${sub.endpoint}'`).stdout.trim();
  const hpid = await host.evaluate(() => JSON.parse(localStorage.getItem('rsvp.pid')));
  check(sql(`select count(*) from push_targets t join push_subs s on s.id = t.sub_id where s.endpoint = '${sub.endpoint}' and t.role = 'host' and t.pid = '${hpid}'`).stdout.trim() === '1', 'subscription saved with the host event');

  /* ---------------- sending */
  call('gated_rsvp_respond', { p_code: ev.code, p_participant: 'guest-000001', p_owner_token: null, p_first_name: 'Amy', p_last_name: 'Lee', p_phone: '', p_status: 'going', p_plus_ones: 1, p_note: '', p_answers: {}, p_key: null });
  check(sql(`select count(*) from rsvp_guests`).stdout.trim() === '1', 'RSVP still saved without pg_net');
  let r = await sendWaiting();
  check(r.sent === 1 && pushed.length === 1 && pushed[0].endpoint === sub.endpoint, 'one alert sent: ' + JSON.stringify(r));
  let p = await decrypt(pushed[0].body, sub);
  check(p.type === 'rsvp.rsvp_new' && p.name === 'Amy Lee' && p.code === ev.code && p.title === 'Game Night' && p.emoji === '🎲' && p.detail.plus === 1, 'payload: ' + JSON.stringify(p));
  check(!JSON.stringify(p).includes('guest-000001'), 'no participant ids in the alert');
  const h = pushed[0].headers;
  check(h['Content-Encoding'] === 'aes128gcm' && Number(h.TTL) > 0 && /^[A-Za-z0-9_-]{1,32}$/.test(h.Topic), 'push headers');
  const [, jwt, k] = h.Authorization.match(/^vapid t=([^,]+), k=(.+)$/), [jh, jb, js] = jwt.split('.');
  const vk = await crypto.subtle.importKey('raw', unb64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  check(k === g1.publicKey && await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk, unb64u(js), Buffer.from(jh + '.' + jb)), 'VAPID signature verifies with the public key');
  check(JSON.parse(Buffer.from(jb, 'base64url')).aud === 'https://fcm.googleapis.com', 'VAPID audience is the push service');
  check((await sendWaiting()).sent === 0, 'nothing sent twice');
  check(await host.evaluate(p => { const v = PebblyNotify.alertView(p); return v.title === '🎲 Game Night' && v.body === '✅ Amy Lee is going +1' && v.url === '/rsvp/?e=' + p.code; }, p), 'alert wording');

  call('gated_rsvp_post', { p_code: ev.code, p_participant: hpid, p_owner_token: ev.owner_token, p_name: 'Me', p_kind: 'comment', p_body: 'my own', p_key: null });
  check((await sendWaiting()).sent === 0, 'your own comment: no alert');
  call('gated_rsvp_post', { p_code: ev.code, p_participant: 'guest-000001', p_owner_token: null, p_name: 'Amy Lee', p_kind: 'comment', p_body: 'Can I bring my dog?', p_key: null });
  r = await sendWaiting();
  check(r.sent === 1 && (await decrypt(pushed[0].body, sub)).detail.snippet === 'Can I bring my dog?', 'guest comment alert');
  call('gated_rsvp_post', { p_code: ev.code, p_participant: hpid, p_owner_token: ev.owner_token, p_name: '', p_kind: 'announce', p_body: 'Hi all', p_key: null });
  check((await sendWaiting()).sent === 0, 'host doesn’t get guest alerts');
  sql("update notifications set pushed_at = null, created_at = now() - interval '2 hours' where type = 'rsvp.comment'");
  check((await sendWaiting()).sent === 0, 'stale items (over an hour) skipped');

  // settings switches apply to alerts too
  await host.click('.card:has-text("Events you host") .sw:has-text("New comments")');
  await host.waitForSelector('.toast.show');
  call('gated_rsvp_post', { p_code: ev.code, p_participant: 'guest-000001', p_owner_token: null, p_name: 'Amy Lee', p_kind: 'comment', p_body: 'again', p_key: null });
  check((await sendWaiting()).sent === 0, 'turned-off kind: no alert');

  // test alert
  pushed.length = 0;
  await host.click('[data-alert=test]');
  await host.waitForFunction(() => /Sent/.test(document.getElementById('toast').textContent));
  check(pushed.length === 1 && (await decrypt(pushed[0].body, sub)).test === true, 'test alert sent');

  // a new event on this phone joins the subscription by itself
  const ev2 = call('rsvp_create', { p_event: { title: 'Brunch', tz: 'UTC' } });
  await host.goto(B + '/rsvp/?e=' + ev2.code + '&o=' + ev2.owner_token);
  await host.waitForSelector('#host .host');
  await host.waitForFunction(c => (JSON.parse(localStorage.getItem('pebbly_push')) || {}).sig.includes(c), ev2.code, { timeout: 5000 }).catch(() => {});
  check(sql(`select count(*) from push_targets t join rsvp_events e on e.id = t.event_id where e.code = '${ev2.code}'`).stdout.trim() === '1', 'new event added to phone alerts');
  call('gated_rsvp_respond', { p_code: ev2.code, p_participant: 'guest-000002', p_owner_token: null, p_first_name: 'Bo', p_last_name: 'Bee', p_phone: '', p_status: 'maybe', p_plus_ones: 0, p_note: '', p_answers: {}, p_key: null });
  check((await sendWaiting()).sent === 1, 'alert for the new event');

  // dead subscription is removed
  goneEndpoint = sub.endpoint;
  call('gated_rsvp_respond', { p_code: ev2.code, p_participant: 'guest-000003', p_owner_token: null, p_first_name: 'Cy', p_last_name: 'Sea', p_phone: '', p_status: 'going', p_plus_ones: 0, p_note: '', p_answers: {}, p_key: null });
  r = await sendWaiting();
  check(r.gone === 1 && mine() === '0', 'push service says gone: subscription deleted ' + JSON.stringify(r));
  goneEndpoint = null;
  // the phone notices on its next check and signs up again (once a day, or when its events change)
  await host.evaluate(() => { const p = JSON.parse(localStorage.getItem('pebbly_push')); p.sig = 'old'; localStorage.setItem('pebbly_push', JSON.stringify(p)); return PebblyNotify.check(); });
  await host.waitForTimeout(800);
  check(mine() === '1', 'phone re-registers');

  /* ---------------- after replying to an RSVP, a phone is offered alerts */
  const gsub = fakeSub(2);
  const guest = await phone(browser, devices, DB);
  await guest.context().route(SB + '/functions/v1/notify-push', async route => {
    const res = await handle(new Request(route.request().url(), { method: 'GET' }), { env, fetch: fakeFetch });
    route.fulfill({ status: res.status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: await res.text() });
  });
  await guest.context().addInitScript(stub, { endpoint: gsub.endpoint, p256dh: gsub.p256dh, auth: gsub.auth });
  await guest.goto(B + '/rsvp/?e=' + ev.code);
  await guest.waitForSelector('#me');
  await guest.waitForTimeout(500);
  check(!(await guest.locator('.alertoffer').count()), 'no offer before replying');
  const gp = await guest.evaluate(() => JSON.parse(localStorage.getItem('rsvp.pid')));
  call('gated_rsvp_respond', { p_code: ev.code, p_participant: gp, p_owner_token: null, p_first_name: 'Gus', p_last_name: 'Guest', p_phone: '', p_status: 'going', p_plus_ones: 0, p_note: '', p_answers: {}, p_key: null });
  await guest.reload();
  await guest.waitForSelector('.alertoffer [data-act=alerts-on]');
  check(/announcements/.test(await guest.textContent('.alertoffer')), 'offer after replying: ' + await guest.textContent('.alertoffer'));
  if (process.env.SHOTS) await guest.screenshot({ path: '/tmp/push_offer.png' });
  await guest.click('[data-act=alerts-on]');
  await guest.waitForFunction(() => !document.querySelector('.alertoffer'));
  check(sql(`select count(*) from push_targets t join push_subs s on s.id = t.sub_id where s.endpoint = '${gsub.endpoint}' and t.role = 'guest'`).stdout.trim() === '1', 'guest’s alerts cover the event');
  call('gated_rsvp_post', { p_code: ev.code, p_participant: hpid, p_owner_token: ev.owner_token, p_name: '', p_kind: 'announce', p_body: 'Doors at 6', p_key: null });
  r = await sendWaiting();
  const toGuest = pushed.filter(x => x.endpoint === gsub.endpoint);
  check(toGuest.length === 1 && (await decrypt(toGuest[0].body, gsub)).detail.snippet === 'Doors at 6', 'announcement reaches the guest’s phone');
  await guest.reload(); await guest.waitForSelector('#me'); await guest.waitForTimeout(600);
  check(!(await guest.locator('.alertoffer').count()), 'no offer once alerts are on');
  // "Not now" on another phone hides it for a while
  const nn = await phone(browser, devices, DB);
  await nn.context().addInitScript(stub, fakeSub(3));
  await nn.goto(B + '/rsvp/?e=' + ev.code); await nn.waitForSelector('#me');
  const nnp = await nn.evaluate(() => JSON.parse(localStorage.getItem('rsvp.pid')));
  call('gated_rsvp_respond', { p_code: ev.code, p_participant: nnp, p_owner_token: null, p_first_name: 'Nia', p_last_name: 'Now', p_phone: '', p_status: 'maybe', p_plus_ones: 0, p_note: '', p_answers: {}, p_key: null });
  await nn.reload(); await nn.waitForSelector('[data-act=alerts-later]');
  await nn.click('[data-act=alerts-later]');
  await nn.reload(); await nn.waitForSelector('#me'); await nn.waitForTimeout(600);
  check(!(await nn.locator('.alertoffer').count()), '“Not now” hides the offer');

  // turn off
  await host.goto(B + '/notifications/');
  await host.waitForSelector('#alerts [data-alert=off]');
  await host.click('[data-alert=off]');
  await host.waitForSelector('#alerts [data-alert=on]');
  check(mine() === '0', 'turning off removes the subscription');

  /* ---------------- the real service worker shows an alert */
  // (the default headless browser always refuses notifications; the full Chromium build allows them)
  const full = await chromium.launch({ channel: 'chromium' });
  const ctx = await full.newContext({ ...devices['Pixel 7'], permissions: ['notifications'] });
  const pg = await ctx.newPage(); const swErrs = []; pg.on('pageerror', e => swErrs.push(e.message));
  await pg.goto(B + '/notifications/');
  await pg.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await ctx.newCDPSession(pg);
  const regId = new Promise(res => cdp.on('ServiceWorker.workerRegistrationUpdated', e => { const x = e.registrations.find(r => r.scopeURL === B + '/'); if (x) res(x.registrationId); }));
  await cdp.send('ServiceWorker.enable');
  const id = await regId;
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: B, registrationId: id, data: JSON.stringify({ app: 'wdw', code: 'abcdefgh', title: 'Cabin weekend', emoji: '📅', type: 'wdw.final_date', name: 'Cabin weekend', detail: { date: '2026-12-05', days: 2 }, tag: 'wdw:abcdefgh:wdw.final_date' }) });
  const shown = await pg.waitForFunction(() => navigator.serviceWorker.ready.then(r => r.getNotifications()).then(l => l.length && l.map(n => ({ title: n.title, body: n.body, tag: n.tag, url: n.data.url }))), null, { timeout: 5000 }).then(h => h.jsonValue()).catch(() => []);
  check(shown.length === 1 && shown[0].title === '📅 Cabin weekend' && shown[0].body === '🎯 The date is set: Sat, Dec 5 (2 days)' && shown[0].url === '/whichdayworks/?e=abcdefgh', 'service worker shows the alert: ' + JSON.stringify(shown));
  check(!swErrs.length && !host.errs.length && !guest.errs.length && !nn.errs.length, 'page errors: ' + swErrs.concat(host.errs, guest.errs, nn.errs).join('; '));

  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); await full.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' checks:', e.message.split('\n')[0], (e.stack.match(/push_test.js:\d+/) || [])[0]); process.exit(1); });
