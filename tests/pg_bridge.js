// Test helper: routes the pages' Supabase RPC calls to a local Postgres (as the anon role) through psql,
// so database functions can be tested end to end in Playwright. See CLAUDE.md → Testing.
// Routes Supabase RPC calls from the page to the local test Postgres as the anon role.
const { spawnSync } = require('child_process');
function rpc(db, fn, args) {
  const names = Object.keys(args); const vars = []; const parts = [];
  names.forEach((n, i) => { const v = args[n];
    if (v === null || v === undefined) parts.push(`${n} => NULL`);
    else { vars.push('-v', `a${i}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`); parts.push(`${n} => :'a${i}'`); } });
  if (!/^[a-z_]+$/.test(fn)) return { status: 400, body: '{}' };
  const sql = `set role anon;\nselect coalesce(to_jsonb(public.${fn}(${parts.join(', ')}))::text, 'null');\n`;
  const r = spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', db, '-At', '-v', 'ON_ERROR_STOP=1', ...vars], { input: sql, encoding: 'utf8' });
  if (r.status !== 0) { const m = (r.stderr.match(/ERROR:\s+(.*)/) || [])[1] || r.stderr; return { status: 400, body: JSON.stringify({ message: m.trim() }) }; }
  const out = r.stdout.trim().split('\n').filter(Boolean).pop();
  return { status: 200, body: out === undefined ? '' : out };
}
async function phone(browser, devices, db, opts) {
  const c = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', ...(opts || {}) });  // sw.js has its own test (tests/sw_test.js)
  await c.route('https://xujtuijpbwujduuzlwat.supabase.co/rest/v1/rpc/*', r => { const fn = r.request().url().split('/rpc/')[1]; const res = rpc(db, fn, JSON.parse(r.request().postData() || '{}')); r.fulfill({ status: res.status, contentType: 'application/json', body: res.body }); });
  await c.route('**fonts.g*/**', r => r.abort());
  const p = await c.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message)); p.on('dialog', d => d.accept());
  return p;
}
module.exports = { rpc, phone };
