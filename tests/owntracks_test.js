// Basecamp's OwnTracks receiver (supabase/functions/owntracks/handler.js), run in Node against the test Postgres:
// the function's database calls go to psql as service_role. Checks: GET answers, reports without a key or with an
// unknown one are dropped quietly ([]), a location report moves the person's dot, a list of reports works, other
// report types are ignored, and database trouble answers 503 (so OwnTracks sends it again later).
// Setup: sh tests/setup_db.sh owntracks; then:  node tests/owntracks_test.js
const { spawnSync } = require('child_process');
const path = require('path');
const DB = process.env.DB || 'owntracks';
let pass = 0, fail = 0;
const check = (ok, m) => { if (ok) pass++; else { fail++; console.log('FAIL', m); } };
function sql(q, role) {
  const r = spawnSync('psql', ['-h', '/tmp/pebbly-pgtest', '-p', '5439', '-U', 'postgres', '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1'],
    { input: (role ? 'set role ' + role + ';\n' : '') + q, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim().split('\n').pop();
}
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
// stand-in for Supabase's REST API: rpc → psql as service_role
let broken = false;
async function fakeFetch(url, opts) {
  const fn = url.split('/rpc/')[1], a = JSON.parse(opts.body);
  if (broken || fn !== 'bc_owntracks' || !opts.headers.apikey) return new Response('{"message":"down"}', { status: 500 });
  const out = sql(`select to_jsonb(bc_owntracks(${lit(a.p_token)}, ${lit(JSON.stringify(a.p_body))}::jsonb));`, 'service_role');
  return new Response(out, { status: 200 });
}
const env = (n) => ({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' })[n];

(async () => {
  const { handle } = await import(path.join(__dirname, '../supabase/functions/owntracks/handler.js'));
  const call = (method, query, body) => handle(new Request('https://example.supabase.co/functions/v1/owntracks' + (query || ''),
    { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), { env, fetch: fakeFetch });

  const c = JSON.parse(sql(`select bc_create('Camp', 'Amy');`, 'anon'));
  const link = JSON.parse(sql(`select gated_bc_ot_link(${lit(c.code)}, ${lit(c.member_key)}, true);`, 'anon'));
  check(/^[0-9a-f]{64}$/.test(link.token) && link.tid === 'AM', 'personal key and tracker id: ' + link.tid);
  const pos = () => JSON.parse(sql(`select gated_bc_sync(${lit(c.code)}, ${lit(c.member_key)}, null, null, null, 0, 0);`, 'anon')).members[0];

  let r = await call('GET');
  check(r.status === 200 && /OwnTracks/.test(await r.text()), 'GET answers');
  r = await call('POST', '', { _type: 'location', lat: 45, lon: -93 });
  check(r.status === 200 && (await r.text()) === '[]', 'no key: dropped quietly');
  r = await call('POST', '?k=' + 'f'.repeat(64), { _type: 'location', lat: 45, lon: -93 });
  check(r.status === 200 && (await r.text()) === '[]' && pos().lat == null, 'unknown key: dropped');
  const now = Math.floor(Date.now() / 1000);
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.1234, lon: -93.4321, acc: 9, tst: now - 5, vel: 6, cog: 270, batt: 80 });
  const p1 = pos();
  check(r.status === 200 && (await r.text()) === '[]' && p1.lat === 45.1234 && p1.lng === -93.4321 && p1.ot === true && Math.round(p1.heading) === 270, 'location report moves the dot');
  r = await call('POST', '?k=' + link.token, [{ _type: 'transition' }, { _type: 'location', lat: 45.1240, lon: -93.4321, acc: 9, tst: now }]);
  check(r.status === 200 && pos().lat === 45.124, 'a list of reports, other types ignored');
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.5, lon: -93.5, acc: 9, tst: now - 600 });
  check(pos().lat === 45.124, 'an older report doesn’t move the dot back');
  const pts = JSON.parse(sql(`select gated_bc_sync(${lit(c.code)}, ${lit(c.member_key)}, null, null, null, 0, 0);`, 'anon')).points;
  check(pts.length === 2, 'trail recorded from the reports: ' + pts.length + ' points');
  broken = true;
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.2, lon: -93.4, acc: 9, tst: now + 1 });
  check(r.status === 503, 'database trouble: 503 so OwnTracks retries');
  broken = false;
  r = await call('POST', '?k=' + link.token, 'not json at all');
  check(r.status === 200, 'junk body: dropped');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
