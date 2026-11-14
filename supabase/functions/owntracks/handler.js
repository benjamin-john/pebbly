// owntracks: receives location reports from the free OwnTracks app (HTTP mode) for Basecamp's
// "share with the screen off". See supabase/migrations/20261115000000_basecamp_owntracks.sql.
//   POST /functions/v1/owntracks?k=<personal key>   body: one OwnTracks message (or a list of them)
// The key in the address is the person's own (Basecamp makes it with bc_ot_link); bc_owntracks checks it.
// The reply is a list of OwnTracks commands from bc_owntracks (usually []): "go Quiet" when sharing ended or the key is
// unknown, "report less / normally" when nobody is / someone is looking at the map. OwnTracks only acts on commands it
// receives as replies, with remote commands allowed in its settings (Basecamp's setup link does that).
// Database trouble answers 503 so OwnTracks keeps the report and sends it again later. Kept free of Deno-only APIs so tests can run it in Node: handle(request, { env, fetch }).

const QUIET = [{ _type: 'cmd', action: 'setConfiguration', configuration: { _type: 'configuration', monitoring: -1 } }];
function reply(status, body) {
  return new Response(body == null ? '[]' : body, { status, headers: { 'Content-Type': 'application/json' } });
}
function serviceKey(env) {
  const k = env('SUPABASE_SERVICE_ROLE_KEY');
  if (k) return k;
  try { const all = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}'); return Object.values(all)[0] || ''; } catch (e) { return ''; }
}

export async function handle(req, deps) {
  const env = deps.env, http = deps.fetch || fetch;
  if (req.method === 'GET') return reply(200, JSON.stringify({ ok: true, what: 'Basecamp OwnTracks receiver' }));
  if (req.method !== 'POST') return reply(405);
  const key = new URL(req.url).searchParams.get('k') || '';
  if (!key || key.length > 200) return reply(200, JSON.stringify(QUIET));
  let body = null;
  try { body = await req.json(); } catch (e) { return reply(200); }
  const list = (Array.isArray(body) ? body : [body]).filter((m) => m && typeof m === 'object').slice(0, 50);
  const base = String(env('SUPABASE_URL') || '').replace(/\/+$/, ''), skey = serviceKey(env);
  if (!base || !skey) return reply(503);
  const headers = { 'Content-Type': 'application/json', apikey: skey };
  if (!/^sb_/.test(skey)) headers.Authorization = 'Bearer ' + skey;
  let out = [];
  try {
    for (const m of list) {
      const r = await http(base + '/rest/v1/rpc/bc_owntracks', { method: 'POST', headers, body: JSON.stringify({ p_token: key, p_body: m }) });
      const t = await r.text();
      if (!r.ok) { console.log('bc_owntracks failed', r.status, t.slice(0, 200)); return reply(503); }
      let d = null; try { d = JSON.parse(t); } catch (e) {}
      // (an older database answers with just a word; then there's nothing to send back)
      if (d && Array.isArray(d.reply) && d.reply.length) out = d.reply;    // the latest instruction wins
    }
  } catch (e) {
    console.log('owntracks error', e && e.message);
    return reply(503);
  }
  return reply(200, JSON.stringify(out));
}
