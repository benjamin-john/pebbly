// Mancala (/mancala/): sowing (skipping the other store), extra turn, capture, end-of-game sweep,
// undo, the computer (speed and a sensible pick), rematch with the loser starting, and a 2-phone
// "play together" game against a local Postgres (the guest sees their own side at the bottom).
// Setup: sh tests/setup_db.sh agent_g; serve the repo root on port 8791 (python3 -m http.server 8791), then:
//   NODE_PATH=$(npm root -g) node tests/mancala_test.js        (SHOTS=<folder> to save screenshots)
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
const pits = p => p.evaluate(() => window.__mancala.game().pits.join(','));

(async () => {
  const browser = await chromium.launch();
  const p = await mk(browser);
  await p.goto(B + '/mancala/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Amy', 'Ben'], games: [] })); });
  await p.reload();

  /* ---------------- rules (pure) */
  const r = await p.evaluate(() => {
    const s = window.__mancala.sow, out = {};
    let a = [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0];
    out.extra = s(a, 0, 2).extra; out.extraPits = a.join(',');
    a = [0, 0, 0, 0, 0, 13, 0, 1, 1, 1, 1, 1, 1, 0];       // 13 seeds from pit 5: goes all the way round, skips store 13
    out.round = s(a, 0, 5); out.roundPits = a.join(',');
    a = [1, 0, 3, 3, 3, 3, 0, 3, 3, 3, 5, 3, 3, 0];         // pit 0 → lands in empty pit 1, across (11) has 3
    out.cap = s(a, 0, 0); out.capPits = a.join(',');
    a = [0, 0, 0, 0, 0, 1, 10, 2, 0, 0, 0, 0, 3, 7];        // last seed into store, side empty → game over, sweep
    out.end = s(a, 0, 5); out.endPits = a.join(',');
    return out;
  });
  check(r.extra && r.extraPits === '4,4,0,5,5,5,1,4,4,4,4,4,4,0', 'four seeds from pit 3 end in the store: go again');
  check(r.roundPits === '1,1,1,1,1,0,4,0,2,2,2,2,2,0' && r.round.capN === 3, 'skips the other store, then captures in the emptied pit: ' + r.roundPits);
  check(r.cap.capN === 4 && r.capPits === '0,0,3,3,3,3,4,3,3,3,5,0,3,0', 'capture 1 + 3: ' + r.capPits);
  check(r.end.over && r.endPits === '0,0,0,0,0,0,11,0,0,0,0,0,0,12', 'game over sweeps the other side: ' + r.endPits);

  /* ---------------- play */
  await p.click('#playerChips .add:text-is("Amy")'); await p.click('#playerChips .add:text-is("Ben")');
  await p.click('.mode:has(input[name=seeds][value="3"])');
  await shot(p, 'mancala-setup', true);
  await p.click('#startBtn');
  check(await p.locator('#board .pit').count() === 12 && await p.locator('#board .pit.can').count() === 6, '12 pits, 6 playable');
  await p.click('#board .pit[data-pit="3"]');   // 3 seeds from pit 4 → 4,5, store: go again
  check((await p.textContent('#status')).includes('go again'), 'extra turn shown');
  check(await p.evaluate(() => window.__mancala.game().cur) === 0, 'still Amy');
  await p.click('#board .pit[data-pit="0"]');
  check(await p.evaluate(() => window.__mancala.game().cur) === 1 && await p.locator('#board .pit.can').count() === 5, 'Amy captured from pit 10; Ben’s other 5 pits playable');
  await shot(p, 'mancala-play');
  const before = await pits(p);
  await p.click('#board .pit[data-pit="10"]');
  await p.click('#undoBtn');
  check(await pits(p) === before, 'undo');
  // finish the game quickly from a set position
  await p.evaluate(() => { const g = JSON.parse(localStorage.getItem('pebbly_mancala')); g.pits = [0, 0, 0, 0, 0, 1, 10, 2, 0, 0, 0, 0, 3, 7]; g.cur = 0; localStorage.setItem('pebbly_mancala', JSON.stringify(g)); });
  await p.reload();
  await p.click('#board .pit[data-pit="5"]');
  await p.waitForSelector('#winDlg[open]');
  check((await p.textContent('#winTitle')).includes('Ben wins'), 'Ben wins 12 to 11: ' + await p.textContent('#winTitle'));
  await shot(p, 'mancala-win');
  await p.click('#wRestart');
  const g1 = await p.evaluate(() => window.__mancala.game());
  check(g1.cur === 0 && g1.first === 0 && g1.tally[g1.players[1].id] === 1 && g1.pits[0] === 3, 'rematch: Amy (lost) starts, Ben 1 win');

  /* ---------------- computer */
  await p.click('#menuBtn'); await p.click('#mSetup');
  await p.click('.mode:has(input[name=vs][value=bot])');
  await p.click('.mode:has(input[name=seeds][value="4"])');
  await p.click('#startBtn');
  const t0 = Date.now();
  const pick = await p.evaluate(() => { const g = window.__mancala.game(); g.cur = 1; const t = performance.now(); const k = window.__mancala.botPick(); g.cur = 0; return [k, performance.now() - t]; });
  check(pick[1] < 1500, 'computer thinks fast enough: ' + Math.round(pick[1]) + ' ms');
  check(pick[0] >= 7 && pick[0] <= 12, 'computer picks one of its own pits (got ' + pick[0] + ')');
  // Hard computer against random moves: should win nearly every game.
  const wins = await p.evaluate(() => {
    const M = window.__mancala, g = M.game(), keep = JSON.stringify(g); let w = 0;
    for (let n = 0; n < 6; n++) {
      g.pits = [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0]; g.cur = n % 2; let over = false;
      while (!over) {
        let pit;
        if (g.cur === 1) pit = M.botPick();
        else { const o = [0, 1, 2, 3, 4, 5].filter(k => g.pits[k]); pit = o[Math.floor(Math.random() * o.length)]; }
        const r = M.sow(g.pits, g.cur, pit); over = r.over; if (!r.extra) g.cur = 1 - g.cur;
      }
      if (g.pits[13] > g.pits[6]) w++;
    }
    Object.assign(g, JSON.parse(keep)); return w;
  });
  check(wins >= 5, 'hard computer beats random play (' + wins + '/6)');
  await p.click('#board .pit[data-pit="1"]');   // 4 seeds from pit 2 → 2..5, Amy's turn over
  check(await waitFor(p, () => window.__mancala.game().cur === 0 && window.__mancala.game().moves >= 2, null, 10000), 'computer moved');
  await shot(p, 'mancala-bot');
  await p.evaluate(() => localStorage.setItem('pebbly_theme', 'dark')); await p.reload();
  check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(20, 26, 24)', 'dark mode');
  await shot(p, 'mancala-dark');
  await p.evaluate(() => localStorage.removeItem('pebbly_theme'));

  /* ---------------- play together */
  const h = await mk(browser), g = await mk(browser);
  await h.goto(B + '/mancala/');
  await h.fill('#newPlayer', 'Hal'); await h.press('#newPlayer', 'Enter');
  await h.click('.ps-mode[data-m="1"]');
  await h.click('#startBtn');
  await h.waitForSelector('.ps-code');
  const code = (await h.textContent('.ps-code')).trim();
  await h.click('.ps-dlg [data-ps-close]');
  await g.goto(B + '/mancala/?join=' + code);
  await g.waitForSelector('#psName');
  await g.fill('#psName', 'Gus'); await g.click('#psJoinGo');
  await g.waitForSelector('#play:not([hidden])');
  check(await waitFor(h, () => document.querySelectorAll('#board .pit.can').length === 6), 'host can play once Gus joined');
  check(await g.locator('#board .pit.can').count() === 0 && await g.isVisible('.ps-wait'), 'guest waits');
  check((await g.textContent('#board .store:last-child')).includes('Gus'), 'guest’s store at the bottom on their phone');
  await h.click('#board .pit[data-pit="0"]');
  check(await waitFor(g, () => document.querySelectorAll('#board .pit.can').length === 6), 'guest’s turn after Hal');
  await g.click('#board .pit[data-pit="8"]');
  check(await waitFor(h, () => window.__mancala.game().moves === 2), 'host sees Gus’s move');
  await shot(g, 'mancala-guest');

  for (const x of [p, h, g]) check(!x.errs.length, 'page errors: ' + x.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
