// Real hub/runner protocol with disposable identities. This is a managed
// board-run move, never a claim to stop an observed provider conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub, runMsg, runHb } from './helpers.js';
import { T_HANDOVER_MS } from '../../shared/liveness.js';

async function rig(fn) {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    const pin = { expected_fence: run.fence, prior_run_id: run.run_id };
    await fn({ h, alice, runner, run, pin });
  } finally { await h.destroy(); }
}
const proof = { stop_confirmed: true, checkpoint_confirmed: true, handover_written: true };
async function prepare({ h, alice, runner, run, pin }) {
  const requested = await h.action(alice, run.card_id, 'hand_over', { target: { kind: 'hold' }, ...pin });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal(requested.body.card.handover_hold, true);
  await runner.next('cmd', m => m.cmd === 'handover_begin');
}
async function checkpoint({ runner, run }) {
  await runner.out({ kind: 'handover.write', ...runMsg(run), patch: { done: ['implemented parser'], next: 'check the empty case' } });
  await runner.out({ kind: 'snapshot', ...runMsg(run), status: 'pushed', sha: 'a'.repeat(40), ref: `refs/board/${run.key}/r${run.fence}` });
}

test('managed move waits for exact stop/doc/code proof, holds, then Codex receives the handover seed', () => rig(async (f) => {
  const { h, alice, runner, run, pin } = f;
  await prepare(f);
  const early = await h.action(alice, run.card_id, 'take_over_with_claude', { ...pin, request_id: randomUUID(), ai: 'codex', budget_usd: null });
  assert.equal(early.status, 409);
  await checkpoint(f);
  await runner.out({ kind: 'handover.complete', ...runMsg(run), ...proof });
  await h.hub.idle();
  assert.equal(h.card(run.card_id).run_state, 'handed_over', 'no automatic follow-up starts another AI');
  assert.equal(h.hub.pendingDispatch(run.card_id), null);
  const view = (await h.api(alice, 'GET', `/api/cards/${run.card_id}`)).body.card;
  assert.equal(view.handover_provenance, 'checkpoint_complete');
  assert.equal(view.handover_hold, true);
  const nextPin = { expected_fence: view.fence, prior_run_id: view.run.id };
  const stale = await h.action(alice, run.card_id, 'take_over_with_claude', { ...pin, request_id: randomUUID(), ai: 'codex', budget_usd: null });
  assert.equal(stale.status, 409, 'stale displayed fence cannot switch a later run');
  const next = await h.action(alice, run.card_id, 'take_over_with_claude', { ...nextPin, request_id: randomUUID(), ai: 'codex', budget_usd: null });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const dispatch = h.hub.pendingDispatch(run.card_id);
  assert.equal(dispatch.backend, 'codex_cli');
  const seed = h.hub.offerFrame(run.card_id).seed;
  assert.match(seed.handover_md, /implemented parser/);
  assert.match(seed.handover_md, /check the empty case/);
  assert.equal(seed.from_snapshot.sha, 'a'.repeat(40));
}));

test('held move refuses legacy/missing/false stop, narrative and checkpoint confirmations', () => rig(async (f) => {
  await prepare(f);
  const { h, runner, run } = f;
  // Flags cannot substitute for actual persisted final narrative/snapshot.
  await runner.out({ kind: 'handover.complete', ...runMsg(run), ...proof });
  assert.equal(h.card(run.card_id).run_state, 'handing_over');
  await checkpoint(f);
  for (const flags of [{}, { ...proof, stop_confirmed: false }, { ...proof, handover_written: false }, { ...proof, checkpoint_confirmed: false }]) {
    await runner.out({ kind: 'handover.complete', ...runMsg(run), ...flags });
    assert.equal(h.card(run.card_id).run_state, 'handing_over');
  }
  await runner.out({ kind: 'snapshot', ...runMsg(run), status: 'push_failed', sha: 'a'.repeat(40), ref: `refs/board/${run.key}/r${run.fence}` });
  await runner.out({ kind: 'handover.complete', ...runMsg(run), ...proof });
  assert.equal(h.card(run.card_id).run_state, 'handing_over');
}));

test('handover timeout never auto-starts replacement or allows take-myself bypass', () => rig(async (f) => {
  await prepare(f);
  const { h, alice, runner, run } = f;
  for (let ms = 0; ms <= T_HANDOVER_MS; ms += 15000) {
    h.clock.advance(15000); await runner.hb([runHb(run)]); await h.tick();
  }
  await h.hub.idle();
  const c = h.card(run.card_id);
  assert.equal(c.run_state, 'handed_over');
  assert.equal(c.handover_provenance, 'checkpoint_incomplete');
  assert.equal(h.hub.pendingDispatch(run.card_id), null);
  const body = { expected_fence: c.fence, prior_run_id: run.run_id, request_id: randomUUID(), ai: 'codex', budget_usd: null };
  assert.equal((await h.action(alice, run.card_id, 'take_over_with_claude', body)).status, 409);
  assert.equal((await h.action(alice, run.card_id, 'take_over_myself')).status, 409);
  assert.equal(h.card(run.card_id).run_state, 'handed_over');
}));

test('same-clock pre-request handover and snapshot never satisfy a newly requested move', () => rig(async (f) => {
  await checkpoint(f);
  await prepare(f);
  const { h, runner, run } = f;
  await runner.out({ kind: 'handover.complete', ...runMsg(run), ...proof });
  assert.equal(h.card(run.card_id).run_state, 'handing_over');
  await runner.out({ kind: 'handover.write', ...runMsg(run), patch: { next: 'fresh final handover' } });
  await runner.out({ kind: 'snapshot', ...runMsg(run), status: 'unchanged', sha: 'a'.repeat(40), ref: `refs/board/${run.key}/r${run.fence}` });
  await runner.out({ kind: 'handover.complete', ...runMsg(run), ...proof });
  assert.equal(h.card(run.card_id).run_state, 'handing_over', 'new narrative cannot freshen an old checkpoint');
  await runner.out({ kind: 'snapshot', ...runMsg(run), status: 'pushed', sha: 'b'.repeat(40), ref: `refs/board/${run.key}/r${run.fence}` });
  await runner.out({ kind: 'handover.complete', ...runMsg(run), ...proof });
  assert.equal(h.card(run.card_id).run_state, 'handed_over');
}));

test('move binds the displayed run and preserves unrelated member and viewer refusal', () => rig(async (f) => {
  const { h, alice, run, pin } = f;
  for (const wrong of [{}, { ...pin, expected_fence: pin.expected_fence + 1 }, { ...pin, prior_run_id: 'different-run' }]) {
    assert.equal((await h.action(alice, run.card_id, 'hand_over', { target: { kind: 'hold' }, ...wrong })).status, 409);
    assert.equal(h.card(run.card_id).run_state, 'running');
  }
  const bob = await h.login('bob');
  assert.equal((await h.action(bob, run.card_id, 'hand_over', { target: { kind: 'hold' }, ...pin })).status, 403);
  assert.equal(h.card(run.card_id).run_state, 'running');
}));

test('stop during a held move cannot launder it through retry or takeover', () => rig(async (f) => {
  await prepare(f);
  const { h, alice, run } = f;
  assert.equal((await h.action(alice, run.card_id, 'stop')).status, 200);
  assert.equal(h.card(run.card_id).run_state, 'failed');
  assert.equal(JSON.parse(h.card(run.card_id).handover_target).kind, 'hold');
  assert.equal((await h.action(alice, run.card_id, 'retry', { request_id: randomUUID(), ai: 'codex', budget_usd: null })).status, 409);
  assert.equal((await h.action(alice, run.card_id, 'take_over')).status, 409);
  assert.equal(h.hub.pendingDispatch(run.card_id), null);
}));
