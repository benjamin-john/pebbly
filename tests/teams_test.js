// Team Picker (/teams/): players, sitting out, teams, pick someone, turn order, copy, memory.
// Randomness is fixed by replacing crypto.getRandomValues with a queue (window.__q).
// Serve the repo root on port 8784 (python3 -m http.server 8784), then:
//   NODE_PATH=$(npm root -g) node tests/teams_test.js        (SHOTS=<folder> to save screenshots)
const { chromium, devices } = require('playwright');
const B = 'http://localhost:' + (process.env.PORT || 8784);
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }

// Same algorithm as the page, to work out what fixed numbers should give.
function shuffle(list, q) { const a = list.slice(); q = q.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (q.shift() || 0) % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function mk(browser, opts) {
  const c = await browser.newContext({ ...devices['Pixel 7'], permissions: ['clipboard-read', 'clipboard-write'], ...(opts || {}) });
  await c.route('**fonts.g*/**', r => r.abort());
  await c.route('**cloudflareinsights**', r => r.abort());
  await c.addInitScript(() => {
    window.__q = [];
    const orig = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = a => { if (window.__q.length && a.length === 1) { a[0] = window.__q.shift(); return a; } return orig(a); };
  });
  const p = await c.newPage(); p.errs = [];
  p.on('pageerror', e => p.errs.push(e.message)); p.on('dialog', d => d.accept());
  return p;
}
const texts = (p, sel) => p.$$eval(sel, els => els.map(e => e.textContent.trim()));

(async () => {
  const browser = await chromium.launch();
  const p = await mk(browser);
  await p.goto(B + '/teams/');
  await p.evaluate(() => localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Amy', 'Ben', 'Cal'], games: ['Uno'] })));
  await p.reload();
  check((await texts(p, '#chips .add')).join() === 'Amy,Ben,Cal', 'remembered names shown as chips');
  check(await p.isDisabled('#goBtn'), 'button disabled with no players');

  // add by typing, a comma list, and chips
  await p.fill('#newName', 'Dan'); await p.press('#newName', 'Enter');
  await p.fill('#newName', 'Eve, Fay, Gus'); await p.click('#addForm button');
  await p.fill('#newName', 'dan'); await p.press('#newName', 'Enter');
  for (const n of ['Amy', 'Ben', 'Cal']) await p.click(`#chips .add:text-is("${n}")`);
  let names = await texts(p, '#plist .nm');
  check(names.join() === 'Dan,Eve,Fay,Gus,Amy,Ben,Cal', 'players added, no duplicates: ' + names.join());
  check(!(await p.locator('#chips .chip').count()), 'chips disappear once added');

  // sit Gus out
  await p.click('#plist li:nth-child(4) .sit');
  check((await p.textContent('#count')) === '6 playing · 1 sitting out', 'count with sitting out');

  // make 2 teams with fixed randomness
  const act = ['Dan', 'Eve', 'Fay', 'Amy', 'Ben', 'Cal'];
  let q = [3, 1, 0, 2, 1];
  await p.evaluate(q => { window.__q = q.slice(); }, q);
  check((await p.textContent('#splitHint')).includes('2 teams of 3'), 'split hint');
  await p.click('#goBtn');
  let sh = shuffle(act, q);
  let teams = await p.$$eval('.team', ts => ts.map(t => t.querySelector('h3 span').textContent + ':' + [...t.querySelectorAll('li')].map(l => l.textContent).join('+')));
  check(teams.join(' | ') === `Team Red:${sh[0]}+${sh[2]}+${sh[4]} | Team Blue:${sh[1]}+${sh[3]}+${sh[5]}`, 'two even teams: ' + teams.join(' | '));
  check(!(await p.textContent('#result')).includes('Gus'), 'sitting-out player left out');

  // copy for the group chat
  await p.click('#copyBtn');
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  check(clip.split('\n')[0] === `Team Red: ${sh[0]}, ${sh[2]}, ${sh[4]}`, 'copied text: ' + JSON.stringify(clip));
  check((await p.textContent('#copyBtn')).includes('Copied'), 'copy confirmation');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/teams-2.png', fullPage: true });

  // three teams, numbers; uneven split
  await p.click('#plus');
  await p.click('#nmNumbers');
  await p.click('#plist li:nth-child(4) .sit');   // Gus back: 7 players
  check((await p.textContent('#splitHint')).includes('1 team of 3, 2 of 2'), 'uneven hint: ' + await p.textContent('#splitHint'));
  await p.evaluate(() => { window.__q = [0, 0, 0, 0, 0, 0]; });
  await p.click('#goBtn');
  let sizes = await p.$$eval('.team', ts => ts.map(t => t.querySelectorAll('li').length));
  check(sizes.join() === '3,2,2', 'as even as possible: ' + sizes);
  check((await texts(p, '.team h3 span')).join() === 'Team 1,Team 2,Team 3', 'number names');

  // players per team
  await p.click('#bySize');
  check((await p.textContent('#stepVal')) === '2', 'per-team default 2');
  check((await p.textContent('#splitHint')).includes('1 team of 3, 2 of 2'), '7 in pairs → 3 teams');
  await p.click('#plus'); await p.click('#plus'); await p.click('#plus');   // 5 per team
  check((await p.textContent('#splitHint')).includes('1 team of 4, 1 of 3'), '7 in fives → 2 teams: ' + await p.textContent('#splitHint'));
  await p.click('#byCount');
  for (let i = 0; i < 4; i++) await p.click('#plus');
  check((await p.textContent('#stepVal')) === '7' && await p.isDisabled('#goBtn') === false, '7 teams of 1 allowed');
  await p.click('#plus');
  check((await p.textContent('#stepVal')) === '8' && await p.isDisabled('#goBtn') && (await p.textContent('#goBtn')).includes('Need at least 8'), '8 teams needs 8 players');
  for (let i = 0; i < 6; i++) await p.click('#minus');
  check((await p.textContent('#stepVal')) === '2' && await p.isDisabled('#minus'), 'min 2 teams');

  // pick someone, no repeats
  await p.click('#tabPick');
  check((await p.textContent('#goBtn')) === 'Pick someone', 'pick tab button');
  check(await p.locator('#result').isHidden(), 'team result not shown on pick tab');
  const all7 = ['Dan', 'Eve', 'Fay', 'Gus', 'Amy', 'Ben', 'Cal'];
  await p.evaluate(() => { window.__q = [2]; });
  await p.click('#goBtn');
  check(await p.locator('.pick.spinning').count() === 1, 'spin animation runs');
  await p.waitForSelector('.pick.revealed');
  check((await p.textContent('.pick .who')) === 'Fay', 'picked index 2 = Fay');
  await p.evaluate(() => { window.__q = [2]; });
  await p.click('#againBtn'); await p.waitForSelector('.pick.revealed');
  check((await p.textContent('.pick .who')) === 'Gus', 'no repeat: Fay skipped, index 2 = Gus');
  await p.uncheck('#noRepeat');
  await p.evaluate(() => { window.__q = [3]; });
  await p.click('#againBtn'); await p.waitForSelector('.pick.revealed');
  check((await p.textContent('.pick .who')) === 'Gus', 'repeats allowed when unticked');
  await p.click('#copyBtn');
  check((await p.evaluate(() => navigator.clipboard.readText())) === '🎯 Picked: Gus', 'copy pick');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/teams-pick.png', fullPage: true });

  // turn order
  await p.click('#tabOrder');
  q = [1, 4, 2, 0, 1, 0];
  await p.evaluate(q => { window.__q = q.slice(); }, q);
  await p.click('#goBtn');
  sh = shuffle(all7, q);
  check((await texts(p, '.order .nm')).join() === sh.join(), 'turn order: ' + (await texts(p, '.order .nm')).join());
  check((await texts(p, '.order .n')).join() === '1,2,3,4,5,6,7', 'numbered');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/teams-order.png', fullPage: true });

  // remembered names updated
  const mem = await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_score_memory')));
  check(['Dan', 'Gus', 'Amy'].every(n => mem.players.includes(n)) && mem.games.includes('Uno'), 'new names remembered');

  // reload keeps everything
  await p.reload();
  check((await texts(p, '#plist .nm')).length === 7 && (await p.getAttribute('#tabOrder', 'aria-selected')) === 'true', 'list and tab kept');
  check((await texts(p, '.order .nm')).join() === sh.join(), 'result kept after reload');

  // remove, clear, add everyone from last time
  await p.click('#plist li:nth-child(1) .x');
  check(!(await texts(p, '#plist .nm')).includes('Dan'), 'removed Dan');
  await p.click('#clearAll');
  check(!(await p.locator('#plist li').count()) && await p.isVisible('#empty'), 'list cleared');
  check(await p.isVisible('#addLast'), 'add-everyone button offered');
  await p.click('#addLast');
  check((await texts(p, '#plist .nm')).length === 6, 'everyone from last time back: ' + (await texts(p, '#plist .nm')).join());

  // layout: no sideways scroll at 360 and 320, dark mode
  for (const w of [360, 320]) {
    await p.setViewportSize({ width: w, height: 760 });
    await p.click('#tabTeams'); await p.click('#goBtn');
    const over = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(!over, 'no horizontal scroll at ' + w);
    if (process.env.SHOTS && w === 320) await p.screenshot({ path: process.env.SHOTS + '/teams-320.png', fullPage: true });
  }
  await p.setViewportSize({ width: 412, height: 915 });
  await p.evaluate(() => localStorage.setItem('pebbly_theme', 'dark')); await p.reload();
  check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(20, 26, 24)', 'dark mode');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/teams-dark.png', fullPage: true });

  check(!p.errs.length, 'page errors: ' + p.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
