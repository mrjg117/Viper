import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPassword, createSession, validSession, readCookie,
  saveTarget, loadTarget, issueTicket, redeemTicket,
  b64urlEncode, b64urlDecode, timingSafeEqual,
} from '../src/auth.js';
import { parseShare } from '../src/baidu.js';

function memKV() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    _m: m,
  };
}

const SECRET = 'test-sign-secret';

test('base64url roundtrip', () => {
  const b = new TextEncoder().encode('hello世界');
  assert.deepEqual(b64urlDecode(b64urlEncode(b)), b);
});

test('timingSafeEqual', async () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(await checkPassword('pw', 'pw'), true);
  assert.equal(await checkPassword('pw', 'px'), false);
});

test('session: correct password only, cookie read', async () => {
  const kv = memKV();
  assert.equal(await createSession(kv, 'wrong', 'right'), null);
  const sid = await createSession(kv, 'right', 'right');
  assert.equal(typeof sid, 'string');
  assert.equal(await validSession(kv, sid), true);
  assert.equal(await validSession(kv, 'bad'), false);
  assert.equal(readCookie(`a=1; viper_sid=${sid}; b=2`), sid);
});

test('ticket: valid redeem', async () => {
  const kv = memKV();
  await saveTarget(kv, 'tid1', { dlink: 'https://d.pcs.baidu.com/x', ua: 'pan.baidu.com' });
  const ticket = await issueTicket(SECRET, 'tid1', 900);
  assert.equal(await redeemTicket(SECRET, kv, ticket), 'tid1');
  assert.deepEqual((await loadTarget(kv, 'tid1')).dlink, 'https://d.pcs.baidu.com/x');
});

test('ticket: single-use replay blocked', async () => {
  const kv = memKV();
  await saveTarget(kv, 'tid2', { dlink: 'x' });
  const ticket = await issueTicket(SECRET, 'tid2', 900);
  assert.equal(await redeemTicket(SECRET, kv, ticket), 'tid2');
  assert.equal(await redeemTicket(SECRET, kv, ticket), null);
});

test('ticket: tampered signature rejected', async () => {
  const kv = memKV();
  await saveTarget(kv, 'tid3', { dlink: 'x' });
  const ticket = await issueTicket(SECRET, 'tid3', 900);
  const parts = ticket.split('.');
  parts[2] = parts[2].slice(0, -2) + 'aa';
  assert.equal(await redeemTicket(SECRET, kv, parts.join('.')), null);
});

test('ticket: expired rejected', async () => {
  const kv = memKV();
  await saveTarget(kv, 'tid4', { dlink: 'x' });
  const ticket = await issueTicket(SECRET, 'tid4', -1);
  assert.equal(await redeemTicket(SECRET, kv, ticket), null);
});

test('ticket: wrong secret rejected', async () => {
  const kv = memKV();
  await saveTarget(kv, 'tid5', { dlink: 'x' });
  const ticket = await issueTicket(SECRET, 'tid5', 900);
  assert.equal(await redeemTicket('other-secret', kv, ticket), null);
});

test('parseShare', () => {
  assert.deepEqual(parseShare('https://pan.baidu.com/s/abcDEF123?pwd=xy12'), { surl: 'abcDEF123', pwd: 'xy12' });
  assert.deepEqual(parseShare('abcDEF123456', '1234'), { surl: 'abcDEF123456', pwd: '1234' });
  assert.throws(() => parseShare('not a link'));
});
