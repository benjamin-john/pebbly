// Homepage "Yours" section: every event, list and map this phone has (from each app's saved list), newest opened first,
// with host tags; ✕ removes one (with Undo) and it stays removed after a reload, until it's opened again (nav.js notes
// opens on every app page); "Show all"; hidden when there's nothing; the "Yours" home-screen shortcut (/#mine).
// Run: python3 -m http.server 8798 (repo root), then NODE_PATH=$(npm root -g) node tests/home_test.js   (SHOTS=<dir> for screenshots)
const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path');
const B = 'http://localhost:' + (process.env.PORT || 8798), SHOTS = process.env.SHOTS;
let pass = 0, fail = 0;
const check = (ok, m) => { if (ok) pass++; else { fail++; console.log('FAIL', m); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' });
  await ctx.route('https://xujtuijpbwujduuzlwat.supabase.co/**', r => r.abort());
  await ctx.route('**fonts.g*/**', r => r.abort());
  await ctx.route('https://static.cloudflareinsights.com/**', r => r.abort());
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  const titles = () => p.$$eval('#minelist .t', e => e.map(x => x.textContent));

  await p.goto(B + '/');
  check(await p.isHidden('#mine'), 'nothing saved: no "Yours" section');
  const now = Date.now();
  await p.evaluate(now => {
    const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    set('rsvp.recent', [{ code: 'abc123', title: 'Birthday party', emoji: '🎂' }]);
    set('rsvp.owners', { abc123: 'tok' });
    set('pick.recent', [{ code: 'p1', name: 'Lunch spot' }, { code: 'p2', name: 'Movie night' }]);
    set('meetup.recent', [{ code: 'w1', name: 'Cabin weekend' }]);
    set('pebbly_list_recent', [{ code: 'l1', title: 'Groceries', emoji: '🥕', at: now - 1000 }]);
    set('pebbly_basecamp_recent', [{ code: 'm1', name: 'Deer camp', at: now - 5000 }]);
    set('pebbly_santa_recent', [{ code: 'g1', name: 'Family swap' }]);
    set('pebbly_basecamp_owners', { m1: 'tok' });
  }, now);
  await p.reload();
  check(await p.isVisible('#mine'), '"Yours" section shows');
  let t = await titles();
  check(t[0] === 'Groceries' && t[1] === 'Deer camp' && t[2] === 'Birthday party', 'newest opened first, then each app’s own order: ' + t.join(', '));
  check(t.length === 6 && /Show all 7/.test(await p.textContent('#mineall')), 'first 6, with "Show all 7"');
  await p.click('#mineall');
  check((await titles()).length === 7, 'Show all');
  check(await p.getAttribute('#minelist li:nth-child(2) a', 'href') === '/basecamp/?m=m1', 'links to the map');
  check(/Basecamp/.test(await p.textContent('#minelist li:nth-child(2)')) && /host/.test(await p.textContent('#minelist li:nth-child(2)')), 'app name and host tag');
  check(!/host/.test(await p.textContent('#minelist li:nth-child(1)')), 'no host tag where you’re a guest');
  if (SHOTS) { await p.screenshot({ path: SHOTS + '/home-mine.png', fullPage: true }); }

  // remove (with Undo), stays removed after a reload
  await p.click('[data-hide="basecamp:m1"]');
  check(!(await titles()).includes('Deer camp') && /Removed “Deer camp”/.test(await p.textContent('#mineundo')), 'removed, with Undo');
  await p.click('#mineundob');
  check((await titles()).includes('Deer camp') && await p.isHidden('#mineundo'), 'Undo brings it back');
  await p.click('[data-hide="basecamp:m1"]');
  await p.reload();
  check(!(await titles()).includes('Deer camp'), 'stays removed after a reload');
  check(await p.evaluate(() => JSON.parse(localStorage.getItem('pebbly_basecamp_recent')).length === 1), 'the app’s own list is untouched');

  // opening it again brings it back, at the top
  await p.goto(B + '/basecamp/?m=m1');
  await p.waitForTimeout(500);
  await p.goto(B + '/');
  t = await titles();
  check(t[0] === 'Deer camp', 'opened again: back, at the top: ' + t.slice(0, 3).join(', '));
  await p.goto(B + '/rsvp/?e=ABC123');
  await p.waitForTimeout(500);
  await p.goto(B + '/');
  check((await titles())[0] === 'Birthday party', 'opening an RSVP moves it to the top (code case doesn’t matter)');

  // the home-screen shortcut
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.webmanifest'), 'utf8'));
  check(man.shortcuts[0].url === '/#mine' && man.shortcuts[0].name === 'Yours', 'home-screen shortcut "Yours" first');
  await p.goto(B + '/#mine');
  check(await p.evaluate(() => { const r = document.getElementById('mine').getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight; }), '/#mine shows the section');

  // dark mode look
  await p.emulateMedia({ colorScheme: 'dark' });
  if (SHOTS) await p.screenshot({ path: SHOTS + '/home-mine-dark.png' });

  check(!errs.length, 'page errors: ' + errs.join(' | '));
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
