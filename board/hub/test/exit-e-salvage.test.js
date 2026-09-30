// Exit (e): a revived first laptop is fenced. Its HB gets current:false
// (FENCED), its outbox writes are acked and dropped (salvage note), its RPCs
// fail FENCED, and its salvage is stored — promoted per D7 while no newer run
// was claimed, recorded only once one was.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, runHb, runMsg } from './helpers.js';

test('exit (e): zombie with a stale fence gets current:false; its writes are rejected; salvage stored and promoted', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const devA = await h.enroll(alice, 'Laptop-A');
    const a1 = await h.runner(devA);
    const run = await h.startRun(alice, a1);
    await a1.out({ kind: 'handover.write', ...runMsg(run), patch: { hypothesis: 'h1' } });

    a1.terminate();                       // laptop A goes dark
    await h.run(60_000);
    assert.equal(h.card(run.card_id).run_state, 'unresponsive');
    const noConfirm = await h.action(alice, run.card_id, 'take_over');
    assert.equal(noConfirm.status, 428);
    assert.equal(noConfirm.body.error.code, 'CONFIRM_REQUIRED');
    const took = await h.action(alice, run.card_id, 'take_over', { confirm: true });
    assert.equal(took.status, 200);
    const c = h.card(run.card_id);
    assert.deepEqual([c.run_state, c.fence], ['handed_over', run.fence + 1]);
    assert.equal(h.db.get("SELECT count(*) AS n FROM memories WHERE card_id = ? AND kind = 'handoff'", run.card_id).n, 1);

    // Laptop A revives with its old run.
    const a2 = await h.runner(devA, { advertise: false, runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'paused_offline' }] });
    const fenced = await a2.next('fenced', (m) => m.run_id === run.run_id);
    assert.deepEqual([fenced.held_fence, fenced.current_fence], [run.fence, run.fence + 1]);
    const stop = await a2.next('cmd', (m) => m.run_id === run.run_id && m.cmd === 'stop');
    assert.equal(stop.fence, run.fence);

    const ack = await a2.hb([runHb(run)]);
    assert.deepEqual([ack.runs[0].current, ack.runs[0].reason], [false, 'FENCED']);
    assert.equal(h.card(run.card_id).run_state, 'handed_over', 'a stale HB changes nothing');

    // Stale outbox entry: acked, dropped, recorded as salvage note.
    const before = h.db.get('SELECT count(*) AS n FROM handovers WHERE card_id = ?', run.card_id).n;
    const out = await a2.out({ kind: 'handover.write', ...runMsg(run), patch: { hypothesis: 'zombie write' } });
    assert.equal(out.seq, a2.seq, 'acked');
    assert.equal(h.db.get('SELECT count(*) AS n FROM handovers WHERE card_id = ?', run.card_id).n, before, 'not applied');
    const note = h.db.get("SELECT * FROM events WHERE card_id = ? AND kind = 'salvage' AND seq = ?", run.card_id, a2.seq);
    assert.equal(JSON.parse(note.payload).reason, 'FENCED');
    const failed = await a2.out({ kind: 'run.failed', ...runMsg(run), fail_kind: 'error', reason: 'x' });
    assert.ok(failed);
    assert.equal(h.card(run.card_id).run_state, 'handed_over');

    // RPC with the old token: FENCED.
    const rpc = await a2.rpc(run, 'board_get_card', {});
    assert.equal(rpc.ok, false);
    assert.equal(rpc.error.code, 'FENCED');

    // Salvage lane accepts the stale fence; promoted (most recent run, no newer claim).
    a2.send({ type: 'salvage', ...runMsg(run), kind: 'handover', payload: { patch: { hypothesis: 'final words', next: 'check toJSON' } } });
    a2.send({ type: 'salvage', ...runMsg(run), kind: 'snapshot', payload: { sha: 'feedbee1', ref: `refs/board/${run.key}/r${run.fence}-salvage`, status: 'pushed' } });
    await a2.hb([]);
    const detail = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body;
    assert.equal(detail.handover.doc.sections.hypothesis, 'final words');
    const top = h.db.get('SELECT * FROM handovers WHERE card_id = ? ORDER BY version DESC LIMIT 1', run.card_id);
    assert.equal(top.provenance, 'post_fence');
    assert.equal(detail.run.snapshot.sha, 'feedbee1');
    assert.ok(detail.handover.doc.sections.salvage.length >= 2);
    assert.ok(detail.feed.some((e) => e.kind === 'salvage' && e.data.promoted === true));

    // Take over with Claude on laptop B → a newer run; later zombie salvage is only recorded.
    const devB = await h.enroll(alice, 'Laptop-B');
    const b = await h.runner(devB);
    const re = await h.action(alice, run.card_id, 'take_over_with_claude');
    assert.equal(re.status, 200);
    const offer = await b.next('offer', (o) => o.card_id === run.card_id);
    assert.match(offer.seed.handover_md, /final words/);
    assert.deepEqual(offer.seed.from_snapshot, { ref: `refs/board/${run.key}/r${run.fence}-salvage`, sha: 'feedbee1' });
    const cl = await b.claim(offer);
    assert.equal(cl.ok, true);
    assert.equal(cl.fence, run.fence + 2);
    a2.send({ type: 'salvage', ...runMsg(run), kind: 'handover', payload: { patch: { hypothesis: 'late zombie' } } });
    await a2.hb([]);
    assert.notEqual(JSON.parse(h.db.get('SELECT sections FROM handovers WHERE card_id = ? ORDER BY version DESC LIMIT 1', run.card_id).sections).hypothesis, 'late zombie');
    const last = h.db.get("SELECT payload FROM events WHERE card_id = ? AND kind = 'salvage' ORDER BY id DESC LIMIT 1", run.card_id);
    assert.equal(JSON.parse(last.payload).promoted, false);
  } finally {
    await h.destroy();
  }
});

test('exit (e): outbox dedupes by (device, seq), applies in order, acks cumulatively', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    const base = r.seq;
    await r.out({ kind: 'progress.append', ...runMsg(run), text: 'one' }, { seq: base + 1 });
    await r.out({ kind: 'progress.append', ...runMsg(run), text: 'one again' }, { seq: base + 1 });
    // out of order: +3 buffered until +2 arrives, then one cumulative ack.
    await r.out({ kind: 'progress.append', ...runMsg(run), text: 'three' }, { seq: base + 3, wait: false });
    const ack = await r.out({ kind: 'progress.append', ...runMsg(run), text: 'two' }, { seq: base + 2 });
    assert.ok(ack.seq >= base + 3);
    await r.hb([]);
    const texts = h.db.all("SELECT payload FROM events WHERE card_id = ? AND kind = 'progress' ORDER BY id", run.card_id).map((e) => JSON.parse(e.payload).text);
    assert.deepEqual(texts, ['one', 'two', 'three']);
    assert.equal(h.db.get('SELECT last_seq_acked FROM devices WHERE id = ?', r.dev.device_id).last_seq_acked, base + 3);
  } finally {
    await h.destroy();
  }
});
