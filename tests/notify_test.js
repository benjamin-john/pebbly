// Notifications (🔔 bell, notify.js, /notifications/) end to end against a local Postgres (see CLAUDE.md → Testing).
//   sh tests/setup_db.sh notify && sh tests/setup_db.sh notify_old nomigrations
//   python3 -m http.server 8795        (from the repo root)
//   NODE_PATH=$(npm root -g) node tests/notify_test.js      (SHOTS=1 also saves screenshots to /tmp/notify_*.png)
const { chromium, devices } = require('playwright');
const { spawnSync } = require('child_process');
const { rpc, phone } = require('./pg_bridge');
const B = 'http://localhost:8795', DB = 'notify';
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }
function call(fn, args, db) { const r = rpc(db || DB, fn, args); if (r.status !== 200) throw new Error(fn + ': ' + r.body); return r.body ? JSON.parse(r.body) : null; }
function fails(fn, args) { return rpc(DB, fn, args).status !== 200; }
function sql(q) { return spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', DB, '-At', '-c', q], { encoding: 'utf8' }); }
const badge = p => p.evaluate(() => { const b = document.querySelector('[data-pn-bell] .pn-badge'); return b && !b.hidden ? b.textContent : ''; });
const bellShown = p => p.evaluate(() => { const b = document.querySelector('[data-pn-bell]'); return !!b && !b.hidden && !!b.querySelector('.pn-bell'); });
const check_ = p => p.evaluate(() => PebblyNotify.check());
const pidOf = (p, k) => p.evaluate(k => JSON.parse(localStorage.getItem(k)), k);
const feed = (app, code, role, key, extra) => call('notify_feed', { p_feeds: [{ app, code, role, key, ...(extra || {}) }] })[0];

(async () => {
  const browser = await chromium.launch();
  const shots = !!process.env.SHOTS;

  /* ---------------- database rules */
  const ev = call('rsvp_create', { p_event: { title: 'Pizza Night', emoji: '🍕', tz: 'UTC' } });
  const code = ev.code, tok = ev.owner_token;
  call('gated_rsvp_respond', { p_code: code, p_participant: 'dbguest-0001', p_owner_token: null, p_first_name: 'Ann', p_last_name: 'Ash', p_phone: '', p_status: 'going', p_plus_ones: 0, p_note: '', p_answers: {}, p_key: null });
  call('gated_rsvp_respond', { p_code: code, p_participant: 'dbguest-0001', p_owner_token: null, p_first_name: 'Ann', p_last_name: 'Ash', p_phone: '', p_status: 'maybe', p_plus_ones: 0, p_note: '', p_answers: {}, p_key: null });
  let f = feed('rsvp', code, 'host', tok);
  check(f.ok && f.title === 'Pizza Night' && f.emoji === '🍕', 'host feed ok with title');
  check(f.items.length === 1 && f.items[0].type === 'rsvp.rsvp_new' && f.items[0].detail.status === 'maybe', 'quick change merges into the new RSVP: ' + JSON.stringify(f.items));
  check(!('actor' in f.items[0]) && !JSON.stringify(f).includes('dbguest-0001'), 'participant ids never returned');
  sql("update notifications set created_at = now() - interval '1 hour'");
  call('gated_rsvp_respond', { p_code: code, p_participant: 'dbguest-0001', p_owner_token: null, p_first_name: 'Ann', p_last_name: 'Ash', p_phone: '', p_status: 'going', p_plus_ones: 0, p_note: '', p_answers: {}, p_key: null });
  call('gated_rsvp_respond', { p_code: code, p_participant: 'dbguest-0001', p_owner_token: null, p_first_name: 'Ann', p_last_name: 'Ash', p_phone: '', p_status: 'going', p_plus_ones: 0, p_note: 'note only', p_answers: {}, p_key: null });
  f = feed('rsvp', code, 'host', tok);
  check(f.items.length === 2 && f.items[0].type === 'rsvp.rsvp_changed' && f.items[0].detail.from === 'maybe' && f.items[0].detail.status === 'going', 'later change is its own item (note-only edits are quiet)');
  call('gated_rsvp_respond', { p_code: code, p_participant: 'dbguest-0001', p_owner_token: null, p_first_name: 'Ann', p_last_name: 'Ash', p_phone: '', p_status: 'maybe', p_plus_ones: 0, p_note: '', p_answers: {}, p_key: null });
  check(feed('rsvp', code, 'host', tok).items.length === 1, 'changed and changed back within 10 minutes: nothing to tell');
  check(!feed('rsvp', code, 'host', 'wrong').ok && !feed('rsvp', code, 'guest', 'nobody-responded').ok && !feed('rsvp', 'zzzzzzzz', 'host', tok).ok, 'wrong key / not responded / no event → ok:false');
  check(!feed('rsvp', code, 'admin', tok).ok && !feed('poll', code, 'host', tok).ok, 'bad role or app → ok:false');
  call('gated_rsvp_post', { p_code: code, p_participant: 'hostpid-0001', p_owner_token: tok, p_name: '', p_kind: 'announce', p_body: 'Bring a chair', p_key: null });
  f = feed('rsvp', code, 'guest', 'dbguest-0001');
  check(f.ok && f.items.length === 1 && f.items[0].type === 'rsvp.announce', 'guest feed: announcements only');
  check(!feed('rsvp', code, 'host', tok).items.some(n => n.type === 'rsvp.announce'), 'host feed: no announcements');
  check(/permission denied/.test(sql("set role anon; select count(*) from notifications").stderr), 'anon cannot read the table');
  check(/permission denied/.test(sql("set role anon; select _notify_add('rsvp', gen_random_uuid(), 'rsvp.comment', null, null, 'x', '{}')").stderr), 'anon cannot add notifications');
  check(fails('notify_feed', { p_feeds: 'nope' }) && fails('notify_feed', { p_feeds: Array(41).fill({}) }), 'bad input rejected');
  // admin "open as host" keys don't get a host feed
  sql(`insert into rsvp_owner_keys (event_id, key_hash, label) select id, _rsvp_hash('admintok'), 'admin' from rsvp_events where code = '${code}'`);
  check(!feed('rsvp', code, 'host', 'admintok').ok, 'admin key has no host feed');
  // passwords: guests need the lock key
  const ls = call('lock_set', { p_app: 'rsvp', p_code: code, p_owner_token: tok, p_password: 'tacos' });
  check(!feed('rsvp', code, 'guest', 'dbguest-0001').ok, 'locked event: guest without lock key refused');
  check(feed('rsvp', code, 'guest', 'dbguest-0001', { lock: ls.key }).ok, 'locked event: guest with lock key ok');
  check(feed('rsvp', code, 'host', tok).ok, 'locked event: host fine');
  call('lock_set', { p_app: 'rsvp', p_code: code, p_owner_token: tok, p_password: '' });
  // turning kinds off
  let so = call('notify_set_off', { p_feeds: [{ app: 'rsvp', code, role: 'host', key: tok, off: ['rsvp.rsvp_new', 'rsvp.announce', 'wdw.final_date', 'junk'] }] });
  f = feed('rsvp', code, 'host', tok);
  check(so[0].ok && JSON.stringify(f.off) === '["rsvp.rsvp_new"]', 'only this app/role kinds can be turned off: ' + JSON.stringify(f.off));
  check(!f.items.some(n => n.type === 'rsvp.rsvp_new'), 'turned-off kind hidden');
  check(!call('notify_set_off', { p_feeds: [{ app: 'rsvp', code, role: 'host', key: 'wrong', off: [] }] })[0].ok, 'set_off needs the key');
  call('notify_set_off', { p_feeds: [{ app: 'rsvp', code, role: 'host', key: tok, off: [] }] });
  check(feed('rsvp', code, 'host', tok).items.some(n => n.type === 'rsvp.rsvp_new'), 'turned back on: history is back');
  // deleting
  const cid = (call('gated_rsvp_post', { p_code: code, p_participant: 'dbguest-0001', p_owner_token: null, p_name: 'Ann Ash', p_kind: 'comment', p_body: 'spam', p_key: null }), JSON.parse(sql(`select to_jsonb(id) from rsvp_posts where body = 'spam'`).stdout));
  check(feed('rsvp', code, 'host', tok).items.some(n => n.type === 'rsvp.comment'), 'comment notifies');
  call('gated_rsvp_delete_post', { p_code: code, p_participant: null, p_owner_token: tok, p_post: cid, p_key: null });
  check(!feed('rsvp', code, 'host', tok).items.some(n => n.type === 'rsvp.comment'), 'deleted comment leaves the bell');
  call('rsvp_delete_event', { p_code: code, p_owner_token: tok });
  check(sql(`select count(*) from notifications`).stdout.trim() === '0' && sql(`select count(*) from notify_off`).stdout.trim() === '0', 'event delete clears its notifications');

  /* ---------------- RSVP pages */
  const ev2 = call('rsvp_create', { p_event: { title: 'Game Night', emoji: '🎲', tz: 'UTC' } });
  call('rsvp_invite_add', { p_code: ev2.code, p_owner_token: ev2.owner_token, p_people: [{ name: 'Zed Zee', phones: ['6125550100'] }] });
  const host = await phone(browser, devices, DB), guest = await phone(browser, devices, DB);
  await host.goto(B + '/rsvp/?e=' + ev2.code + '&o=' + ev2.owner_token);
  await host.waitForSelector('#host .host');
  await host.waitForFunction(() => { const b = document.querySelector('[data-pn-bell]'); return b && !b.hidden; });
  check(await badge(host) === '', 'host bell shows, nothing new');
  await guest.goto(B + '/rsvp/?e=' + ev2.code);
  await guest.waitForSelector('#me');
  check(!(await bellShown(guest)), 'guest who hasn’t replied: no bell');
  const gpid = await pidOf(guest, 'rsvp.pid'), hpid = await pidOf(host, 'rsvp.pid');
  call('gated_rsvp_respond', { p_code: ev2.code, p_participant: gpid, p_owner_token: null, p_first_name: 'Amy', p_last_name: 'Lee', p_phone: '6125550199', p_status: 'going', p_plus_ones: 0, p_note: '', p_answers: {}, p_key: null });
  call('gated_rsvp_post', { p_code: ev2.code, p_participant: gpid, p_owner_token: null, p_name: 'Amy Lee', p_kind: 'comment', p_body: 'Can I bring my dog?', p_key: null });
  call('gated_rsvp_post', { p_code: ev2.code, p_participant: hpid, p_owner_token: ev2.owner_token, p_name: 'Hosty Host', p_kind: 'comment', p_body: 'My own comment', p_key: null });
  await check_(host);
  check(await badge(host) === '2', 'host badge counts the reply and comment, not their own comment: ' + await badge(host));
  await host.waitForFunction(() => /Can I bring my dog/.test(document.querySelector('#comments').textContent), null, { timeout: 5000 }).catch(() => {});
  check(/Can I bring my dog/.test(await host.textContent('#comments')), 'open page reloads when something new arrives');
  await host.click('.pn-bell');
  const txt = await host.textContent('.pn-sheet');
  check(/Amy Lee is going/.test(txt) && /Amy Lee: “Can I bring my dog\?”/.test(txt) && !/My own comment/.test(txt), 'list shows the items: ' + txt);
  check(await host.locator('.pn-item.new').count() === 2, 'both marked new in the list');
  if (shots) await host.screenshot({ path: '/tmp/notify_rsvp_list.png' });
  check(await badge(host) === '', 'opening the list clears the badge');
  await host.click('.pn-item:has-text("dog")');
  check(!(await host.locator('.pn-wrap').count()), 'tapping an item closes the list');
  await host.waitForTimeout(600);
  check(await host.evaluate(() => { const r = document.querySelector('#comments').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }), 'tapping a comment scrolls to comments');
  await host.reload(); await host.waitForSelector('#host .host');
  await host.waitForFunction(() => { const b = document.querySelector('[data-pn-bell]'); return b && !b.hidden; });
  check(await badge(host) === '', 'seen is remembered on this phone');

  // announcement → guest bell, and the text-the-invited offer
  await host.fill('#annBody', 'Parking is behind the hall');
  await host.click('#annForm button[type=submit]');
  await host.waitForSelector('.annsent');
  check(/1 person on your invite list hasn’t replied/.test(await host.textContent('.annsent')), 'announcement: offers to text who hasn’t replied');
  if (shots) { await host.locator('#host').scrollIntoViewIfNeeded(); await host.screenshot({ path: '/tmp/notify_annsent.png' }); }
  await host.click('[data-act=ann-text]');
  check(await host.inputValue('#smsBody') === 'Parking is behind the hall', 'text box filled with the announcement');
  check(await host.isChecked('[data-aud=invited]') && !(await host.isChecked('[data-aud=going]')), 'audience: invited, no reply yet');
  check(/Zed Zee/.test(await host.textContent('#textList')), 'Zed is in the text list');
  await guest.reload(); await guest.waitForSelector('#me');
  await guest.waitForFunction(() => { const b = document.querySelector('[data-pn-bell]'); return b && !b.hidden; });
  check(await badge(guest) === '', 'guest feed starts with what was already there marked seen');
  call('gated_rsvp_post', { p_code: ev2.code, p_participant: hpid, p_owner_token: ev2.owner_token, p_name: '', p_kind: 'announce', p_body: 'Starts at 7 now', p_key: null });
  await check_(guest);
  check(await badge(guest) === '1', 'guest badge for a new announcement');
  await guest.click('.pn-bell');
  check(/Host: Starts at 7 now/.test(await guest.textContent('.pn-sheet')), 'guest sees the announcement');
  check(!/Amy Lee is going/.test(await guest.textContent('.pn-sheet')), 'guest never sees host items');
  await guest.click('[data-pn=close]');

  /* ---------------- Which Day Works? */
  const w = call('wdw_create', { p_name: 'Cabin weekend', p_description: '', p_num_days: 2, p_earliest: null, p_latest: null });
  await host.goto(B + '/whichdayworks/?e=' + w.code + '&o=' + w.owner_token);
  await host.waitForSelector('#cal');
  const wg = await phone(browser, devices, DB);
  await wg.goto(B + '/whichdayworks/?e=' + w.code); await wg.waitForSelector('#cal');
  const wpid = await pidOf(wg, 'meetup.pid');
  call('gated_save_response', { p_code: w.code, p_participant: wpid, p_name: 'Jo', p_note: '', p_picks: { '2026-12-05': { s: 'preferred' } }, p_replace: false, p_key: null });
  await host.waitForFunction(() => { const b = document.querySelector('[data-pn-bell]'); return b && !b.hidden; });
  await check_(host);
  check(await badge(host) === '1', 'organizer badge for a new answer');
  await host.click('.pn-bell');
  check(/Jo added their days/.test(await host.textContent('.pn-sheet')), 'organizer sees “Jo added their days”');
  await host.click('[data-pn=close]');
  await wg.reload(); await wg.waitForSelector('#cal');
  await wg.waitForFunction(() => { const b = document.querySelector('[data-pn-bell]'); return b && !b.hidden; });
  call('wdw_set_final', { p_code: w.code, p_owner_token: w.owner_token, p_start: '2026-12-05' });
  await check_(wg);
  check(await badge(wg) === '1', 'guest badge when the date is picked');
  await wg.click('.pn-bell');
  check(/The date is set: Sat, Dec 5 \(2 days\)/.test(await wg.textContent('.pn-sheet')), 'guest sees the final date: ' + await wg.textContent('.pn-sheet'));
  if (shots) await wg.screenshot({ path: '/tmp/notify_wdw_guest.png' });

  /* ---------------- homepage and settings */
  await host.goto(B + '/');
  await host.waitForFunction(() => { const b = document.querySelector('[data-pn-bell]'); return b && !b.hidden; });
  await host.click('.pn-bell');
  const home = await host.textContent('.pn-sheet');
  check(/🎲 Game Night/.test(home) && /Cabin weekend/.test(home) && /Which Day Works\?/.test(home), 'homepage bell lists all events, grouped: ' + home);
  if (shots) {
    await host.screenshot({ path: '/tmp/notify_home.png' });
    await host.emulateMedia({ colorScheme: 'dark' }); await host.screenshot({ path: '/tmp/notify_home_dark.png' }); await host.emulateMedia({ colorScheme: 'light' });
  }
  await host.click('[data-pn=close]');
  await host.goto(B + '/notifications/');
  await host.waitForSelector('.card');
  const st = await host.textContent('#app');
  check(/RSVP/.test(st) && /Events you host/.test(st) && /New comments/.test(st) && /Someone added their days/.test(st) && /Game Night/.test(st), 'settings lists kinds and events');
  check(!/Announcements from the host/.test(st), 'host-only phone: no guest kinds');
  if (shots) {
    await host.screenshot({ path: '/tmp/notify_settings.png', fullPage: true });
    await host.emulateMedia({ colorScheme: 'dark' }); await host.screenshot({ path: '/tmp/notify_settings_dark.png', fullPage: true }); await host.emulateMedia({ colorScheme: 'light' });
  }
  await host.click('.card:has-text("Events you host") .sw:has-text("New comments")');
  await host.waitForSelector('.toast.show');
  check(/Saved/.test(await host.textContent('.toast')), 'saved toast');
  check(JSON.stringify(feed('rsvp', ev2.code, 'host', ev2.owner_token).off) === '["rsvp.comment"]', 'all-events switch saved on the server');
  check(!(await host.isChecked('.card:has-text("Events you host") .sw:has-text("New comments") input')), 'switch stays off after redraw');
  await host.click('details.card:has-text("Cabin weekend") summary');
  await host.click('details.card:has-text("Cabin weekend") .sw:has-text("Someone changed their days")');
  await host.waitForFunction(() => document.querySelector('details.card:has(.offn)'));
  check(JSON.stringify(feed('wdw', w.code, 'host', w.owner_token).off) === '["wdw.response_changed"]', 'per-event switch saved');
  check(JSON.stringify(feed('rsvp', ev2.code, 'host', ev2.owner_token).off) === '["rsvp.comment"]', 'per-event switch leaves other events alone');
  // a new event picks up the phone's "all events" choice
  const ev3 = call('rsvp_create', { p_event: { title: 'Brunch', tz: 'UTC' } });
  await host.goto(B + '/rsvp/?e=' + ev3.code + '&o=' + ev3.owner_token);
  await host.waitForSelector('#host .host');
  await host.waitForFunction(() => { const b = document.querySelector('[data-pn-bell]'); return b && !b.hidden; });
  await host.waitForTimeout(500);
  check(JSON.stringify(feed('rsvp', ev3.code, 'host', ev3.owner_token).off) === '["rsvp.comment"]', 'new event gets the all-events setting');
  // deleting an event forgets it
  await host.click('[data-act=delete-event]');
  await host.waitForSelector('#eventForm');
  check(!(await host.evaluate(c => Object.keys(JSON.parse(localStorage.getItem('pebbly_notify_feeds'))).some(k => k.includes(c)), ev3.code)), 'deleted event dropped from this phone');

  /* ---------------- before the migration: no bell, no errors */
  const old = await phone(browser, devices, 'notify_old');
  const ev4 = call('rsvp_create', { p_event: { title: 'Old DB', tz: 'UTC' } }, 'notify_old');
  await old.goto(B + '/rsvp/?e=' + ev4.code + '&o=' + ev4.owner_token);
  await old.waitForSelector('#host .host');
  await old.waitForTimeout(800);
  check(!(await bellShown(old)), 'no bell before the migration');
  await old.goto(B + '/notifications/'); await old.waitForSelector('.msg');
  check(/aren’t switched on yet/.test(await old.textContent('.msg')), 'settings page explains before the migration');

  for (const p of [host, guest, wg, old]) check(!p.errs.length, 'page errors: ' + p.errs.join('; '));
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' checks:', e.message.split('\n')[0], (e.stack.match(/notify_test.js:\d+/) || [])[0]); process.exit(1); });
