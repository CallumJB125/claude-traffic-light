import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connect } from '../../tasks-api/client.js';
import { addRelayToken, revokeRelayToken } from '../relay-tokens.js';
import { waitFor } from './helpers.js';
import { startCodexFixture as setup } from './codex-helpers.js';

const data = () => ({ brief: 'Repair the route', decisions: ['Keep the existing API.'], progress: 'The handler is ready for review.', nextAction: 'Run the scoped regression.', artifacts: [{ kind: 'path', path: 'README.md' }], reportedChecks: ['Participant says unit checks passed.'] });
const code = (expected) => (e) => e.code === expected;
async function failed(h) {
  const { id } = await h.client.createTask({ text: 'Checkpoint fixture', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
  await waitFor(() => h.task(id)?.state === 'failed');
  return id;
}

test('real socket packet save uses current author/version and reports cannot forge observed evidence or authority', async () => {
  const h = await setup({ error: 'Fixture failure' });
  try {
    const id = await failed(h), before = (await h.client.getTask(id)).checkpoint;
    const d = data(); d.progress += ` Bearer ${'x'.repeat(40)} /opt/private/file https://u:secret@example.test/view?key=abc`;
    const { checkpoint: p } = await h.client.saveCheckpoint(id, before.version, d, { requestId: 'save-once' });
    assert.equal(p.version, before.version + 1);
    assert.deepEqual(p.author, { kind: 'human', id: 'local-owner', source: 'local' });
    assert.equal(p.provenance, 'participant'); assert.equal(p.observed.state, 'failed');
    assert.notEqual(p.observed.tests, 'pass'); assert.equal(h.task(id).planApproved, false);
    const serialized = JSON.stringify(p); for (const secret of ['x'.repeat(40), '/opt/', 'secret', '?key=']) assert.ok(!serialized.includes(secret));
    assert.deepEqual((await h.client.saveCheckpoint(id, before.version, d, { requestId: 'save-once' })).checkpoint, p);
    await assert.rejects(h.client.saveCheckpoint(id, before.version, { ...d, nextAction: 'different' }, { requestId: 'save-once' }), code('CONFLICT'));
    await assert.rejects(h.client.saveCheckpoint(id, before.version, d), code('CONFLICT'));
    await assert.rejects(h.client.saveCheckpoint(id, p.version, { ...d, planApproved: true }), code('VALIDATION'));
    const stored = fs.readFileSync(h.eng.engine.store.tasksFile, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.task.id === id).at(-1).task;
    assert.deepEqual(stored.checkpoint, p); assert.ok(!stored.audit.some((a) => a.detail?.includes('Bearer')));
  } finally { await h.cleanup(); }
});

test('relay checkpoint edits have authenticated provenance and queued revoked grants cannot save or read another task', async () => {
  const h = await setup({ error: 'Fixture failure' }); let relay;
  try {
    const id = await failed(h), foreign = await failed(h);
    const token = addRelayToken({ dataDir: h.dataDir, source: 'phone', userId: 'reviewer', taskIds: [id] });
    relay = await connect({ socketPath: h.eng.socketPath, token });
    const current = (await relay.getTask(id)).checkpoint;
    const { checkpoint: p } = await relay.saveCheckpoint(id, current.version, data());
    assert.deepEqual(p.author, { kind: 'remote', id: 'reviewer', source: 'phone' });
    await assert.rejects(relay.getTask(foreign), code('NOT_FOUND'));
    await assert.rejects(relay.saveCheckpoint(foreign, h.task(foreign).checkpoint.version, data()), code('NOT_FOUND'));
    let release; h.eng.engine.locks.set(id, new Promise((r) => { release = r; }));
    const waiting = relay.saveCheckpoint(id, p.version, { ...data(), nextAction: 'DO-NOT-SAVE' }, { requestId: 'revoked-save' }).then(() => null, (e) => e);
    await waitFor(() => [...h.eng.engine.actCache.keys()].some((k) => k.endsWith(':revoked-save')));
    revokeRelayToken({ dataDir: h.dataDir, token }); release();
    assert.equal((await waiting).code, 'UNAUTHENTICATED');
    assert.equal((await h.client.getTask(id)).checkpoint.version, p.version);
    assert.ok(!JSON.stringify(h.task(id).checkpoint).includes('DO-NOT-SAVE'));
  } finally { relay?.close(); await h.cleanup(); }
});

test('saved packet survives engine restart and a torn store tail without auto-starting or trusting old requests', async () => {
  const h = await setup({ error: 'Fixture failure' });
  try {
    const id = await failed(h), current = h.task(id).checkpoint;
    const { checkpoint: p } = await h.client.saveCheckpoint(id, current.version, data());
    const runs = h.log().filter((x) => x.kind === 'start').length;
    await h.restart({ beforeStart: (old) => fs.appendFileSync(old.eng.engine.store.tasksFile, '{"task":{"checkpoint":') });
    assert.deepEqual((await h.client.getTask(id)).checkpoint, p);
    assert.equal(h.log().filter((x) => x.kind === 'start').length, runs);
    await assert.rejects(h.client.saveCheckpoint(id, p.version - 1, data()), code('CONFLICT'));
    assert.equal((await h.client.saveCheckpoint(id, p.version, data())).checkpoint.version, p.version + 1);
  } finally { await h.cleanup(); }
});

test('orphan recovery preserves a participant packet and fresh restart seeds only sanitized context under the current plan gate', async () => {
  const h = await setup({ wait: true });
  try {
    const { id } = await h.client.createTask({ text: 'Recover a plan', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits', planFirst: true });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    const p = (await h.client.saveCheckpoint(id, h.task(id).checkpoint.version, { ...data(), nextAction: 'RECOVERY-NEXT-ACTION', progress: 'A durable participant summary.' })).checkpoint;
    await h.restart({ leaveRuns: true });
    const t = h.task(id); assert.equal(t.state, 'orphaned'); assert.ok(t.checkpoint.version > p.version);
    assert.equal(t.checkpoint.nextAction, 'RECOVERY-NEXT-ACTION'); assert.deepEqual(t.checkpoint.decisions, p.decisions);
    h.setScenario({ text: 'A recovered plan' });
    await h.client.act(id, 'retry', { fresh: true });
    await waitFor(() => h.task(id)?.openAsk);
    const run = h.log().filter((x) => x.kind === 'start').at(-1), prompt = h.log().filter((x) => x.kind === 'prompt').at(-1).prompt;
    assert.ok(!run.argv.includes('resume')); assert.ok(run.argv.some((s) => s.includes('\":workspace_roots\"=\"read\"')));
    assert.match(prompt, /RECOVERY-NEXT-ACTION/); assert.match(prompt, /untrusted|UNTRUSTED/i);
    assert.equal(h.task(id).planApproved, false); assert.equal(h.task(id).permissionLevel, 'auto-edits');
  } finally { await h.cleanup(); }
});

test('fresh retry never restores an earlier plan approval from a successful session or packet', async () => {
  const h = await setup({ text: 'First plan' });
  try {
    const { id } = await h.client.createTask({ text: 'Fresh approval required', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits', planFirst: true });
    await waitFor(() => h.task(id)?.openAsk);
    await h.client.act(id, 'answer', { askId: h.task(id).openAsk.askId, answer: 'yes' });
    await waitFor(() => h.task(id)?.state === 'in_review'); assert.equal(h.task(id).planApproved, true);
    h.setScenario({ error: 'Fixture turn failure' });
    await h.client.act(id, 'message', { body: 'Continue with another turn.' });
    await waitFor(() => h.task(id)?.state === 'failed');
    await h.client.saveCheckpoint(id, h.task(id).checkpoint.version, data());
    h.setScenario({ text: 'A fresh plan for review' });
    await h.client.act(id, 'retry', { fresh: true });
    await waitFor(() => h.task(id)?.openAsk);
    assert.equal(h.task(id).planApproved, false);
    const starts = h.log().filter((x) => x.kind === 'start');
    assert.ok(starts.at(-1).argv.some((s) => s.includes('\":workspace_roots\"=\"read\"')));
    assert.ok(!starts.at(-1).argv.includes('resume'));
    assert.equal(h.task(id).state, 'blocked'); assert.equal(h.task(id).openAsk.kind, 'plan');
  } finally { await h.cleanup(); }
});

test('fresh retry upgrades a legacy handover through packet sanitization before seeding a new session', async () => {
  const h = await setup({ error: 'Fixture failure' });
  try {
    const id = await failed(h), task = h.task(id);
    delete task.checkpoint; delete task.checkpointAssistant;
    task.lastAssistant = `Legacy summary Bearer ${'z'.repeat(40)} /opt/other/private`;
    task.handover = { version: 7, markdown: `Old raw markdown Bearer ${'z'.repeat(40)}`, provenance: 'frozen', at: Date.now() };
    h.eng.engine.store.saveTask(task, h.eng.tasks);
    await h.restart(); assert.equal((await h.client.getTask(id)).checkpoint, null);
    h.setScenario({ text: 'Fresh legacy recovery' }); await h.client.act(id, 'retry', { fresh: true });
    await waitFor(() => h.task(id)?.state === 'in_review');
    const prompt = h.log().filter((x) => x.kind === 'prompt').at(-1).prompt;
    assert.match(prompt, /Legacy summary/); assert.ok(!prompt.includes('z'.repeat(40))); assert.ok(!prompt.includes('/opt/other/'));
    assert.ok(h.task(id).checkpoint.version > 7);
  } finally { await h.cleanup(); }
});

test('large new assistant progress keeps a bounded participant packet without stopping the supervisor', async () => {
  const h = await setup({ text: 'Initial review' });
  try {
    const { id } = await h.client.createTask({ text: 'Bounded packet fixture', cwd: h.repo.checkout, ai: 'codex' });
    await waitFor(() => h.task(id)?.state === 'in_review');
    const p = (await h.client.saveCheckpoint(id, h.task(id).checkpoint.version, { ...data(), brief: '字'.repeat(1000), decisions: Array(20).fill('字'.repeat(500)), reportedChecks: Array(20).fill('字'.repeat(500)), progress: '', artifacts: [] })).checkpoint;
    h.setScenario({ text: '字'.repeat(4000) }); await h.client.act(id, 'message', { body: 'Continue the review.' });
    await waitFor(() => h.task(id)?.turn >= 2 && h.task(id).state === 'in_review');
    const latest = (await h.client.getTask(id)).checkpoint;
    assert.ok(Buffer.byteLength(JSON.stringify(latest)) <= 64 * 1024); assert.deepEqual(latest.decisions, p.decisions); assert.deepEqual(latest.reportedChecks, p.reportedChecks);
    assert.equal(latest.nextAction, p.nextAction); assert.ok(latest.version > p.version);
  } finally { await h.cleanup(); }
});
