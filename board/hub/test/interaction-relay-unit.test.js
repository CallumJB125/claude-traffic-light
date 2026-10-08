// InteractionRelay against a fake hub and fake sockets: the races and edge
// paths a live hub makes hard to hit (concurrent upgrades, a send that throws,
// a drop while a call is on the wire). No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InteractionRelay } from '../interaction-relay.js';

const T = { timeout: 10_000 };

function fakeHub(roles) {
  return {
    accounts: { credValid: () => true },
    db: { get: (sql, id) => (sql.includes('interaction_role') ? { r: roles[id] ?? null } : { name: 'Device', platform: 'darwin-arm64' }), run: () => {} },
    mono: () => Date.now(),
  };
}

function fakeWs({ throwOnRequest = false } = {}) {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.closed = null;
  ws.send = (s) => { const f = JSON.parse(s); if (throwOnRequest && f.type === 'relay.request') throw new Error('socket gone'); ws.sent.push(f); };
  ws.close = (code) => { ws.closed = code; };
  ws.ping = () => {};
  return ws;
}

const user = { id: 'u1' };
const hostCred = { kind: 'device', id: 'mac' };
const client = { user, cred: { kind: 'device', id: 'win' } };
const rid = () => crypto.randomUUID();
const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: e }));

test('attach re-checks admit: of two upgrades admitted at once, the second is closed and the first stays', T, () => {
  const relay = new InteractionRelay(fakeHub({ mac: 'host' }));
  // Both passed admit() before either attached (no live host yet).
  assert.equal(relay.admit({ cred: hostCred }), null);
  assert.equal(relay.admit({ cred: hostCred }), null);
  const a = fakeWs(), b = fakeWs();
  relay.attach(a, { user, cred: hostCred });
  relay.attach(b, { user, cred: hostCred });
  assert.equal(b.closed, 1008);
  assert.equal(relay.hosts.get('mac').ws, a);
  assert.equal(a.closed, null);
  assert.ok(a.sent.some((f) => f.type === 'relay.notice' && f.kind === 'replace-refused'));
  // With the live socket's resume nonce, a later upgrade does replace it.
  const c = fakeWs();
  relay.attach(c, { user, cred: hostCred }, { 'x-plexiform-resume': a.sent[0].resume });
  assert.equal(relay.hosts.get('mac').ws, c);
  assert.equal(a.closed, 4409);
  relay.close();
});

test('a request whose send throws answers 404 and leaves its request_id usable', T, async () => {
  const relay = new InteractionRelay(fakeHub({ mac: 'host', win: 'client' }));
  const broken = fakeWs({ throwOnRequest: true });
  relay.attach(broken, { user, cred: hostCred });
  const id = rid();
  const first = await settle(relay.call(client, 'mac', { request_id: id, op: 'send', args: {} }));
  assert.equal(first.err.code, 'NOT_FOUND');
  // The same request_id goes through once the device is back (not REPLAYED).
  relay.drop(relay.hosts.get('mac'));
  const ws = fakeWs();
  relay.attach(ws, { user, cred: hostCred });
  const p = relay.call(client, 'mac', { request_id: id, op: 'send', args: {} });
  const frame = ws.sent.find((f) => f.type === 'relay.request');
  assert.equal(frame.rid, id);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'relay.reply', id: frame.id, result: { ok: true } })), false);
  assert.deepEqual((await p).result, { ok: true });
  relay.close();
});

test('a drop while calls are on the wire: a mutating op is OUTCOME_UNKNOWN (id stays used), a read is 404 (id freed)', T, async () => {
  const relay = new InteractionRelay(fakeHub({ mac: 'host', win: 'client' }));
  const ws = fakeWs();
  relay.attach(ws, { user, cred: hostCred });
  const sendId = rid(), readId = rid();
  const send = settle(relay.call(client, 'mac', { request_id: sendId, op: 'send', args: {} }));
  const read = settle(relay.call(client, 'mac', { request_id: readId, op: 'list', args: {} }));
  ws.emit('close');
  const s = await send, r = await read;
  assert.equal(s.err.code, 'TIMEOUT');
  assert.equal(s.err.extra.reason, 'OUTCOME_UNKNOWN');
  assert.match(s.err.message, /outcome is unknown/);
  assert.equal(r.err.code, 'NOT_FOUND');
  assert.equal(relay.replayed('u1', readId), false, 'the read id was freed');
  assert.equal(relay.replayed('u1', sendId), true, 'the send id stays used');
  relay.close();
});
