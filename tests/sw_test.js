// Offline: the service worker saves every page, so pages never opened before still open offline.
// Run: NODE_PATH=$(npm root -g) node tests/sw_test.js   (starts and then stops its own web server on
// port 8790; stopping the server is how "offline" is simulated, since Playwright's offline switch
// doesn't block a service worker's own requests).
const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const B = 'http://localhost:8790';
let pass = 0, fail = 0; const check = (ok, m) => ok ? pass++ : (fail++, console.log('FAIL', m));
(async () => {
  // every folder with an index.html must be in PAGES
  const root = path.join(__dirname, '..'), sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const pages = JSON.parse(sw.match(/const PAGES = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  const dirs = fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'index.html'))).map(d => '/' + d + '/');
  dirs.forEach(d => check(pages.includes(d), d + ' is missing from PAGES in sw.js'));

  const server = spawn('python3', ['-m', 'http.server', '8790'], { cwd: root, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1000));
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['Pixel 7'] });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(B + '/darts/');                                   // first visit is an app page, not the homepage
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.waitForFunction(n => caches.open('pebbly-v3').then(c => c.keys()).then(k => k.length >= n), pages.length + 5, { timeout: 30000 });
  check(true, 'pages saved in the background');

  server.kill(); await new Promise(r => setTimeout(r, 500));
  for (const [u, sel] of [['/timer/', 'body'], ['/trivia/', 'body'], ['/', '.app'], ['/kwiks/?join=ABCDE', 'body'], ['/score/', 'body']]) {
    const r = await p.goto(B + u).catch(e => null);
    const title = r ? await p.title() : '';
    check(r && r.ok() && title && !/offline|not available/i.test(title), 'offline ' + u + ' → ' + title);
  }
  await p.goto(B + '/rsvp/?e=abcdefgh');
  await p.waitForTimeout(1500);
  check(/RSVP/.test(await p.title()), 'offline RSVP page still opens (and can say it can’t connect)');
  await p.goto(B + '/no-such-page/').catch(() => {});
  check(/Pebbly/.test(await p.title()), 'unknown page offline → homepage');
  check(!errs.length, errs.join('; '));
  console.log(pass + ' passed, ' + fail + ' failed'); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { try { require('child_process').execSync('pkill -f "http.server 8790"'); } catch (x) {} console.log('ERROR after ' + pass + ':', e.message.split('\n')[0]); process.exit(1); });
