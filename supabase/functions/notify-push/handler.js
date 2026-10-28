// notify-push: sends Pebbly's phone alerts (Web Push). See supabase/migrations/20261028180000_notify_push.sql.
//   GET              → { publicKey }  (phones need it to turn alerts on; made on the first call)
//   POST {}          → sends everything waiting (the database calls this after each new notification)
//   POST { test }    → sends a test alert to that subscription endpoint
// Kept free of Deno-only APIs so tests can run it in Node: handle(request, { env, fetch }).
import { makeVapidKeys, send } from './webpush.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info'
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function serviceKey(env) {
  const k = env('SUPABASE_SERVICE_ROLE_KEY');
  if (k) return k;
  try { const all = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}'); return Object.values(all)[0] || ''; } catch (e) { return ''; }
}

export async function handle(req, deps) {
  const env = deps.env, http = deps.fetch || fetch;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const base = String(env('SUPABASE_URL') || '').replace(/\/+$/, ''), key = serviceKey(env);
  if (!base || !key) return json({ error: 'not_configured' }, 500);

  async function rpc(fn, args) {
    const headers = { 'Content-Type': 'application/json', apikey: key };
    if (!/^sb_/.test(key)) headers.Authorization = 'Bearer ' + key;
    const r = await http(base + '/rest/v1/rpc/' + fn, { method: 'POST', headers, body: JSON.stringify(args || {}) });
    const t = await r.text();
    if (!r.ok) throw new Error(fn + ' failed: ' + r.status + ' ' + t.slice(0, 200));
    return t ? JSON.parse(t) : null;
  }
  async function vapid() {
    let v = await rpc('notify_push_vapid');
    if (!v) { const k = await makeVapidKeys(); v = await rpc('notify_push_set_vapid', { p_public: k.publicKey, p_private: k.privateJwk }); }
    return v;
  }
  // Sends a list of { sub, payload, topic }; returns { sent, gone }.
  async function deliver(list, v) {
    const gone = [], ok = [];
    await Promise.all(list.map(async (x) => {
      try {
        const r = await send(x.sub, x.payload, v, { fetch: http, topic: x.topic });
        await r.text().catch(() => '');
        if (r.status === 404 || r.status === 410) gone.push(x.sub.endpoint);
        else if (r.ok) ok.push(x.sub.endpoint);
        else console.log('push refused', r.status, new URL(x.sub.endpoint).host);
      } catch (e) { console.log('push failed', e && e.message); }
    }));
    if (gone.length || ok.length) await rpc('notify_push_result', { p_gone: gone, p_ok: [...new Set(ok)] });
    return { sent: ok.length, gone: gone.length };
  }
  // Topic (replaces an undelivered alert for the same thing): up to 32 URL-safe characters.
  function topic(tag) {
    let h = 0;
    for (const c of String(tag)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return ('p' + h.toString(36) + String(tag).replace(/[^A-Za-z0-9_-]/g, '')).slice(0, 32);
  }

  try {
    if (req.method === 'GET') return json({ publicKey: (await vapid()).publicKey });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    let body = {};
    try { body = await req.json(); } catch (e) {}
    const v = await vapid();
    if (body && body.test) {
      const sub = await rpc('notify_push_sub', { p_endpoint: String(body.test) });
      if (!sub) return json({ error: 'not_found' }, 404);
      return json(await deliver([{ sub, payload: { test: true } }], v));
    }
    let sent = 0, gone = 0;
    for (let round = 0; round < 5; round++) {      // a few rounds in case more arrive while sending
      const list = await rpc('notify_push_queue');
      if (!list || !list.length) break;
      const r = await deliver(list.map((x) => ({ sub: { endpoint: x.endpoint, p256dh: x.p256dh, auth: x.auth }, payload: x.payload, topic: topic(x.payload.tag) })), v);
      sent += r.sent; gone += r.gone;
    }
    return json({ sent, gone });
  } catch (e) {
    console.log('notify-push error', e && e.message);
    return json({ error: 'failed' }, 500);
  }
}
