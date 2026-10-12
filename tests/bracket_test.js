// Bracket (/bracket/): seeding and byes, recording winners and scores, changing an earlier result,
// undo, whole-bracket view, champion, paste 64, shuffle (fixed randomness), and a 2-phone
// "play together" test against a local Postgres.
// Setup: sh tests/setup_db.sh agent_d; serve the repo root on port 8784 (python3 -m http.server 8784), then:
//   NODE_PATH=$(npm root -g) node tests/bracket_test.js        (SHOTS=<folder> to save screenshots)
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const B = 'http://localhost:' + (process.env.PORT || 8784);
const DB = process.env.DB || 'agent_d';
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }
const texts = (p, sel) => p.$$eval(sel, els => els.map(e => e.textContent.trim()));
const shot = (p, name, full) => process.env.SHOTS ? p.screenshot({ path: process.env.SHOTS + '/' + name + '.png', fullPage: !!full }) : null;

async function mk(browser) {
  const p = await phone(browser, devices, DB);
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
  await p.context().route('**cloudflareinsights**', r => r.abort());
  await p.context().addInitScript(() => {
    window.__q = [];
    const orig = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = a => { if (window.__q.length && a.length === 1) { a[0] = window.__q.shift(); return a; } return orig(a); };
  });
  return p;
}
async function side(p, name) { return p.locator('#matches .side', { hasText: name }).first(); }
async function waitFor(p, fn, arg, ms) { try { await p.waitForFunction(fn, arg, { timeout: ms || 8000 }); return true; } catch (e) { return false; } }

(async () => {
  const browser = await chromium.launch();
  const p = await mk(browser);
  await p.goto(B + '/bracket/');
  await p.evaluate(() => localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Amy', 'Ben'], games: [] })));
  await p.reload();

  /* ---------------- setup: 5 entrants, seeded */
  check(await p.isVisible('#setup') && await p.isDisabled('#startBtn'), 'setup, needs 2');
  await p.fill('#title', 'Cornhole Cup');
  await p.click('#chips .add:text-is("Amy")'); await p.click('#chips .add:text-is("Ben")');
  for (const n of ['Cal', 'Dan', 'Eve']) { await p.fill('#newName', n); await p.press('#newName', 'Enter'); }
  await p.fill('#newName', 'amy'); await p.press('#newName', 'Enter');
  check((await p.$$eval('#plist input', i => i.map(x => x.value))).join() === 'Amy,Ben,Cal,Dan,Eve', 'duplicate refused');
  check((await p.textContent('#addErr')).includes('already in'), 'duplicate message');
  check((await p.textContent('#byeHint')).includes('3 byes'), 'bye hint: ' + await p.textContent('#byeHint'));
  await shot(p, 'bracket-setup', true);
  await p.click('#startBtn');
  check(await p.isVisible('#play') && (await p.textContent('#pTitle')) === 'Cornhole Cup', 'play view');
  check((await texts(p, '.rtab')).map(t => t.replace(/\d+ of \d+|✓ done/, '').trim()).join() === 'Quarterfinals,Semifinals,Final', 'round tabs: ' + (await texts(p, '.rtab')).join('|'));
  check(await p.locator('#matches .match').count() === 1 && await p.locator('#matches .bye').count() === 3, 'one real match, three byes');
  check((await texts(p, '#matches .bye b')).join() === 'Amy,Ben,Cal', 'byes go to top seeds');
  check((await texts(p, '#matches .match .nm')).join() === 'Dan,Eve', '4 v 5');

  /* ---------------- play it out */
  await (await side(p, 'Eve')).click();
  check((await p.getAttribute('#matches .side.win', 'aria-label')).startsWith('Eve'), 'Eve wins');
  check(await waitFor(p, () => document.querySelector('.rtab[aria-selected=true]').textContent.startsWith('Semifinals')), 'moves to semifinals when round done');
  check((await texts(p, '#matches .match .nm')).join() === 'Amy,Eve,Ben,Cal', 'semifinal pairs (1 v 4/5, 2 v 3): ' + (await texts(p, '#matches .match .nm')).join());
  await (await side(p, 'Amy')).click();
  await (await side(p, 'Cal')).click();
  check(await waitFor(p, () => document.querySelector('.rtab[aria-selected=true]').textContent.startsWith('Final')), 'moves to final');
  await shot(p, 'bracket-final-before');
  await p.click('[data-score]');
  await p.fill('#sA', '21'); await p.fill('#sB', '15'); await p.click('#sSave');
  check(await p.isVisible('.champ') && (await p.textContent('.champ .who')) === 'Amy', 'champion Amy');
  check((await texts(p, '#matches .sc')).join() === '21,15', 'scores shown');
  await p.waitForTimeout(400); await shot(p, 'bracket-champion');
  check((await p.textContent('#pSub')).includes('Finished'), 'finished');

  /* ---------------- copy */
  await p.click('.champ [data-a=copy]');
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  check(clip.includes('🏆 Champion: Amy') && clip.includes('Amy beat Cal (21–15)') && clip.includes('Eve beat Dan'), 'copied results: ' + JSON.stringify(clip));

  /* ---------------- change an earlier result: clears what depended on it */
  await p.click('.rtab[data-tab="0"]');
  await (await side(p, 'Dan')).click();   // dialog auto-accepted
  const res = await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_bracket')).res);
  check(res['0-1'].w && !res['1-0'] && !res['2-0'] && res['1-1'], 'later results cleared, other semi kept: ' + JSON.stringify(res));
  check(!(await p.isVisible('.champ')), 'champion gone');
  await p.click('.rtab[data-tab="1"]');
  check((await texts(p, '#matches .match:first-child .nm')).join() === 'Amy,Dan', 'Dan now in semifinal');
  await p.click('#undoBtn');
  check(await p.isVisible('.champ') && (await p.textContent('.champ .who')) === 'Amy', 'undo brings it all back');
  // a cancelled change does nothing
  p.removeAllListeners('dialog'); p.once('dialog', d => d.dismiss());
  await p.click('.rtab[data-tab="0"]'); await (await side(p, 'Dan')).click();
  p.on('dialog', d => d.accept());
  check(await p.isVisible('.champ'), 'dismissed confirm keeps results');

  /* ---------------- whole bracket */
  await p.click('#vAll');
  check(await p.locator('.oc').count() === 4 && (await p.textContent('#ov')).includes('bye'), 'overview columns');
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page sideways scroll in overview');
  await shot(p, 'bracket-overview');
  await p.click('.ob[data-go="1-1"]');
  check(await p.isVisible('#roundsView') && (await p.getAttribute('.rtab[data-tab="1"]', 'aria-selected')) === 'true', 'tap in overview opens that round');

  /* ---------------- reload */
  await p.reload();
  check((await p.getAttribute('.rtab[data-tab="1"]', 'aria-selected')) === 'true' && await p.isVisible('.champ'), 'state and tab kept after reload');

  /* ---------------- clear a result from the score dialog */
  await p.click('.rtab[data-tab="2"]'); await p.click('[data-score]'); await p.click('#sClear');
  check(!(await p.isVisible('.champ')) && !(await p.locator('#matches .side.win').count()), 'result cleared');

  /* ---------------- 64 pasted things, shuffled */
  await p.click('#menuBtn'); await p.click('#mNew');
  check(await p.isVisible('#setup') && (await p.inputValue('#title')) === 'Cornhole Cup', 'new bracket prefilled');
  for (let i = 0; i < 5; i++) await p.click('#plist li:first-child [data-rm]');
  await p.click('#kThings');
  check(!(await p.locator('#chips .chip').count()), 'no name chips for things');
  const names = Array.from({ length: 66 }, (_, i) => 'Pizza ' + (i + 1));
  await p.evaluate(t => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.getElementById('newName').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, names.join('\n'));
  check(await p.locator('#plist li').count() === 64 && await p.isHidden('#addForm'), 'pasted, capped at 64');
  check((await p.textContent('#addErr')).includes('64'), 'cap message');
  await p.click('#oShuffle');
  const q = Array.from({ length: 63 }, (_, k) => (k * 7) % 5);
  await p.evaluate(q => { window.__q = q.slice(); }, q);
  await p.setViewportSize({ width: 320, height: 700 });
  await p.click('#startBtn');
  const exp = names.slice(0, 64); const qq = q.slice();
  for (let i = exp.length - 1; i > 0; i--) { const j = qq.shift() % (i + 1); [exp[i], exp[j]] = [exp[j], exp[i]]; }
  const ents = await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_bracket')).entrants.map(e => e.name));
  check(ents.join() === exp.join(), 'shuffled with fixed randomness');
  check((await p.$$eval('.rtab', els => els.map(e => e.firstChild.textContent))).join() === 'Round 1,Round 2,Round 3,Quarterfinals,Semifinals,Final', '6 rounds');
  check(await p.locator('#matches .match').count() === 32, '32 first-round matches');
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 320');
  await shot(p, 'bracket-320');
  await p.click('#vAll');
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('ov').scrollWidth > document.getElementById('ov').clientWidth), 'overview scrolls inside its box only');
  await p.evaluate(() => localStorage.setItem('pebbly_theme', 'dark'));
  await p.setViewportSize({ width: 412, height: 915 }); await p.reload();
  await shot(p, 'bracket-dark-overview');
  await p.click('#vRounds'); await shot(p, 'bracket-dark-rounds');
  check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(20, 26, 24)', 'dark mode');
  await p.evaluate(() => localStorage.removeItem('pebbly_theme'));

  /* ---------------- play together: host + guest */
  const h = await mk(browser), g = await mk(browser);
  await h.goto(B + '/bracket/');
  await h.fill('#title', 'Ping Pong');
  for (const n of ['Ann', 'Bob', 'Cat', 'Don']) { await h.fill('#newName', n); await h.press('#newName', 'Enter'); }
  await h.click('.ps-mode[data-m="1"]');
  await h.waitForSelector('#openCard:not([hidden])', { timeout: 3000 }).catch(() => {});
  check(await h.isVisible('#openCard') && await h.isChecked('#openSetup'), 'open toggle shown for shared');
  await h.click('#startBtn');
  await h.waitForSelector('.ps-code');
  const code = (await h.textContent('.ps-code')).trim();
  check(/^[A-Z0-9]{5}$/.test(code), 'code ' + code);
  await h.click('.ps-dlg [data-ps-close]');
  await g.goto(B + '/bracket/?join=' + code);
  await g.waitForSelector('#psName');
  await g.fill('#psName', 'Zed'); await g.click('#psJoinGo');
  await g.waitForSelector('#play:not([hidden])');
  check((await g.textContent('#pTitle')) === 'Ping Pong', 'guest sees the bracket');
  // host records: guest sees it live
  await (await side(h, 'Ann')).click();
  check(await waitFor(g, () => !!document.querySelector('#matches .side.win') && document.querySelector('#matches .side.win').textContent.includes('Ann')), 'guest sees host result live');
  // guest records (allowed)
  await (await side(g, 'Cat')).click();
  check(await waitFor(h, () => [...document.querySelectorAll('#matches .side.win')].some(s => s.textContent.includes('Cat'))), 'host sees guest result');
  // tabs are per phone
  await h.waitForTimeout(1000);
  await h.click('.rtab[data-tab="0"]');
  await g.waitForTimeout(2500);
  check((await g.getAttribute('.rtab[data-tab="1"]', 'aria-selected')) === 'true', 'guest stays on its own tab');
  check((await h.getAttribute('.rtab[data-tab="0"]', 'aria-selected')) === 'true', 'host on its tab');
  // host closes recording
  await h.click('#menuBtn');
  check(await h.isVisible('#mOpenCard'), 'host sees the permission switch');
  await h.uncheck('#mOpen'); await h.click('#menuDlg [data-close]');
  check(await waitFor(g, () => !document.getElementById('watch').hidden), 'guest told only the host records');
  check(await g.locator('#matches .side:not([disabled])').count() === 0, 'guest buttons disabled');
  await g.click('#menuBtn');
  check(await g.isHidden('#mOpenCard'), 'guest has no permission switch');
  await g.click('#menuDlg [data-close]');
  await shot(g, 'bracket-guest-watching');
  await h.click('.rtab[data-tab="1"]');
  await (await side(h, 'Cat')).click();
  check(await waitFor(g, () => !!document.querySelector('.champ') && document.querySelector('.champ .who').textContent === 'Cat'), 'guest sees champion');
  const sh = await h.evaluate(() => JSON.parse(localStorage.getItem('pebbly_bracket'))), sg = await g.evaluate(() => JSON.parse(localStorage.getItem('pebbly_bracket')));
  check(JSON.stringify(sh.res) === JSON.stringify(Object.fromEntries(Object.keys(sh.res).sort().map(k => [k, sg.res[k]]))) && !('tab' in sh) && !('view' in sh), 'same results on both phones, no view state in the shared game');

  for (const x of [p, h, g]) check(!x.errs.length, 'page errors: ' + x.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
