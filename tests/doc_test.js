// doc.js (shared documents) against a local Postgres: two phones editing at once, passwords, host key.
// Setup: sh tests/setup_db.sh docs; serve the repo root on port 8770; NODE_PATH=$(npm root -g) node tests/doc_test.js
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
const PAGE = 'http://localhost:8770/install/';   // any page; doc.js and lock.js are injected
async function mk(b) {
  const p = await phone(b, devices, 'docs');
  await p.goto(PAGE);
  await p.addScriptTag({ url: '/lock.js' }); await p.addScriptTag({ url: '/doc.js' });
  await p.evaluate(() => { window.seen = []; });
  return p;
}
(async () => {
  const b = await chromium.launch();
  const a = await mk(b), c = await mk(b);
  const code = await a.evaluate(() => PebblyDoc.create('list', { title: 'Groceries', items: {} }).then(r => r.code));
  check(/^[a-z0-9]{8}$/.test(code), 'created ' + code);
  const openIt = p => p.evaluate(code => PebblyDoc.open(code, { kind: 'list', onState: s => window.seen.push(s) }).then(d => { window.D = d; return d && d.isOwner; }), code);
  check(await openIt(a) === true, 'creator is owner');
  check(await openIt(c) === false, 'other phone is not owner');
  // both add at the same moment
  await Promise.all([
    a.evaluate(() => D.change(s => { s.items.a1 = { text: 'Milk', order: 1 }; })),
    c.evaluate(() => D.change(s => { s.items.c1 = { text: 'Eggs', order: 2 }; }))
  ]);
  await a.waitForTimeout(7000);
  const ia = await a.evaluate(() => Object.keys(D.state().items).sort().join());
  const ic = await c.evaluate(() => Object.keys(D.state().items).sort().join());
  check(ia === 'a1,c1' && ic === 'a1,c1', 'both edits kept on both phones: ' + ia + ' / ' + ic);
  // one ticks, other renames at once
  await Promise.all([
    a.evaluate(() => D.change(s => { s.items.c1.done = true; })),
    c.evaluate(() => D.change(s => { s.items.c1.text = 'Brown eggs'; delete s.items.a1; }))
  ]);
  await a.waitForTimeout(7000);
  const sa = await a.evaluate(() => JSON.stringify(D.state().items)), sc = await c.evaluate(() => JSON.stringify(D.state().items));
  check(await a.evaluate(t => PebblyDoc.same(D.state().items, JSON.parse(t)), sc) && /Brown eggs/.test(sa) && /"done":true/.test(sa) && !/Milk/.test(sa), 'field-level merge: ' + sa + ' | ' + sc);
  // password: owner sets, new phone gets the gate
  await a.evaluate(code => PebblyLock.afterCreate('doc', code, PebblyDoc.owner(code), 'tacos', PebblyDoc.raw), code);
  const g = await mk(b);
  await g.evaluate(() => { document.body.innerHTML = '<main id="m"></main>'; });
  const opened = g.evaluate(code => PebblyDoc.open(code, { kind: 'list', el: document.getElementById('m'), what: 'list' }).then(d => !!d), code);
  await g.waitForSelector('.pl-gate');
  check((await g.textContent('.pl-gate')).includes('This list is password protected'), 'gate wording');
  await g.fill('.pl-gate input', 'tacos'); await g.click('.pl-gate button');
  check(await opened === true, 'opens after password');
  check(await c.evaluate(() => new Promise(r => setTimeout(() => r(D.closed), 4000))) === true, 'open phone without key is closed after password added');
  // a second host phone with the list open keeps saving after the password changes
  const h2 = await mk(b);
  await h2.evaluate(([code, tok]) => { PebblyDoc.setOwner(code, tok); }, [code, await a.evaluate(code => PebblyDoc.owner(code), code)]);
  check(await h2.evaluate(code => PebblyDoc.open(code, { kind: 'list' }).then(d => { window.D = d; return !!d && d.isOwner; }), code), 'second host phone opens');
  await a.evaluate(code => PebblyLock.afterCreate('doc', code, PebblyDoc.owner(code), 'nachos', PebblyDoc.raw), code);
  await h2.evaluate(() => D.change(s => { s.items.h2 = { text: 'Bread', order: 3 }; }));
  await h2.waitForTimeout(7000);
  check(await h2.evaluate(() => !D.closed && D.status === 'live'), 'host phone recovers the new key and keeps saving');
  await a.waitForTimeout(3500);
  check(await a.evaluate(() => !!D.state().items.h2), 'its change reaches the other host phone');
  // wrong kind / missing
  check(await a.evaluate(code => PebblyDoc.open(code, { kind: 'bill' }).then(d => d === null), code), 'wrong kind → null');
  check(await a.evaluate(() => PebblyDoc.open('zzzzzzzz', { kind: 'list' }).then(d => d === null)), 'missing → null');
  for (const p of [a, c, g, h2]) check(!p.errs.length, p.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
