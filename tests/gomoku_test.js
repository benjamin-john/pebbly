// Gomoku (/gomoku/): setup, tap-then-place, five in a row (and "exactly five" ignoring six), undo,
// the computer (takes a win, blocks four), rematch with the loser starting, and a 2-phone
// "play together" game against a local Postgres.
// Setup: sh tests/setup_db.sh agent_g; serve the repo root on port 8791 (python3 -m http.server 8791), then:
//   NODE_PATH=$(npm root -g) node tests/gomoku_test.js        (SHOTS=<folder> to save screenshots)
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
const at = (n, r, q) => r * n + q;
async function play(p, c) { await p.click('#board .pt[data-c="' + c + '"]'); await p.click('#board .pt[data-c="' + c + '"]'); }

(async () => {
  const browser = await chromium.launch();
  const p = await mk(browser);
  await p.goto(B + '/gomoku/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Amy', 'Ben', 'Cal'], games: [] })); });
  await p.reload();

  /* ---------------- setup */
  check(await p.isVisible('#setup') && await p.isDisabled('#startBtn'), 'setup needs players');
  await p.click('#playerChips .add:text-is("Amy")'); await p.click('#playerChips .add:text-is("Ben")');
  check(await p.isHidden('#addPlayerForm') && await p.locator('#playerChips .chip').count() === 0, 'only two players');
  await shot(p, 'gomoku-setup', true);
  await p.click('#startBtn');
  check(await p.isVisible('#play'), 'playing');
  check(await p.locator('#board .pt').count() === 225, '15 × 15');

  /* ---------------- tap then place */
  const n = 15;
  await p.click('#board .pt[data-c="' + at(n, 7, 7) + '"]');
  check(await p.locator('#board .pt.sel .ghost.b').count() === 1, 'ghost stone after one tap');
  await p.click('[data-a=place]');
  check(await p.locator('#board .s.b').count() === 1, 'placed with the button');
  check((await p.textContent('#status')).includes('Ben'), 'Ben’s turn');
  // Amy: row 7 cols 7..11; Ben: row 9
  for (let k = 0; k < 4; k++) {
    await play(p, at(n, 9, 3 + k));
    if (k < 3) await play(p, at(n, 7, 8 + k));
  }
  check(!(await p.evaluate(() => window.__gomoku.game().over)), 'four is not a win');
  await play(p, at(n, 7, 11));
  await p.waitForSelector('#winDlg[open]');
  check((await p.textContent('#winTitle')).includes('Amy wins'), 'Amy wins: ' + await p.textContent('#winTitle'));
  check(await p.locator('#board .pt.win').count() === 5, 'winning line marked');
  await shot(p, 'gomoku-win');
  await p.click('#wUndo');
  check(!(await p.evaluate(() => window.__gomoku.game().over)) && await p.locator('#board .s').count() === 8, 'undo the winning stone');
  await play(p, at(n, 7, 11));
  await p.waitForSelector('#winDlg[open]');
  await p.click('#wRestart');
  const g1 = await p.evaluate(() => window.__gomoku.game());
  check(g1.moves.length === 0 && g1.black === 1 && g1.tally[g1.players[0].id] === 1, 'rematch: Ben (lost) is Black, Amy has 1 win');

  /* ---------------- exactly five: a line of six doesn't win */
  const ex = await p.evaluate(() => {
    const g = window.__gomoku, b = new Array(225).fill(0);
    [0, 1, 2, 4, 5].forEach(q => b[q] = 1); b[3] = 1;
    return [g.winLine(b, 15, 3, 1, 'exact'), !!g.winLine(b, 15, 3, 1, 'free')];
  });
  check(ex[0] === null && ex[1], 'six: no win with exactly five, win with five or more');

  /* ---------------- computer */
  await p.click('#menuBtn'); await p.click('#mSetup');
  await p.click('.mode:has(input[name=vs][value=bot])');
  check(await p.isVisible('#levelOpt') && await p.isHidden('#psSetup'), 'level shown, no sharing with the computer');
  check(await p.locator('#setupPlayers input').count() === 1 && await p.isVisible('#setupPlayers .bot'), 'one person + computer');
  await p.click('#startBtn');
  await play(p, at(n, 7, 7));
  check(await waitFor(p, () => document.querySelectorAll('#board .s').length === 2), 'computer answered');
  // Computer must block an open four and take its own win.
  const picks = await p.evaluate(() => {
    const g = window.__gomoku.game(); const n = g.n;
    // Black (person) has 4 in a row at row 3 cols 3..6 (col 2 already blocked by white), white elsewhere; white to move.
    g.moves = [3 * n + 3, 10 * n + 10, 3 * n + 4, 3 * n + 2, 3 * n + 5, 12 * n + 1, 3 * n + 6];
    const block = window.__gomoku.botPick();
    // White has four at row 10, black elsewhere: white should win rather than block.
    g.moves = [3 * n + 3, 10 * n + 4, 3 * n + 4, 10 * n + 5, 3 * n + 5, 10 * n + 6, 0, 10 * n + 7, 3 * n + 6];
    const win = window.__gomoku.botPick();
    return [block, win, n];
  });
  check(picks[0] === 3 * picks[2] + 7, 'computer blocks the four (' + picks[0] + ')');
  check(picks[1] === 10 * picks[2] + 3 || picks[1] === 10 * picks[2] + 8, 'computer takes its five (' + picks[1] + ')');
  await p.reload();
  await shot(p, 'gomoku-bot');

  /* ---------------- dark mode */
  await p.evaluate(() => localStorage.setItem('pebbly_theme', 'dark')); await p.reload();
  check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(20, 26, 24)', 'dark mode');
  await shot(p, 'gomoku-dark');
  await p.evaluate(() => localStorage.removeItem('pebbly_theme'));

  /* ---------------- play together */
  const h = await mk(browser), g = await mk(browser);
  await h.goto(B + '/gomoku/');
  await h.fill('#newPlayer', 'Hal'); await h.press('#newPlayer', 'Enter');
  await h.click('.ps-mode[data-m="1"]');
  check(await waitFor(h, () => !document.getElementById('startBtn').disabled), 'shared game can start with one player');
  await h.click('#startBtn');
  await h.waitForSelector('.ps-code');
  const code = (await h.textContent('.ps-code')).trim();
  check(/^[A-Z0-9]{5}$/.test(code), 'code ' + code);
  await h.click('.ps-dlg [data-ps-close]');
  check((await h.textContent('#status')).includes('Waiting for the other player'), 'waiting for the second player');
  await g.goto(B + '/gomoku/?join=' + code);
  await g.waitForSelector('#psName');
  await g.fill('#psName', 'Gus'); await g.click('#psJoinGo');
  await g.waitForSelector('#play:not([hidden])');
  check(await waitFor(h, () => document.getElementById('status').textContent.includes('Hal’s turn')), 'host sees Gus joined, Hal to play');
  check(await g.isVisible('.ps-wait'), 'guest waits for Hal');
  await play(h, 40);
  check(await waitFor(g, () => document.querySelectorAll('#board .s.b').length === 1 && document.getElementById('status').textContent.includes('Gus’s turn')), 'guest sees Hal’s stone');
  check(await h.isVisible('.ps-wait'), 'host now waits');
  await play(g, 41);
  check(await waitFor(h, () => document.querySelectorAll('#board .s.w').length === 1), 'host sees Gus’s stone');
  await shot(g, 'gomoku-guest');

  for (const x of [p, h, g]) check(!x.errs.length, 'page errors: ' + x.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
