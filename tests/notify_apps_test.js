// Notifications for Poll (winner picked), Sign-up Sheet (someone signs up) and Secret Santa (names drawn),
// end to end against a local Postgres (see CLAUDE.md → Testing). The bell itself is tested in notify_test.js.
//   sh tests/setup_db.sh notify2
//   python3 -m http.server 8795        (from the repo root)
//   NODE_PATH=$(npm root -g) node tests/notify_apps_test.js      (SHOTS=1 also saves screenshots to /tmp/notify_apps_*.png)
const { chromium, devices } = require('playwright');
const { spawnSync } = require('child_process');
const { rpc, phone } = require('./pg_bridge');
const B = 'http://localhost:8795', DB = 'notify2';
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }
function call(fn, args) { const r = rpc(DB, fn, args); if (r.status !== 200) throw new Error(fn + ': ' + r.body); return r.body ? JSON.parse(r.body) : null; }
function sql(q) { return spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', DB, '-At', '-c', q], { encoding: 'utf8' }).stdout.trim(); }
const feed = (app, code, role, key, extra) => call('notify_feed', { p_feeds: [{ app, code, role, key, ...(extra || {}) }] })[0];
const badge = p => p.evaluate(() => { const b = document.querySelector('[data-pn-bell] .pn-badge'); return b && !b.hidden ? b.textContent : ''; });
const bellShown = p => p.evaluate(() => { const b = document.querySelector('[data-pn-bell]'); return !!b && !b.hidden && !!b.querySelector('.pn-bell'); });
const waitBell = p => p.waitForFunction(() => { const b = document.querySelector('[data-pn-bell]'); return b && !b.hidden && b.querySelector('.pn-bell'); });
const pidOf = (p, k) => p.evaluate(k => JSON.parse(localStorage.getItem(k)), k);
const sheet = async p => { await p.click('.pn-bell'); const t = await p.textContent('.pn-sheet'); return t; };

(async () => {
  const browser = await chromium.launch();
  const shots = !!process.env.SHOTS;

  /* ---------------- Poll: voters hear the winner */
  const pl = call('poll_create', { p_name: 'Lunch spot', p_description: '', p_allow_down: false, p_anonymous: false, p_allow_custom: true, p_options: ['Tacos', 'Pizza'], p_single_vote: false });
  const voter = await phone(browser, devices, DB), host = await phone(browser, devices, DB);
  await host.goto(B + '/poll/?p=' + pl.code + '&o=' + pl.owner_token);
  await host.waitForSelector('#opts');
  await voter.goto(B + '/poll/?p=' + pl.code);
  await voter.waitForSelector('#opts');
  await voter.waitForTimeout(600);
  check(!(await bellShown(voter)), 'no bell before voting');
  const opts = call('gated_poll_get', { p_code: pl.code, p_participant: null, p_owner_token: null, p_key: null }).options;
  const vpid = await pidOf(voter, 'pick.pid');
  call('gated_poll_vote', { p_code: pl.code, p_participant: vpid, p_name: 'Amy', p_option: opts[0].id, p_value: 1, p_key: null });
  await voter.reload(); await voter.waitForSelector('#opts'); await waitBell(voter);
  check(await badge(voter) === '', 'voter’s bell starts quiet');
  check(!feed('poll', pl.code, 'guest', 'someone-else-1').ok, 'not voted: no feed');
  call('poll_set_winner', { p_code: pl.code, p_owner_token: pl.owner_token, p_option: opts[0].id, p_method: 'roulette' });
  await voter.evaluate(() => PebblyNotify.check());
  check(await badge(voter) === '1', 'voter told about the winner');
  const vt = await sheet(voter);
  check(/The winner is Tacos \(picked by a spin\)/.test(vt), 'winner wording: ' + vt);
  if (shots) await voter.screenshot({ path: '/tmp/notify_apps_poll.png' });
  await voter.click('.pn-item');
  await voter.waitForTimeout(500);
  check(await voter.evaluate(() => { const r = document.querySelector('#winner').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }), 'tapping it shows the winner');
  call('poll_set_winner', { p_code: pl.code, p_owner_token: pl.owner_token, p_option: null, p_method: null });
  check(!feed('poll', pl.code, 'guest', vpid).items.length, 'winner cleared: notification gone');
  call('poll_set_winner', { p_code: pl.code, p_owner_token: pl.owner_token, p_option: opts[1].id, p_method: 'picked' });
  const pf = feed('poll', pl.code, 'guest', vpid);
  check(pf.items.length === 1 && pf.items[0].name === 'Pizza' && pf.title === 'Lunch spot', 'new pick replaces it');
  check(!(await bellShown(host)), 'host-only phone: no bell yet (nothing for hosts in Poll)');

  /* ---------------- Sign-up Sheet: the host hears about sign-ups */
  const state = { title: 'Potluck', details: '', slots: { s1: { label: 'Bring dessert', when: '', spots: 2, order: 1 } }, signups: {} };
  const sd = call('doc_create', { p_kind: 'signup', p_state: state });
  await host.goto(B + '/signup/?d=' + sd.code + '&o=' + sd.owner_token);
  await host.waitForSelector('#slots');
  await waitBell(host);
  check(await badge(host) === '', 'host bell on the sheet, quiet');
  const hpid = await pidOf(host, 'pebbly_signup_pid');
  const push = (st) => { const v = call('gated_doc_get', { p_code: sd.code, p_owner_token: null, p_since: 0, p_key: null }).version; return call('gated_doc_push', { p_code: sd.code, p_expected: v, p_state: st, p_key: null }); };
  push({ ...state, signups: { e1: { slot: 's1', name: 'Sam', note: '', pid: 'sampid-0001', at: 1 }, e2: { slot: 's1', name: 'Me', note: '', pid: hpid, at: 2 } } });
  await host.evaluate(() => PebblyNotify.check());
  check(await badge(host) === '1', 'host told about Sam (not about themselves): ' + await badge(host));
  const st = await sheet(host);
  check(/Sam signed up for Bring dessert/.test(st), 'sign-up wording: ' + st);
  if (shots) await host.screenshot({ path: '/tmp/notify_apps_signup.png' });
  await host.click('[data-pn=close]');
  push({ ...state, signups: { e2: { slot: 's1', name: 'Me', note: '', pid: hpid, at: 2 } } });
  check(!feed('signup', sd.code, 'host', sd.owner_token).items.some(n => n.name === 'Sam'), 'Sam takes their name off: notification gone');
  const bill = call('doc_create', { p_kind: 'bill', p_state: { people: {}, items: {} } });
  check(!feed('signup', bill.code, 'host', bill.owner_token).ok, 'a bill isn’t a sign-up sheet');
  check(!feed('signup', sd.code, 'guest', 'sampid-0001').ok, 'no guest feed for sign-up sheets');

  /* ---------------- Secret Santa: everyone who picked their name hears about the draw */
  const sg = call('santa_create', { p_name: 'Family swap', p_budget: '$30', p_swap_date: null, p_note: '', p_people: ['Ann', 'Bo', 'Cy'], p_self_join: true });
  const ann = await phone(browser, devices, DB);
  await ann.goto(B + '/santa/?g=' + sg.code);
  await ann.waitForSelector('#pick');
  const apid = await pidOf(ann, 'pebbly_santa_pid');
  const people = call('gated_santa_get', { p_code: sg.code, p_participant: apid, p_owner_token: null, p_key: null }).people;
  call('gated_santa_claim', { p_code: sg.code, p_participant: apid, p_person: people.find(p => p.name === 'Ann').id, p_key: null });
  await ann.reload(); await waitBell(ann);
  call('santa_draw', { p_code: sg.code, p_owner_token: sg.owner_token });
  await ann.evaluate(() => PebblyNotify.check());
  check(await badge(ann) === '1', 'Ann told names are drawn');
  const at = await sheet(ann);
  check(/Names are drawn! Open it to see who you’re buying for\./.test(at), 'draw wording: ' + at);
  if (shots) await ann.screenshot({ path: '/tmp/notify_apps_santa.png' });
  const af = JSON.stringify(feed('santa', sg.code, 'guest', apid));
  check(!/"Bo"|"Cy"/.test(af), 'the notification never says who has whom: ' + af);
  check(!feed('santa', sg.code, 'guest', 'not-claimed-123').ok, 'phone without a name: no feed');
  call('santa_undraw', { p_code: sg.code, p_owner_token: sg.owner_token });
  check(!feed('santa', sg.code, 'guest', apid).items.length, 'undo the draw: notification gone');
  call('santa_draw', { p_code: sg.code, p_owner_token: sg.owner_token });

  /* ---------------- phone alerts carry the right names and links */
  sql(`insert into push_subs (endpoint, p256dh, auth) values ('https://fcm.googleapis.com/fcm/send/x', 'k', 'a')`);
  sql(`insert into push_targets (sub_id, app, event_id, role, who_hash, pid) select s.id, 'santa', g.id, 'guest', 'w', '' from push_subs s, santa_groups g where g.code = '${sg.code}'`);
  sql(`insert into push_targets (sub_id, app, event_id, role, who_hash, pid) select s.id, 'signup', d.id, 'host', 'w', '' from push_subs s, plan_docs d where d.code = '${sd.code}'`);
  sql(`update notifications set pushed_at = null`);
  const q = JSON.parse(spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', DB, '-At'], { input: 'set role service_role;\nselect notify_push_queue();', encoding: 'utf8' }).stdout.trim().split('\n').pop());
  const sa = q.find(x => x.payload.app === 'santa'), su = q.find(x => x.payload.app === 'signup');
  check(sa && sa.payload.title === 'Family swap' && sa.payload.emoji === '🎁' && sa.payload.code === sg.code, 'Santa alert: ' + JSON.stringify(sa && sa.payload));
  check(su && su.payload.title === 'Potluck' && su.payload.type === 'signup.signup', 'Sign-up alert: ' + JSON.stringify(su && su.payload));
  check(await ann.evaluate(c => { const v = PebblyNotify.alertView({ app: 'santa', code: c, title: 'Family swap', emoji: '🎁', type: 'santa.drawn', name: 'Family swap', detail: {} }); return v.url === '/santa/?g=' + c && v.title === '🎁 Family swap'; }, sg.code), 'alert opens the Santa group');

  /* ---------------- RSVP: the host hears who's bringing what */
  const rv = call('rsvp_create', { p_event: { title: 'BBQ', tz: 'UTC' } });
  for (const l of ['Chips', 'Ice']) call('gated_rsvp_item_add', { p_code: rv.code, p_participant: 'hostsetup01', p_owner_token: rv.owner_token, p_name: '', p_label: l, p_needed: 1, p_key: null });
  await host.goto(B + '/rsvp/?e=' + rv.code + '&o=' + rv.owner_token);
  await host.waitForSelector('#host .host'); await waitBell(host);
  const items = call('gated_rsvp_get', { p_code: rv.code, p_participant: 'x', p_owner_token: null, p_key: null }).items;
  const chips = items.find(i => i.label === 'Chips').id, rhpid = await pidOf(host, 'rsvp.pid');
  call('gated_rsvp_item_claim', { p_code: rv.code, p_participant: 'guestbring01', p_name: 'Amy Lee', p_item: chips, p_claim: true, p_key: null });
  call('gated_rsvp_item_add', { p_code: rv.code, p_participant: 'guestbring02', p_owner_token: null, p_name: 'Bo Bee', p_label: 'Lawn games', p_needed: 1, p_key: null });
  call('gated_rsvp_item_claim', { p_code: rv.code, p_participant: rhpid, p_name: 'Host', p_item: items.find(i => i.label === 'Ice').id, p_claim: true, p_key: null });
  await host.evaluate(() => PebblyNotify.check());
  check(await badge(host) === '2', 'host told about two volunteers (not their own claim): ' + await badge(host));
  const bt = await sheet(host);
  check(/Amy Lee is bringing Chips/.test(bt) && /Bo Bee is bringing Lawn games/.test(bt), 'bring wording: ' + bt);
  if (shots) await host.screenshot({ path: '/tmp/notify_apps_bring.png' });
  await host.click('.pn-item:has-text("Chips")');
  await host.waitForTimeout(500);
  check(await host.evaluate(() => { const r = document.querySelector('#bring').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }), 'tapping it shows the bring list');
  call('gated_rsvp_item_claim', { p_code: rv.code, p_participant: 'guestbring01', p_name: 'Amy Lee', p_item: chips, p_claim: false, p_key: null });
  check(!feed('rsvp', rv.code, 'host', rv.owner_token).items.some(n => n.name === 'Amy Lee'), 'Amy takes it back: notification gone');

  /* ---------------- homepage bell and settings */
  await host.goto(B + '/notifications/');
  await host.waitForSelector('.card');
  const hs = await host.textContent('#app');
  check(/Sign-up Sheet/.test(hs) && /Someone signs up/.test(hs) && /Potluck/.test(hs), 'settings: sign-up sheet');
  check(!/Poll/.test(hs), 'settings: nothing for a Poll host');
  await voter.goto(B + '/notifications/'); await voter.waitForSelector('.card');
  check(/The winner is picked/.test(await voter.textContent('#app')), 'settings: poll voter');
  await ann.goto(B + '/'); await waitBell(ann);
  check(/🎁 Family swap/.test(await sheet(ann)), 'homepage bell lists the Santa group');

  for (const p of [voter, host, ann]) check(!p.errs.length, 'page errors: ' + p.errs.join('; '));
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' checks:', e.message.split('\n')[0], (e.stack.match(/notify_apps_test.js:\d+/) || [])[0]); process.exit(1); });
