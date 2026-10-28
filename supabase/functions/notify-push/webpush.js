// Web Push with nothing but WebCrypto (works the same in Supabase Edge Functions/Deno and in Node for tests).
//   Payload encryption: RFC 8291 (aes128gcm, RFC 8188), one record.
//   Sender identity:    RFC 8292 (VAPID): an ES256 JWT signed with this server's key pair.
// Exports:
//   makeVapidKeys()                       → { publicKey (base64url, 65-byte raw point), privateJwk }
//   encrypt(payload, p256dh, auth, opts)  → Uint8Array body (opts.asKeys / opts.salt for test vectors)
//   vapidHeader(endpoint, vapid, subject) → 'vapid t=…, k=…'
//   send(sub, payload, vapid, opts)       → fetch Response  (sub: { endpoint, p256dh, auth })

const enc = new TextEncoder();

export function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str) {
  const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF with a single 32-byte block, cut to len.
async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, cat(info, new Uint8Array([1])))).slice(0, len);
}

export async function makeVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64u(raw), privateJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d } };
}

// opts.asKeys: { publicKey: Uint8Array(65), privateJwk } and opts.salt: Uint8Array(16), for test vectors only.
export async function encrypt(payload, p256dh, auth, opts = {}) {
  const uaPublic = typeof p256dh === 'string' ? unb64u(p256dh) : p256dh;
  const authSecret = typeof auth === 'string' ? unb64u(auth) : auth;
  let asPrivate, asPublic;
  if (opts.asKeys) {
    asPrivate = await crypto.subtle.importKey('jwk', opts.asKeys.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    asPublic = opts.asKeys.publicKey;
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const data = typeof payload === 'string' ? enc.encode(payload) : payload;
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(data, new Uint8Array([2]))));
  const rs = 4096, header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  return cat(header, asPublic, sealed);
}

export async function vapidHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + vapid.publicKey;
}

export async function send(sub, payload, vapid, opts = {}) {
  const body = await encrypt(JSON.stringify(payload), sub.p256dh, sub.auth);
  return (opts.fetch || fetch)(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttl || 24 * 3600),
      Urgency: opts.urgency || 'normal',
      ...(opts.topic ? { Topic: opts.topic } : {}),
      Authorization: await vapidHeader(sub.endpoint, vapid, opts.subject || 'https://pebbly.dev')
    },
    body
  });
}
