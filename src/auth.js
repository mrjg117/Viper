const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacBytes(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function checkPassword(input, expected) {
  return timingSafeEqual(enc.encode(input), enc.encode(expected));
}

export async function createSession(kv, password, expected, ttl = 86400) {
  if (!(await checkPassword(password, expected))) return null;
  const sid = crypto.randomUUID();
  const h = await sha256Hex(sid);
  await kv.put(`sess:${h}`, String(Date.now() + ttl * 1000), { expirationTtl: ttl });
  return sid;
}

export async function validSession(kv, sid) {
  if (!sid) return false;
  const h = await sha256Hex(sid);
  const exp = await kv.get(`sess:${h}`);
  return exp !== null && Number(exp) > Date.now();
}

export function sessionCookie(sid, ttl = 86400) {
  return `viper_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`;
}

export async function saveTarget(kv, tid, data, ttl = 1800) {
  await kv.put(`dl:${tid}`, JSON.stringify(data), { expirationTtl: ttl });
}

export async function loadTarget(kv, tid) {
  const raw = await kv.get(`dl:${tid}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function issueTicket(secret, tid, ttl = 900) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = { t: tid, e: exp, n: crypto.randomUUID() };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = b64urlEncode(await hmacBytes(secret, `v1.${body}`));
  return `v1.${body}.${sig}`;
}

export async function redeemTicket(secret, kv, ticket) {
  const parts = (ticket || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, body, sig] = parts;
  const expected = b64urlEncode(await hmacBytes(secret, `v1.${body}`));
  if (!timingSafeEqual(enc.encode(sig), enc.encode(expected))) return null;

  let payload;
  try { payload = JSON.parse(dec.decode(b64urlDecode(body))); } catch { return null; }
  if (!payload.t || !payload.e || !payload.n) return null;

  const now = Math.floor(Date.now() / 1000);
  if (Number(payload.e) <= now) return null;

  const usedKey = `used:${payload.n}`;
  if (await kv.get(usedKey) !== null) return null;
  await kv.put(usedKey, '1', { expirationTtl: Number(payload.e) - now });
  return payload.t;
}

export function readCookie(header, name = 'viper_sid') {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
