// Sign-up Sheet (/signup/) end to end against a local Postgres, with several phones.
// Setup: sh tests/setup_db.sh agent_b; serve the repo root: python3 -m http.server 8782
// Run:   NODE_PATH=$(npm root -g) node tests/signup_test.js     (DB=… PORT=… SHOTS=<dir> to change; SHOTS saves screenshots)
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const DB = process.env.DB || 'agent_b', B = 'http://localhost:' + (process.env.PORT || 8782) + '/signup/', SHOTS = process.env.SHOTS;
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
const all = [];
async function mk(b, opts) {
  const p = await phone(b, devices, DB, { permissions: ['clipboard-read', 'clipboard-write'], ...(opts || {}) });
  all.push(p); return p;
}
async function shot(p, name, full = true) { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name + '.png', fullPage: full }); }
async function ok(p) { await p.click('dialog.dlg [data-ok]'); await p.waitForSelector('dialog.dlg', { state: 'detached' }); }
const slot = (label) => `.slot:has(b:text-is("${label}"))`;
async function signUp(p, label, name, note, submit = true) {
  await p.click(slot(label) + ' [data-act=signup]');
  if (name !== null) await p.fill('dialog input[name=name]', name);
  if (note) await p.fill('dialog input[name=note]', note);
  if (submit) { await p.click('dialog button[type=submit]'); await p.waitForSelector('dialog.dlg', { state: 'detached' }); }
}
const badge = (p, label) => p.textContent(slot(label) + ' .badge');
async function waitText(p, sel, s, t = 9000) { await p.locator(sel).filter({ hasText: s }).first().waitFor({ timeout: t }); return true; }

(async () => {
  const b = await chromium.launch();
  /* ---- organizer creates */
  const org = await mk(b);
  await org.goto(B);
  await org.evaluate(() => localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Gina', 'Hal'], games: [] })));
  await shot(org, 'home');
  await org.click('#createForm button[type=submit]');
  check((await org.textContent('#formErr')).includes('name'), 'title required');
  await org.fill('input[name=title]', 'Potluck on Saturday');
  await org.fill('textarea[name=details]', 'Park pavilion, 5pm. Bring a chair!');
  await org.fill('textarea[name=slots]', 'Bring dessert x3\nBring drinks\nSetup crew x2\n\nbring drinks');
  await org.click('#createForm button[type=submit]');
  await org.waitForSelector('.slot');
  const code = new URL(org.url()).searchParams.get('d');
  check(/^[a-z0-9]{8}$/.test(code), 'sheet created ' + code);
  check((await org.locator('.slot').count()) === 3, '3 slots (duplicate line skipped)');
  check((await badge(org, 'Bring dessert')) === '3 of 3 left' && (await badge(org, 'Bring drinks')) === '1 spot open', 'spot counts from "x3"');
  check(await org.locator('.created').isVisible() && await org.locator('.host').isVisible(), 'share box and organizer tools');
  await waitText(org, '#sync', 'Saved');

  /* ---- guests */
  const ann = await mk(b), ben = await mk(b, { colorScheme: 'dark' }), cy = await mk(b);
  for (const p of [ann, ben, cy]) { await p.goto(B + '?d=' + code); await p.waitForSelector('.slot'); }
  check(!(await ann.locator('.host').count()) && !(await ann.locator('.created').count()), 'guest sees no organizer tools');
  await ann.evaluate(() => localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Ann'], games: [] })));
  await ann.click(slot('Bring dessert') + ' [data-act=signup]');
  await ann.click('dialog .chip .add');
  check((await ann.inputValue('dialog input[name=name]')) === 'Ann', 'remembered-name chip fills the name');
  await ann.click('dialog button[type=submit]');
  check(true, 'no note needed');
  await ann.waitForSelector(slot('Bring dessert') + ' .you');
  check((await badge(ann, 'Bring dessert')) === '2 of 3 left', 'spots left updates');
  check(!(await ann.locator(slot('Bring dessert') + ' [data-act=signup]').count()), 'no second sign-up for the same slot');
  // name is remembered for next time
  await ann.click(slot('Bring drinks') + ' [data-act=signup]');
  check((await ann.inputValue('dialog input[name=name]')) === 'Ann', 'own name remembered');
  await ann.click('dialog [data-no]');
  // note
  await ann.click(slot('Bring dessert') + ' [data-act=note]');
  await ann.fill('dialog input[name=note]', 'bringing brownies');
  await ann.click('dialog button[type=submit]');
  await waitText(ann, slot('Bring dessert') + ' .note', 'brownies');
  // empty name refused
  await signUp(ben, 'Bring drinks', '', '', false);
  await ben.click('dialog button[type=submit]');
  check((await ben.textContent('dialog .err')).includes('Enter your name'), 'name required');
  await ben.fill('dialog input[name=name]', 'Ben'); await ben.fill('dialog input[name=note]', 'lemonade');
  await ben.click('dialog button[type=submit]');
  await ben.waitForSelector(slot('Bring drinks') + ' .you');
  check((await badge(ben, 'Bring drinks')) === 'Full', 'single spot shows Full');
  // live on other phones
  check(await waitText(org, slot('Bring drinks'), 'Ben'), 'organizer sees Ben live');
  check(await waitText(cy, slot('Bring dessert'), 'brownies'), 'other guest sees Ann’s note live');
  check(await cy.locator(slot('Bring drinks') + ' button:has-text("Full")').isDisabled(), 'full slot can’t be taken');
  check(!(await cy.locator(slot('Bring drinks') + ' [data-act=remove]').count()), 'guest can’t remove others');
  check((await cy.textContent(slot('Bring drinks'))).includes('lemonade') && !(await cy.textContent(slot('Bring drinks'))).includes('(you)'), 'others not marked (you)');

  /* ---- two phones take the last spot at the same moment */
  await signUp(cy, 'Setup crew', 'Cy');
  await ann.waitForFunction(() => document.body.textContent.includes('Cy'), null, { timeout: 9000 });
  await ben.waitForFunction(() => document.body.textContent.includes('Cy'), null, { timeout: 9000 });
  await signUp(ann, 'Setup crew', null, '', false);
  await signUp(ben, 'Setup crew', 'Ben', '', false);
  await Promise.all([ann.click('dialog button[type=submit]'), ben.click('dialog button[type=submit]')]);
  await org.waitForFunction(() => { const b = [...document.querySelectorAll('.slot')].find(s => s.textContent.includes('Setup crew')); return b && b.querySelectorAll('.people li').length === 3; }, null, { timeout: 12000 });
  check((await badge(org, 'Setup crew')) === 'Full +1 extra', 'overfill shown honestly: ' + await badge(org, 'Setup crew'));
  check((await org.locator(slot('Setup crew') + ' .extra').count()) === 1, 'the later one is marked extra');
  await ann.waitForFunction(() => document.body.textContent.includes('Full +1 extra'), null, { timeout: 9000 });
  await shot(ben, 'sheet-dark');
  await shot(org, 'sheet-organizer');

  /* ---- remove own sign-up, organizer removes someone */
  await ben.click(slot('Setup crew') + ' [data-act=remove]'); await ok(ben);
  await ben.waitForFunction(() => { const b = [...document.querySelectorAll('.slot')].find(s => s.textContent.includes('Setup crew')); return !b.querySelector('.you'); });
  check((await badge(ben, 'Setup crew')) === 'Full', 'own sign-up removed');
  await org.waitForFunction(() => document.body.textContent.includes('Setup crew') && !document.body.textContent.includes('+1 extra'), null, { timeout: 9000 });
  await org.click(slot('Setup crew') + ' li:has-text("Cy") [data-act=remove]'); await ok(org);
  check(await waitText(cy, slot('Setup crew') + ' .badge', '1 of 2 left'), 'organizer removed Cy (seen live by Cy)');

  /* ---- summary */
  await org.click('.tools [data-act=summary]');
  const sum = await org.evaluate(() => navigator.clipboard.readText());
  check(sum.includes('Potluck on Saturday') && sum.includes('Bring dessert: Ann (bringing brownies) [2 spots open]') && sum.includes('Bring drinks: Ben (lemonade)') && sum.includes('?d=' + code),
    'summary text: ' + JSON.stringify(sum));

  /* ---- organizer edits */
  await org.click('[data-act=edit]');
  await org.waitForSelector('#editor');
  await shot(org, 'editor');
  const es = (label) => `.eslot:has(input[data-ed=label][value="${label}"])`;
  await org.fill(es('Setup crew') + ' input[data-ed=when]', 'Sat 9–11am'); await org.press(es('Setup crew') + ' input[data-ed=when]', 'Enter');
  await org.fill(es('Bring drinks') + ' input[data-ed=label]', 'Bring cold drinks'); await org.press(es('Bring drinks') + ' input[data-ed=label]', 'Enter');
  await org.fill(es('Bring dessert') + ' input[data-ed=spots]', '1'); await org.press(es('Bring dessert') + ' input[data-ed=spots]', 'Tab');
  await org.click(es('Setup crew') + ' [data-act=up]');
  await org.fill('#addSlots textarea', 'Cleanup x4\nPlates');
  await org.click('#addSlots button[type=submit]');
  await org.waitForFunction(() => document.querySelectorAll('.eslot').length === 5);
  await org.click('.eslot:has(input[value="Plates"]) [data-act=rmslot]'); await ok(org);
  await org.waitForFunction(() => document.querySelectorAll('.eslot').length === 4);
  await org.fill('input[data-ed=title]', 'Big potluck'); await org.press('input[data-ed=title]', 'Enter');
  await org.click('[data-act=done]');
  await org.waitForSelector('#slots');
  const order = await org.$$eval('.slot .shead b', els => els.map(e => e.textContent));
  check(JSON.stringify(order) === JSON.stringify(['Bring dessert', 'Setup crew', 'Bring cold drinks', 'Cleanup']), 'edits and order: ' + order);
  check((await org.textContent(slot('Setup crew') + ' .when')).includes('Sat 9–11am'), 'when text');
  check((await badge(org, 'Cleanup')) === '4 of 4 left', 'added with x4');
  check((await badge(org, 'Bring dessert')) === 'Full', 'spots reduced');
  check(await waitText(cy, 'h1', 'Big potluck') && await waitText(cy, slot('Bring cold drinks'), 'Ben'), 'edits reach guests live, sign-ups kept on renamed slot');
  // remove a slot that has sign-ups
  await org.click('[data-act=edit]'); await org.click('.eslot:has(input[value="Bring cold drinks"]) [data-act=rmslot]');
  check((await org.textContent('dialog.dlg')).includes('1 sign-up on it'), 'warns about sign-ups on a slot');
  await ok(org); await org.click('[data-act=done]');
  check(await ben.waitForFunction(() => !document.body.textContent.includes('cold drinks'), null, { timeout: 9000 }).then(() => true), 'slot removed for guests');

  /* ---- password, organizer link, delete */
  await org.click('[data-act=lock]'); await org.waitForSelector('.pl-dlg [type=submit]:not([disabled])');
  await org.fill('.pl-dlg input', 'cake'); await org.click('.pl-dlg [type=submit]');
  await org.waitForSelector('.pl-dlg', { state: 'detached' });
  check(await ann.waitForSelector('text=Password added', { timeout: 9000 }).then(() => true), 'open guest page told a password was added');
  const g = await mk(b); await g.goto(B + '?d=' + code);
  await g.waitForSelector('.pl-gate');
  check((await g.textContent('.pl-gate')).includes('This sheet is password protected') && !(await g.textContent('body')).includes('potluck'), 'gate, nothing shown');
  await shot(g, 'gate');
  await g.fill('.pl-gate input', 'cake'); await g.click('.pl-gate button'); await g.waitForSelector('.slot');
  await signUp(g, 'Cleanup', 'Gil');
  check(await waitText(g, slot('Cleanup') + ' .badge', '3 of 4'), 'guest signs up after password');
  const olink = await org.evaluate(c => PebblyDoc.ownerLink(c), code);
  const org2 = await mk(b); await org2.goto(olink); await org2.waitForSelector('.host');
  check(!(await org2.url()).includes('o='), 'organizer link works on another phone (no password asked), address tidied');
  await org.goto(B); await org.waitForSelector('.recent');
  check((await org.textContent('.recent')).includes('Big potluck') && (await org.textContent('.recent')).includes('organizer'), 'Your sheets list');
  await org2.click('[data-act=delete]'); await ok(org2);
  await org2.waitForSelector('#createForm');
  await g.waitForSelector('text=Sheet deleted', { timeout: 9000 });
  check(true, 'open page sees the sheet was deleted');
  const nf = await mk(b); await nf.goto(B + '?d=zzzzzzzz'); await nf.waitForSelector('text=Sheet not found');
  check(true, 'not-found page');

  /* ---- 320px */
  const small = await mk(b, { viewport: { width: 320, height: 640 } });
  await small.goto(B); await small.waitForSelector('#createForm');
  await small.fill('input[name=title]', 'Office party with a fairly long name'); await small.fill('textarea[name=slots]', 'Bring a really quite long named dish to share x12\nMusic');
  await small.click('#createForm button[type=submit]'); await small.waitForSelector('.slot');
  await signUp(small, 'Music', 'Maximiliana Longname-Smith', 'playlist and speaker and also some extra cables');
  check(await small.evaluate(() => document.documentElement.scrollWidth <= 320), 'no sideways scroll at 320px');
  await shot(small, 'sheet-320');
  await small.click('[data-act=edit]');
  check(await small.evaluate(() => document.documentElement.scrollWidth <= 320), 'editor fits at 320px');
  await shot(small, 'editor-320');

  for (const p of all) check(!p.errs.length, 'page errors: ' + p.errs.join(' | '));
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' passed:', e.message.split('\n')[0]); process.exit(1); });
