// Farkle (/farkle/): Undo after rolling on puts the turn back exactly as it was (no double-counted points);
// Three 1s = 300 (old saved rules on the former 1000 default move over once).
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
  check(pts1.replace(',', '') === '1000', 'four 1s show 1000 (four of a kind beats three 1s + a 1 = 400; got ' + pts1 + ')');

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
  check(pts3.replace(',', '') === '1050', 'rolling again after Undo: 1000 + 50 = 1050 (got ' + pts3 + ')');

  // Saved rules from before (Three 1s = 1000, the old default) move to 300 once; three 1s then score 300.
  await p.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('pebbly_farkle_settings')); delete st.v; st.R.three1 = 1000;
    localStorage.setItem('pebbly_farkle_settings', JSON.stringify(st));
    const g = JSON.parse(localStorage.getItem('pebbly_farkle')); g.R.three1 = 1000;
    localStorage.setItem('pebbly_farkle', JSON.stringify(g));
  });
  await p.reload();
  check(await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_farkle_settings')).R.three1) === 300, 'saved rules moved to 300');
  check(await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_farkle')).R.three1) === 300, 'game on screen moved to 300');
  // A rule someone picked on purpose stays (only the old default moves, and only once).
  await p.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('pebbly_farkle_settings')); st.R.three1 = 1000;
    localStorage.setItem('pebbly_farkle_settings', JSON.stringify(st));
  });
  await p.reload();
  check(await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_farkle_settings')).R.three1) === 1000, 'a 1000 chosen later is kept');
  await p.evaluate(() => { const st = JSON.parse(localStorage.getItem('pebbly_farkle_settings')); st.R.three1 = 300; localStorage.setItem('pebbly_farkle_settings', JSON.stringify(st)); });

  // New game: three 1s + junk scores 300.
  await p.click('#menuBtn'); await p.click('#mSetup'); await p.click('#startBtn');
  await p.evaluate(() => { window.__dice = [1, 1, 1, 2, 3, 4]; });
  await p.click('[data-a=roll]');
  for (const i of [0, 1, 2]) await p.click('#dice .die[data-i="' + i + '"]');
  check((await p.textContent('#tPts')) === '300', 'three 1s score 300 (got ' + await p.textContent('#tPts') + ')');

  check(!errs.length, 'no page errors: ' + errs.join('; '));
  await browser.close();
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
