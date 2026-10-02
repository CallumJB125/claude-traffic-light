// Runner connection robustness (review fixes): a hung GitHub call never stalls
// the connection's frame sequence, GitHub fetches time out, merge polls never
// stack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, fakeGitHub, runMsg, runHb } from './helpers.js';
import { createGitHub } from '../github.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function hangingGitHub() {
  const gh = fakeGitHub();
  gh.calls = 0;
  gh.getPull = () => { gh.calls++; return new Promise(() => {}); };
  return gh;
}

test('accepted heartbeat records only the server-issued current connection generation; replacement cannot inherit it', async () => {
  const h = await startHub();
  try {
    const cookie = await h.login('alice'), dev = await h.enroll(cookie), runner = await h.runner(dev), run = await h.startRun(cookie, runner);
    const old = h.hub.runners.get(dev.device_id), live = h.hub.lease(run.run_id);
    assert.equal(live.hb_connection_generation, old.generation);
    const replacement = await h.runner(dev, { runs: [{ ...runMsg(run), state: 'running' }] });
    const current = h.hub.runners.get(dev.device_id); assert.notEqual(current.generation, old.generation);
    assert.equal(live.hb_connection_generation, old.generation, 'old task state remains historical until this connection sends a heartbeat');
    assert.notEqual(live.hb_connection_generation, current.generation);
    const ack = await replacement.hb([runHb(run, { generation: old.generation, hb_connection_generation: old.generation })]);
    assert.equal(ack.runs[0].current, true); assert.equal(live.hb_connection_generation, current.generation);
    assert.match(current.generation, /^[0-9a-f-]{36}$/);
  } finally { await h.destroy(); }
});

test('a hung GitHub evidence check does not hold up the heartbeats and outbox frames behind it', async () => {
  const h = await startHub({ github: hangingGitHub() });
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    runner.send({ type: 'rpc', id: 'ev1', method: 'board_attach_evidence', ...runMsg(run), run_token: run.run_token, params: { kind: 'pr', ref: '#7', summary: 'PR' } });
    const t0 = Date.now();
    const ack = await runner.hb([runHb(run)]);
    assert.equal(ack.runs[0].current, true);
    await runner.out({ kind: 'status.update', ...runMsg(run), summary: 'still going' });
    assert.ok(Date.now() - t0 < 1000, 'answered while the rpc is still waiting on GitHub');
    assert.equal(runner.all('rpc.result', (m) => m.re === 'ev1').length, 0);
  } finally { await h.destroy(); }
});

test('GitHub fetches abort after the timeout instead of hanging', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    // A real pending network request keeps Node alive. Mirror that handle,
    // since AbortSignal.timeout deliberately uses an unreferenced timer.
    const handle = setInterval(() => {}, 1000);
    signal.addEventListener('abort', () => { clearInterval(handle); reject(signal.reason); }, { once: true });
  });
  const gh = createGitHub({ fetchImpl, timeoutMs: 50 });
  const t0 = Date.now();
  await assert.rejects(gh.getPull('github.com/acme/app', 1), /TimeoutError|aborted|timeout/i);
  assert.ok(Date.now() - t0 < 2000);
});

test('merge polls never overlap', async () => {
  const gh = hangingGitHub();
  const h = await startHub({ github: gh });
  try {
    const alice = await h.login('alice');
    const card = await h.createCard(alice);
    h.db.run("UPDATE cards SET run_state = 'in_review', column_name = 'in_review' WHERE id = ?", card.id);
    h.db.insert('evidence', { id: 'ev-x', card_id: card.id, run_id: null, kind: 'pr', ref: '#3', verification: 'hub_verified', created_at: h.hub.iso() });
    h.hub.pollMerges();
    h.hub.pollMerges();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(gh.calls, 1);
  } finally { await h.destroy(); }
});

test('restore from backup: the runner\'s acked seq wins over the older DB, so the outbox never jams', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-restore-'));
  const h1 = await startHub({ dataDir });
  let dev;
  let seq;
  try {
    const alice = await h1.login('alice');
    dev = await h1.enroll(alice);
    const r = await h1.runner(dev);
    const run = await h1.startRun(alice, r);
    for (let i = 0; i < 3; i++) await r.out({ kind: 'status.update', ...runMsg(run), summary: `s${i}` });
    seq = r.seq;
  } finally { await h1.close(); }
  // The backup is older than the runner's acks.
  const db = new DatabaseSync(join(dataDir, 'board.db'));
  db.prepare('UPDATE devices SET last_seq_acked = ? WHERE id = ?').run(seq - 3, dev.device_id);
  db.close();
  writeFileSync(join(dataDir, 'board.db.restored'), '');
  const h2 = await startHub({ dataDir });
  try {
    const alice = await h2.login('alice');
    const r = await h2.runner(dev, { hello: false });
    const w = await r.hello([], { outbox_acked_seq: seq });
    assert.equal(w.last_seq_acked, seq);
    assert.ok(h2.db.get("SELECT 1 AS x FROM journal WHERE kind = 'device.outbox' AND json_extract(payload, '$.reason') = 'runner_acked'"));
    await r.advertise([{ repo_id: h2.ids.repo, approvals_from: [], auto_accept_from: [] }]);
    const run = await h2.startRun(alice, r);   // its activity is seq + 1: applied, card goes running
    assert.equal(h2.card(run.card_id).run_state, 'running');
  } finally { await h2.destroy(); }
});

test('a wiped runner outbox (new outbox_id, seq back at 1) is applied, not dropped as already acked', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r1 = await h.runner(dev, { hello: false });
    await r1.hello([], { outbox_id: 'box-1' });
    await r1.advertise([{ repo_id: h.ids.repo, approvals_from: [], auto_accept_from: [] }]);
    const run = await h.startRun(alice, r1);
    for (let i = 0; i < 4; i++) await r1.out({ kind: 'status.update', ...runMsg(run), summary: `old ${i}` });
    const before = r1.seq;
    r1.terminate();
    const r2 = await h.runner(dev, { hello: false });
    const w = await r2.hello([], { outbox_id: 'box-2', outbox_acked_seq: 0, outbox_head_seq: 0 });
    assert.equal(w.last_seq_acked, 0);
    r2.seq = 0;
    const ack = await r2.out({ kind: 'status.update', ...runMsg(run), summary: 'after the wipe' });
    assert.equal(ack.seq, 1);
    assert.equal(h.db.get('SELECT status_summary FROM runs WHERE id = ?', run.run_id).status_summary, 'after the wipe');
    const j = JSON.parse(h.db.get("SELECT payload FROM journal WHERE kind = 'device.outbox' AND json_extract(payload, '$.reason') = 'reset'").payload);
    assert.deepEqual([j.from, j.to, j.outbox_id, j.outbox_id_before], [before, 0, 'box-2', 'box-1']);
    assert.ok(h.db.get('SELECT seq FROM events WHERE device_id = ? ORDER BY id DESC LIMIT 1', dev.device_id).seq > before, 'events keep UNIQUE(device_id, seq)');
  } finally { await h.destroy(); }
});

test('a gap before the first replayed entry can never fill: skipped on the record, the rest applied', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r = await h.runner(dev);
    const run = await h.startRun(alice, r);
    r.terminate();
    const r2 = await h.runner(dev, { hello: false });
    await r2.hello([]);
    const acked = r2.welcome.last_seq_acked;
    const ack = await r2.out({ kind: 'status.update', ...runMsg(run), summary: 'after lost entries' }, { seq: acked + 3 });
    assert.equal(ack.seq, acked + 3);
    assert.equal(h.db.get('SELECT status_summary FROM runs WHERE id = ?', run.run_id).status_summary, 'after lost entries');
    const j = JSON.parse(h.db.get("SELECT payload FROM journal WHERE kind = 'device.outbox' AND json_extract(payload, '$.reason') = 'gap'").payload);
    assert.deepEqual([j.from, j.to], [acked, acked + 2]);
  } finally { await h.destroy(); }
});

test('stale outbox entries of one run: one visible salvage line, the rest internal', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    await h.action(alice, run.card_id, 'stop');
    for (let i = 0; i < 4; i++) await r.out({ kind: 'progress.append', ...runMsg(run), text: `late ${i}` });
    const kinds = h.db.all('SELECT kind FROM events WHERE run_id = ? AND kind IN (\'salvage\', \'outbox_dropped\')', run.run_id).map((e) => e.kind);
    assert.deepEqual(kinds, ['salvage', 'outbox_dropped', 'outbox_dropped', 'outbox_dropped']);
    const feed = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body.feed;
    assert.equal(feed.filter((e) => e.kind === 'salvage').length, 1);
  } finally { await h.destroy(); }
});

test('commands queued for an offline device are bounded in size and age', async () => {
  const h = await startHub();
  try {
    for (let i = 0; i < 60; i++) h.hub.sendToDevice('dev-away', { type: 'cmd', cmd_id: `c${i}`, run_id: 'r', card_id: 'c', fence: 1, cmd: 'stop' }, { queue: true });
    assert.equal(h.hub.pendingCmds.get('dev-away').length, 50);
    h.clock.advance(31 * 60_000);
    await h.tick();
    assert.equal(h.hub.pendingCmds.has('dev-away'), false);
    assert.deepEqual(h.hub.takePendingCmds('dev-away'), []);
  } finally { await h.destroy(); }
});

test('a handing_over run gets handover_begin again when its runner reconnects (hub restart or a drop)', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r = await h.runner(dev);
    const run = await h.startRun(alice, r);
    assert.equal((await h.action(alice, run.card_id, 'hand_over', { target: { kind: 'queue' } })).status, 200);
    const first = await r.next('cmd', (m) => m.cmd === 'handover_begin');
    r.terminate();
    const r2 = await h.runner(dev, { hello: false });
    await r2.hello([{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'running' }]);
    const again = await r2.next('cmd', (m) => m.cmd === 'handover_begin' && m.run_id === run.run_id);
    assert.equal(again.fence, run.fence);
    assert.notEqual(again.cmd_id, first.cmd_id);
  } finally { await h.destroy(); }
});
