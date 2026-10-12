// Split the Bill (/bill/) end to end against a local Postgres (see CLAUDE.md → Testing).
// Setup: sh tests/setup_db.sh bill; serve the repo root: python3 -m http.server 8781
// Run:   NODE_PATH=$(npm root -g) node tests/bill_test.js [db] [port] [screenshot dir]
// Covers: money parsing, fair penny split, settle-up plan, create, expenses (equal and exact, edit, delete),
// balances, Mark paid / Undo, adding and removing people, two phones adding at once, password gate,
// host link on a second phone, not found, deleting, plus screenshots (light, dark, 320px).
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const DB = process.argv[2] || 'bill', PORT = process.argv[3] || '8781', SS = process.argv[4] || '';
const B = 'http://localhost:' + PORT + '/bill/';
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
const all = [];
async function mk(b, opts) { const p = await phone(b, devices, DB, opts); all.push(p); return p; }
const shot = async (p, name, full) => { if (SS) await p.screenshot({ path: SS + '/' + name + '.png', fullPage: full !== false }); };
async function addExpense(p, what, amt, payer, opts) {
  opts = opts || {};
  await p.click('.fab');
  await p.fill('dialog [name=what]', what); await p.fill('dialog [name=amount]', amt);
  if (payer) await p.click(`dialog .pill:has-text("${payer}")`);
  if (opts.only) { await p.click('dialog [data-x=none]'); for (const n of opts.only) await p.click(`dialog label.ck:has-text("${n}")`); }
  if (opts.exact) {
    await p.click('dialog .seg >> text=Exact amounts');
    const ins = await p.$$('dialog [name=share]');
    for (let i = 0; i < opts.exact.length; i++) await ins[i].fill(opts.exact[i]);
  }
  await p.click('dialog [type=submit]');
}
const net = (p, name) => p.evaluate(n => { const li = [...document.querySelectorAll('.bal li')].find(l => l.querySelector('b').textContent.startsWith(n)); return li ? li.querySelector('.net').textContent : null; }, name);

(async () => {
  const b = await chromium.launch();
  const a = await mk(b);
  await a.goto(B);
  /* ---- pure functions */
  const u = await a.evaluate(() => {
    const B = window.__bill;
    return {
      m: ['12', '12.5', '1,234.56', '12,50', '$7.05', 'abc', '1.234', ''].map(B.parseMoney),
      eq: B.equalShares('x1', 100, ['a', 'b', 'c']),
      settle: B.settle([{ id: 'a', net: 3000 }, { id: 'b', net: -1000 }, { id: 'c', net: -2500 }, { id: 'd', net: 500 }])
    };
  });
  check(JSON.stringify(u.m) === JSON.stringify([1200, 1250, 123456, 1250, 705, null, null, null]), 'parseMoney ' + JSON.stringify(u.m));
  const eqv = Object.values(u.eq).sort();
  check(eqv.join() === '33,33,34', 'equal split 100 / 3 = ' + eqv.join());
  check(u.settle.length === 3 && u.settle[0].from === 'c' && u.settle[0].to === 'a' && u.settle[0].amount === 2500, 'settle greedy ' + JSON.stringify(u.settle));
  check(u.settle.reduce((s, x) => s + x.amount, 0) === 3500, 'settle total');

  /* ---- create */
  await a.evaluate(() => localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Dana'], games: [] })));
  await a.reload();
  await shot(a, 'home');
  await a.click('#createForm [type=submit]');
  check((await a.textContent('#formErr')).includes('name'), 'needs a name');
  await a.fill('[name=title]', 'Lake weekend');
  await a.fill('#draftName', 'Amy'); await a.press('#draftName', 'Enter');
  await a.click('#createForm [type=submit]');
  check((await a.textContent('#formErr')).includes('two people'), 'needs two people');
  await a.fill('#draftName', 'Ben'); await a.click('[data-act=draft-add]');
  await a.click('[data-act=chip-add][data-name=Dana]');
  await a.fill('#draftName', 'Cara');                       // typed but not added: still counts
  await a.click('#createForm [type=submit]');
  await a.waitForSelector('.fab');
  const code = new URL(a.url()).searchParams.get('d');
  check(/^[a-z0-9]{8}$/.test(code), 'created ' + code);
  check(await a.isVisible('.created'), 'created card shown');
  check((await a.textContent('.facts')).includes('4 people'), '4 people');
  check(await a.isVisible('.host'), 'host tools for creator');
  check((await a.evaluate(() => JSON.parse(localStorage.getItem('pebbly_score_memory')).players)).includes('Cara'), 'names remembered');
  check(await a.isVisible('.empty'), 'empty expenses state');
  await shot(a, 'new');

  /* ---- who am I, expenses */
  await a.click('[data-act=me]:has-text("Amy")');
  check((await a.textContent('.mebar')).includes('Amy'), 'picked me');
  await addExpense(a, 'Groceries', '100', 'Amy');
  await a.waitForSelector('.exp');
  check((await a.textContent('.summary')).includes('$100.00'), 'total 100');
  check(await net(a, 'Amy') === 'gets back $75.00', 'Amy gets back 75: ' + await net(a, 'Amy'));
  check(await net(a, 'Ben') === 'owes $25.00', 'Ben owes 25');
  check((await a.textContent('.exp')).includes('added by Amy'), 'added by shown');
  // validation in the dialog
  await a.click('.fab');
  await a.fill('dialog [name=what]', 'Gas'); await a.fill('dialog [name=amount]', 'abc');
  await a.click('dialog [type=submit]');
  check((await a.textContent('dialog .err')).includes('amount'), 'bad amount message');
  await a.fill('dialog [name=amount]', '45.50'); await a.click('dialog .pill:has-text("Ben")');
  await a.click('dialog .seg >> text=Exact amounts');
  const ins = await a.$$('dialog [name=share]');
  await ins[0].fill('20'); await ins[1].fill('10');
  check((await a.textContent('dialog .remain')).includes('$15.50 left'), 'remaining shown');
  await a.click('dialog [type=submit]');
  check((await a.textContent('dialog .err')).includes('still left'), 'exact must add up');
  await ins[3].fill('15.50');
  check((await a.textContent('dialog .remain')).includes('Adds up'), 'adds up');
  await shot(a, 'dialog_exact', false);
  await a.click('dialog [type=submit]');
  await a.waitForFunction(() => !document.querySelector('dialog'));
  await addExpense(a, 'Dinner', '10.01', 'Cara', { only: ['Ben', 'Cara'] });
  await a.waitForFunction(() => document.querySelectorAll('.exp').length === 3);
  const s1 = await a.evaluate(() => window.__bill.state());
  const dinner = Object.values(s1.expenses).find(e => e.what === 'Dinner');
  check(Object.keys(dinner.among).length === 2 && dinner.amount === 1001, 'dinner split between 2');
  check((await a.textContent('.exps li:first-child')).includes('Dinner'), 'newest first');
  // nets: Amy 100-25-20=55; Ben 45.50-25-10-5.00/5.01; Cara 10.01-25-5.0x-0; Dana -25-15.50
  const nets = await a.evaluate(() => [...document.querySelectorAll('.bal .net')].map(x => x.textContent));
  check(nets.length === 4, 'four balances ' + nets);
  // settle plan pays everything off
  const plan = await a.evaluate(() => [...document.querySelectorAll('.pay')].map(x => x.textContent));
  check(plan.length >= 2 && plan.length <= 3, 'settle plan ' + plan.length);
  await shot(a, 'bill');

  /* ---- mark paid / undo */
  const before = await a.$$eval('.pay', l => l.length);
  await a.click('.pay [data-act=mark-paid] >> nth=0');
  await a.waitForSelector('[data-act=undo-pay]');
  check((await a.$$eval('.pay', l => l.length)) < before, 'payment recorded, plan shrinks');
  await a.click('[data-act=undo-pay]');
  await a.waitForSelector('[data-act=undo-pay]', { state: 'detached' });
  check((await a.$$eval('.pay', l => l.length)) === before, 'plan back after undo');
  check(!(await a.isVisible('[data-act=undo-pay]')), 'payment undone');
  // pay everything → square
  for (let i = 0; i < 6 && await a.isVisible('.pay'); i++) { const k = await a.$$eval('.paid li', l => l.length); await a.click('.pay [data-act=mark-paid] >> nth=0'); await a.waitForFunction(k => document.querySelectorAll('.paid li').length === k + 1, k); }
  check(await a.isVisible('.square'), 'everyone square');
  check((await a.evaluate(() => [...document.querySelectorAll('.bal .net')].every(x => x.textContent === 'square'))), 'all nets square');
  // copy summary
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await a.click('[data-act=summary]');
  const clip = await a.evaluate(() => navigator.clipboard.readText());
  check(clip.includes('Lake weekend') && clip.includes('square') && clip.includes('?d=' + code), 'summary text');

  /* ---- edit + delete an expense */
  await a.click('.exp:has-text("Dinner")');
  check((await a.inputValue('dialog [name=amount]')) === '10.01', 'edit prefilled');
  await a.fill('dialog [name=amount]', '12');
  await a.click('dialog [type=submit]');
  await a.waitForFunction(() => document.querySelector('.exps').textContent.includes('$12.00'));
  check((await a.textContent('.exps')).includes('edited'), 'edited marker');
  await a.click('.exp:has-text("Dinner")');
  await a.click('dialog [data-x=delete]');        // confirm auto-accepted
  await a.waitForFunction(() => !document.querySelector('.exps').textContent.includes('Dinner'));
  pass++;

  /* ---- people */
  await a.click('[data-act=people]');
  await a.fill('#pplAdd [name=nm]', 'Eve'); await a.press('#pplAdd [name=nm]', 'Enter');
  await a.waitForFunction(() => document.querySelector('#pplList').textContent.includes('Eve'));
  let alerted = '';
  a.removeAllListeners('dialog'); a.on('dialog', d => { if (d.type() === 'alert') alerted = d.message(); d.accept(); });
  await a.click('#pplList li:has-text("Amy") [data-p=rm]');
  check(alerted.includes('can’t be removed'), 'used person cannot be removed: ' + alerted);
  await a.click('#pplList li:has-text("Eve") [data-p=rm]');
  await a.waitForFunction(() => !document.querySelector('#pplList').textContent.includes('Eve'));
  pass++;
  await a.click('#pplList li:has-text("Dana") [data-p=rename]');
  await a.fill('#pplList [data-rn] input', 'Danielle'); await a.press('#pplList [data-rn] input', 'Enter');
  await a.waitForFunction(() => document.querySelector('#pplList').textContent.includes('Danielle'));
  await shot(a, 'people', false);
  await a.click('dialog [data-close] >> nth=0');
  check((await a.textContent('.bal')).includes('Danielle'), 'rename shows in balances');

  /* ---- second phone, both add at once */
  const c = await mk(b);
  await c.goto(B + '?d=' + code);
  await c.waitForSelector('.fab');
  check(!(await c.isVisible('.host')), 'guest has no host tools');
  check(await c.isVisible('[data-act=me]'), 'guest asked who they are');
  await c.click('[data-act=me]:has-text("Ben")');
  await Promise.all([addExpense(a, 'Boat', '60', 'Amy'), addExpense(c, 'Ice', '8', 'Ben')]);
  await a.waitForTimeout(7000);
  const ea = await a.$$eval('.exp .what', l => l.map(x => x.textContent).sort().join());
  const ec = await c.$$eval('.exp .what', l => l.map(x => x.textContent).sort().join());
  check(ea === ec && ea.includes('Boat') && ea.includes('Ice'), 'both expenses kept: ' + ea + ' | ' + ec);
  check((await c.textContent('.exp:has-text("Ice")')).includes('added by Ben'), 'added by Ben');
  check((await c.textContent('.summary')).includes('You'), 'guest sees own balance');
  await shot(c, 'guest');

  /* ---- host link on another phone */
  const link = await a.evaluate(code => PebblyDoc.ownerLink(code), code);
  const h2 = await mk(b);
  await h2.goto(link);
  await h2.waitForSelector('.host');
  check(!new URL(h2.url()).searchParams.get('o'), 'host token removed from address bar');

  /* ---- password: set by host, guest needs it */
  await a.click('[data-act=lock]');
  await a.waitForSelector('.pl-dlg [type=submit]:not([disabled])');
  await a.fill('.pl-dlg input', 'tacos'); await a.click('.pl-dlg [type=submit]');
  await a.waitForFunction(() => !document.querySelector('.pl-dlg'));
  const g = await mk(b);
  await g.goto(B + '?d=' + code);
  await g.waitForSelector('.pl-gate');
  check((await g.textContent('.pl-gate')).includes('This bill is password protected'), 'gate shown');
  check(!(await g.textContent('#app')).includes('Lake weekend'), 'nothing visible before password');
  await g.fill('.pl-gate input', 'nope'); await g.click('.pl-gate button');
  await g.waitForFunction(() => document.querySelector('.pl-gate .err').textContent.length > 0);
  check((await g.textContent('.pl-gate .err')).includes('isn’t right'), 'wrong password');
  await g.fill('.pl-gate input', 'tacos'); await g.click('.pl-gate button');
  await g.waitForSelector('.fab');
  check((await g.textContent('h1')).includes('Lake weekend'), 'opens with password');
  // the old guest phone without the key gets told
  await c.waitForSelector('.banner', { timeout: 10000 });
  check((await c.textContent('.banner')).includes('password'), 'open phone told about new password');
  // a fresh host-link phone with a password skips the gate
  const h3 = await mk(b);
  await h3.goto(link);
  await h3.waitForSelector('.host');
  pass++;
  // create with password from the form
  const p2 = await mk(b);
  await p2.goto(B);
  await p2.fill('[name=title]', 'Secret dinner');
  for (const n of ['X', 'Y']) { await p2.fill('#draftName', n); await p2.press('#draftName', 'Enter'); }
  await p2.click('[name=cur][value=other] + span'); await p2.fill('[name=curOther]', 'kr');
  await p2.fill('[name=lockpw]', 'pw1');
  await p2.click('#createForm [type=submit]');
  await p2.waitForSelector('.fab');
  check((await p2.textContent('.created')).includes('password separately'), 'created with password');
  const code2 = new URL(p2.url()).searchParams.get('d');
  const g2 = await mk(b);
  await g2.goto(B + '?d=' + code2);
  await g2.waitForSelector('.pl-gate');
  pass++;
  await addExpense(p2, 'Fish', '10', 'X');
  await p2.waitForSelector('.exp');
  check((await p2.textContent('.summary')).includes('kr10.00'), 'custom currency');

  /* ---- not found, home list */
  const n = await mk(b);
  await n.goto(B + '?d=zzzzzzzz');
  await n.waitForSelector('.state h1');
  check((await n.textContent('h1')) === 'Bill not found', 'not found');
  await a.goto(B);
  check((await a.textContent('.recent')).includes('Lake weekend') && (await a.textContent('.recent')).includes('host'), 'Your bills list');

  /* ---- screenshots: dark + 320px */
  if (SS) {
    const dk = await mk(b, { colorScheme: 'dark' });
    await dk.goto(B + '?d=' + code2); await dk.waitForSelector('.pl-gate'); await shot(dk, 'dark_gate');
    await dk.goto(link); await dk.waitForSelector('.fab'); await dk.waitForTimeout(300); await shot(dk, 'dark_bill');
    await dk.click('.exp >> nth=0'); await dk.waitForTimeout(200); await shot(dk, 'dark_dialog', false);
    const sm = await mk(b, { viewport: { width: 320, height: 640 } });
    await sm.goto(link); await sm.waitForSelector('.fab'); await sm.click('[data-act=me]:has-text("Cara")'); await shot(sm, 'w320_bill');
    check(await sm.evaluate(() => document.documentElement.scrollWidth <= 320), 'no sideways scroll at 320');
    await sm.click('.fab'); await sm.click('dialog .seg >> text=Exact amounts'); await shot(sm, 'w320_dialog', false);
    await sm.goto(B); await shot(sm, 'w320_home');
    check(await sm.evaluate(() => document.documentElement.scrollWidth <= 320), 'home no sideways scroll at 320');
  }

  /* ---- delete */
  await a.goto(B + '?d=' + code);
  await a.waitForSelector('.host');
  await a.click('[data-act=delete]');
  await a.waitForSelector('#createForm');
  check(!(await a.textContent('#app')).includes('Lake weekend'), 'deleted and gone from list');
  await g.waitForSelector('.banner', { timeout: 10000 });
  check((await g.textContent('.banner')).includes('deleted'), 'other phone told it was deleted');

  for (const p of all) check(!p.errs.length, 'page errors: ' + p.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' passed:', e.message.split('\n').slice(0, 3).join(' ')); process.exit(1); });
