// Basecamp's OwnTracks receiver (supabase/functions/owntracks/handler.js), run in Node against the test Postgres:
// the function's database calls go to psql as service_role. Checks: GET answers, reports without a key or with an
// unknown one get "go Quiet" back, a location report moves the person's dot, a list of reports works, other report
// types are ignored, nobody watching for 12 hours → "report less", someone watching again → normal settings back (Move mode if it
// was in Move), after the end time → "go Quiet", and database trouble answers 503 (so OwnTracks sends it again later).
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
  const link = JSON.parse(sql(`select gated_bc_ot_link(${lit(c.code)}, ${lit(c.member_key)}, true, 4320);`, 'anon'));
  const look = () => sql(`select gated_bc_sync(${lit(c.code)}, null, null, null, null, 0, 0);`, 'anon');      // someone opens the map
  const quiet = (t) => { try { const j = JSON.parse(t); return j.length === 1 && j[0]._type === 'cmd' && j[0].action === 'setConfiguration' && j[0].configuration.monitoring === -1; } catch (e) { return false; } };
  check(link.until > Date.now() + 71 * 3600e3 && link.until < Date.now() + 73 * 3600e3, 'shares for 3 days');
  look();
  check(/^[0-9a-f]{64}$/.test(link.token) && link.tid === 'AM', 'personal key and tracker id: ' + link.tid);
  const pos = () => JSON.parse(sql(`select gated_bc_sync(${lit(c.code)}, ${lit(c.member_key)}, null, null, null, 0, 0);`, 'anon')).members[0];

  let r = await call('GET');
  check(r.status === 200 && /OwnTracks/.test(await r.text()), 'GET answers');
  r = await call('POST', '', { _type: 'location', lat: 45, lon: -93 });
  check(r.status === 200 && quiet(await r.text()), 'no key: told to go Quiet');
  r = await call('POST', '?k=' + 'f'.repeat(64), { _type: 'location', lat: 45, lon: -93 });
  check(r.status === 200 && quiet(await r.text()) && pos().lat == null, 'unknown key: dropped, told to go Quiet');
  const now = Math.floor(Date.now() / 1000);
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.1234, lon: -93.4321, acc: 9, tst: now - 5, vel: 6, cog: 270, batt: 80, m: 2 });
  const p1 = pos();
  check(r.status === 200 && (await r.text()) === '[]' && p1.lat === 45.1234 && p1.lng === -93.4321 && p1.ot === true && Math.round(p1.heading) === 270, 'location report moves the dot');
  r = await call('POST', '?k=' + link.token, [{ _type: 'transition' }, { _type: 'location', lat: 45.1240, lon: -93.4321, acc: 9, tst: now }]);
  check(r.status === 200 && pos().lat === 45.124, 'a list of reports, other types ignored');
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.5, lon: -93.5, acc: 9, tst: now - 600 });
  check(pos().lat === 45.124, 'an older report doesn’t move the dot back');
  const pts = JSON.parse(sql(`select gated_bc_sync(${lit(c.code)}, ${lit(c.member_key)}, null, null, null, 0, 0);`, 'anon')).points;
  check(pts.length === 2, 'trail recorded from the reports: ' + pts.length + ' points');
  // nobody looking for 30 minutes: told to report less; someone looks: normal again, back in Move mode
  sql(`update bc_sessions set viewed_at = now() - interval '11 hours';`);
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.1240, lon: -93.4321, acc: 9, tst: now + 1, m: 2 });
  check((await r.text()) === '[]', 'nobody looking for 11 hours: still normal');
  sql(`update bc_sessions set viewed_at = now() - interval '12 hours 1 minute';`);
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.1241, lon: -93.4321, acc: 9, tst: now + 2, m: 2 });
  let j = JSON.parse(await r.text());
  check(j.length === 1 && j[0].configuration.monitoring === 1 && j[0].configuration.locatorDisplacement >= 500, 'nobody looking for 12 hours: report less');
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.1242, lon: -93.4321, acc: 9, tst: now + 3, m: 1 });
  check((await r.text()) === '[]', 'told once, not every time');
  check(pos().ot_slow === true, 'shown as slow while nobody watches');
  look();
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.1243, lon: -93.4321, acc: 9, tst: now + 4, m: 1 });
  j = JSON.parse(await r.text());
  check(j.length === 1 && j[0].configuration.monitoring === 2 && j[0].configuration.locatorDisplacement === 20, 'someone watching again: normal settings, back in Move mode');
  broken = true;
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.2, lon: -93.4, acc: 9, tst: now + 1 });
  check(r.status === 503, 'database trouble: 503 so OwnTracks retries');
  broken = false;
  r = await call('POST', '?k=' + link.token, 'not json at all');
  check(r.status === 200, 'junk body: dropped');
  // the end time passes: told to go Quiet, and the key stops working
  sql(`update bc_members set ot_until = now() - interval '1 minute';`);
  r = await call('POST', '?k=' + link.token, { _type: 'location', lat: 45.2, lon: -93.4, acc: 9, tst: now + 9 });
  check(quiet(await r.text()), 'after the end time: told to go Quiet');
  check(pos().ot === false, 'and it’s off');
  // one setup, two maps: the second map joins with the phone's key; it keeps going after the first ends
  const c2 = JSON.parse(sql(`select bc_create('Camp 2', 'Amy');`, 'anon'));
  const c3 = JSON.parse(sql(`select bc_create('Camp 3', 'Amy');`, 'anon'));
  const l2 = JSON.parse(sql(`select gated_bc_ot_link(${lit(c2.code)}, ${lit(c2.member_key)}, false, 60);`, 'anon'));
  const l3 = JSON.parse(sql(`select gated_bc_ot_link(${lit(c3.code)}, ${lit(c3.member_key)}, false, 0, ${lit(l2.token)});`, 'anon'));
  check(l3.token === l2.token && l3.joined === true && l3.until == null, 'second map joins the same setup (until stopped)');
  sql(`select gated_bc_sync(${lit(c2.code)}, null, null, null, null, 0, 0); select gated_bc_sync(${lit(c3.code)}, null, null, null, null, 0, 0);`, 'anon');
  r = await call('POST', '?k=' + l2.token, { _type: 'location', lat: 46.5, lon: -94.5, acc: 9, tst: now + 20 });
  const where = (c, k) => JSON.parse(sql(`select gated_bc_sync(${lit(c)}, ${lit(k)}, null, null, null, 0, 0);`, 'anon')).members[0].lat;
  check(where(c2.code, c2.member_key) === 46.5 && where(c3.code, c3.member_key) === 46.5, 'one report updates both maps');
  sql(`update bc_members set ot_until = now() - interval '1 minute' where session_id = (select id from bc_sessions where name = 'Camp 2');`);
  r = await call('POST', '?k=' + l2.token, { _type: 'location', lat: 46.6, lon: -94.5, acc: 9, tst: now + 21 });
  check((await r.text()) === '[]' && where(c3.code, c3.member_key) === 46.6 && where(c2.code, c2.member_key) === 46.5, 'first map ended: the other keeps going, no Quiet');
  sql(`select gated_bc_ot_stop(${lit(c3.code)}, ${lit(c3.member_key)});`, 'anon');
  r = await call('POST', '?k=' + l2.token, { _type: 'location', lat: 46.7, lon: -94.5, acc: 9, tst: now + 22 });
  check(quiet(await r.text()), 'last map stopped: told to go Quiet');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
