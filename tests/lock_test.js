// Passwords for the Plan apps, end to end against a local Postgres (see CLAUDE.md → Testing).
// Database "t1": wdw_fixture, schema_snapshot, organizer, final_date, rsvp schema + updates + rsvp_admin,
// poll_fixture, then the plan_passwords migration. Database "t0": the same without the migration
// (checks the pages still work before it's applied). Serve the repo root on port 8770, then:
//   NODE_PATH=$(npm root -g) node tests/lock_test.js
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const B = 'http://localhost:8770';
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }

(async () => {
  const browser = await chromium.launch();
  const all = [];
  const mk = async (db) => { const p = await phone(browser, devices, db || 't1'); all.push(p); return p; };

  /* ---------------- RSVP */
  const host = await mk();
  await host.goto(B + '/rsvp/');
  await host.fill('input[name=title]', 'Secret Party');
  await host.fill('input[name=lockpw]', 'tacos');
  await host.click('#eventForm button[type=submit]');
  await host.waitForSelector('.host');
  const code = new URL(host.url()).searchParams.get('e');
  check(!!code, 'rsvp created');
  check(await host.locator('[data-act=lock]').isVisible(), 'host has password button');

  const g1 = await mk();
  await g1.goto(B + '/rsvp/?e=' + code);
  await g1.waitForSelector('.pl-gate');
  check(!(await g1.textContent('body')).includes('Secret Party'), 'guest sees nothing before password');
  await g1.fill('.pl-gate input', 'nachos');
  await g1.click('.pl-gate button');
  await g1.waitForFunction(() => document.querySelector('.pl-gate .err').textContent.length > 0);
  check((await g1.textContent('.pl-gate .err')).includes('isn’t right'), 'wrong password message');
  await g1.fill('.pl-gate input', ' tacos ');
  await g1.click('.pl-gate button');
  await g1.waitForSelector('#me');
  check((await g1.textContent('body')).includes('Secret Party'), 'guest opens with password');
  await g1.click('[data-act=status][data-id=going]');
  await g1.fill('#rFirst', 'Ana'); await g1.fill('#rLast', 'Lee');
  await g1.click('#rsvpForm button[type=submit]');
  await g1.waitForSelector('.myans');
  check((await g1.textContent('#guests')).includes('Ana'), 'guest can RSVP after unlocking');
  await g1.reload(); await g1.waitForSelector('#me');
  check(!(await g1.locator('.pl-gate').count()), 'password remembered on reload');

  // host link on another phone: no password asked
  const ownerTok = await host.evaluate(c => JSON.parse(localStorage.getItem('rsvp.owners'))[c], code);
  const host2 = await mk();
  await host2.goto(B + '/rsvp/?e=' + code + '&o=' + ownerTok);
  await host2.waitForSelector('.host');
  check(!(await host2.locator('.pl-gate').count()), 'host link skips password');

  // host changes the password
  await host.click('[data-act=lock]');
  await host.waitForSelector('.pl-dlg .pl-cur:not([hidden])');
  check((await host.textContent('.pl-dlg .pl-cur')).includes('tacos'), 'host sees current password');
  if (process.env.SHOTS) await host.screenshot({ path: process.env.SHOTS + '/lock-host.png' });
  await host.fill('.pl-dlg input', 'nachos');
  await host.click('.pl-dlg [type=submit]');
  await host.waitForSelector('.pl-dlg', { state: 'detached' });
  await host.reload(); await host.waitForSelector('.host');
  check(true, 'host still in after change');
  await g1.reload();
  await g1.waitForSelector('.pl-gate');
  check(true, 'guest asked again after change');
  if (process.env.SHOTS) await g1.screenshot({ path: process.env.SHOTS + '/lock-gate.png' });
  await g1.fill('.pl-gate input', 'nachos'); await g1.click('.pl-gate button');
  await g1.waitForSelector('#me');
  check(true, 'new password works');

  // remove
  await host.click('[data-act=lock]');
  await host.waitForSelector('.pl-dlg .pl-rm:not([hidden])');
  await host.click('.pl-dlg .pl-rm');
  await host.waitForSelector('.pl-dlg', { state: 'detached' });
  const g2 = await mk();
  await g2.goto(B + '/rsvp/?e=' + code);
  await g2.waitForSelector('#me');
  check(!(await g2.locator('.pl-gate').count()), 'no password after removing');

  // event without a password
  await host.goto(B + '/rsvp/');
  await host.fill('input[name=title]', 'Open Party');
  await host.click('#eventForm button[type=submit]');
  await host.waitForSelector('.host');
  const open = new URL(host.url()).searchParams.get('e');
  await g2.goto(B + '/rsvp/?e=' + open); await g2.waitForSelector('#me');
  check(!(await g2.locator('.pl-gate').count()), 'unprotected event opens directly');

  /* ---------------- Poll */
  await host.goto(B + '/poll/');
  await host.fill('input[name=name]', 'Secret Lunch');
  await host.fill('textarea[name=options]', 'Tacos\nPizza');
  await host.fill('input[name=lockpw]', 'pw1');
  await host.click('#createForm button[type=submit]');
  await host.waitForSelector('[data-act=lock]');
  const pcode = new URL(host.url()).searchParams.get('p');
  const pg = await mk();
  await pg.goto(B + '/poll/?p=' + pcode);
  await pg.waitForSelector('.pl-gate');
  check((await pg.textContent('.pl-gate')).includes('poll'), 'poll gate wording');
  await pg.fill('.pl-gate input', 'pw1'); await pg.click('.pl-gate button');
  await pg.waitForSelector('[data-act=vote]');
  await pg.fill('#myName', 'Bo');
  await pg.click('[data-act=vote] >> nth=0');
  await pg.waitForSelector('[data-act=vote][aria-pressed=true]');
  check(true, 'poll vote after unlocking');

  /* ---------------- Which Day Works? */
  await host.goto(B + '/whichdayworks/');
  await host.fill('input[name=name]', 'Secret Trip');
  await host.fill('input[name=lockpw]', 'pw2');
  await host.click('#createForm button[type=submit]');
  await host.waitForFunction(() => document.body.innerText.includes('Event created'));
  const wcode = await host.evaluate(() => { const o = JSON.parse(localStorage.getItem('meetup.owners') || localStorage.getItem('pick.owners') || '{}'); return Object.keys(o)[0]; });
  check(!!wcode, 'wdw created (' + wcode + ')');
  await host.goto(B + '/whichdayworks/?e=' + wcode);
  await host.waitForSelector('.panel.owner');
  check(await host.locator('[data-act=lock]').isVisible(), 'wdw organizer has password button');
  const wg = await mk();
  await wg.goto(B + '/whichdayworks/?e=' + wcode);
  await wg.waitForSelector('.pl-gate');
  await wg.fill('.pl-gate input', 'pw2'); await wg.click('.pl-gate button');
  await wg.waitForFunction(() => document.body.innerText.includes('Secret Trip'));
  check(true, 'wdw opens with password');

  /* ---------------- before the migration (t0): everything still works, no gates */
  const old = await mk('t0');
  await old.goto(B + '/rsvp/');
  await old.fill('input[name=title]', 'Old DB Party');
  await old.click('#eventForm button[type=submit]');
  await old.waitForSelector('.host');
  check((await old.textContent('body')).includes('Old DB Party'), 'rsvp works before migration');
  await old.click('[data-act=lock]');
  await old.waitForFunction(() => /available yet/.test((document.querySelector('.pl-dlg .pl-state') || {}).textContent || ''));
  check(true, 'password dialog explains before migration');

  for (const p of all) check(!p.errs.length, 'no page errors: ' + p.errs.join('; '));
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' passed:', e.message.split('\n')[0]); process.exit(1); });
