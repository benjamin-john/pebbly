// Dots and Boxes (/dots/): drawing lines by tapping between dots, closing a box (go again), scores,
// end of game and winner, undo, the computer (takes a box, avoids giving one away), 3 players,
// and a 2-phone "play together" game against a local Postgres.
// Setup: sh tests/setup_db.sh agent_g; serve the repo root on port 8791 (python3 -m http.server 8791), then:
//   NODE_PATH=$(npm root -g) node tests/dots_test.js        (SHOTS=<folder> to save screenshots)
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
// Tap the middle of line i (n boxes a side), the way a finger would.
async function tapLine(p, i) {
  const pt = await p.evaluate(i => {
    const g = window.__dots.game(), n = g.n, U = 100, H = (n + 1) * n;
    let x, y; if (i < H) { const r = Math.floor(i / n), c = i % n; x = c * U + 50; y = r * U; } else { const j = i - H, r = Math.floor(j / (n + 1)), c = j % (n + 1); x = c * U; y = r * U + 50; }
    const b = document.getElementById('board').getBoundingClientRect(), W = n * U + 28;
    return [b.left + (x + 14 + (i < H ? 0 : 6)) / W * b.width, b.top + (y + 14 + (i < H ? 6 : 0)) / W * b.height];
  }, i);
  await p.mouse.click(pt[0], pt[1]);
}
const G = p => p.evaluate(() => window.__dots.game());

(async () => {
  const browser = await chromium.launch();
  const p = await mk(browser);
  await p.goto(B + '/dots/');
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Amy', 'Ben', 'Cal'], games: [] })); });
  await p.reload();
  await p.click('#playerChips .add:text-is("Amy")'); await p.click('#playerChips .add:text-is("Ben")');
  await p.click('.mode:has(input[name=size][value="3"])');
  await shot(p, 'dots-setup', true);
  await p.click('#startBtn');
  let g = await G(p);
  check(g.lines.length === 24 && g.boxes.length === 9, '3 × 3: 24 lines, 9 boxes');
  // Box 0: top 0, bottom 3, left 12, right 13
  await tapLine(p, 0);  g = await G(p); check(g.lines[0] === 1 && g.cur === 1, 'Amy drew the top line, Ben’s turn');
  await tapLine(p, 3);  await tapLine(p, 12);
  g = await G(p); check(g.cur === 1 && g.lines[3] === 2 && g.lines[12] === 1, 'Ben then Amy: back to Ben (' + g.cur + ')');
  await tapLine(p, 13);
  g = await G(p); check(g.boxes[0] === 2 && g.cur === 1, 'Ben closed box 0 and goes again');
  check((await p.textContent('#status')).includes('Ben goes again'), 'status says go again');
  check((await p.textContent('#players .pl:nth-child(2) .sc')) === '1', 'Ben has 1 box');
  await shot(p, 'dots-play');
  await p.click('#undoBtn');
  g = await G(p); check(!g.boxes[0] && g.cur === 1 && !g.lines[13], 'undo');
  // Fill everything except one line so that Amy closes the last boxes
  await p.evaluate(() => {
    const g = JSON.parse(localStorage.getItem('pebbly_dots'));
    g.lines = g.lines.map(() => 2); g.lines[13] = 0; g.boxes = [0, 0, 2, 2, 2, 2, 2, 1, 1]; g.cur = 0;
    localStorage.setItem('pebbly_dots', JSON.stringify(g));
  });
  await p.reload();
  await tapLine(p, 13);
  await p.waitForSelector('#winDlg[open]');
  check((await p.textContent('#winTitle')).includes('Ben wins'), 'Ben 5, Amy 4: ' + await p.textContent('#winTitle'));
  await shot(p, 'dots-win');
  await p.click('#wRestart');
  g = await G(p); check(g.cur === 1 && g.tally[g.players[1].id] === 1 && g.moves === 0, 'rematch: next player starts, Ben 1 win');

  /* ---------------- computer */
  const picks = await p.evaluate(() => {
    const g = window.__dots.game(), out = {};
    g.lines = g.lines.map(() => 0); g.boxes = g.boxes.map(() => 0); g.cur = 1;
    g.lines[0] = g.lines[3] = g.lines[12] = 1;          // box 0 has 3 sides
    out.take = window.__dots.botPick();
    g.lines[13] = 1; g.boxes[0] = 1;
    // Lots of free lines: any pick must not draw a third side
    let bad = 0;
    for (let k = 0; k < 30; k++) { const i = window.__dots.botPick(); if (window.__dots.boxesOf(3, i).some(b => !g.boxes[b] && window.__dots.sides(3, b).filter(s => g.lines[s]).length === 2)) bad++; }
    out.bad = bad;
    return out;
  });
  check(picks.take === 13, 'computer takes the box (' + picks.take + ')');
  check(picks.bad === 0, 'computer never draws a third side while safe moves exist');
  await p.click('#menuBtn'); await p.click('#mSetup');
  await p.click('.mode:has(input[name=vs][value=bot])');
  await p.click('#playerChips .add:text-is("Cal")');
  check(await p.locator('#setupPlayers input').count() === 3 && await p.isVisible('#setupPlayers .bot'), '3 people + computer');
  await p.click('.mode:has(input[name=size][value="5"])');
  await p.click('#startBtn');
  check(await p.locator('#players .pl').count() === 4, 'four players shown');
  await tapLine(p, 0); await tapLine(p, 40); await tapLine(p, 7);
  check(await waitFor(p, () => window.__dots.game().moves >= 4 && window.__dots.game().cur === 0, null, 10000), 'computer moved, back to Amy');
  await shot(p, 'dots-bot');
  await p.evaluate(() => localStorage.setItem('pebbly_theme', 'dark')); await p.reload();
  check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(20, 26, 24)', 'dark mode');
  await shot(p, 'dots-dark');
  await p.evaluate(() => localStorage.removeItem('pebbly_theme'));

  /* ---------------- play together */
  const h = await mk(browser), q = await mk(browser);
  await h.goto(B + '/dots/');
  await h.fill('#newPlayer', 'Hal'); await h.press('#newPlayer', 'Enter');
  await h.click('.ps-mode[data-m="1"]');
  await h.click('#startBtn');
  await h.waitForSelector('.ps-code');
  const code = (await h.textContent('.ps-code')).trim();
  await h.click('.ps-dlg [data-ps-close]');
  check((await h.textContent('#status')).includes('Waiting'), 'waiting for others');
  await q.goto(B + '/dots/?join=' + code);
  await q.waitForSelector('#psName');
  await q.fill('#psName', 'Gus'); await q.click('#psJoinGo');
  await q.waitForSelector('#play:not([hidden])');
  check(await waitFor(h, () => window.__dots.game().players.length === 2 && document.getElementById('status').textContent.includes('Hal’s turn')), 'Gus joined; Hal to play');
  check(await q.isVisible('.ps-wait'), 'guest waits');
  await tapLine(h, 30);
  check(await waitFor(q, () => window.__dots.game().lines[30] === 1 && document.getElementById('status').textContent.includes('Gus’s turn')), 'guest sees Hal’s line');
  await tapLine(q, 31);
  check(await waitFor(h, () => window.__dots.game().lines[31] === 2), 'host sees Gus’s line');
  await shot(q, 'dots-guest');

  for (const x of [p, h, q]) check(!x.errs.length, 'page errors: ' + x.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
