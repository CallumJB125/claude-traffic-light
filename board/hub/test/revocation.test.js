// A runner the hub has closed stays closed: a peer that ignores the close
// frame and sends hello + out on the same socket is never re-registered and
// nothing it sends is applied (member removal, device revoke, REPLACED). A
// hello after revocation on a socket nobody closed is refused too, and a
// revoked device's run token no longer verifies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub, runMsg, settle } from './helpers.js';
import { verifyRun } from '../rpc.js';

const agentComments = (h, cardId) => h.db.get("SELECT COUNT(*) AS n FROM comments WHERE card_id = ? AND source = 'agent'", cardId).n;

// The peer stops reading (never sees the close frame) and keeps writing.
async function replayAfterClose(h, r, run) {
  r.send({ type: 'hello', protocol: 1, device_id: r.dev.device_id, runner_version: 'evil', outbox_head_seq: r.seq + 1, runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'running' }] });
  r.send({ type: 'out', seq: r.seq + 1, delayed: false, msg: { kind: 'comment.create', ...runMsg(run), text: 'still here' } });
  await settle(100);
}

test('member removed: hello + out during the close handshake apply nothing', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const dev = await h.enroll(bob);
    const r = await h.runner(dev);
    const run = await h.startRun(bob, r);
    const conn = h.hub.runners.get(dev.device_id);
    r.ws.pause();
    assert.equal((await h.api(alice, 'DELETE', `/api/members/${h.ids.bob}`, { request_id: randomUUID() })).status, 200);
    await replayAfterClose(h, r, run);
    assert.equal(agentComments(h, run.card_id), 0);
    assert.equal(h.hub.runners.has(dev.device_id), false);
    assert.equal(conn.ready, false);
    r.ws.resume();
    assert.equal(await r.closed(), 4403);
  } finally { await h.destroy(); }
});

test('device revoked: hello + out during the close handshake apply nothing', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r = await h.runner(dev);
    const run = await h.startRun(alice, r);
    r.ws.pause();
    assert.equal((await h.api(alice, 'DELETE', `/api/devices/${dev.device_id}`, { request_id: randomUUID() })).status, 200);
    await replayAfterClose(h, r, run);
    assert.equal(agentComments(h, run.card_id), 0);
    assert.equal(h.hub.runners.has(dev.device_id), false);
    r.ws.resume();
    assert.equal(await r.closed(), 4403);
  } finally { await h.destroy(); }
});

test('REPLACED: the old socket cannot take the device back with hello + out', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r1 = await h.runner(dev);
    const run = await h.startRun(alice, r1);
    r1.ws.pause();
    const r2 = await h.runner(dev, { runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'running' }] });
    const newest = h.hub.runners.get(dev.device_id);
    await replayAfterClose(h, r1, run);
    assert.equal(agentComments(h, run.card_id), 0);
    assert.equal(h.hub.runners.get(dev.device_id), newest, 'the newest connection keeps the device');
    assert.equal(r2.closeCode, null);
    r1.ws.resume();
    assert.equal(await r1.closed(), 4409);
  } finally { await h.destroy(); }
});

test('a socket authenticated before the revoke cannot hello afterwards; a revoked device\'s run token fails', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r = await h.runner(dev);
    const run = await h.startRun(alice, r);
    const late = await h.runner(dev, { hello: false });
    h.db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', h.hub.iso(), dev.device_id);   // no socket was notified
    const msg = { ...runMsg(run), run_token: run.run_token };
    assert.throws(() => verifyRun(h.hub, { id: dev.device_id }, msg), /revoked/);
    late.send({ type: 'hello', protocol: 1, device_id: dev.device_id, runner_version: 't', outbox_head_seq: 0, runs: [] });
    assert.equal(await late.closed(), 4403);
    assert.equal(late.all('welcome').length, 0);
  } finally { await h.destroy(); }
});

test('verifyRun refuses a run whose member was removed', async () => {
  const h = await startHub();
  try {
    const bob = await h.login('bob');
    const dev = await h.enroll(bob);
    const r = await h.runner(dev);
    const run = await h.startRun(bob, r);
    const msg = { ...runMsg(run), run_token: run.run_token };
    assert.ok(verifyRun(h.hub, { id: dev.device_id }, msg));
    h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), h.ids.bob);
    assert.throws(() => verifyRun(h.hub, { id: dev.device_id }, msg), /member removed/);
  } finally { await h.destroy(); }
});
