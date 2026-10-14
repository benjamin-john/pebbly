// Color Stack (/colorstack/): moving one bead at a time (lift, drop, put back), full rods, the
// "same color only" rule, undo, hints that lead to a solve, finishing and best score, deals that
// can be solved (and the extra empty rod when none can), 360px width. No database.
// Serve the repo root on port 8791 (python3 -m http.server 8791), then:
//   NODE_PATH=$(npm root -g) node tests/colorstack_test.js        (SHOTS=<folder> to save screenshots)
const { chromium, devices } = require('playwright');
const B = 'http://localhost:' + (process.env.PORT || 8791);
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }
const shot = (p, name, full) => process.env.SHOTS ? p.screenshot({ path: process.env.SHOTS + '/' + name + '.png', fullPage: !!full }) : null;
const G = p => p.evaluate(() => window.__cs.game());
const rod = (p, i) => p.click('.rod[data-rod="' + i + '"]');
async function setRods(p, rods, extra) {
  await p.evaluate(([rods, extra]) => {
    const g = JSON.parse(localStorage.getItem('pebbly_colorstack'));
    Object.assign(g, extra || {}, { rods, start: rods, moves: 0, ms: 0, solved: false });
    localStorage.setItem('pebbly_colorstack', JSON.stringify(g)); localStorage.setItem('pebbly_colorstack_undo', '[]');
  }, [rods, extra]);
  await p.reload();
}

(async () => {
  const browser = await chromium.launch();
  const c = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' });
  await c.route('**fonts.g*/**', r => r.abort()); await c.route('**cloudflareinsights**', r => r.abort());
  await c.addInitScript(() => { navigator.vibrate = () => true; });
  const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.goto(B + '/colorstack/');
  await p.evaluate(() => localStorage.clear()); await p.reload();
  check(await p.isVisible('#setup'), 'setup first');
  await shot(p, 'cs-setup', true);
  await p.click('[data-preset=easy]');
  let g = await G(p);
  check(g.rods.length === 6 && g.rods.filter(r => r.length === 4).length === 4 && g.rods.filter(r => !r.length).length === 2, 'easy: 4 full rods + 2 empty');
  check(await p.locator('.bead').count() === 16, '16 beads drawn');
  await shot(p, 'cs-start');

  /* ---------------- moves (free rule) */
  await setRods(p, [[0, 1, 0, 1], [1, 0, 1, 0], [2, 3, 2, 3], [3, 2, 3, 2], [], []]);
  await rod(p, 4);
  check((await p.textContent('#status')).includes('empty'), 'can’t lift from an empty rod');
  await rod(p, 0);
  check(await p.locator('.rod[data-rod="0"] .bead.up').count() === 1, 'top bead lifted');
  check(await p.locator('.rod.can').count() === 2, 'only the two empty rods have room');
  await rod(p, 0);
  check(await p.locator('.bead.up').count() === 0, 'tap again to put it back');
  await rod(p, 0); await rod(p, 1);
  check((await p.textContent('#status')).includes('full'), 'full rod refused');
  await rod(p, 4);
  g = await G(p);
  check(JSON.stringify(g.rods[0]) === '[0,1,0]' && JSON.stringify(g.rods[4]) === '[1]' && g.moves === 1, 'one bead moved');
  await rod(p, 0); await rod(p, 5);
  check((await G(p)).rods[5][0] === 0, 'free rule: onto an empty rod');
  await rod(p, 1); await rod(p, 5);   // 0 onto 0
  await rod(p, 4); await rod(p, 0);   // 1 onto 0: fine with the free rule
  g = await G(p); check(JSON.stringify(g.rods[0]) === '[0,1,1]' && g.moves === 4, 'free rule allows a different color');
  await p.click('#undoBtn');
  g = await G(p); check(JSON.stringify(g.rods[0]) === '[0,1]' && g.moves === 3, 'undo');
  await shot(p, 'cs-play');

  /* ---------------- hints lead to a solve */
  await setRods(p, [[0, 1, 0, 1], [1, 0, 1, 0], [2, 3, 2, 3], [3, 2, 3, 2], [], []]);
  let steps = 0;
  while (!(await G(p)).solved && steps < 60) {
    await p.click('#hintBtn');
    await p.waitForSelector('.rod.hint', { timeout: 5000 });
    const m = await p.evaluate(() => [...document.querySelectorAll('.rod.hint')].map(e => +e.dataset.rod));
    const txt = await p.textContent('#status'), from = +txt.match(/rod (\d+) to/)[1] - 1, to = +txt.match(/to rod (\d+)/)[1] - 1;
    if (steps === 0) check(m.includes(from) && m.includes(to), 'hint highlights both rods');
    await rod(p, from); await rod(p, to); steps++;
  }
  g = await G(p);
  check(g.solved, 'solved by following hints (' + steps + ' moves)');
  await p.waitForSelector('#winDlg[open]');
  check((await p.textContent('#winTitle')).includes('New best') && (await p.textContent('#winMoves')).includes(String(g.moves)), 'win dialog with new best');
  await shot(p, 'cs-win');
  await p.click('#wRestart');
  g = await G(p); check(!g.solved && g.moves === 0 && JSON.stringify(g.rods) === JSON.stringify(g.start), 'try again: same puzzle from the start');
  check((await p.textContent('#best')) === String(steps), 'best moves shown');

  /* ---------------- same color only */
  await p.click('#menuBtn'); await p.click('#mSetup');
  await p.click('.mode:has(input[name=rule][value=match])');
  await p.click('.mode:has(input[name=colors][value="3"])');
  await p.click('#startBtn');
  await setRods(p, [[0, 1, 2], [1, 2, 0], [2, 0, 1], [], []], { h: 3, colors: 3, rule: 'match' });
  await rod(p, 0); await rod(p, 3);   // 2 onto empty
  await rod(p, 1); await rod(p, 3);   // 0 onto 2: refused
  check((await p.textContent('#status')).includes('same color'), 'same color only: different color refused');
  await rod(p, 1);                    // put it back
  await rod(p, 2); await rod(p, 0);   // 1 onto 1
  g = await G(p); check(JSON.stringify(g.rods[0]) === '[0,1,1]', 'same color allowed');

  /* ---------------- deals */
  const d = await p.evaluate(() => {
    const cs = window.__cs, out = { ok: 0 };
    for (let k = 0; k < 10; k++) { const r = cs.deal({ colors: 6, h: 4, spare: 1, rule: 'match' }); if (r && cs.solve(r, 4, 'match', 60000)) out.ok++; }
    const t = performance.now(); const r = cs.deal({ colors: 8, h: 5, spare: 1, rule: 'match' }); out.ms = performance.now() - t;
    out.fine = r === null || !!cs.solve(r, 5, 'match', 60000);
    return out;
  });
  check(d.ok === 10, 'tricky deals (same color, one empty rod) are always solvable: ' + d.ok + '/10');
  check(d.fine && d.ms < 4000, 'hardest combination: a solvable deal or gives up, quickly (' + Math.round(d.ms) + ' ms)');
  // no solvable deal at all: a second empty rod is added and explained
  await p.evaluate(() => { window.__cs.game().moves = 0; window.__cs._noDeal = true; });
  await p.click('#newBtn');
  g = await G(p);
  check(g.extra && g.rods.filter(r => !r.length).length === g.spare + 1 && (await p.textContent('#status')).includes('extra empty rod'), 'no solvable deal: an extra empty rod added, with a note');
  await p.evaluate(() => { window.__cs._noDeal = false; });

  /* ---------------- big board, dark, 360px */
  await p.click('#menuBtn'); await p.click('#mSetup');
  await p.click('[data-preset=hard]');
  g = await G(p);
  check(g.rods.length === 9 && g.rods.filter(r => !r.length).length === 1, 'hard: 8 colors + 1 empty rod');
  await shot(p, 'cs-hard');
  await p.evaluate(() => localStorage.setItem('pebbly_theme', 'dark')); await p.reload();
  check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(20, 26, 24)', 'dark mode');
  await shot(p, 'cs-dark');
  await p.setViewportSize({ width: 360, height: 740 }); await p.reload();
  check(await p.evaluate(() => document.documentElement.scrollWidth <= 360), 'fits at 360px');
  await shot(p, 'cs-360');

  check(!errs.length, 'page errors: ' + errs.join());
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
