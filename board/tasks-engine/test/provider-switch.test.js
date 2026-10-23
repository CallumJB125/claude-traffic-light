import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { providerFixture } from './provider-switch-helpers.js';
import { startEngine, waitFor } from './helpers.js';
import { validate } from '../../tasks-api/validate.js';
import { SCHEMA } from '../engine.js';
const local = process.platform === 'win32' ? test.skip : test;
async function setup(t, opts) { const h = await providerFixture(opts); t.after(() => h.cleanup()); return h; }
const preview = async (h, id) => (await h.client.act(id, 'switchAi', { phase: 'preview', ai: 'codex' })).providerChange;
const apply = (h, id, r) => h.client.act(id, 'switchAi', { phase: 'apply', reviewId: r.id, reviewHash: r.hash, confirm: true });
const addPending = (h, id, messageId, body) => h.eng.engine.messages.add(id, { id: messageId, direction: 'in', body,
  from: { kind: 'human', id: 'you' }, createdAt: Date.now(), deliveredAt: null });
local('reviewed cross-provider handover starts a fresh real adapter session and preserves worktree, context and permissions', async t => {
  const h = await setup(t), id = await h.parked({ model: 'claude-fixture-model' }), before = await h.client.getTask(id);
  assert.ok(before.actions.includes('switchAi'));
  await assert.rejects(h.client.act(id, 'switchAi', { ai: 'codex' }), e => e.code === 'VALIDATION');
  const r = await preview(h, id); assert.equal(r.from, 'claude'); assert.equal(r.to, 'codex'); assert.match(r.patch, /original contribution/);
  assert.equal(h.log().length, 0); assert.equal(h.task(id).ai.id, 'claude');
  const result = await apply(h, id, r); assert.equal(result.providerChange.status, 'queued'); assert.equal(validate(SCHEMA, 'ActResult', result), null);
  await waitFor(() => h.task(id).state === 'in_review');
  const task = h.task(id), start = h.log().find(x => x.kind === 'start'), prompt = h.log().find(x => x.kind === 'prompt').prompt;
  assert.equal(task.worktree, before.worktree); assert.equal(task.branch, before.branch); assert.equal(task.permissionLevel, before.permissionLevel);
  assert.notEqual(task.sessionId, before.sessionId); assert.equal(task.ai.id, 'codex'); assert.equal(task.ai.model, null);
  assert.equal(start.argv.includes('resume'), false); assert.equal(start.argv.includes('claude-fixture-model'), false);
  assert.match(prompt, /reviewed handover from a different AI/); assert.match(prompt, /Preserve original contribution/); assert.match(prompt, /<untrusted_board_content_/);
  assert.equal(fs.readFileSync(path.join(task.worktree, 'original.txt'), 'utf8'), 'original contribution\n');
  assert.equal(fs.readFileSync(path.join(task.worktree, 'codex-result.txt'), 'utf8'), 'fixture edit\n');
  assert.equal(fs.existsSync(path.join(h.repo.checkout, 'codex-result.txt')), false);
  assert.equal(task.providerTransitions.length, 1); assert.equal(task.providerTransitions[0].oldSession, before.sessionId);
  await assert.rejects(apply(h, id, r), e => ['CONFLICT', 'ILLEGAL_TRANSITION'].includes(e.code));
});
for (const change of ['files', 'checkpoint', 'provider', 'expiry']) local(`a reviewed handover spanning changed ${change} cannot start the new AI`, async t => {
  let clock = Date.now(); const h = await setup(t, { now: () => clock }), id = await h.parked(), r = await preview(h, id);
  if (change === 'files') fs.appendFileSync(path.join(h.task(id).worktree, 'original.txt'), 'later user edit\n');
  if (change === 'checkpoint') {
    const p = h.task(id).checkpoint; await h.client.saveCheckpoint(id, p.version, { brief: p.brief, decisions: ['New scope'], progress: p.progress, nextAction: p.nextAction, artifacts: p.artifacts, reportedChecks: p.reportedChecks });
  }
  if (change === 'provider') h.eng.engine.ais.find(x => x.id === 'codex').version = 'changed';
  if (change === 'expiry') clock += 300001;
  await assert.rejects(apply(h, id, r), e => e.code === 'CONFLICT'); assert.equal(h.log().length, 0); assert.equal(h.task(id).ai.id, 'claude'); assert.equal(h.task(id).state, 'parked');
});
local('an unsupported budget or approval capability cannot be silently dropped during provider change', async t => {
  const h = await setup(t), id = await h.parked();
  h.task(id).cost.budgetUsd = 2;
  assert.equal((await h.client.getTask(id)).actions.includes('switchAi'), false);
  await assert.rejects(preview(h, id), e => e.code === 'ILLEGAL_TRANSITION');
  h.task(id).cost.budgetUsd = null; h.task(id).permissionLevel = 'ask';
  assert.equal((await h.client.getTask(id)).actions.includes('switchAi'), false); assert.equal(h.log().length, 0);
});
local('relay participants cannot review or apply a cross-provider handover', async t => {
  const h = await setup(t), id = await h.parked();
  await assert.rejects(h.eng.engine.act({ id, action: 'switchAi', payload: { phase: 'preview', ai: 'codex' }, requestId: crypto.randomUUID() },
    { principal: { kind: 'relay', id: 'synthetic-relay', source: 'phone', userId: 'person', taskIds: [id] } }), e => e.code === 'POLICY_DENIED');
  assert.equal(h.log().length, 0);
});
local('a queued handover rechecks its exact source before provider launch', async t => {
  const h = await setup(t), id = await h.parked(), originalSession = h.task(id).sessionId;
  addPending(h, id, 'queued-source-note', 'Keep this note pending until dispatch');
  const r = await preview(h, id);
  h.eng.engine.limits.maxParallel = 0;
  await apply(h, id, r); assert.equal(h.task(id).state, 'queued');
  assert.deepEqual(h.eng.engine.messages.pending(id).map(m => m.id), ['queued-source-note']);
  fs.appendFileSync(path.join(h.task(id).worktree, 'original.txt'), 'later user edit\n');
  await h.client.setLimits({ maxParallel: 1 });
  await waitFor(() => h.task(id).state === 'parked'); assert.equal(h.task(id).ai.id, 'claude'); assert.equal(h.task(id).providerTransitions.at(-1).status, 'refused-before-launch');
  assert.equal(h.task(id).sessionId, originalSession); assert.deepEqual(h.eng.engine.messages.pending(id).map(m => m.id), ['queued-source-note']);
  assert.equal(h.log().length, 0); assert.match(fs.readFileSync(path.join(h.task(id).worktree, 'original.txt'), 'utf8'), /later user edit/);
});
local('queued handover marks only reviewed messages at provider dispatch', async t => {
  const h = await setup(t), id = await h.parked();
  addPending(h, id, 'reviewed-note', 'Reviewed note for the new AI');
  const r = await preview(h, id);
  h.eng.engine.limits.maxParallel = 0; await apply(h, id, r);
  assert.deepEqual(h.eng.engine.messages.pending(id).map(m => m.id), ['reviewed-note']);
  addPending(h, id, 'later-note', 'A later note outside this handover');
  const originalStart = h.backends.codex.prototype.start; let pendingAtFirstStart;
  h.backends.codex.prototype.start = function (prompt) {
    pendingAtFirstStart ??= h.eng.engine.messages.pending(id).map(m => m.id);
    return originalStart.call(this, prompt);
  };
  await h.client.setLimits({ maxParallel: 1 });
  await waitFor(() => h.task(id).state === 'in_review');
  assert.deepEqual(pendingAtFirstStart, ['later-note']);
  const prompt = h.log().find(x => x.kind === 'prompt').prompt;
  assert.match(prompt, /Reviewed note for the new AI/); assert.doesNotMatch(prompt, /A later note outside this handover/);
});
local('review includes pending task messages and later messages retire it before retargeting', async t => {
  const h = await setup(t), id = await h.parked();
  await h.client.act(id, 'message', { body: 'Carry this reviewed task note' }).catch(e => { assert.equal(e.code, 'ILLEGAL_TRANSITION'); });
  // Parked task messages arrive through the existing local message store. Their
  // sender/recipient records remain the authority; no renderer fields are used.
  h.eng.engine.messages.add(id, { id: 'message-switch-test', direction: 'in', body: 'Carry this reviewed task note', from: { kind: 'human', id: 'you' }, createdAt: Date.now(), deliveredAt: null });
  const r = await preview(h, id); assert.match(r.messagesText, /Carry this reviewed task note/);
  h.eng.engine.messages.add(id, { id: 'message-switch-later', direction: 'in', body: 'New instructions for original task', from: { kind: 'human', id: 'you' }, createdAt: Date.now(), deliveredAt: null });
  await assert.rejects(apply(h, id, r), e => e.code === 'CONFLICT'); assert.equal(h.log().length, 0); assert.equal(h.task(id).ai.id, 'claude');
});
local('a queued provider review expires before launch without a provider effect', async t => {
  let clock = Date.now(); const h = await setup(t, { now: () => clock }), id = await h.parked(), originalSession = h.task(id).sessionId;
  addPending(h, id, 'queued-expiry-note', 'Do not consume a note for an expired review');
  const r = await preview(h, id);
  h.eng.engine.limits.maxParallel = 0; await apply(h, id, r); clock += 300001;
  await h.client.setLimits({ maxParallel: 1 }); await waitFor(() => h.task(id).state === 'parked');
  assert.equal(h.log().length, 0); assert.equal(h.task(id).ai.id, 'claude');
  assert.equal(h.task(id).sessionId, originalSession); assert.deepEqual(h.eng.engine.messages.pending(id).map(m => m.id), ['queued-expiry-note']);
  assert.equal((await h.client.getTask(id)).actions.includes('retry'), false); assert.equal((await h.client.getTask(id)).actions.includes('switchAi'), true);
});
for (const reason of ['unavailable', 'stop', 'restart', 'timeout']) local(`a ${reason} before handover dispatch preserves the original provider and pending note`, async t => {
  const h = await setup(t), id = await h.parked(), originalSession = h.task(id).sessionId;
  addPending(h, id, 'undispatched-note', 'This message needs an actual dispatch');
  const r = await preview(h, id);
  h.eng.engine.limits.maxParallel = 0; await apply(h, id, r);
  if (reason === 'stop') {
    await h.client.act(id, 'stop'); assert.equal(h.task(id).state, 'failed');
  } else if (reason === 'restart') {
    await h.close();
    const restarted = await startEngine({ dir: h.dir, engineOpts: { backends: h.backends } });
    try {
      const restored = restarted.eng.tasks.get(id);
      assert.equal(restored.state, 'parked'); assert.equal(restored.ai.id, 'claude'); assert.equal(restored.sessionId, originalSession);
      assert.deepEqual(restarted.eng.engine.messages.pending(id).map(m => m.id), ['undispatched-note']);
      assert.equal(h.log().length, 0);
    } finally { await restarted.close(); }
    return;
  } else {
    let release;
    if (reason === 'unavailable') h.eng.engine.ais.find(x => x.id === 'codex').bin = null;
    else {
      h.eng.engine.opts.launchTimeoutMs = 30;
      const inspect = h.eng.engine.integration.inspectSource;
      const paused = new Promise(resolve => { release = resolve; });
      h.eng.engine.integration.inspectSource = async (...args) => { await paused; return inspect(...args); };
    }
    try { await h.client.setLimits({ maxParallel: 1 }); await waitFor(() => h.task(id).state === 'parked'); }
    finally { release?.(); }
  }
  assert.equal(h.task(id).ai.id, 'claude'); assert.equal(h.task(id).sessionId, originalSession);
  assert.deepEqual(h.eng.engine.messages.pending(id).map(m => m.id), ['undispatched-note']); assert.equal(h.log().length, 0);
});
local('a prior provider plan approval cannot authorize edits for the new provider', async t => {
  const h = await setup(t), id = await h.parked(); h.task(id).planFirst = true; h.task(id).planApproved = true;
  const r = await preview(h, id); assert.equal(r.planFirst, true); await apply(h, id, r);
  await waitFor(() => h.task(id).state === 'blocked' && h.task(id).openAsk?.kind === 'plan');
  assert.equal(h.task(id).planApproved, false);
  const start = h.log().find(x => x.kind === 'start'); assert.ok(start.argv.some(s => s.includes('\":workspace_roots\"=\"read\"')));
});
// Review #42 finding 7: a provider switch is the person's own reviewed choice; the spend cap and usage windows that
// hold new wrapper tasks never block it (#switchTarget routes with gates:false).
local('a provider switch is not held by the spend cap or the next AI\'s usage window', async t => {
  let gate = null;
  const h = await setup(t, { spendGate: () => gate }), id = await h.parked();
  gate = { v: 1, cap: 'Plexiform budget cap reached' };
  h.eng.engine.usage.codex = { status: 'rejected', resetsAt: Date.now() + 3600e3, utilization: 1 };
  assert.ok((await h.client.getTask(id)).actions.includes('switchAi'));
  const r = await preview(h, id); assert.equal(r.to, 'codex');
});
