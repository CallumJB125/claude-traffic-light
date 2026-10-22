// source 'bus' in the engine (AGENT-BUS.md §2.4): the three hidden human gates
// are gone (plan ask, start confirmation, budget dialog), the remote rules still
// apply (clamp, worktree), bus_auto is the one opt-in and remote_tasks never
// counts, sourceMeta survives, and refusals are reasons, never prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor, writePolicy } from './helpers.js';
import { startBus, rid } from './bus-helpers.js';

const busSpec = (b, extra = {}) => ({ text: 'Fix it', cwd: b.h.repo.checkout, ai: 'codex', source: 'bus',
  sourceMeta: { handoffId: 'hof_0123456789abcdef', fence: 1, originTier: 'local_attested', scope: 'local' }, ...extra });

test('a bus task reaches running with no ask: planFirst false although bus is a remote source', async () => {
  const b = await startBus({ wait: true });
  try {
    const offer = await b.handoff({ request_id: rid('noask') });
    const task = await waitFor(() => b.taskOf(offer.handoff_id)?.state === 'running' && b.taskOf(offer.handoff_id), { label: 'running' });
    assert.equal(task.remoteRules, true, 'bus runs under the remote rules');
    assert.equal(task.planFirst, false);
    assert.equal(task.openAsk, null);
    assert.deepEqual(task.openApprovals, []);
    assert.equal(task.awaitingConfirm, false);
    assert.deepEqual({ handoffId: task.sourceMeta.handoffId, fence: task.sourceMeta.fence, originTier: task.sourceMeta.originTier, scope: task.sourceMeta.scope },
      { handoffId: offer.handoff_id, fence: 1, originTier: 'local_attested', scope: 'local' }, 'sourceMeta preserved (never rewritten to local)');
    assert.equal(task.source, 'bus');
  } finally { await b.cleanup(); }
});

test('Gemini never takes a bus run: the engine refuses source bus on it, and the bus refuses the target (NO_ELIGIBLE_AGENT)', async () => {
  class FakeGemini {
    static describe() { return { id: 'gemini', label: 'Gemini', startable: true, capabilities: { structuredEvents: true, permissions: 'none', budget: 'none', resume: true } }; }
    static async detect() { return { installed: true, signedIn: true, version: '1', bin: '/nonexistent/gemini' }; }
  }
  const b = await startBus({ wait: true }, { engineOpts: { backends: { gemini: FakeGemini }, enabledAis: ['gemini'], defaultAi: 'gemini' } });
  try {
    await assert.rejects(b.engine.createTask({ requestId: rid('gem'), spec: busSpec(b, { ai: 'gemini' }) }), (e) => e.code === 'POLICY_DENIED' && e.details?.reason === 'NO_ELIGIBLE_AGENT');
    await assert.rejects(b.engine.createTask({ requestId: rid('gem'), spec: busSpec(b, { ai: 'auto', text: 'Auto' }) }), (e) => e.details?.reason === 'NO_ELIGIBLE_AGENT', 'auto picking Gemini is refused too');
    assert.equal((await b.handoff({ request_id: rid('gem'), to: { provider: 'gemini' } })).reason, 'NO_ELIGIBLE_AGENT');
    assert.equal(b.engine.tasks.size, 0);
  } finally { await b.cleanup(); }
});

test('awaitingConfirm: policy.json auto_accept false wins over Preferences auto_accept true', async () => {
  const b = await startBus({ wait: true }, { policy: (repo) => ({ bus: { auto_accept: false }, repos: { [repo]: { bus_auto: true } } }) });
  try {
    await b.bus('busSetContext', { settings: { auto_accept: true } });
    const { id } = await b.engine.createTask({ requestId: rid('strict'), spec: busSpec(b) });
    assert.equal(b.engine.tasks.get(id).awaitingConfirm, true);
  } finally { await b.cleanup(); }
});

test('remote clamp and always-worktree apply; workInPlace and auto are refused for bus', async () => {
  const b = await startBus({ wait: true });
  try {
    const { id } = await b.engine.createTask({ requestId: rid('clamp'), spec: busSpec(b, { permissionLevel: 'auto', workInPlace: true }) });
    const t = b.engine.tasks.get(id);
    assert.equal(t.permissionLevel, 'auto-edits');
    assert.equal(t.workInPlace, false);
    assert.notEqual(t.worktree, b.h.repo.checkout);
    assert.equal(t.planFirst, false);
  } finally { await b.cleanup(); }
});

test('awaitingConfirm: false for local scope with auto_accept, true when policy turns auto_accept off', async () => {
  const b = await startBus({ wait: true });
  try {
    const on = await b.engine.createTask({ requestId: rid('acc'), spec: busSpec(b) });
    assert.equal(b.engine.tasks.get(on.id).awaitingConfirm, false);
    writePolicy(b.h.dataDir, { bus: { auto_accept: false }, repos: { [b.h.repo.checkout]: { bus_auto: true } } });
    const off = await b.engine.createTask({ requestId: rid('acc'), spec: busSpec(b, { text: 'Another' }) });
    const t = b.engine.tasks.get(off.id);
    assert.equal(t.awaitingConfirm, true);
    assert.equal(t.state, 'queued');
    // Team scope from an interactive session is never accepted without the tier.
    writePolicy(b.h.dataDir, { repos: { [b.h.repo.checkout]: { bus_auto: true } } });
    const team = await b.engine.createTask({ requestId: rid('acc'), spec: busSpec(b, { text: 'Team', sourceMeta: { handoffId: 'hof_0123456789abcdee', fence: 1, originTier: 'local_attested', scope: 'team' } }) });
    assert.equal(b.engine.tasks.get(team.id).awaitingConfirm, true);
  } finally { await b.cleanup(); }
});

test('the one opt-in rule: bus_auto passes, remote_tasks alone does not (engine and bus op)', async () => {
  const b = await startBus({ wait: true }, { policy: (repo) => ({ repos: { [repo]: { remote_tasks: true } } }) });
  try {
    await assert.rejects(b.engine.createTask({ requestId: rid('opt'), spec: busSpec(b) }), (e) => e.code === 'POLICY_DENIED');
    const refused = await b.handoff({ request_id: rid('opt') });
    assert.equal(refused.reason, 'NO_ELIGIBLE_AGENT');
    assert.equal(b.h.log().length, 0, 'nothing started');
    writePolicy(b.h.dataDir, { repos: { [b.h.repo.checkout]: { bus_auto: true } } });
    assert.ok((await b.engine.createTask({ requestId: rid('opt'), spec: busSpec(b) })).id);
    // The Preferences opt-in list (busSetContext) counts the same, with no policy.json key.
    writePolicy(b.h.dataDir, {});
    await b.bus('busSetContext', { repos: [b.h.repo.checkout], folders: [] });
    const ok = await b.handoff({ request_id: rid('opt'), title: 'Via Preferences' });
    assert.equal(ok.state, 'offered');
  } finally { await b.cleanup(); }
});

test('no folder dialog: repos map only from known checkouts, else NO_LOCAL_CHECKOUT; refusals are audited', async () => {
  const b = await startBus({ wait: true });
  try {
    const plain = path.join(b.h.dir, 'not-a-repo');
    fs.mkdirSync(plain);
    assert.equal((await b.handoff({ request_id: rid('nlc'), repo: plain })).reason, 'NO_LOCAL_CHECKOUT');
    assert.equal((await b.handoff({ request_id: rid('nlc'), repo: 'github.com/acme/unknown' })).reason, 'NO_LOCAL_CHECKOUT');
    // A canonical remote resolves through a registered folder.
    b.h.repo.git('remote', 'add', 'origin', 'https://github.com/acme/app.git');
    await b.bus('busSetContext', { folders: [b.h.repo.checkout] });
    const viaRemote = await b.handoff({ request_id: rid('nlc'), repo: 'github.com/acme/app', title: 'By remote' });
    assert.equal(viaRemote.state, 'offered');
    const list = await b.bus('list', {});
    assert.equal(list.events.filter((e) => e.kind === 'handoff.refused' && e.reason === 'NO_LOCAL_CHECKOUT').length, 2);
  } finally { await b.cleanup(); }
});

test('SPEND_CAP (caps explicitly on): admission reservation refuses with a reason, never a dialog; caps off by default', async () => {
  const b = await startBus({ wait: true });
  try {
    assert.equal((await b.bus('hello', { provider: 'claude' })).policy_summary.caps_enabled, false, 'owner default: caps off');
    await b.bus('busSetContext', { settings: { caps: { enabled: true, member_usd: 6, handoff_usd: 5 } } });
    const first = await b.handoff({ request_id: rid('cap'), title: 'First' });
    assert.equal(first.state, 'offered');
    const second = await b.handoff({ request_id: rid('cap'), title: 'Second' });
    assert.equal(second.reason, 'SPEND_CAP');
    assert.equal(b.engine.agentBus.log.spend(new Date().toISOString().slice(0, 10)).reserved, 5);
    await b.bus('busSetContext', { settings: { caps: { enabled: false } } });
    assert.equal((await b.handoff({ request_id: rid('cap'), title: 'Third' })).state, 'offered', 'caps off: no refusal');
    assert.ok(![...b.engine.tasks.values()].some((t) => t.awaitingConfirm || t.openApprovals.length), 'no prompt anywhere');
  } finally { await b.cleanup(); }
});

test('the bus method is the local owner\'s only: unknown ops are VALIDATION', async () => {
  const b = await startBus({ text: 'x' });
  try {
    await assert.rejects(b.h.client.bus('approve', {}), (e) => e.code === 'VALIDATION');
    await assert.rejects(b.h.client.bus('handoff', { request_id: 'short', to: { provider: 'codex' }, title: 'x' }), (e) => e.code === 'VALIDATION');
  } finally { await b.cleanup(); }
});
