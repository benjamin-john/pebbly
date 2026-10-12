// Shared List (/list/) end to end against a local Postgres (see CLAUDE.md → Testing).
// Setup: sh tests/setup_db.sh list; serve the repo root: python3 -m http.server 8781
// Run:   NODE_PATH=$(npm root -g) node tests/list_test.js [db] [port] [screenshot dir]
// Covers: create (kind, first items), fast entry (Enter keeps focus, pasting several lines), sections
// (picker, order, grouping), ticking with a name, checked items last, count, edit, delete, menu
// (uncheck all, clear checked, copy), two phones editing at once, live updates, password gate, host link
// on a second phone, not found, deleting, plus screenshots (light, dark, 320px).
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const DB = process.argv[2] || 'list', PORT = process.argv[3] || '8781', SS = process.argv[4] || '';
const B = 'http://localhost:' + PORT + '/list/';
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
const all = [];
async function mk(b, opts) { const p = await phone(b, devices, DB, opts); all.push(p); return p; }
const shot = async (p, name, full) => { if (SS) await p.screenshot({ path: SS + '/' + name + '.png', fullPage: full !== false }); };
const texts = p => p.$$eval('.item .txt b', l => l.map(x => x.textContent));
const count = p => p.textContent('#count').catch(() => '');
async function add(p, t) { await p.fill('#addText', t); await p.press('#addText', 'Enter'); }
async function paste(p, text) {
  await p.focus('#addText');
  await p.evaluate(text => { const dt = new DataTransfer(); dt.setData('text/plain', text);
    document.getElementById('addText').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, text);
}

(async () => {
  const b = await chromium.launch();
  const a = await mk(b);
  await a.goto(B);
  check(JSON.stringify(await a.evaluate(() => window.__list.cleanLines('- Milk\n\n* Eggs \n1. Bread\n[ ] Jam\n  two  spaces '))) ===
    JSON.stringify(['Milk', 'Eggs', 'Bread', 'Jam', 'two spaces']), 'cleanLines');
  await shot(a, 'home');
  await a.click('#createForm [type=submit]');
  check((await a.textContent('#formErr')).includes('name'), 'needs a name');
  await a.click('.kinds span:has-text("Other")');
  check(await a.isVisible('#emojis'), 'emoji choice for Other');
  await a.click('.kinds span:has-text("Groceries")');
  check(!(await a.isVisible('#emojis')), 'emoji choice hidden again');
  await a.fill('[name=title]', 'Weekend groceries');
  await a.fill('[name=items]', 'Milk\n- Bread');
  await a.click('#createForm [type=submit]');
  await a.waitForSelector('#addText');
  const code = new URL(a.url()).searchParams.get('d');
  check(/^[a-z0-9]{8}$/.test(code), 'created ' + code);
  check((await a.textContent('h1')).includes('🛒'), 'emoji in title');
  check(JSON.stringify(await texts(a)) === '["Milk","Bread"]', 'first items');
  check(await a.isVisible('.host'), 'host tools for creator');
  check((await count(a)) === '0 of 2 done', 'count 0 of 2');

  /* ---- fast entry */
  await add(a, 'Eggs');
  check(await a.evaluate(() => document.activeElement.id === 'addText' && document.getElementById('addText').value === ''), 'add box stays focused and clears');
  await a.waitForFunction(() => document.querySelectorAll('.item').length === 3);
  await paste(a, 'Butter\nJam\n\n- Tea');
  await a.waitForFunction(() => document.querySelectorAll('.item').length === 6);
  check((await texts(a)).slice(3).join() === 'Butter,Jam,Tea', 'pasted lines added in order');

  /* ---- sections */
  await a.click('#secBtn');
  await a.waitForSelector('dialog [data-sec="Produce"]');
  check((await a.textContent('dialog')).includes('Dairy & eggs'), 'grocery section suggestions');
  await a.click('dialog [data-sec="Produce"]');
  check((await a.textContent('#secBtn')).includes('Produce'), 'section picked');
  await add(a, 'Apples');
  await a.click('#secBtn'); await a.fill('dialog [name=nm]', 'Snacks'); await a.press('dialog [name=nm]', 'Enter');
  await add(a, 'Chips');
  await a.click('#secBtn'); await a.click('dialog [data-sec="Produce"]');
  await add(a, 'Bananas');
  await a.waitForFunction(() => document.querySelectorAll('.sec h2').length === 2);
  const heads = await a.$$eval('.sec h2', l => l.map(x => x.firstChild.textContent));
  check(heads.join() === 'Produce,Snacks', 'sections in first-used order: ' + heads);
  check((await a.textContent('.sec:has(h2:has-text("Produce"))')).includes('Bananas'), 'grouped by section');
  check(await a.evaluate(() => JSON.parse(localStorage.getItem('pebbly_list_section'))[new URLSearchParams(location.search).get('d')] === 'Produce'), 'last section remembered');

  /* ---- name + ticking */
  await a.click('[data-act=name]');
  await a.fill('dialog [name=nm]', 'Amy'); await a.press('dialog [name=nm]', 'Enter');
  check((await a.textContent('.mebar')).includes('Amy'), 'name set');
  await a.click('.tick:has-text("Milk")');
  await a.waitForFunction(() => document.querySelector('.item.done'));
  const first = await texts(a);
  check(first.indexOf('Milk') === 5, 'checked item moves to bottom of its section: ' + first);
  check((await a.textContent('.item.done')).includes('✓ Amy'), 'who checked it');
  check((await count(a)) === '1 of 9 done', 'count 1 of 9: ' + await count(a));
  check(await a.getAttribute('.item.done .tick', 'aria-checked') === 'true', 'aria-checked');
  await shot(a, 'list');

  /* ---- edit + delete */
  await a.click('.item:has-text("Tea") .more');
  await a.fill('dialog [name=text]', 'Green tea'); await a.fill('dialog [name=note]', '2 boxes'); await a.fill('dialog [name=sec]', 'Drinks');
  await a.click('dialog [type=submit]');
  await a.waitForFunction(() => document.body.innerText.includes('Green tea'));
  check((await a.textContent('.sec:has(h2:has-text("Drinks"))')).includes('2 boxes'), 'edited text, note and section');
  await a.click('.item:has-text("Jam") .more');
  await a.click('dialog [data-x=delete]');
  await a.waitForFunction(() => !document.querySelector('#items').textContent.includes('Jam'));
  pass++;

  /* ---- second phone: live updates and both editing at once */
  const c = await mk(b);
  await c.goto(B + '?d=' + code);
  await c.waitForSelector('.item');
  check(!(await c.isVisible('.host')), 'guest has no host tools');
  check((await texts(c)).length === 8, 'guest sees items');
  await Promise.all([add(a, 'Coffee'), add(c, 'Rice')]);
  await Promise.all([a.click('.tick:has-text("Bread")'), c.click('.tick:has-text("Eggs")')]);
  await a.waitForTimeout(7000);
  const ta = (await texts(a)).sort().join(), tc = (await texts(c)).sort().join();
  check(ta === tc && ta.includes('Coffee') && ta.includes('Rice'), 'both adds kept: ' + ta + ' | ' + tc);
  check((await count(a)) === '3 of 10 done' && (await count(c)) === '3 of 10 done', 'both ticks kept: ' + await count(a) + ' / ' + await count(c));
  // live: a ticks, c sees it within a few seconds
  await a.click('.tick:has-text("Apples")');
  await c.waitForFunction(() => document.querySelector('#count').textContent === '4 of 10 done', null, { timeout: 8000 });
  pass++;
  // c is typing while an update arrives: text and focus survive
  await c.fill('#addText', 'half typed'); await c.focus('#addText');
  await a.click('.tick:has-text("Chips")');
  await c.waitForFunction(() => document.querySelector('#count').textContent === '5 of 10 done', null, { timeout: 8000 });
  check(await c.evaluate(() => document.activeElement.id === 'addText' && document.getElementById('addText').value === 'half typed'), 'typing survives a remote update');
  await c.fill('#addText', '');
  await shot(c, 'guest');

  /* ---- menu: uncheck all, clear checked, copy */
  await a.click('[data-act=menu]');
  await shot(a, 'menu', false);
  await a.click('dialog [data-m=uncheck]');
  await a.waitForFunction(() => !document.querySelector('.item.done'));
  check((await count(a)) === '0 of 10 done', 'uncheck all');
  await a.click('.tick:has-text("Milk")'); await a.click('.tick:has-text("Rice")');
  await a.waitForFunction(() => document.querySelectorAll('.item.done').length === 2);
  await a.click('[data-act=menu]'); await a.click('dialog [data-m=clear]');
  await a.waitForFunction(() => document.querySelectorAll('.item').length === 8);
  check(!(await texts(a)).includes('Milk'), 'clear checked items');
  await a.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await a.click('[data-act=menu]'); await a.click('dialog [data-m=copy]');
  const clip = await a.evaluate(() => navigator.clipboard.readText());
  check(clip.includes('Weekend groceries') && clip.includes('Produce:') && clip.includes('☐ Apples'), 'copy as text');
  await c.waitForFunction(() => document.querySelectorAll('.item').length === 8, null, { timeout: 8000 });
  pass++;

  /* ---- host link on another phone */
  const link = await a.evaluate(code => PebblyDoc.ownerLink(code), code);
  const h2 = await mk(b);
  await h2.goto(link);
  await h2.waitForSelector('.host');
  check(!new URL(h2.url()).searchParams.get('o'), 'host token removed from address bar');
  await h2.click('[data-act=rename]');
  await h2.fill('dialog [name=title]', 'Big shop'); await h2.click('dialog .emojis span:has-text("🎉")');
  await h2.click('dialog [type=submit]');
  await a.waitForFunction(() => document.querySelector('h1').textContent.includes('Big shop'), null, { timeout: 8000 });
  check((await a.textContent('h1')).includes('🎉'), 'rename + emoji reaches other phone');

  /* ---- password */
  await a.click('[data-act=lock]');
  await a.waitForSelector('.pl-dlg [type=submit]:not([disabled])');
  await a.fill('.pl-dlg input', 'tacos'); await a.click('.pl-dlg [type=submit]');
  await a.waitForFunction(() => !document.querySelector('.pl-dlg'));
  const g = await mk(b);
  await g.goto(B + '?d=' + code);
  await g.waitForSelector('.pl-gate');
  check((await g.textContent('.pl-gate')).includes('This list is password protected'), 'gate shown');
  check(!(await g.textContent('#app')).includes('Big shop'), 'nothing visible before password');
  await g.fill('.pl-gate input', 'nope'); await g.click('.pl-gate button');
  await g.waitForFunction(() => document.querySelector('.pl-gate .err').textContent.length > 0);
  check((await g.textContent('.pl-gate .err')).includes('isn’t right'), 'wrong password');
  await g.fill('.pl-gate input', 'tacos'); await g.click('.pl-gate button');
  await g.waitForSelector('.item');
  check((await g.textContent('h1')).includes('Big shop'), 'opens with password');
  await c.waitForSelector('.banner', { timeout: 10000 });
  check((await c.textContent('.banner')).includes('password'), 'open phone without the key is told');
  check(await c.isHidden('#adder'), 'add box hidden when it can’t save');
  const h3 = await mk(b);
  await h3.goto(link);
  await h3.waitForSelector('.host');
  pass++;
  // create with a password and kind Other
  const p2 = await mk(b);
  await p2.goto(B);
  await p2.click('.kinds span:has-text("Packing")');
  check((await p2.getAttribute('[name=title]', 'placeholder')).includes('packing'), 'placeholder follows kind');
  await p2.click('.kinds span:has-text("Other")'); await p2.click('#emojis span:has-text("🏕️")');
  await p2.fill('[name=title]', 'Camping'); await p2.fill('[name=lockpw]', 'pw1');
  await p2.click('#createForm [type=submit]');
  await p2.waitForSelector('#addText');
  check((await p2.textContent('h1')).includes('🏕️'), 'chosen emoji');
  check((await p2.textContent('.created')).includes('password separately'), 'created with password');
  check(await p2.isVisible('.empty'), 'empty state');
  await shot(p2, 'empty');
  const g2 = await mk(b);
  await g2.goto(B + '?d=' + new URL(p2.url()).searchParams.get('d'));
  await g2.waitForSelector('.pl-gate');
  pass++;

  /* ---- not found, recent */
  const n = await mk(b);
  await n.goto(B + '?d=zzzzzzzz');
  await n.waitForSelector('.state h1');
  check((await n.textContent('h1')) === 'List not found', 'not found');
  await g.goto(B);
  check((await g.textContent('.recent')).includes('Big shop'), 'Your lists on a guest phone');

  /* ---- screenshots */
  if (SS) {
    const dk = await mk(b, { colorScheme: 'dark' });
    await dk.goto(link); await dk.waitForSelector('.item');
    await dk.click('.tick >> nth=0'); await dk.waitForTimeout(400); await shot(dk, 'dark_list');
    await dk.click('.more >> nth=1'); await dk.waitForTimeout(200); await shot(dk, 'dark_edit', false);
    await dk.goto(B); await shot(dk, 'dark_home');
    const sm = await mk(b, { viewport: { width: 320, height: 640 } });
    await sm.goto(link); await sm.waitForSelector('.item'); await shot(sm, 'w320_list');
    check(await sm.evaluate(() => document.documentElement.scrollWidth <= 320), 'no sideways scroll at 320');
    await sm.click('#secBtn'); await shot(sm, 'w320_sections', false);
    await sm.goto(B); await shot(sm, 'w320_home');
    check(await sm.evaluate(() => document.documentElement.scrollWidth <= 320), 'home no sideways scroll at 320');
  }

  /* ---- delete */
  await a.goto(B + '?d=' + code);
  await a.waitForSelector('.host');
  await a.click('[data-act=delete]');
  await a.waitForSelector('#createForm');
  check(!(await a.textContent('#app')).includes('Big shop'), 'deleted and gone from Your lists');
  await h3.waitForSelector('.banner', { timeout: 10000 });
  check((await h3.textContent('.banner')).includes('deleted'), 'other phone told it was deleted');

  for (const p of all) check(!p.errs.length, 'page errors: ' + p.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' passed:', e.message.split('\n').slice(0, 3).join(' ')); process.exit(1); });
