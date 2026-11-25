// Little Ones (/littleones/) end to end against a local Postgres (see CLAUDE.md → Testing).
// Setup: sh tests/setup_db.sh littleones; serve the repo root: python3 -m http.server 8793
// Run:   NODE_PATH=$(npm root -g) node tests/littleones_test.js [db] [port] [screenshot dir]
// Covers: create with a password (the partner needs it), due date and week; kick counter; contraction timer (start/stop,
// list, edit strength), 5-1-1 pattern on the page and as a notification for the other phone (not your own), water broke
// alert; lo_sync between two phones and the database rules (bad entries, deleted rows); offline: entries wait on the
// phone and go up when back online; "Baby's here" (birth weight saved), breastfeeding timer (left/right/done), bottle,
// diaper with undo, sleep timer, medicine (next dose), totals, history, editing and deleting; Copy for AI and the doctor
// summary; Baby Names opens the same space (names you both like counted) and links back; screenshots light and dark.
const { chromium, devices } = require('playwright');
const { spawnSync } = require('child_process');
const { phone } = require('./pg_bridge');
const DB = process.argv[2] || 'littleones', PORT = process.argv[3] || '8793', SS = process.argv[4] || '';
const B = 'http://localhost:' + PORT + '/littleones/';
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
const shot = async (p, name) => { if (SS) await p.screenshot({ path: SS + '/' + name + '.png', fullPage: true }); };
const sql = q => { const r = spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', DB, '-At', '-c', q], { encoding: 'utf8' }); if (r.status) console.log(r.stderr); return r.stdout.trim().split('\n').filter(l => l !== 'SET').join('\n'); };
const ents = p => p.evaluate(() => Object.values(__lo.entries()));
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 9000)) { if (await fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };

(async () => {
  const b = await chromium.launch();
  const a = await phone(b, devices, DB, { permissions: ['clipboard-read', 'clipboard-write'] });
  await a.goto(B);

  /* ---- create */
  await a.click('#createForm [type=submit]');
  check((await a.textContent('#formErr')).includes('your name'), 'needs a name');
  const due = new Date(Date.now() + 36 * 864e5), dueS = due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0') + '-' + String(due.getDate()).padStart(2, '0');
  await a.fill('[name=a]', 'Ben'); await a.fill('[name=b]', 'Amy'); await a.fill('[name=due]', dueS); await a.fill('input[name=lockpw]', 'stork');
  await a.click('#createForm [type=submit]');
  await a.waitForSelector('.hero');
  const code = new URL(a.url()).searchParams.get('d');
  check(/^[a-z0-9]{8}$/.test(code), 'created ' + code);
  check((await a.textContent('.sub')).includes('Week 34 + 6') && (await a.textContent('.sub')).includes('36 days to go'), 'week and days to go: ' + await a.textContent('.sub'));
  check((await a.textContent('.hero')).includes('honeydew') || (await a.textContent('.hero')).includes('cantaloupe'), 'size comparison');
  check((await a.textContent('.created')).includes('tell them the password'), 'share card mentions the password');
  await shot(a, 'bump');

  /* ---- kick counter */
  await a.click('[data-act=kick-start]');
  for (let i = 0; i < 10; i++) await a.click('[data-act=kick]');
  check((await a.textContent('.kickbtn')).includes('10 kicks'), 'ten kicks');
  await a.click('[data-act=kick-done]');
  check((await a.textContent('#kicks .tl')).includes('10 kicks in'), 'kick session saved');

  /* ---- partner joins (password) */
  const m = await phone(b, devices, DB);
  await m.goto(B + '?d=' + code);
  await m.waitForSelector('.pl-gate');
  check(!(await m.textContent('body')).includes('Ben'), 'nothing shown before the password');
  await m.fill('.pl-gate input[name=pw]', 'stork'); await m.click('.pl-gate [type=submit]');
  await m.waitForSelector('[data-act=iam][data-slot=b]');
  await m.click('[data-act=iam][data-slot=b]');
  await m.waitForSelector('.hero');
  check(await until(async () => (await ents(m)).some(x => x.k === 'kicks')), 'partner sees the kick count');

  /* ---- contractions */
  await a.click('.tabs [data-v=labor]');
  await a.click('[data-act=ct]');
  await a.waitForTimeout(1200);
  check((await a.textContent('.ctbtn')).includes('Stop'), 'timer running');
  await a.click('[data-act=ct-earlier]');
  await a.click('[data-act=ct]');
  const c1 = (await ents(a)).filter(x => x.k === 'contraction');
  check(c1.length === 1 && c1[0].end - c1[0].at >= 15000, 'contraction saved with the earlier start: ' + JSON.stringify(c1));
  check(await until(() => sql(`select count(*) from notifications where app='little' and type='little.contractions'`) === '1'), 'started-timing notification');
  // the partner's bell gets it, Ben's own doesn't
  const lk = sql(`select key from plan_locks where app='doc' and code='${code}'`);
  const feed = (key, lock) => JSON.parse(sql(`set role anon; select notify_feed('[{"app":"little","code":"${code}","role":"guest","key":"${key}","pid":"${key}","lock":"${lock}"}]')`));
  const apid = await a.evaluate(() => JSON.parse(localStorage.getItem('pebbly_little_pid'))), mpid = await m.evaluate(() => JSON.parse(localStorage.getItem('pebbly_little_pid')));
  check(feed(mpid, lk)[0].items.length === 1 && feed(apid, lk)[0].items.length === 0, 'alert for the partner, not for yourself');
  check(feed(mpid, '')[0].ok === false, 'no feed without the password');
  // strength
  await a.click('#view .tl [data-act=entry]');
  await a.click('dialog .seg span:has-text("Strong")'); await a.click('dialog [type=submit]');
  check((await a.textContent('#view .tl')).includes('strong'), 'strength saved');
  // an hour of contractions 5 minutes apart → 5-1-1
  await a.evaluate(() => { const now = Date.now(); for (let i = 13; i >= 1; i--) { const at = now - i * 5 * 60000; __lo.put({ id: 'ct' + i + 'x' + (now % 1e6), k: 'contraction', at, end: at + 62000, d: {} }); } });
  check(await a.isVisible('.rule.met'), 'page says 5-1-1 reached');
  check(await until(() => sql(`select count(*) from notifications where app='little' and type='little.pattern'`) === '1'), 'pattern notification');
  check(JSON.parse(sql(`select detail from notifications where type='little.pattern'`)).rule === '5-1-1', 'pattern detail');
  await shot(a, 'labor');
  await a.click('[data-act=water]'); await a.click('dialog [type=submit]');
  check(await a.isVisible('.banner.urgent'), 'water broke banner');
  check(await until(() => sql(`select count(*) from notifications where type='little.water'`) === '1'), 'water notification');
  check(await until(async () => (await m.evaluate(() => { const t = document.querySelector('.tabs [data-v=labor]'); t.click(); return document.body.textContent; })).includes('Water broke')), 'partner sees water broke');

  /* ---- database rules */
  const k = lk;
  const bad = sql(`set role anon; select gated_lo_sync('${code}', 0, '[{"id":"BAD!","k":"feed","at":1764000000000}]', 'p', '${k}')`);
  check(bad === '', 'bad id refused');
  check(sql(`set role anon; select gated_lo_sync('${code}', 0, '[]', 'p', 'wrong')`) === '', 'wrong key refused');
  check(sql(`set role anon; select lo_sync('${code}', 0, '[]', 'p')`) === '', 'plain lo_sync not callable');

  /* ---- baby's here */
  await a.click('.tabs [data-v=bump]');
  await a.click('[data-act=born]');
  await a.fill('dialog [name=baby]', 'June'); await a.fill('dialog [name=lb]', '7'); await a.fill('dialog [name=oz]', '8');
  await a.click('dialog [type=submit]');
  await a.waitForSelector('.tiles');
  check((await a.textContent('h1')).includes('June'), 'baby name in the title');
  check((await ents(a)).some(x => x.k === 'growth' && Math.abs(x.d.g - 3402) < 2), 'birth weight saved');
  check(await until(async () => (await m.textContent('h1')).includes('June') && await m.isVisible('.tiles')), 'partner switches to the baby log');

  /* ---- breastfeeding timer */
  await a.click('[data-act=feed]'); await a.click('dialog [data-start=L]');
  await a.waitForSelector('.run .sides');
  await a.waitForTimeout(1100);
  await a.click('[data-act=feed-side][data-side=R]');
  await a.waitForTimeout(1100);
  check(await until(async () => (await m.textContent('#view')).includes('Feeding')), 'partner sees the running feed');
  await a.click('[data-act=feed-done]');
  const fd = (await ents(a)).filter(x => x.k === 'feed')[0];
  check(fd && fd.end && fd.d.l >= 1 && fd.d.r >= 1 && fd.d.last === 'R' && !fd.d.side, 'feed saved with both sides: ' + JSON.stringify(fd));
  check((await a.textContent('.tile.feed')).includes('ended on right'), 'tile shows the side it ended on');

  /* ---- bottle, diaper (undo), sleep, medicine */
  await a.click('[data-act=feed]'); await a.click('dialog .seg span:has-text("Bottle")');
  await a.click('dialog [data-amt="3"]'); await a.click('dialog .seg span:has-text("Formula")'); await a.click('dialog [type=submit]');
  check((await ents(a)).some(x => x.k === 'bottle' && x.d.amt === 3 && x.d.milk === 'formula'), 'bottle saved');
  await a.click('[data-act=diaper]'); await a.click('dialog [data-dp=both]');
  check((await ents(a)).filter(x => x.k === 'diaper').length === 1, 'diaper saved in one tap');
  await a.click('#toast [data-undo]');
  check((await ents(a)).filter(x => x.k === 'diaper').length === 0, 'undo removes it');
  await a.click('[data-act=diaper]'); await a.click('dialog [data-ago="15"]'); await a.click('dialog [data-dp=wet]');
  const dp = (await ents(a)).filter(x => x.k === 'diaper')[0];
  check(dp && Math.abs(Date.now() - 15 * 60000 - dp.at) < 60000 && dp.d.wet && !dp.d.dirty, '"15 min ago" diaper');
  await a.click('[data-act=sleep]'); await a.click('dialog [data-now]');
  check(await a.isVisible('[data-act=wake]'), 'sleep timer');
  await a.waitForTimeout(500);
  await a.click('.run [data-act=wake]');
  check((await ents(a)).some(x => x.k === 'sleep' && x.end), 'woke up');
  await a.click('[data-act=more]'); await a.click('dialog [data-m=med]');
  await a.fill('dialog [name=name]', 'Vitamin D'); await a.fill('dialog [name=dose]', '1 drop'); await a.fill('dialog [name=every]', '24');
  await a.click('dialog [type=submit]');
  check((await a.textContent('#top')).length > 0 && (await a.textContent('#view')).includes('Next dose allowed'), 'next dose shown');
  const tot = await a.evaluate(() => __lo.totals(new Date().setHours(0, 0, 0, 0)));
  check(tot.feeds === 2 && tot.wet === 1 && tot.bottle === 3, 'today totals: ' + JSON.stringify(tot));
  check((await a.textContent('.totals')).includes('1 / 0'), 'wet / dirty shown');
  await shot(a, 'today');

  /* ---- editing and deleting */
  await a.click('#view .tl li:has-text("Vitamin D") [data-act=entry]');
  await a.click('dialog [data-del]');
  check(!(await a.textContent('#view .tl')).includes('Vitamin D'), 'deleted');
  check(await until(() => sql(`select deleted from lo_entries where data='{}'::jsonb and kind='med'`) === 't'), 'deleted on the server (tombstone)');
  check(await until(async () => !(await m.textContent('#view')).includes('Vitamin D')), 'deleted on the partner’s phone');

  /* ---- offline */
  const block = r => r.abort('internetdisconnected');
  await m.context().route('**/rpc/gated_lo_sync', block);
  await m.click('[data-act=diaper]'); await m.click('dialog [data-dp=dirty]');
  await m.waitForTimeout(3500);
  check(Object.keys(await m.evaluate(() => __lo.queue())).length === 1, 'waits on the phone while offline');
  await m.context().unroute('**/rpc/gated_lo_sync', block);
  await m.evaluate(() => __lo.sync());
  check(await until(async () => (await ents(a)).some(x => x.k === 'diaper' && x.d.dirty && x.by === 'b')), 'goes up when back online, logged by Amy');

  /* ---- feed reminders */
  await a.click('[data-act=remind]');
  await a.waitForSelector('#rmPhone .hint, #rmPhone [data-push]');
  await a.selectOption('dialog [name=every]', '1.5'); await a.selectOption('dialog [name=repeat]', '15');
  await a.click('dialog .seg span:has-text("Only at night")'); if (SS) await a.screenshot({ path: SS + '/remind.png' });
  await a.selectOption('dialog [name=from]', '0'); await a.selectOption('dialog [name=to]', '23');
  await a.click('dialog [type=submit]');
  const rm = (await a.evaluate(() => __lo.state())).lo.remind;
  check(rm.on && rm.every === 1.5 && rm.repeat === 15 && rm.night && rm.from === 0 && rm.to === 23 && rm.tz, 'reminder settings saved: ' + JSON.stringify(rm));
  check((await a.textContent('[data-act=remind]')).includes('every 1.5 h'), 'reminder button text');
  check((await a.textContent('.tile.feed')).includes('next'), 'next feed time on the tile');
  await until(() => sql(`select state->'lo'->'remind'->>'every' from plan_docs where code='${code}'`) === '1.5');
  const lastFeed = Number(sql(`select max(at) from lo_entries where kind in ('feed','bottle') and not deleted`));
  const tickAt = ms => sql(`select lo_remind_tick(to_timestamp(${ms} / 1000.0))`);
  check(tickAt(lastFeed + 80 * 60000) === '0', 'not due yet');
  check(tickAt(lastFeed + 91 * 60000) === '1', 'due after 1.5 hours');
  check(tickAt(lastFeed + 95 * 60000) === '0' && tickAt(lastFeed + 107 * 60000) === '1', 'repeats 15 minutes later');
  check(feed(mpid, lk)[0].items.some(x => x.type === 'little.feed_due') && feed(apid, lk)[0].items.some(x => x.type === 'little.feed_due'), 'both phones get it');
  const al = await a.evaluate(() => PebblyNotify.alertView({ type: 'little.feed_due', app: 'little', code: 'x', title: 'June', emoji: '🤱', name: 'June', detail: { n: 1, last: Date.now() } }));
  check(al.body.startsWith('🍼 Time to feed June') && al.urgent, 'alert wording: ' + al.body);
  sql(`set role anon; select notify_set_off('[{"app":"little","code":"${code}","role":"guest","key":"${apid}","lock":"${lk}","off":["little.feed_due"]}]')`);
  check(!feed(apid, lk)[0].items.some(x => x.type === 'little.feed_due'), 'a phone can turn them off for itself');
  await a.click('[data-act=feed]'); await a.click('dialog .seg span:has-text("Bottle")'); await a.click('dialog [data-amt="2"]'); await a.click('dialog [type=submit]');
  check(await until(() => sql(`select count(*) from notifications where type='little.feed_due'`) === '0'), 'a new feed clears waiting reminders');

  /* ---- night alarm */
  await a.click('[data-act=night]');
  check(await a.isVisible('#night') && (await a.textContent('#night')).includes('Alarm at'), 'night alarm screen');
  const at1 = (await a.evaluate(() => __lo.alarm())).at.at;
  await a.click('#night [data-na="+15"]');
  check((await a.evaluate(() => __lo.alarm())).at.at - at1 === 15 * 60000, '+15 min moves the alarm');
  // every recent feed moves back, so the latest one is due in 2.5 s
  await a.evaluate(() => Object.values(__lo.entries()).filter(x => (x.k === 'bottle' || x.k === 'feed') && x.at > Date.now() - 3 * 3600000)
    .forEach((x, i) => { x.at = Date.now() - 90 * 60000 + 2500 - i * 60000; if (x.end) x.end = x.at + 60000; __lo.put(x); }));
  check(await until(async () => (await a.evaluate(() => __lo.alarm())).ringing, 8000), 'rings when it’s time');
  check(await a.evaluate(() => document.getElementById('night').className === 'ring' && !!document.querySelector('#night .nup')), 'ringing screen with “I’m up”');
  await shot(a, 'night-ring');
  await a.click('#night [data-na=snooze]');
  const sn = await a.evaluate(() => __lo.alarm());
  check(!sn.ringing && sn.at.at > Date.now() + 4 * 60000, 'snooze 5 minutes');
  await a.evaluate(() => __lo.put({ id: 'nightfeed2', k: 'bottle', at: Date.now() - 90 * 60000 + 1500, d: { amt: 2, unit: 'oz', milk: 'breast' } }));
  check(await until(async () => (await a.evaluate(() => __lo.alarm())).ringing, 8000), 'a new feed sets a new alarm (rings again)');
  await m.evaluate(() => __lo.put({ id: 'nightfeed3', k: 'bottle', at: Date.now(), d: { amt: 3, unit: 'oz', milk: 'breast' } }));
  check(await until(async () => !(await a.evaluate(() => __lo.alarm())).ringing, 9000), 'stops when the other phone logs a feed');
  await a.click('#night [data-na=off]');
  check(!(await a.isVisible('#night')), 'turned off');

  /* ---- history, AI, doctor */
  await a.click('.tabs [data-v=history]');
  check((await a.textContent('.days')).includes('Today'), 'history table');
  const ai = await a.evaluate(() => __lo.aiPrompt('naps'));
  check(ai.includes('predict the times of the next naps') && ai.includes('Baby: June') && /Slept|Asleep/.test(ai) && ai.includes('Daily totals'), 'AI prompt: ' + ai.slice(0, 200));
  const lab = await a.evaluate(() => __lo.aiPrompt('labor', null, 1));
  check(lab.includes('Contraction 1 min') || lab.includes('(62 s)'), 'labor prompt lists contractions');
  await a.click('[data-act=ai]'); await a.click('dialog [type=submit]');
  const clip = await a.evaluate(() => navigator.clipboard.readText());
  check(clip.includes('Here is the log'), 'copied for AI');
  check((await a.evaluate(() => __lo.doctorText())).includes('June'), 'doctor summary');
  await shot(a, 'history');

  /* ---- Baby Names is the same space */
  sql(`update plan_docs set state = jsonb_set(jsonb_set(state, '{votes,a}', '{"ada":4,"iris":2}'), '{votes,b}', '{"ada":5,"iris":0}') where code='${code}'`);
  await a.reload(); await a.waitForSelector('.tabs');
  await a.click('.tabs [data-v=names]');
  check((await a.textContent('#view')).includes('1 name you both like'), 'names count from Baby Names');
  await a.click('text=Open Baby Names');
  await a.waitForSelector('text=← Little Ones');
  check(a.url().includes('/babynames/?d=' + code), 'opens Baby Names');
  await a.click('text=← Little Ones'); await a.waitForSelector('.tabs [data-v=names][aria-selected=true]');
  check(true, 'back to Little Ones');

  /* ---- dark mode, narrow */
  await a.emulateMedia({ colorScheme: 'dark' });
  await a.click('.tabs [data-v=today]');
  await shot(a, 'today-dark');
  await a.setViewportSize({ width: 360, height: 780 });
  const wide = await a.evaluate(() => document.documentElement.scrollWidth);
  check(wide <= 360, 'no sideways scroll at 360px (' + wide + ')');
  await shot(a, 'today-360');

  const errs = a.errs.concat(m.errs);
  check(!errs.length, 'page errors: ' + errs.join(' | '));
  await b.close();
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
