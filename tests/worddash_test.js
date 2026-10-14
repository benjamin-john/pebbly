// Word Dash (/worddash/): word lists, clue colors (repeated letters), practice mode (typing on the
// on-screen and a real keyboard, not-a-word, win, lose, give up, stats, next word), and a 3-phone
// race against a local Postgres (no turns, rivals' colors live, first to solve wins even if another
// phone solves a moment later, running out, next word for everyone, joining mid-race).
// Setup: sh tests/setup_db.sh agent_g; serve the repo root on port 8791 (python3 -m http.server 8791), then:
//   NODE_PATH=$(npm root -g) node tests/worddash_test.js        (SHOTS=<folder> to save screenshots)
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
  await p.context().addInitScript(() => { window.__vib = 0; navigator.vibrate = () => { window.__vib++; return true; }; });
  return p;
}
async function waitFor(p, fn, arg, ms) { try { await p.waitForFunction(fn, arg, { timeout: ms || 8000 }); return true; } catch (e) { return false; } }
async function tapWord(p, w) { for (const ch of w) await p.click('.k[data-k="' + ch + '"]'); await p.click('.k[data-k="enter"]'); }
async function typeWord(p, w) { await p.keyboard.type(w); await p.keyboard.press('Enter'); }
const word = p => p.evaluate(() => window.__wd.word());
// A real word that isn't the answer and shares no letter with it, when possible.
const wrong = (p, avoid) => p.evaluate(a => window.__wd.ANSWERS.find(x => x !== a && ![...x].some(c => a.includes(c))) || window.__wd.ANSWERS.find(x => x !== a), avoid);

(async () => {
  const browser = await chromium.launch();
  const p = await mk(browser);
  await p.goto(B + '/worddash/');
  await p.evaluate(() => localStorage.clear()); await p.reload();

  /* ---------------- words and clues */
  const info = await p.evaluate(() => {
    const W = window.__wd, a = W.ANSWERS;
    return { n: a.length, allValid: a.every(W.isValid), five: a.every(w => /^[a-z]{5}$/.test(w)), uniq: new Set(a).size === a.length,
      bad: ['zzzzz', 'abcde', 'crane'].map(W.isValid), noPlural: !a.includes('women') && !a.includes('years'),
      c1: W.clue('speed', 'abide').join(''), c2: W.clue('eerie', 'there').join(''), c3: W.clue('crane', 'crane').join(''), c4: W.clue('allee', 'apple').join('') };
  });
  check(info.n > 1000 && info.allValid && info.five && info.uniq, 'answers: ' + info.n + ', all valid words');
  check(info.bad.join() === 'false,false,true', 'only real words accepted');
  check(info.noPlural, 'no plurals as answers');
  check(info.c1 === 'mmnmn' && info.c2 === 'nmnmh' && info.c3 === 'hhhhh' && info.c4 === 'hnmmh', 'clues with repeated letters: ' + [info.c1, info.c2, info.c3, info.c4].join(' '));

  /* ---------------- practice */
  check(await p.isVisible('#setup') && await p.isHidden('#nameOpt'), 'setup, practice by default');
  await shot(p, 'wd-setup', true);
  await p.click('#startBtn');
  check(await p.isVisible('#kb') && await p.locator('.grow').count() === 6, 'six rows and a keyboard');
  let w = await word(p);
  await typeWord(p, 'zzzzz');
  check((await p.textContent('#status')).includes('Not in the word list'), 'not a word refused');
  await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace');
  const w1 = await wrong(p, w);
  await p.evaluate(() => { window.__vib = 0; });
  await tapWord(p, w1);
  check(await p.evaluate(() => window.__vib) === 0, 'no vibration while typing or on an ordinary guess');
  check(await p.locator('.grow:first-child .tile.m').count() === 5, 'first guess: all gray (' + w1 + ' vs ' + w + ')');
  check(await p.locator('.k.m').count() === new Set(w1).size, 'keyboard grays the used letters');
  await shot(p, 'wd-solo');
  await typeWord(p, w);
  await p.waitForSelector('#endDlg[open]', { timeout: 5000 });
  check((await p.textContent('#endWord')) === w && (await p.textContent('#endBody')).includes('played'), 'win: word + stats');
  let st = await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_worddash_stats')));
  check(st.played === 1 && st.won === 1 && st.dist[1] === 1 && st.streak === 1, 'stats: won in 2');
  await shot(p, 'wd-solo-win');
  await p.click('#endNext');
  const w2 = await word(p);
  check(w2 !== w && await p.locator('.tile.m, .tile.h, .tile.n').count() === 0, 'next word, empty board');
  // lose
  const x = await wrong(p, w2);
  for (let i = 0; i < 6; i++) await typeWord(p, x);
  await p.waitForSelector('#endDlg[open]', { timeout: 5000 });
  check((await p.textContent('#endTitle')).includes('Not this time') && (await p.textContent('#endWord')) === w2, 'six misses: lost, word shown');
  st = await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_worddash_stats')));
  check(st.played === 2 && st.won === 1 && st.streak === 0 && st.best === 1, 'stats after a loss');
  await p.click('#endNext');
  await p.click('#menuBtn'); await p.click('#mGiveUp');
  await p.waitForSelector('#endDlg[open]', { timeout: 5000 });
  st = await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_worddash_stats')));
  check(st.played === 3, 'give up counts as played');
  await p.click('#endDlg [data-close]');
  check(await p.isVisible('[data-a=next]') && await p.isHidden('#kb'), 'after the word: Next word button, keyboard hidden');
  await p.evaluate(() => localStorage.setItem('pebbly_theme', 'dark')); await p.reload();
  await p.click('[data-a=next]');
  await typeWord(p, 'crane'); await typeWord(p, 'moist');
  check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(20, 26, 24)', 'dark mode');
  // letters not in the word stand out from unused keys (clearly darker in dark mode)
  const lum = await p.evaluate(() => { const L = el => { const m = getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
    return [L(document.querySelector('.k.m')), L(document.querySelector('.k:not(.m):not(.h):not(.n):not(.wide)'))]; });
  check(lum[1] - lum[0] > 50, 'dark mode: wrong letters greyed out (' + lum.map(Math.round) + ')');
  await shot(p, 'wd-dark');
  await p.evaluate(() => localStorage.removeItem('pebbly_theme'));
  // small phone: everything fits without scrolling
  await p.setViewportSize({ width: 360, height: 640 }); await p.reload();
  check(await p.evaluate(() => document.documentElement.scrollWidth <= 360 && document.getElementById('kb').getBoundingClientRect().bottom <= innerHeight + 1), 'fits a 360 × 640 screen');
  await shot(p, 'wd-small');

  /* ---------------- race */
  const h = await mk(browser), a = await mk(browser), z = await mk(browser);
  await h.goto(B + '/worddash/');
  await h.click('.mode:has(input[value=race])');
  check(await h.isVisible('#nameOpt') && await h.isDisabled('#startBtn'), 'race needs a name');
  await h.fill('#myName', 'Hal');
  await h.click('#startBtn');
  await h.waitForSelector('.ps-code');
  const code = (await h.textContent('.ps-code')).trim();
  await h.click('.ps-dlg [data-ps-close]');
  for (const [ph, nm] of [[a, 'Amy']]) {
    await ph.goto(B + '/worddash/?join=' + code);
    await ph.waitForSelector('#psName'); await ph.fill('#psName', nm); await ph.click('#psJoinGo');
    await ph.waitForSelector('#play:not([hidden])');
  }
  check(await waitFor(h, () => window.__wd.game().players.length === 2 && document.querySelectorAll('.rival').length === 1), 'host sees Amy');
  const rw = await word(h);
  check(await word(a) === rw, 'same word on both phones');
  // no turns: both guess straight away
  const g1 = await wrong(h, rw);
  await typeWord(h, g1); await typeWord(a, g1); await typeWord(a, 'crane');
  check(await waitFor(h, () => document.querySelectorAll('.rival .mini i.m, .rival .mini i.h, .rival .mini i.n').length === 10), 'host sees Amy’s two rows (colors only)');
  check(!(await h.textContent('#rivals')).toLowerCase().includes('crane'), 'never her letters');
  await shot(h, 'wd-race');
  // Amy solves first, Hal a moment later (before he's seen it): Amy still wins
  await typeWord(a, rw);
  await h.evaluate(() => { const g = window.__wd.game(); });
  await typeWord(h, rw);
  check(await waitFor(h, () => document.getElementById('endDlg').open && document.getElementById('endTitle').textContent.includes('Amy won')), 'Amy solved first: Amy wins on Hal’s phone');
  check(await waitFor(a, () => document.getElementById('endDlg').open && document.getElementById('endTitle').textContent.includes('You won')), 'Amy sees she won');
  await shot(a, 'wd-race-end');
  // Zed joins mid-game, next word for everyone
  await z.goto(B + '/worddash/?join=' + code);
  await z.waitForSelector('#psName'); await z.fill('#psName', 'Zed'); await z.click('#psJoinGo');
  await z.waitForSelector('#play:not([hidden])');
  await a.click('#endNext');
  check(await waitFor(h, () => window.__wd.game().round === 2 && !document.getElementById('endDlg').open), 'next word reaches Hal (dialog closes)');
  check(await waitFor(z, () => window.__wd.game().round === 2 && !document.getElementById('kb').hidden), 'Zed plays the new word');
  const r2 = await word(h);
  check(r2 !== rw && await word(z) === r2, 'new word, same everywhere');
  check(await h.evaluate(() => window.__wd.game().results[1]) === await a.evaluate(() => window.__wd.game().players[1].id), 'round 1 recorded for Amy');
  check(await waitFor(h, () => [...document.querySelectorAll('.rival')].some(r => r.textContent.includes('Amy') && r.querySelector('b').textContent === '1')), 'Amy shows 1 win');
  // everyone runs out: nobody wins
  const m2 = await wrong(h, r2);
  for (const ph of [h, a, z]) for (let i = 0; i < 6; i++) await typeWord(ph, m2);
  check(await waitFor(z, () => document.getElementById('endDlg').open && document.getElementById('endTitle').textContent.includes('Nobody')), 'all out: nobody wins');

  for (const x of [p, h, a, z]) check(!x.errs.length, 'page errors: ' + x.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
