// Backup & restore (/backup/, backup.js) end to end against a local Postgres (see CLAUDE.md → Testing).
//   sh tests/setup_db.sh backup && sh tests/setup_db.sh backup_old nomigrations
//   python3 -m http.server 8797        (from the repo root)
//   NODE_PATH=$(npm root -g) node tests/backup_test.js      (SHOTS=1 also saves screenshots to /tmp/backup_*.png)
const { chromium, devices } = require('playwright');
const { spawnSync } = require('child_process');
const { rpc, phone } = require('./pg_bridge');
const B = 'http://localhost:8797', DB = 'backup';
let pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }
function sql(q) { return spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', DB, '-At', '-c', q], { encoding: 'utf8' }).stdout.trim(); }
const ok = (fn, a) => rpc(DB, fn, a).status === 200, err = (fn, a) => (rpc(DB, fn, a).body.match(/"message":"([a-z_]+)/) || [])[1];
const ls = (p, k) => p.evaluate(k => localStorage.getItem(k), k);
// stored the way the apps store them: JSON (the theme is plain text)
const setLs = (p, o) => p.evaluate(o => Object.keys(o).forEach(k => localStorage.setItem(k, k === 'pebbly_theme' ? o[k] : JSON.stringify(o[k]))), o);
const toast = p => p.waitForFunction(() => document.querySelector('.toast.show')).then(() => p.textContent('#toast'));

(async () => {
  /* ---------------- database rules */
  const id = 'a'.repeat(64);
  check(err('backup_put', { p_id: 'nothex', p_blob: 'QUJD', p_version: 0 }) === 'invalid_backup', 'bad id refused');
  check(err('backup_put', { p_id: id, p_blob: 'not base64!', p_version: 0 }) === 'backup_too_big', 'junk blob refused');
  check(ok('backup_put', { p_id: id, p_blob: 'QUJD', p_version: 0 }) && err('backup_put', { p_id: id, p_blob: 'QUJD', p_version: 0 }) === 'backup_conflict', 'a new backup can’t be made twice');
  check(rpc(DB, 'backup_put', { p_id: id, p_blob: 'REVG', p_version: 1 }).body === '2' && err('backup_put', { p_id: id, p_blob: 'R0hJ', p_version: 1 }) === 'backup_conflict', 'saving needs the latest version');
  check(JSON.parse(rpc(DB, 'backup_get', { p_id: id }).body).blob === 'REVG', 'get returns the latest');
  check(ok('backup_delete', { p_id: id }) && rpc(DB, 'backup_get', { p_id: id }).body === 'null', 'delete');
  check(/permission denied/.test(spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', DB, '-c', 'set role anon; select * from backups'], { encoding: 'utf8' }).stderr), 'phones can’t read the table');

  const browser = await chromium.launch();
  const mk = async (db) => { const p = await phone(browser, devices, db || DB, { permissions: ['clipboard-read', 'clipboard-write'] }); return p; };

  /* ---------------- phone A makes a backup */
  const a = await mk();
  await a.goto(B + '/');
  await setLs(a, {
    'rsvp.owners': { abcd1234: 'hosttokenAAAA' }, 'rsvp.pid': 'pidA-123', 'rsvp.first': 'Ben', 'rsvp.recent': [{ code: 'abcd1234', title: 'Party' }],
    'pebbly_doc_owners': { bill1: 'billtoken' }, 'pebbly_score_memory': { players: ['Amy', 'Ben'], games: [] }, 'pebbly_theme': 'light',
    'pebbly_farkle': { inprogress: true }, 'pebbly_farkle_undo': [1, 2], 'pebbly_push': { on: true }, 'rsvp.local.db': { x: 1 }, 'pebbly_lock_keys': { 'rsvp:abcd1234': 'lockkey' }
  });
  await a.reload();
  check(await a.isVisible('#bknote'), 'homepage suggests a backup to a host');
  await a.click('#bknote a');
  await a.waitForSelector('[data-act=create]');
  check(/2 host links/.test(await a.textContent('#mine')), 'counts host links');
  await a.click('[data-act=create]');
  await a.waitForSelector('.words li');
  const words = await a.$$eval('.words li', l => l.map(x => x.textContent));
  check(words.length === 6 && words.every(w => /^[a-z]{3,8}$/.test(w)), 'six words: ' + words.join(' '));
  check(await a.evaluate(w => w.every(x => PebblyBackup.WORDS.includes(x)), words), 'words from the list');
  if (process.env.SHOTS) { await a.screenshot({ path: '/tmp/backup_words.png', fullPage: true }); await a.emulateMedia({ colorScheme: 'dark' }); await a.screenshot({ path: '/tmp/backup_words_dark.png', fullPage: true }); await a.emulateMedia({ colorScheme: 'light' }); }
  await a.click('[data-act=copy]');
  check(await a.evaluate(() => navigator.clipboard.readText()) === words.join(' '), 'copy puts the words on the clipboard');
  check(sql('select count(*) from backups') === '1', 'backup saved');
  const blob = sql('select blob from backups');
  const raw = Buffer.from(blob, 'base64').toString('latin1');
  check(!/hosttokenAAAA|pidA-123|Ben|Party/.test(raw) && !/hosttokenAAAA/.test(blob), 'server copy is encrypted');
  check(!sql('select id from backups').includes(words[0]), 'id isn’t the words');
  // automatic updates
  await setLs(a, { 'meetup.owners': { wdw1: 'wdwtokenA' } });
  await a.evaluate(() => PebblyBackup.sync());
  check(sql('select version from backups') === '2', 'a change is saved');
  await a.evaluate(() => PebblyBackup.sync());
  check(sql('select version from backups') === '2', 'no change: nothing saved');
  await a.goto(B + '/timer/');
  await a.waitForFunction(() => window.PebblyBackup);
  await setLs(a, { 'pick.owners': { poll1: 'polltoken' } });
  await a.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await a.waitForTimeout(1500);
  check(sql('select version from backups') === '3', 'any app page keeps it up to date (nav.js), e.g. when leaving the page');
  await a.goto(B + '/');
  check(!(await a.isVisible('#bknote')), 'no suggestion once backed up');

  /* ---------------- phone B restores */
  const b = await mk();
  await b.goto(B + '/backup/');
  await setLs(b, { 'meetup.owners': { wdw2: 'wdwtokenB' }, 'rsvp.pid': 'pidB-999', 'pebbly_theme': 'dark', 'pebbly_score_memory': { players: ['Cy'], games: [] } });
  await b.reload();
  await b.fill('#rWords', 'one two three');
  await b.click('#rForm button');
  check(/six words/.test(await b.textContent('#rErr')), 'not six words: explained');
  await b.fill('#rWords', 'abandon ability able about above absent');
  await b.click('#rForm button');
  await b.waitForFunction(() => /no backup/.test(document.getElementById('rErr').textContent));
  check(true, 'words with no backup: explained');
  // any case, commas, first four letters are enough
  await b.fill('#rWords', words.map((w, i) => i % 2 ? w.toUpperCase() : (w.length > 4 ? w.slice(0, 4) : w)).join(', '));
  await b.click('#rForm button');
  await b.waitForSelector('#restore h2:has-text("Restored")');
  const restored = await b.textContent('#restore');
  check(/5 host links/.test(restored), 'restore summary: ' + restored);
  if (process.env.SHOTS) await b.screenshot({ path: '/tmp/backup_restored.png', fullPage: true });
  check(JSON.parse(await ls(b, 'rsvp.owners')).abcd1234 === 'hosttokenAAAA' && JSON.parse(await ls(b, 'pick.owners')).poll1 === 'polltoken', 'host links restored');
  const mo = JSON.parse(await ls(b, 'meetup.owners'));
  check(mo.wdw1 === 'wdwtokenA' && mo.wdw2 === 'wdwtokenB', 'added to what was on the phone: ' + JSON.stringify(mo));
  check(await ls(b, 'rsvp.pid') === '"pidA-123"' && await ls(b, 'pebbly_theme') === 'light', 'single values come from the backup (guest id, theme)');
  check(JSON.stringify(JSON.parse(await ls(b, 'pebbly_score_memory')).players.sort()) === '["Amy","Ben","Cy"]', 'remembered names combined');
  check(JSON.parse(await ls(b, 'pebbly_lock_keys'))['rsvp:abcd1234'] === 'lockkey', 'event passwords restored');
  check(await ls(b, 'pebbly_farkle') === null && await ls(b, 'pebbly_farkle_undo') === null && await ls(b, 'pebbly_push') === null && await ls(b, 'rsvp.local.db') === null, 'games in progress, alerts and previews not restored');
  check(await b.evaluate(w => PebblyBackup.state().words.join(' ') === w, words.join(' ')), 'phone B keeps backing up with the same words');
  await b.waitForFunction(() => PebblyBackup.state().savedAt);
  // A's next save keeps B's additions in the copy (without changing A's own phone)
  await setLs(a, { 'rsvp.first': 'Benjamin' });
  await a.evaluate(() => PebblyBackup.sync());
  const c = await mk();
  await c.goto(B + '/backup/');
  await c.fill('#rWords', words.join(' '));
  await c.click('#rForm button');
  await c.waitForSelector('#restore h2:has-text("Restored")');
  check(JSON.parse(await ls(c, 'meetup.owners')).wdw2 === 'wdwtokenB' && await ls(c, 'rsvp.first') === '"Benjamin"', 'two phones on one key both end up in the copy');
  check(!JSON.parse(await ls(a, 'meetup.owners')).wdw2, 'saving never changes the phone itself');
  // two phones saving at once both land
  await setLs(a, { 'pebbly_santa_owners': { s1: 'x' } }); await setLs(b, { 'pebbly_santa_owners': { s2: 'y' } });
  await Promise.all([a.evaluate(() => PebblyBackup.sync()), b.evaluate(() => PebblyBackup.sync())]);
  const d = await mk();
  await d.goto(B + '/backup/'); await d.fill('#rWords', words.join(' ')); await d.click('#rForm button');
  await d.waitForSelector('#restore h2:has-text("Restored")');
  const so = JSON.parse(await ls(d, 'pebbly_santa_owners'));
  check(so.s1 === 'x' && so.s2 === 'y', 'simultaneous saves merge: ' + JSON.stringify(so));

  /* ---------------- show, stop, delete */
  await a.goto(B + '/backup/');
  await a.waitForSelector('[data-act=show]');
  check(/backed up/.test(await a.textContent('#mine')), 'shows backed up');
  await a.click('[data-act=show]');
  check((await a.$$eval('.words li', l => l.map(x => x.textContent))).join(' ') === words.join(' '), 'show my backup key');
  await a.click('[data-act=delete]');
  await toast(a);
  check(sql('select count(*) from backups') === '0' && await a.isVisible('[data-act=create]'), 'delete removes the copy');
  check(JSON.parse(await ls(a, 'rsvp.owners')).abcd1234 === 'hosttokenAAAA', 'delete leaves the phone’s data alone');
  await b.goto(B + '/backup/');
  await b.waitForSelector('[data-act=stop]');
  await b.click('[data-act=stop]');
  check(await b.isVisible('[data-act=create]') && await ls(b, 'pebbly_backup') === null, 'stop backing up on this phone');

  /* ---------------- before the migration */
  const old = await mk('backup_old');
  await old.goto(B + '/backup/');
  await old.click('[data-act=create]');
  check(/aren’t switched on yet/.test(await toast(old)), 'clear message before the migration');
  check(await ls(old, 'pebbly_backup') === null, 'no half-made key left behind');

  for (const p of [a, b, c, d, old]) check(!p.errs.length, 'page errors: ' + p.errs.join('; '));
  console.log(pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ' checks:', e.message.split('\n')[0], (e.stack.match(/backup_test.js:\d+/) || [])[0]); process.exit(1); });
