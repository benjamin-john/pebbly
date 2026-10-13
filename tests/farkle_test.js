// Farkle (/farkle/): Undo after rolling on puts the turn back exactly as it was (no double-counted points).
// Fixed dice: crypto.getRandomValues is fed from a queue (window.__dice).
// Serve the repo root on port 8785 (python3 -m http.server 8785), then:
//   NODE_PATH=$(npm root -g) node tests/farkle_test.js
const { chromium, devices } = require('playwright');
const B = 'http://localhost:' + (process.env.PORT || 8785);
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }

(async () => {
  const browser = await chromium.launch();
  const c = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' });
  await c.route('**fonts.g*/**', r => r.abort());
  await c.route('**cloudflareinsights**', r => r.abort());
  await c.addInitScript(() => {
    window.__dice = [];
    const orig = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = a => { if (window.__dice.length && a.length === 1) { a[0] = window.__dice.shift() - 1; return a; } return orig(a); };
    navigator.vibrate = () => true;
  });
  const p = await c.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.goto(B + '/farkle/');
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.fill('#newPlayer', 'Amy'); await p.click('#addPlayerForm button[type=submit]');
  await p.fill('#newPlayer', 'Ben'); await p.click('#addPlayerForm button[type=submit]');
  await p.click('#startBtn');

  // Roll four 1s plus a 2 and 3, set aside the 1s.
  await p.evaluate(() => { window.__dice = [1, 1, 1, 1, 2, 3]; });
  await p.click('[data-a=roll]');
  for (const i of [0, 1, 2, 3]) await p.click('#dice .die[data-i="' + i + '"]');
  const pts1 = await p.textContent('#tPts');
  check(pts1 === '1,100' || pts1 === '1100', 'four 1s show 1100 (got ' + pts1 + ')');

  // Roll the other two: 2 and 3 → Farkle.
  await p.evaluate(() => { window.__dice = [2, 3]; });
  await p.click('[data-a=roll]');
  check(await p.isVisible('.farkle'), 'second roll is a Farkle');

  // Undo: back to the first roll with the four 1s still set aside, 1100 (not 2200).
  await p.click('#undoBtn');
  const pts2 = await p.textContent('#tPts');
  check(pts2 === pts1, 'after Undo the turn shows ' + pts1 + ' again (got ' + pts2 + ')');
  check(await p.$$eval('#dice .die[data-i]', d => d.length) === 6, 'all six dice of the first roll are back');
  check(await p.$$eval('#kept .grp', g => g.length) === 0, 'nothing kept yet after Undo');

  // Rolling again from there still adds the 1100 just once.
  await p.evaluate(() => { window.__dice = [5, 3]; });
  await p.click('[data-a=roll]');
  await p.click('#dice .die[data-i="0"]');
  const pts3 = await p.textContent('#tPts');
  check(pts3.replace(',', '') === '1150', 'rolling again after Undo: 1100 + 50 = 1150 (got ' + pts3 + ')');

  check(!errs.length, 'no page errors: ' + errs.join('; '));
  await browser.close();
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
