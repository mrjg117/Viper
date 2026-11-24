import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createSession, sessionCookie, saveTarget, issueTicket } from '../src/auth.js';

function memKV() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

const env = {
  VIPER_KV: memKV(),
  ADMIN_PASSWORD: 'right',
  SIGN_SECRET: 'sign-secret',
  BAIDU_CLIENT_ID: 'x',
  BAIDU_CLIENT_SECRET: 'y',
};

async function call(path, init = {}) {
  return worker.fetch(new Request('https://viper.example.com' + path, init), env, {});
}

test('worker: login page public, gen requires session', async () => {
  assert.equal((await call('/login')).status, 200);
  assert.equal((await call('/gen')).status, 401);
  assert.equal((await call('/api/link', { method: 'POST' })).status, 401);
});

test('worker: wrong password 401, correct sets cookie', async () => {
  const form1 = new FormData(); form1.set('password', 'wrong');
  const r1 = await call('/login', { method: 'POST', body: form1 });
  assert.equal(r1.status, 401);

  const form2 = new FormData(); form2.set('password', 'right');
  const r2 = await call('/login', { method: 'POST', body: form2 });
  assert.equal(r2.status, 302);
  assert.match(r2.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
});

test('worker: session grants gen access', async () => {
  const sid = await createSession(env.VIPER_KV, 'right', 'right');
  const r = await call('/gen', { headers: { cookie: `viper_sid=${sid}` } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /get link/);
});

test('worker: /p redeems ticket and redirects, replay blocked', async () => {
  await saveTarget(env.VIPER_KV, 'w1', { dlink: 'https://d.pcs.baidu.com/file' });
  const ticket = await issueTicket(env.SIGN_SECRET, 'w1', 900);
  const r1 = await call('/p?t=' + encodeURIComponent(ticket));
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), 'https://d.pcs.baidu.com/file');
  const r2 = await call('/p?t=' + encodeURIComponent(ticket));
  assert.equal(r2.status, 403);
});

test('worker: auth start uses dynamic redirect_uri', async () => {
  const r = await call('/auth/start');
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://viper.example.com/auth/callback');
});

test('worker: health', async () => {
  const r = await call('/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});
