// Pebbly-wide admin page (/admin/): one sign-in, every app with an admin mode as a section.
// Setup: sh tests/setup_db.sh adm; serve the repo root on port 8770; NODE_PATH=$(npm root -g) node tests/admin_test.js
// (test admin password: "secret", from tests/wdw_fixture.sql)
const { chromium, devices } = require('playwright');
const { execSync } = require('child_process');
const { phone } = require('./pg_bridge');
const DB = process.env.DB || 'adm', B = 'http://localhost:' + (process.env.PORT || 8770);
const sql = (s, asOwner) => execSync(`psql -h /tmp/pebbly-pgtest -p 5439 -U postgres -d ${DB} -At`, { input: (asOwner ? '' : 'set role anon;\n') + s }).toString().trim().split('\n').pop();
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
(async () => {
  const rsvp = JSON.parse(sql(`select rsvp_create('{"title":"Lake BBQ","host_name":"Ben"}'::jsonb);`));
  const wdw = JSON.parse(sql(`select wdw_create('Cabin weekend');`));
  const poll = JSON.parse(sql(`select poll_create('Lunch spot','',false,false,true,'["Tacos","Pizza"]'::jsonb);`));
  const live = JSON.parse(sql(`select live_create('Team Quiz', '[{"q":"2+2?","choices":["3","4"],"answer":1}]');`));
  const b = await chromium.launch();
  const p = await phone(b, devices, DB);
  await p.goto(B + '/');
  await p.click('.admin a');
  await p.waitForSelector('#loginForm');
  check(/Admin \| Pebbly/.test(await p.title()), 'homepage Admin link opens the admin page');
  await p.fill('#pw', 'nope'); await p.click('#loginForm button');
  await p.waitForFunction(() => /isn’t right/.test(document.getElementById('loginErr').textContent));
  check(true, 'wrong password refused');
  check(Number(sql(`select count(*) from admin_attempts;`, true)) === 1, 'a wrong try counts once, not once per app');
  await p.fill('#pw', 'secret'); await p.click('#loginForm button');
  await p.waitForSelector('#dash:not([hidden]) details.app');
  const secs = await p.$$eval('details.app', ds => ds.map(d => d.dataset.app + ':' + d.querySelectorAll('.items li:not(.empty)').length));
  check(secs.join() === 'live:1,rsvp:1,wdw:1,poll:1', 'one section per app with its items: ' + secs);
  const txt = await p.textContent('#apps');
  check(['Lake BBQ', 'Cabin weekend', 'Lunch spot', 'Team Quiz', 'Waiting to start', live.code].every(t => txt.includes(t)), 'titles and details shown');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/admin-all.png', fullPage: true });
  await p.fill('#q', 'cabin');
  check((await p.$$eval('.items li:not(.empty) .nm', l => l.map(x => x.textContent))).join() === 'Cabin weekend', 'search filters across apps');
  await p.fill('#q', '');
  // open each as host
  const hostCheck = { rsvp: '.host', wdw: '.panel.owner', poll: '#ownerTools .panel', live: '#present:not([hidden]), #remote:not([hidden])' };
  for (const app of ['rsvp', 'wdw', 'poll', 'live']) {
    await p.goto(B + '/admin/'); await p.waitForSelector('details.app');
    await p.click(`button[data-act=host][data-app=${app}]`);
    await p.waitForSelector(hostCheck[app], { timeout: 15000 }).then(() => check(true, ''), () => check(false, 'open as host: ' + app + ' ' + p.url()));
  }
  check(await p.evaluate(() => sessionStorage.getItem('pebbly_admin') === 'secret' && !localStorage.getItem('pebbly_admin')), 'password only in this tab’s session');
  // delete
  await p.goto(B + '/admin/'); await p.waitForSelector('details.app');
  await p.click('button[data-act=del][data-app=poll]');
  await p.waitForFunction(() => !document.querySelector('button[data-act=del][data-app=poll]'));
  check(sql(`select count(*) from polls where code='${poll.code}';`, true) === '0', 'delete removes it');
  check(/Nothing here yet/.test(await p.textContent('details[data-app=poll]')), 'empty section message');
  await p.click('#signout');
  check(await p.isVisible('#loginForm') && !(await p.evaluate(() => sessionStorage.getItem('pebbly_admin'))), 'sign out');
  check(!p.errs.length, p.errs.join('; '));
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
