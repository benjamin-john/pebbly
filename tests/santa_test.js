// Secret Santa (/santa/) end to end against a local Postgres, with several phones.
// Setup: sh tests/setup_db.sh agent_b; serve the repo root: python3 -m http.server 8782
// Run:   NODE_PATH=$(npm root -g) node tests/santa_test.js     (DB=… PORT=… SHOTS=<dir> to change; SHOTS saves screenshots)
const { chromium, devices } = require('playwright');
const { phone, rpc } = require('./pg_bridge');
const DB = process.env.DB || 'agent_b', B = 'http://localhost:' + (process.env.PORT || 8782) + '/santa/', SHOTS = process.env.SHOTS;
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
const all = [];
async function mk(b, opts) { const p = await phone(b, devices, DB, opts); all.push(p); return p; }
async function shot(p, name, full = true) { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name + '.png', fullPage: full }); }
async function ok(p) { await p.click('dialog.dlg [data-ok]'); await p.waitForSelector('dialog.dlg', { state: 'detached' }); }
async function claim(p, name) {
  await p.click(`[data-act=claim][data-name="${name}"]`); await ok(p);
  await p.waitForFunction(n => document.querySelector('.youcard b') && document.querySelector('.youcard b').textContent === n, name);
}
async function toastHas(p, s) { await p.waitForFunction(s => document.getElementById('toast').textContent.includes(s), s, { timeout: 8000 }); return true; }

(async () => {
  const b = await chromium.launch();
  /* ---- organizer creates */
  const org = await mk(b);
  await org.goto(B);
  await org.evaluate(() => localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Dan', 'Zed'], games: [] })));
  await org.reload();
  await shot(org, 'home');
  await org.fill('input[name=name]', 'Family Christmas');
  await org.fill('input[name=budget]', '$25');
  await org.fill('input[name=date]', '2026-12-20');
  await org.fill('textarea[name=note]', 'Swap at Grandma’s after dinner.');
  await org.fill('textarea[name=people]', 'Ann\nBen\nCara\nann');
  await org.click('[data-act=add-create][data-name=Dan]');
  check((await org.inputValue('textarea[name=people]')).endsWith('\nDan'), 'name chip adds to the list');
  await org.click('#createForm button[type=submit]');
  await org.waitForSelector('#pick');
  const code = new URL(org.url()).searchParams.get('g');
  check(/^[a-z0-9]{8}$/.test(code), 'group created ' + code);
  check(await org.locator('.created').isVisible(), 'share box after create');
  check((await org.locator('.names button').count()) === 4, 'duplicate name skipped (4 people)');
  check((await org.textContent('.head')).includes('$25') && (await org.textContent('.head')).includes('Dec'), 'budget and date shown');
  check((await org.textContent('.host')).includes('Even you can’t see who has whom'), 'organizer told they cannot see pairs');
  const tok = await org.evaluate(c => JSON.parse(localStorage.getItem('pebbly_santa_owners'))[c], code);
  check(!!tok, 'organizer key stored');
  check((await org.evaluate(() => JSON.parse(localStorage.getItem('pebbly_score_memory')).players)).includes('Cara'), 'names remembered');
  await shot(org, 'organizer-new');
  await claim(org, 'Ann');
  check(await org.locator('#wishForm').isVisible(), 'organizer picked own name, sees wish list');

  /* ---- people claim on their own phones */
  const ben = await mk(b), cara = await mk(b), dan = await mk(b), eve = await mk(b, { colorScheme: 'dark' });
  for (const p of [ben, cara, dan, eve]) await p.goto(B + '?g=' + code);
  await ben.waitForSelector('#pick');
  check(await ben.locator('[data-name=Ann]').isDisabled(), 'Ann shows as picked on another phone');
  check((await ben.textContent('[data-name=Ann]')).includes('picked'), 'picked label');
  check(!(await ben.locator('.host').count()), 'guest has no organizer tools');
  await shot(ben, 'pick');
  await claim(ben, 'Ben');
  await ben.fill('textarea[name=wish]', 'Books, cozy socks (size M). No candles please.');
  await ben.click('#wishForm button[type=submit]');
  check(await toastHas(ben, 'Wish list saved'), 'wish saved');
  // Cara and Dan both try "Cara" at once: the second gets already_claimed
  await dan.waitForSelector('#pick');
  await claim(cara, 'Cara');
  await dan.click('[data-act=claim][data-name=Cara]'); await ok(dan);
  check(await toastHas(dan, 'already picked that name'), 'already_claimed message');
  await dan.waitForFunction(() => document.querySelector('[data-name=Cara]').disabled);
  await claim(dan, 'Dan');
  // "That's not me" then pick again
  await dan.click('[data-act=unclaim]'); await ok(dan);
  await dan.waitForSelector('#pick');
  check(!(await dan.locator('[data-name=Dan]').isDisabled()), 'unclaim frees the name');
  await claim(dan, 'Dan');
  // Eve adds herself
  await eve.waitForSelector('[data-act=join-open]');
  await eve.click('[data-act=join-open]');
  await eve.fill('#joinName', 'Ben');
  await eve.click('#joinForm button[type=submit]');
  check(await toastHas(eve, 'already on the list'), 'name_taken message');
  await eve.fill('#joinName', 'Eve');
  await eve.click('#joinForm button[type=submit]');
  await eve.waitForFunction(() => document.querySelector('.youcard b') && document.querySelector('.youcard b').textContent === 'Eve');
  check(true, 'Eve joined and is claimed');
  await shot(eve, 'waiting-dark');

  /* ---- organizer: live list, wrong-claim reset, exclusions */
  await org.waitForFunction(() => document.querySelectorAll('.plist li').length === 5, null, { timeout: 8000 });
  check((await org.textContent('.drawbox')).includes('5 of 5'), 'organizer sees 5 of 5 picked (live)');
  check((await org.textContent('.plist')).includes('wish list ✓'), 'organizer sees who has a wish list');
  // Free up Dan's name (pretend the wrong person tapped it), Dan re-picks
  await org.click('[data-act=reset][data-name=Dan]'); await ok(org);
  await org.waitForFunction(() => document.querySelector('.drawbox').textContent.includes('4 of 5'));
  check(true, 'reset claim');
  await dan.reload(); await dan.waitForSelector('#pick');
  check(!(await dan.locator('[data-name=Dan]').isDisabled()), 'Dan can pick again after reset');
  await claim(dan, 'Dan');
  // remove + re-add a person
  await org.fill('#addForm input', 'Zed'); await org.click('#addForm button[type=submit]');
  await org.waitForFunction(() => document.querySelectorAll('.plist li').length === 6);
  await org.click('[data-act=rmperson][data-name=Zed]'); await ok(org);
  await org.waitForFunction(() => document.querySelectorAll('.plist li').length === 5);
  check(true, 'add and remove a person');
  // exclusions: Ann & Ben, Cara & Dan
  const ids = Object.fromEntries((await org.$$eval('.plist [data-act=rmperson]', els => els.map(e => [e.dataset.name, e.dataset.id]))));
  await org.selectOption('#pairForm select[name=a]', ids.Ann); await org.selectOption('#pairForm select[name=b]', ids.Ben);
  await org.click('#pairForm button[type=submit]');
  await org.waitForSelector('.pairs li');
  await org.selectOption('#pairForm select[name=a]', ids.Dan); await org.selectOption('#pairForm select[name=b]', ids.Cara);
  await org.click('#pairForm button[type=submit]');
  await org.waitForFunction(() => document.querySelectorAll('.pairs li').length === 2);
  await org.selectOption('#pairForm select[name=a]', ids.Ben); await org.selectOption('#pairForm select[name=b]', ids.Ann);
  await org.click('#pairForm button[type=submit]');
  check(await toastHas(org, 'already on the list'), 'duplicate pair refused');
  check((await org.textContent('.pairs')).includes('Ann & Ben'), 'pair listed');
  await shot(org, 'organizer-before-draw');

  /* ---- draw */
  await org.click('[data-act=draw]'); await ok(org);
  await org.waitForSelector('.drawn');
  check((await org.textContent('.drawbox')).includes('Names drawn'), 'Names drawn ✓');
  check(!(await org.locator('[data-act=rmperson]').count()) && !(await org.locator('#addForm').count()), 'no add/remove after draw');
  const phones = { Ann: org, Ben: ben, Cara: cara, Dan: dan, Eve: eve }, match = {};
  for (const [n, p] of Object.entries(phones)) {
    await p.waitForSelector('.gift', { timeout: 9000 });
    check(!(await p.locator('#matchName').count()), n + ': match hidden until tapped');
    if (n === 'Ben' || n === 'Eve') await shot(p, n === 'Ben' ? 'gift' : 'gift-dark', false);
    await p.click('.gift');
    match[n] = (await p.textContent('#matchName')).trim();
  }
  await shot(ben, 'reveal'); await shot(eve, 'reveal-dark');
  const recv = Object.values(match);
  check(Object.entries(match).every(([g, r]) => g !== r), 'nobody has themselves ' + JSON.stringify(match));
  check(new Set(recv).size === 5 && recv.every(r => phones[r]), 'all receivers distinct');
  check(match.Ann !== 'Ben' && match.Ben !== 'Ann' && match.Cara !== 'Dan' && match.Dan !== 'Cara', 'exclusions respected');
  const benGiver = Object.keys(match).find(k => match[k] === 'Ben');
  check((await phones[benGiver].textContent('.reveal .wish')).includes('cozy socks'), 'Ben’s Santa sees his wish list');
  const noWish = Object.keys(match).find(k => match[k] !== 'Ben');
  check((await phones[noWish].textContent('.reveal .wish')).includes('No wish list yet'), 'no wish list message');
  check((await phones[noWish].textContent('.reveal')).includes('$25'), 'budget on reveal card');
  // the organizer's page and data hold only their own match
  const orgData = await org.evaluate(c => fetch('https://xujtuijpbwujduuzlwat.supabase.co/rest/v1/rpc/gated_santa_get', { method: 'POST',
    body: JSON.stringify({ p_code: c, p_participant: localStorage.getItem('pebbly_santa_pid').replace(/"/g, ''), p_owner_token: JSON.parse(localStorage.getItem('pebbly_santa_owners'))[c], p_key: null }) }).then(r => r.json()), code);
  check(orgData.match.name === match.Ann && !JSON.stringify(orgData).includes('receiver') && !('pairs' in orgData), 'organizer data has only own match');
  const hostText = await org.textContent('.host');
  check(!/buying for/.test(hostText), 'organizer tools show no pairs');
  // after the draw: can't unclaim, can still edit wish
  check(!(await ben.locator('[data-act=unclaim]').count()), 'no "That’s not me" after draw');
  await ben.fill('textarea[name=wish]', 'Books, cozy socks (size M). Puzzles!');
  await ben.click('#wishForm button[type=submit]');
  check(await toastHas(ben, 'Wish list saved'), 'wish editable after draw');
  // a late joiner can't add themselves after the draw
  const late = await mk(b); await late.goto(B + '?g=' + code); await late.waitForSelector('#pick');
  check(!(await late.locator('[data-act=join-open]').count()), 'no self-add after draw');
  check((await late.textContent('#pick')).includes('Everyone has picked'), 'late phone told everyone picked');
  // guest calling santa_draw directly is refused
  check(rpc(DB, 'santa_draw', { p_code: code, p_owner_token: 'nope' }).body.includes('not_owner'), 'draw needs organizer');

  /* ---- undo draw */
  await org.click('[data-act=undraw]'); await ok(org);
  await org.waitForSelector('[data-act=draw]');
  await ben.waitForSelector('[data-act=unclaim]', { timeout: 9000 });
  check(!(await ben.locator('.gift, .reveal').count()), 'match gone after undo');
  check(await org.locator('#addForm').isVisible(), 'can add people again after undo');

  /* ---- no_valid_draw and need_three */
  const g2 = JSON.parse(rpc(DB, 'santa_create', { p_name: 'Tiny', p_budget: '', p_swap_date: null, p_note: '', p_people: ['X', 'Y'], p_self_join: false }).body);
  const o2 = await mk(b); await o2.goto(B + '?g=' + g2.code + '&o=' + g2.owner_token);
  await o2.waitForSelector('.host');
  check(!(await o2.url()).includes('&o='), 'organizer link tidied from address bar');
  check(await o2.locator('[data-act=draw]').isDisabled(), 'draw disabled under 3 people');
  check((await o2.textContent('#pick')).includes('Ask the organizer to add you'), 'join closed hint');
  await o2.fill('#addForm input', 'Z'); await o2.click('#addForm button[type=submit]');
  await o2.waitForFunction(() => document.querySelectorAll('.plist li').length === 3);
  const ids2 = Object.fromEntries((await o2.$$eval('.plist [data-act=rmperson]', els => els.map(e => [e.dataset.name, e.dataset.id]))));
  await o2.selectOption('#pairForm select[name=a]', ids2.X); await o2.selectOption('#pairForm select[name=b]', ids2.Y);
  await o2.click('#pairForm button[type=submit]'); await o2.waitForSelector('.pairs li');
  await o2.click('[data-act=draw]'); await ok(o2);
  check(await toastHas(o2, 'Couldn’t find a draw that fits those rules'), 'no_valid_draw message');
  await o2.click('[data-act=rmpair]'); await o2.waitForFunction(() => !document.querySelector('.pairs li'));
  await o2.click('[data-act=draw]'); await ok(o2); await o2.waitForSelector('.drawn');
  check(true, 'draws after removing the pair');
  // edit details
  await o2.click('[data-act=edit]');
  await o2.fill('dialog input[name=name]', 'Tiny swap'); await o2.fill('dialog input[name=budget]', '£10');
  await o2.click('dialog button[type=submit]'); await o2.waitForSelector('dialog', { state: 'detached' });
  await o2.waitForFunction(() => document.querySelector('h1').textContent.includes('Tiny swap'));
  check((await o2.textContent('.head')).includes('£10'), 'details edited');
  // delete
  await o2.click('[data-act=delete]'); await ok(o2);
  await o2.waitForSelector('#createForm');
  check(!(await o2.textContent('body')).includes('Tiny swap'), 'deleted group gone from Your groups');

  /* ---- password flow */
  const pw = await mk(b); await pw.goto(B);
  await pw.fill('input[name=name]', 'Office swap'); await pw.fill('textarea[name=people]', 'A1\nB1\nC1');
  await pw.fill('input[name=lockpw]', 'tinsel');
  await pw.click('#createForm button[type=submit]'); await pw.waitForSelector('.host');
  const code3 = new URL(pw.url()).searchParams.get('g');
  check((await pw.textContent('.created')).includes('password'), 'share box mentions password');
  const g3 = await mk(b); await g3.goto(B + '?g=' + code3);
  await g3.waitForSelector('.pl-gate');
  check((await g3.textContent('.pl-gate')).includes('This group is password protected'), 'gate wording');
  check(!(await g3.textContent('body')).includes('Office swap'), 'nothing shown before password');
  await shot(g3, 'gate');
  await g3.fill('.pl-gate input', 'wrong'); await g3.click('.pl-gate button');
  await g3.waitForFunction(() => document.querySelector('.pl-gate .err').textContent.length > 0);
  await g3.fill('.pl-gate input', 'tinsel'); await g3.click('.pl-gate button');
  await g3.waitForSelector('#pick');
  await claim(g3, 'B1');
  check(true, 'guest opens and claims with password');
  const host2 = await mk(b);
  const tok3 = await pw.evaluate(c => JSON.parse(localStorage.getItem('pebbly_santa_owners'))[c], code3);
  await host2.goto(B + '?g=' + code3 + '&o=' + tok3); await host2.waitForSelector('.host');
  check(!(await host2.locator('.pl-gate').count()), 'organizer link skips password');
  await pw.click('[data-act=lock]'); await pw.waitForSelector('.pl-dlg .pl-cur:not([hidden])');
  check((await pw.textContent('.pl-dlg')).includes('tinsel'), 'organizer sees password');
  await pw.click('.pl-dlg .pl-close');

  /* ---- 320px wide */
  const small = await mk(b, { viewport: { width: 320, height: 640 } });
  await small.goto(B + '?g=' + code + '&o=' + tok); await small.waitForSelector('.host');
  check(await small.evaluate(() => document.documentElement.scrollWidth <= 320), 'no sideways scroll at 320px (organizer)');
  await shot(small, 'organizer-320');
  await small.goto(B); await small.waitForSelector('#createForm');
  check(await small.evaluate(() => document.documentElement.scrollWidth <= 320), 'no sideways scroll at 320px (home)');
  await shot(small, 'home-320');

  for (const p of all) check(!p.errs.length, 'page errors: ' + p.errs.join(' | '));
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' passed:', e.message.split('\n')[0]); process.exit(1); });
