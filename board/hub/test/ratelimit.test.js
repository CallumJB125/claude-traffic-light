// Abuse limits (security review b): per-member and per-IP buckets on login and
// mutating routes, a tighter one on dispatch-like actions, WS frame caps.
// 429 + Retry-After; buckets refill on the hub clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub, FakeRunner } from './helpers.js';
import { DEFAULT_LIMITS, RateLimiter, clientIp } from '../ratelimit.js';

const limits = (over) => ({ config: { rateLimits: { ...DEFAULT_LIMITS, ...over } } });

test('token bucket: capacity, then retry_after, then refill', () => {
  let now = 0;
  const rl = new RateLimiter({ now: () => now, limits: { mutate_member: { capacity: 2, per_ms: 1000 } } });
  assert.equal(rl.take('mutate_member', 'a').ok, true);
  assert.equal(rl.take('mutate_member', 'a').ok, true);
  const no = rl.take('mutate_member', 'a');
  assert.equal(no.ok, false);
  assert.equal(no.retry_after_ms, 500);
  assert.equal(rl.take('mutate_member', 'b').ok, true, 'per key');
  now += 500;
  assert.equal(rl.take('mutate_member', 'a').ok, true);
});

test('clientIp: CF-Connecting-IP only under Access and only from a loopback peer (cloudflared)', () => {
  const req = (remoteAddress, cf) => ({ socket: { remoteAddress }, headers: cf ? { 'cf-connecting-ip': cf } : {} });
  const access = { auth: 'access' };
  assert.equal(clientIp(req('127.0.0.1', '9.9.9.9'), access), '9.9.9.9');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '9.9.9.9'), access), '9.9.9.9');
  assert.equal(clientIp(req('::1', '9.9.9.9'), access), '9.9.9.9');
  assert.equal(clientIp(req('203.0.113.7', '9.9.9.9'), access), '203.0.113.7', 'a direct peer cannot pick its own bucket');
  assert.equal(clientIp(req('127.0.0.1', '9.9.9.9'), { auth: 'dev' }), '127.0.0.1');
});

test('per-member mutation limit: 429 with Retry-After, cached replays are free, refills with time', async () => {
  const h = await startHub(limits({ mutate_member: { capacity: 3, per_ms: 60_000 } }));
  try {
    const alice = await h.login('alice');
    const card = await h.createCard(alice);
    const comment = (request_id = randomUUID()) => h.api(alice, 'POST', `/api/cards/${card.id}/comments`, { request_id, body: 'hi' });
    const rid = randomUUID();
    assert.equal((await comment(rid)).status, 200);
    assert.equal((await comment()).status, 200);
    const r = await comment();
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'RATE_LIMITED');
    assert.equal(r.headers.get('retry-after'), '20');
    assert.equal((await comment(rid)).status, 200, 'a replayed request_id is served from the cache');
    const bob = await h.login('bob');
    assert.equal((await h.api(bob, 'POST', `/api/cards/${card.id}/comments`, { request_id: randomUUID(), body: 'me too' })).status, 200, 'another member has their own bucket');
    h.clock.advance(20_000);
    assert.equal((await comment()).status, 200);
  } finally { await h.destroy(); }
});

test('dispatch-like actions have a tighter per-member limit', async () => {
  const h = await startHub(limits({ dispatch_member: { capacity: 1, per_ms: 60_000 } }));
  try {
    const alice = await h.login('alice');
    const a = await h.createCard(alice);
    const b = await h.createCard(alice);
    assert.equal((await h.action(alice, a.id, 'dispatch')).status, 200);
    const r = await h.action(alice, b.id, 'dispatch');
    assert.equal(r.status, 429);
    assert.equal((await h.action(alice, a.id, 'cancel')).status, 200, 'other actions are not dispatch-limited');
  } finally { await h.destroy(); }
});

test('per-IP mutation limit spans members; dev login is limited per IP', async () => {
  const h = await startHub(limits({ mutate_ip: { capacity: 2, per_ms: 60_000 }, login_ip: { capacity: 2, per_ms: 60_000 } }));
  try {
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const c1 = await h.createCard(alice);
    await h.createCard(bob);
    const r = await h.api(bob, 'POST', `/api/cards/${c1.id}/comments`, { request_id: randomUUID(), body: 'x' });
    assert.equal(r.status, 429);
    const login = await h.api(null, 'POST', '/api/dev/login', { github_login: 'alice' }, h.devHeaders);
    assert.equal(login.status, 429);
  } finally { await h.destroy(); }
});

test('WS frame caps: a flooding browser gets RATE_LIMITED errors; a flooding runner is disconnected with 4429', async () => {
  const h = await startHub(limits({ ws_browser: { capacity: 5, per_ms: 60_000 }, ws_runner: { capacity: 5, per_ms: 60_000 } }));
  try {
    const alice = await h.login('alice');
    const b = await h.browser(alice);
    for (let i = 0; i < 5; i++) b.send({ type: 'ping' });
    const e = await b.next('error', (m) => m.code === 'RATE_LIMITED');
    assert.ok(e);
    const dev = await h.enroll(alice);
    const r = new FakeRunner(h.base, dev);
    await r.open();
    await r.hello([]);
    for (let i = 0; i < 10; i++) r.send({ type: 'hb', seq_hb: i + 1, mono_ms: 1, wall_ms: 1, slept_ms: 0, runs: [] });
    assert.equal(await r.closed(), 4429);
    r.terminate();
  } finally { await h.destroy(); }
});
