// Game Timer (/timer/): turn timer (time bank and per turn), countdown, buzzer, accuracy, layout.
// Uses Playwright's fake clock (page.clock), and stubs for Web Audio, vibration and wake lock.
// Serve the repo root on port 8784 (python3 -m http.server 8784), then:
//   NODE_PATH=$(npm root -g) node tests/timer_test.js        (SHOTS=<folder> to save screenshots)
const { chromium, devices } = require('playwright');
const B = 'http://localhost:' + (process.env.PORT || 8784);
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }

async function mk(browser) {
  const c = await browser.newContext({ ...devices['Pixel 7'] });
  await c.route('**fonts.g*/**', r => r.abort());
  await c.route('**cloudflareinsights**', r => r.abort());
  await c.addInitScript(() => {
    window.__tones = 0; window.__vib = []; window.__wake = 0;
    navigator.vibrate = p => { window.__vib.push(p); return true; };
    const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} };
    window.AudioContext = function () {
      return { state: 'running', currentTime: 0, destination: {}, resume: () => Promise.resolve(),
        createOscillator: () => ({ type: '', frequency: param, connect() {}, start() { window.__tones++; }, stop() {} }),
        createGain: () => ({ gain: param, connect() {} }) };
    };
    Object.defineProperty(navigator, 'wakeLock', { value: { request: () => { window.__wake++; return Promise.resolve({ addEventListener() {}, release: () => Promise.resolve() }); } } });
  });
  const p = await c.newPage(); p.errs = [];
  p.on('pageerror', e => p.errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.clock.install({ time: new Date('2026-10-12T10:00:00Z') });
  await p.clock.pauseAt(new Date('2026-10-12T10:00:01Z'));   // time only moves when the test says so
  return p;
}
const T = p => p.textContent('#sTime');
const cls = p => p.getAttribute('#stage', 'class');

(async () => {
  const browser = await chromium.launch();
  const p = await mk(browser);
  await p.goto(B + '/timer/');
  await p.evaluate(() => localStorage.setItem('pebbly_score_memory', JSON.stringify({ players: ['Amy', 'Ben'], games: [] })));
  await p.reload();
  check(await p.isVisible('#setup') && (await p.getAttribute('#tabTurn', 'aria-selected')) === 'true', 'setup shows turn timer');
  check(await p.isDisabled('#startBtn'), 'needs 2 players');
  await p.click('#chips .add:text-is("Amy")'); await p.click('#chips .add:text-is("Ben")');
  await p.fill('#newName', 'Cal'); await p.press('#newName', 'Enter');
  await p.click('#plist li:nth-child(3) [data-mv="-1"]');   // Cal up to 2nd
  check((await p.$$eval('#plist input', i => i.map(x => x.value))).join() === 'Amy,Cal,Ben', 'reorder');
  await p.click('#plist li:nth-child(2) [data-mv="1"]');
  await p.click('#clkBank');
  await p.click('#turnPresets [data-s="60"]');
  check((await p.inputValue('#tMin')) === '1' && (await p.inputValue('#tSec')) === '0', 'preset fills custom');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/timer-setup.png', fullPage: true });
  await p.click('#startBtn');
  check(await p.isVisible('#play') && (await T(p)) === '1:00', 'play view, 1:00');
  check((await p.textContent('#sStatus')).includes('Tap to start Amy'), 'waits for first tap');
  await p.clock.runFor(3000);
  check((await T(p)) === '1:00', 'not running before first tap');
  check(await p.evaluate(() => window.__wake) > 0, 'screen kept awake');

  // run, next, back
  await p.click('#stage');
  await p.clock.runFor(5000);
  check((await T(p)) === '0:55', 'Amy 0:55: ' + await T(p));
  await p.click('#stage');   // end Amy's turn
  check((await p.textContent('#sWho')) === 'Ben', 'Ben now');
  await p.clock.runFor(3000);
  check((await T(p)) === '0:57', 'Ben 0:57');
  check((await p.textContent('#strip button:nth-child(1) span')) === '0:55', 'strip shows Amy 0:55');
  await p.click('#prevBtn');
  check((await p.textContent('#sWho')) === 'Amy' && (await T(p)) === '0:55', 'back to Amy at 0:55');
  check((await p.textContent('#strip button:nth-child(2) span')) === '1:00', 'Ben refunded to 1:00');
  await p.clock.runFor(2000);
  check((await T(p)) === '0:53', 'Amy keeps running after back');

  // pause
  await p.click('#pauseBtn');
  await p.clock.runFor(10000);
  check((await T(p)) === '0:53' && (await p.textContent('#sStatus')).includes('Paused'), 'paused holds');
  await p.click('#stage');
  check((await cls(p)).includes('running'), 'tap resumes when paused');

  // a jump in time without ticks (phone in a pocket): computed from timestamps
  await p.clock.fastForward(40000);
  check((await T(p)) === '0:13', 'accurate after background jump: ' + await T(p));
  await p.clock.runFor(4000);
  check((await cls(p)).includes('warn') && (await T(p)) === '0:09', 'warning in last 10 s');
  const tones0 = await p.evaluate(() => window.__tones);
  await p.clock.runFor(10000);
  check((await cls(p)).includes('up'), 'out of time state');
  check((await T(p)) === '−0:01', 'overtime shown: ' + await T(p));
  check((await p.textContent('#sStatus')).includes('Out of time'), 'out of time words');
  check(await p.evaluate(() => window.__vib.some(v => Array.isArray(v) && v.length === 5)), 'vibrated');
  check(await p.evaluate(() => window.__tones) >= tones0 + 6, 'buzzer and ticks played');
  const vibs = await p.evaluate(() => window.__vib.length);
  await p.clock.runFor(5000);
  check(await p.evaluate(() => window.__vib.filter(v => Array.isArray(v)).length) === 1, 'buzzer only once');
  check((await p.textContent('#strip button:nth-child(1)')).includes('⏰'), 'flagged in strip');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/timer-up.png' });
  await p.click('#nextBtn');
  check((await p.textContent('#sWho')) === 'Ben' && !(await cls(p)).includes('up'), 'game continues with Ben');
  await p.clock.runFor(1000);
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/timer-turn.png' });
  // tap a name in the strip to switch
  await p.click('#strip button:nth-child(3)');
  check((await p.textContent('#sWho')) === 'Cal', 'switch by tapping a name');

  // pause, reload: state kept
  await p.click('#pauseBtn');
  const before = await p.$$eval('#strip span', s => s.map(x => x.textContent).join());
  await p.reload();
  check(await p.isVisible('#play') && (await p.textContent('#sWho')) === 'Cal', 'reload returns to timer');
  check((await p.$$eval('#strip span', s => s.map(x => x.textContent).join())) === before, 'times kept after reload: ' + before);

  // restart all clocks
  await p.click('#menuBtn'); await p.click('#mRestart');
  check((await p.$$eval('#strip span', s => s.map(x => x.textContent).join())) === '1:00,1:00,1:00' && (await p.textContent('#sWho')) === 'Amy', 'restart');

  // per turn
  await p.click('#menuBtn'); await p.click('#mSetup');
  check(await p.isVisible('#setup') && (await p.$$eval('#plist input', i => i.map(x => x.value))).join() === 'Amy,Ben,Cal', 'setup keeps players');
  await p.click('#clkTurn'); await p.click('#turnPresets [data-s="15"]');
  await p.click('#startBtn');
  check((await T(p)) === '0:15', 'per turn 0:15');
  await p.click('#stage'); await p.clock.runFor(7000);
  await p.click('#stage');
  check((await p.textContent('#sWho')) === 'Ben' && (await T(p)) === '0:15', 'next player starts fresh');
  await p.clock.runFor(16000);
  check((await cls(p)).includes('up') && (await T(p)) === '0:00' && (await p.textContent('#sStatus')).includes('Time’s up'), 'per-turn time up');
  check(await p.evaluate(() => window.__vib.filter(v => Array.isArray(v)).length) === 1, 'buzzed for per-turn (count restarts after reload)');
  await p.click('#stage');
  check((await p.textContent('#sWho')) === 'Cal' && (await T(p)) === '0:15' && !(await cls(p)).includes('up'), 'tap moves on after time up');
  await p.click('#prevBtn');
  check((await p.textContent('#sWho')) === 'Ben' && (await T(p)) === '0:00', 'back restores Ben at 0:00');

  // countdown
  await p.click('#menuBtn'); await p.click('#mSetup');
  await p.click('#tabCd');
  await p.fill('#cMin', '2'); await p.fill('#cSec', '5');
  check((await p.textContent('#startBtn')).includes('2 min 5 s'), 'custom time: ' + await p.textContent('#startBtn'));
  await p.click('#cdPresets [data-s="30"]');
  await p.click('#startBtn');
  check(await p.isVisible('#cdCtl') && await p.isHidden('#strip'), 'countdown view');
  await p.clock.runFor(10000);
  check((await T(p)) === '0:20', 'countdown 0:20: ' + await T(p));
  await p.click('#plusBtn');
  check((await T(p)) === '0:50', '+30 s while running');
  await p.click('#cdGoBtn'); await p.clock.runFor(5000);
  check((await T(p)) === '0:50' && (await p.textContent('#cdGoBtn')) === 'Resume', 'countdown paused');
  await p.click('#resetBtn');
  check((await T(p)) === '0:30' && (await p.textContent('#cdGoBtn')) === 'Start', 'reset');
  await p.click('#stage'); await p.clock.runFor(31000);
  check((await cls(p)).includes('up') && (await p.textContent('#sWho')) === 'Time’s up!' && (await T(p)) === '0:00', 'countdown time up');
  check(await p.evaluate(() => window.__vib.filter(v => Array.isArray(v)).length) === 2, 'countdown buzzer');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/timer-cd-up.png' });
  await p.click('#plusBtn');
  await p.clock.runFor(2000);
  check((await T(p)) === '0:28' && (await cls(p)).includes('running'), '+30 s after time up restarts');
  await p.click('#resetBtn');
  await p.reload();
  check(await p.isVisible('#cdCtl') && (await T(p)) === '0:30', 'countdown kept after reload');
  const prefs = await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_timer_prefs')));
  check(prefs.cd === 30000 && prefs.turn === 15000 && prefs.bank === 60000 && prefs.clock === 'turn', 'settings remembered');

  // layout: play view fits the screen, also with the Pebbly bar, at 320 wide; dark
  for (const [w, h, q] of [[412, 839, ''], [320, 560, '?appnav'], [360, 640, '?appnav']]) {
    await p.setViewportSize({ width: w, height: h });
    await p.goto(B + '/timer/' + q);
    await p.click('#menuBtn'); await p.click('#mSetup'); await p.click('#tabTurn'); await p.click('#clkBank');
    for (const n of ['Dee', 'Eli', 'Fin', 'Gus', 'Hal']) if (await p.isVisible('#newName')) { await p.fill('#newName', n); await p.press('#newName', 'Enter'); }
    const over = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(!over, 'setup no sideways scroll at ' + w);
    await p.click('#startBtn');
    await p.click('#stage'); await p.clock.runFor(1500);
    const fit = await p.evaluate(() => { const r = document.getElementById('strip').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth; });
    check(fit, 'play view fits ' + w + 'x' + h + q);
    if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + `/timer-${w}${q ? '-nav' : ''}.png` });
  }
  await p.evaluate(() => localStorage.setItem('pebbly_theme', 'dark'));
  await p.setViewportSize({ width: 412, height: 839 }); await p.reload();
  await p.clock.runFor(60000);
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/timer-dark-warn.png' });
  await p.click('#menuBtn'); await p.click('#mSetup');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/timer-dark-setup.png', fullPage: true });
  check(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(20, 26, 24)', 'dark mode');

  check(!p.errs.length, 'page errors: ' + p.errs.join());
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
