// Codebreaker (/codebreaker/): clues (right spot / right color), hiding codes on one phone (pass-the-phone
// screen), equal turns and the last-chance tie, undo, no-repeats, the computer (cracks codes in few
// guesses, quickly), and a 2-phone "play together" game against a local Postgres.
// Setup: sh tests/setup_db.sh agent_g; serve the repo root on port 8791 (python3 -m http.server 8791), then:
//   NODE_PATH=$(npm root -g) node tests/codebreaker_test.js        (SHOTS=<folder> to save screenshots)
const { chromium, devices } = require('playwright');
const { phone } = require('./pg_bridge');
const B = 'http://localhost:' + (process.env.PORT || 8791);
const DB = process.env.DB || 'agent_g';
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }
const shot = (p, name, full) => process.env.SHOTS ? p.screenshot({ path: process.env.SHOTS + '/' + name + '.png', fullPage: !!full }) : null;
async function mk(browser) {
  const p = await phone(browser, devices, DB);
  await p.context().route('**cloudflareinsights**', r => r.abort());
  await p.context().addInitScript(() => { navigator.vibrate = () => true; });
  return p;
}
async function waitFor(p, fn, arg, ms) { try { await p.waitForFunction(fn, arg, { timeout: ms || 8000 }); return true; } catch (e) { return false; } }
async function enter(p, code) { for (const c of code) await p.click('#entry [data-color="' + c + '"]'); }
const G = p => p.evaluate(() => window.__cb.game());
const secretOf = (p, ix) => p.evaluate(ix => window.__cb.secretOf(window.__cb.game().players[ix].id), ix);

(async () => {
  const browser = await chromium.launch();
  const p = await mk(browser);
  await p.goto(B + '/codebreaker/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Amy', 'Ben'], games: [] })); });
  await p.reload();

  /* ---------------- clues */
  const sc = await p.evaluate(() => { const s = window.__cb.score; return [s([0, 0, 1, 2], [0, 1, 0, 3]), s([1, 2, 3, 4], [4, 3, 2, 1]), s([0, 0, 0, 1], [0, 0, 0, 0]), s([5, 4, 3, 2], [5, 4, 3, 2])]; });
  check(JSON.stringify(sc) === JSON.stringify([{ b: 1, w: 2 }, { b: 0, w: 4 }, { b: 3, w: 0 }, { b: 4, w: 0 }]), 'clues: ' + JSON.stringify(sc));

  /* ---------------- one phone: hide codes */
  await p.click('#playerChips .add:text-is("Amy")'); await p.click('#playerChips .add:text-is("Ben")');
  await shot(p, 'cb-setup', true);
  await p.click('#startBtn');
  check((await p.textContent('#entry')).includes('Pass the phone to Amy'), 'pass to Amy first');
  check(await p.locator('#entry [data-color]').count() === 0, 'no code picker before Amy says it’s her');
  await p.click('[data-a=cover]');
  await enter(p, [0, 1, 2, 3]);
  await shot(p, 'cb-hide');
  await p.click('[data-a=lock]');
  check((await p.textContent('#entry')).includes('Pass the phone to Ben'), 'then Ben');
  check(!(await p.textContent('body')).includes('Amy, pick'), 'Amy’s picker gone');
  await p.click('[data-a=cover]'); await p.click('[data-a=random]'); await p.click('[data-a=lock]');
  let g = await G(p);
  check(g.phase === 'play' && g.cur === 0, 'both hidden: Amy guesses first');
  check(!JSON.stringify(g.secrets).includes('0,1,2,3') && !/[0-9]/.test(Object.values(g.secrets).join('')), 'codes stored scrambled');
  check(JSON.stringify(await secretOf(p, 0)) === '[0,1,2,3]', 'Amy’s code kept');
  const benCode = await secretOf(p, 1);

  /* ---------------- guesses, clues, turns */
  const wrong = benCode.map(c => (c + 1) % 6);
  await enter(p, wrong);
  check(await p.locator('#entry .slot .peg.empty').count() === 0, 'four pegs entered');
  await p.click('#entry .slot[data-slot="1"]');
  check(await p.isDisabled('[data-a=guess]'), 'tap a spot to clear it; Guess off until full');
  await p.click('#entry [data-color="' + wrong[1] + '"]');
  await p.click('[data-a=guess]');
  g = await G(p);
  const r1 = g.guesses[g.players[0].id][0];
  check(r1.b === 0 && g.cur === 1, 'Amy’s guess scored, Ben’s turn');
  check(await p.locator('#boardCard .row:not(.secret)').count() === 0 && (await p.textContent('#boardCard')).includes('Ben’s guesses'), 'shows Ben’s (empty) board now');
  await p.click('#players .pl[data-view="0"]');
  check(await p.locator('#boardCard .row:not(.secret)').count() === 1, 'tap Amy to see her board');
  await p.click('[data-view="1"].btn');
  await enter(p, [0, 1, 2, 5]); await p.click('[data-a=guess]');
  await p.click('#players .pl[data-view="1"]');
  check((await p.locator('#boardCard .row:not(.secret) .keys i.b').count()) === 3, 'Ben: 3 in the right spot');
  await shot(p, 'cb-play');
  check((await p.textContent('#entry')).includes('Back to Amy'), 'looking at another board: button back to the guesser');
  await p.click('#undoBtn');
  g = await G(p); check(g.cur === 1 && !(g.guesses[g.players[1].id] || []).length, 'undo Ben’s guess');
  // Ben now cracks it: Amy cracks on her 2nd... order: Ben guess 1 (wrong), Amy guess 2 (right) → Ben last chance → right → tie
  await enter(p, [5, 5, 5, 5]); await p.click('[data-a=guess]');
  await enter(p, benCode); await p.click('[data-a=guess]');
  g = await G(p); check(g.phase === 'play' && g.cur === 1, 'Amy cracked it, Ben gets a last guess');
  check((await p.textContent('#status')).includes('last guess to tie'), 'last chance shown');
  await enter(p, [0, 1, 2, 3]); await p.click('[data-a=guess]');
  await p.waitForSelector('#winDlg[open]');
  check((await p.textContent('#winTitle')).includes('tie'), 'both in 2: tie');
  check(await p.locator('#finalList .pegs .peg').count() === 8, 'codes revealed');
  await shot(p, 'cb-tie');
  await p.click('#wRestart');
  g = await G(p); check(g.phase === 'set' && g.first === 1 && !Object.keys(g.secrets).length, 'rematch: new codes, Ben first');

  /* ---------------- computer */
  const stats = await p.evaluate(() => {
    const cb = window.__cb, g = cb.game(), keep = JSON.stringify(g), out = { max: 0, total: 0, ms: 0 };
    Object.assign(g, { len: 4, colors: 6, rep: true, level: 'hard' });
    const all = cb.allCodes(4, 6, true);
    for (let k = 0; k < 15; k++) {
      const secret = all[(k * 97) % all.length], hist = []; let n = 0;
      while (n < 12) { const t = performance.now(); const gu = cb.botGuess(hist); out.ms = Math.max(out.ms, performance.now() - t); n++;
        const r = cb.score(secret, gu); hist.push({ g: gu, b: r.b, w: r.w }); if (r.b === 4) break; }
      out.max = Math.max(out.max, n); out.total += n;
    }
    Object.assign(g, { len: 5, colors: 8, rep: false });
    const t = performance.now(); cb.botGuess([{ g: [0, 1, 2, 3, 4], b: 1, w: 2 }]); out.big = performance.now() - t;
    Object.assign(g, JSON.parse(keep)); return out;
  });
  check(stats.max <= 7 && stats.total / 15 < 5.5, 'hard computer cracks 4/6 codes fast: avg ' + (stats.total / 15).toFixed(1) + ', worst ' + stats.max);
  check(stats.ms < 1500 && stats.big < 2500, 'thinks quickly: ' + Math.round(stats.ms) + ' ms, 5 pegs/8 colors ' + Math.round(stats.big) + ' ms');
  await p.click('#menuBtn'); await p.click('#mSetup');
  await p.click('.mode:has(input[name=vs][value=bot])');
  await p.click('.mode:has(input[name=rep][value="0"])');
  await p.click('#startBtn');
  g = await G(p);
  check(g.phase === 'set' && Object.keys(g.secrets).length === 1, 'computer hid its code');
  check(await p.locator('#entry [data-color]').count() === 6, 'one person: picker straight away');
  await p.click('#entry [data-color="2"]');
  check(await p.isDisabled('#entry [data-color="2"]'), 'no repeats: used color greyed out');
  await enter(p, [0, 1, 3]); await p.click('[data-a=lock]');
  const botCode = await secretOf(p, 1);
  check(new Set(botCode).size === 4, 'computer’s code has no repeats');
  await enter(p, [5, 4, 3, 2].filter(c => true)); await p.click('[data-a=guess]');
  check(await waitFor(p, () => { const g = window.__cb.game(); return g.cur === 0 && (g.guesses.bot || []).length === 1; }), 'computer guessed back');
  await shot(p, 'cb-bot');
  await p.click('#menuBtn'); await p.click('#mPeek'); await p.waitForSelector('#peekDlg[open]');
  check(await p.locator('#peekPegs .peg').count() === 4 && (await p.textContent('#peekTitle')).includes('Amy'), 'peek at my own code');
  await p.click('#peekDlg [data-close]');
  await p.evaluate(() => localStorage.setItem('pebbly_theme', 'dark')); await p.reload();
  check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(20, 26, 24)', 'dark mode');
  await shot(p, 'cb-dark');
  await p.evaluate(() => localStorage.removeItem('pebbly_theme'));

  /* ---------------- play together */
  const h = await mk(browser), q = await mk(browser);
  await h.goto(B + '/codebreaker/');
  await h.fill('#newPlayer', 'Hal'); await h.press('#newPlayer', 'Enter');
  await h.click('.ps-mode[data-m="1"]');
  await waitFor(h, () => !document.getElementById('startBtn').disabled);
  await h.click('#startBtn');
  await h.waitForSelector('.ps-code');
  const code = (await h.textContent('.ps-code')).trim();
  await h.click('.ps-dlg [data-ps-close]');
  check(await h.locator('#entry [data-color]').count() === 6, 'host hides a code on their own phone (no pass screen)');
  await enter(h, [1, 1, 2, 2]); await h.click('[data-a=lock]');
  await q.goto(B + '/codebreaker/?join=' + code);
  await q.waitForSelector('#psName');
  await q.fill('#psName', 'Gus'); await q.click('#psJoinGo');
  await q.waitForSelector('#play:not([hidden])');
  check(await waitFor(q, () => !!document.querySelector('#entry [data-color]')), 'guest hides a code');
  check(await waitFor(h, () => document.getElementById('entry').textContent.includes('Waiting for Gus')), 'host waits for Gus');
  await enter(q, [3, 3, 4, 4]); await q.click('[data-a=lock]');
  check(await waitFor(h, () => window.__cb.game().phase === 'play' && !!document.querySelector('[data-a=guess]')), 'host guesses first');
  check(await waitFor(q, () => !!document.querySelector('.ps-wait')), 'guest waits');
  await enter(h, [3, 4, 0, 0]); await h.click('[data-a=guess]');
  check(await waitFor(q, () => !!document.querySelector('[data-a=guess]') && document.querySelectorAll('#boardCard .row:not(.secret)').length === 0), 'guest’s turn, own board');
  const hg = await q.evaluate(() => { const g = window.__cb.game(); return g.guesses[g.players[0].id][0]; });
  check(hg.b === 1 && hg.w === 1, 'host’s clue: 1 right spot, 1 right color');
  await shot(q, 'cb-guest');

  for (const x of [p, h, q]) check(!x.errs.length, 'page errors: ' + x.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
