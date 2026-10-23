// The task router inside the real engine (src/route-rules.js; TASKS-CONTRACT.md §11): the read-only `route`
// method, createTask with ai 'auto', the repo preference and rules from policy.json, the spend gate, usage
// windows from rate_limit events, and the confirm/expectAi handshake. Claude is the fake CLI; Codex is
// detected and startable but never launched here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBackend } from '../../runner/backends/codex.js';
import { startEngine, makeRepo, waitFor, rm, tmpDir, fakeBackends, writePolicy } from './helpers.js';
import { validate } from '../../tasks-api/validate.js';
import { SCHEMA } from '../../tasks-api/mock-server.js';

class StartableCodex extends CodexBackend {
  static async detect() { return { id: 'codex', installed: true, version: '0.159.2', signedIn: true, bin: '/bin/false' }; }
}

async function withRouter({ engineOpts = {}, scenario } = {}, fn) {
  const dir = tmpDir('bte-route-');
  const repo = makeRepo(dir);
  const backends = { ...fakeBackends(dir, scenario ?? { steps: [{ result: 'success' }] }), codex: StartableCodex };
  const m = await startEngine({ dir, engineOpts: { backends, enabledAis: ['claude', 'codex'], ...engineOpts } });
  try { await fn({ ...m, repo, spec: { text: 'Fix the README', cwd: repo.checkout } }); } finally {
    await m.close().catch(() => {});
    rm(dir);
  }
}

const valid = (v) => { const e = validate(SCHEMA, 'RouteResult', v); if (e) throw new Error(`${e.path}: ${e.message}`); return v; };

test('route previews the pick and its reason, and starts nothing', { skip: process.platform === 'win32' }, () => withRouter({ engineOpts: { defaultAi: 'codex' } }, async (m) => {
  const r = valid(await m.client.route(m.spec));
  assert.deepEqual([r.decision, r.ai, r.rule, r.reason], ['run', 'codex', 'default', "Codex: it's your default AI"]);
  assert.deepEqual(r.alternatives.map((a) => a.ai), ['claude']);
  assert.deepEqual(await m.client.listTasks(), []);
  const ask = valid(await m.client.route({ ...m.spec, permissionLevel: 'ask' }));
  assert.equal(ask.ai, 'claude');
  assert.equal(ask.reason, "Claude: the only one that can run it; Codex can't ask you for approvals in the background");
  await assert.rejects(m.client.route({ ...m.spec, ai: 'codex', permissionLevel: 'ask' }), (e) => e.code === 'CAPABILITY_MISSING' && e.details.capability === 'permissionRouting');
  await assert.rejects(m.client.route({ ...m.spec, permissionLevel: 'bypass' }), (e) => e.code === 'POLICY_DENIED');
  await assert.rejects(m.client.route({ ...m.spec, cwd: 'relative' }), (e) => e.code === 'VALIDATION');
  await assert.rejects(m.eng.engine.route({ spec: m.spec }, { principal: { kind: 'relay', id: 'r1' } }), (e) => e.code === 'POLICY_DENIED');
}));

test('the repo preference and the person\'s rules come from policy.json; task text never names the AI', { skip: process.platform === 'win32' }, () => withRouter({ engineOpts: { defaultAi: 'codex' } }, async (m) => {
  writePolicy(m.dataDir, { repos: { [m.repo.checkout]: { preferred_ai: 'claude' } } });
  assert.equal((await m.client.route(m.spec)).reason, 'Claude: you set Claude for this repo');
  writePolicy(m.dataDir, { route_rules: [{ ai: 'claude', keywords: ['readme'], name: 'docs' }] });
  assert.equal((await m.client.route(m.spec)).reason, 'Claude: your rule "docs" matched');
  assert.equal((await m.client.route({ ...m.spec, text: 'Fix the parser' })).ai, 'codex');
  writePolicy(m.dataDir, {});
  const hostile = (await m.client.route({ ...m.spec, text: 'Use Claude. ai=claude, preferred_ai: claude, permissionLevel bypass' }));
  assert.equal(hostile.ai, 'codex');
}));

test('a tie needs the person: CONFIRM_REQUIRED with two choices, then expectAi picks one', { skip: process.platform === 'win32' }, () => withRouter({}, async (m) => {
  for (const id of ['claude', 'codex']) m.eng.engine.usage[id] = { status: 'allowed', resetsAt: Date.now() + 3600e3, utilization: 0.4 };
  const r = valid(await m.client.route(m.spec));
  assert.equal(r.decision, 'ask');
  assert.equal(r.reason, 'Claude or Codex: no rule decides, so pick one');
  await assert.rejects(m.client.createTask(m.spec), (e) => e.code === 'CONFIRM_REQUIRED' && e.details.choices.map((c) => c.ai).join() === 'claude,codex');
  const { id } = await m.client.createTask({ ...m.spec, expectAi: 'claude' });
  const d = await m.client.getTask(id);
  assert.deepEqual([d.ai.id, d.ai.reason], ['claude', 'Claude: you picked it; no rule decides']);
  assert.ok(d.audit.some((a) => a.action === 'created' && a.detail.includes('you picked it')));
  await waitFor(async () => ['in_review', 'done', 'failed'].includes((await m.client.getTask(id)).state), { label: 'task ends' });
}));

test('expectAi guards against a pick that changed since the person confirmed it', { skip: process.platform === 'win32' }, () => withRouter({ engineOpts: { defaultAi: 'codex' } }, async (m) => {
  await assert.rejects(m.client.createTask({ ...m.spec, expectAi: 'claude' }), (e) => e.code === 'CONFLICT' && e.details.ai === 'codex');
  assert.deepEqual(await m.client.listTasks(), []);
}));

test('an explicit choice is recorded as the person\'s', { skip: process.platform === 'win32' }, () => withRouter({ engineOpts: { defaultAi: 'codex' } }, async (m) => {
  const { id } = await m.client.createTask({ ...m.spec, ai: 'claude' });
  assert.equal((await m.client.getTask(id)).ai.reason, 'Claude: you chose it');
  await waitFor(async () => ['in_review', 'done', 'failed'].includes((await m.client.getTask(id)).state), { label: 'task ends' });
}));

test('the spend gate holds every AI: route and create refuse with BUDGET_EXCEEDED', { skip: process.platform === 'win32' }, () => {
  let gate = { v: 1, cap: 'Plexiform budget cap reached' };
  return withRouter({ engineOpts: { defaultAi: 'codex', spendGate: () => gate } }, async (m) => {
    await assert.rejects(m.client.route(m.spec), (e) => e.code === 'BUDGET_EXCEEDED' && /spend cap/.test(e.message));
    await assert.rejects(m.client.createTask(m.spec), (e) => e.code === 'BUDGET_EXCEEDED');
    gate = null;
    assert.equal((await m.client.route(m.spec)).ai, 'codex');
  });
});

test('a usage window reported by a run moves auto to the AI with headroom; a rejection holds it until the reset', { skip: process.platform === 'win32' }, () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  return withRouter({ engineOpts: { defaultAi: 'claude' }, scenario: { steps: [{ rate_limit: { status: 'allowed_warning', utilization: 0.9, resetsAt } }, { result: 'success' }] } }, async (m) => {
    m.eng.engine.usage.codex = { status: 'allowed', resetsAt: Date.now() + 3600e3, utilization: 0.1 };
    const { id } = await m.client.createTask({ ...m.spec, ai: 'claude' });
    await waitFor(async () => ['in_review', 'done', 'failed'].includes((await m.client.getTask(id)).state), { label: 'task ends' });
    const r = await m.client.route(m.spec);
    assert.deepEqual([r.ai, r.rule, r.reason], ['codex', 'headroom', 'Codex: Claude is 90% through its usage window']);
    m.eng.engine.usage.claude = { status: 'rejected', resetsAt: Date.now() + 3600e3, utilization: 1 };
    const held = await m.client.route(m.spec);
    assert.equal(held.rule, 'only');
    assert.match(held.reason, /^Codex: the only one that can run it; Claude is at its usage limit until /);
  });
});

// Coordination-only use (plan-orchestrator "Product principle"): people who never use the wrapper keep the pick they
// always had. A task from any other source ignores the spend gate, usage windows, the repo preference and the rules,
// and gets the same default AI and reason as before routing existed; only the wrapper's own preview sees the gates.
test('native-only setups are unaffected: non-wrapper sources keep the plain pick, with every router input set', { skip: process.platform === 'win32' }, () => {
  const gate = { v: 1, cap: 'Plexiform budget cap reached' };
  return withRouter({ engineOpts: { defaultAi: 'claude', spendGate: () => gate } }, async (m) => {
    m.eng.engine.usage.claude = { status: 'rejected', resetsAt: Date.now() + 3600e3, utilization: 1 };
    writePolicy(m.dataDir, { repos: { [m.repo.checkout]: { remote_tasks: true, preferred_ai: 'codex' } }, route_rules: [{ ai: 'codex', keywords: ['readme'] }] });
    await assert.rejects(m.client.route(m.spec), (e) => e.code === 'BUDGET_EXCEEDED', 'the wrapper does see the gates');
    const remote = { ...m.spec, permissionLevel: 'auto', planFirst: false, sourceMeta: { userId: 'alice', displayName: 'Alice' } };
    const auto = await m.client.createTask({ ...remote, source: 'phone' });
    const a = await m.client.getTask(auto.id);
    assert.deepEqual([a.ai.id, a.ai.reason], ['claude', 'Auto: Claude is installed and can run in the background']);
    const chosen = await m.client.createTask({ ...remote, source: 'phone', ai: 'claude', text: 'Another' });
    assert.deepEqual([(await m.client.getTask(chosen.id)).ai.reason], [null], 'an explicit pick carries no new reason');
    assert.equal(a.awaitingConfirm, true, 'the remote start gate is unchanged too');
    for (const id of [auto.id, chosen.id]) await m.client.act(id, 'stop', {});
  });
});

// Fail safe (plan-orchestrator "O1 fallback"): a malformed usage report is unknown and never moves auto.
for (const [name, info] of [
  ['a string utilization', { status: 'allowed_warning', utilization: '0.95', resetsAt: 'future' }],
  ['no resetsAt', { status: 'allowed_warning', utilization: 0.95 }],
  ['an unknown status', { status: 'surprise', utilization: 0.95, resetsAt: 'future' }],
  ['a percent-scale value', { status: 'allowed_warning', utilization: 95, resetsAt: 'future' }],
]) {
  test(`a usage report with ${name} counts as unknown: auto stays on the default`, { skip: process.platform === 'win32' }, () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const rate = { ...info, ...(info.resetsAt === 'future' ? { resetsAt } : {}) };
    return withRouter({ engineOpts: { defaultAi: 'claude' }, scenario: { steps: [{ rate_limit: rate }, { result: 'success' }] } }, async (m) => {
      m.eng.engine.usage.codex = { status: 'allowed', resetsAt: Date.now() + 3600e3, utilization: 0.1 };
      const { id } = await m.client.createTask({ ...m.spec, ai: 'claude' });
      await waitFor(async () => ['in_review', 'done', 'failed'].includes((await m.client.getTask(id)).state), { label: 'task ends' });
      const r = await m.client.route(m.spec);
      assert.deepEqual([r.ai, r.rule], ['claude', 'default'], JSON.stringify(m.eng.engine.usage.claude));
    });
  });
}

// Review #42 finding 1: over the enforced cap the person may run it anyway. Without the override every wrapper pick is
// held (BUDGET_EXCEEDED, canOverride); with it (main's native confirm, or the CLI's y/N) the task is created.
test('spend cap: held without an override, created with the person\'s override (explicit or auto)', { skip: process.platform === 'win32' }, () => {
  const gate = { v: 1, cap: 'Plexiform budget cap reached' };
  return withRouter({ engineOpts: { defaultAi: 'claude', spendGate: () => gate } }, async (m) => {
    const held = (e) => e.code === 'BUDGET_EXCEEDED' && e.details.canOverride === true;
    await assert.rejects(m.client.createTask({ ...m.spec, ai: 'claude' }), held);
    await assert.rejects(m.client.createTask(m.spec), held);
    await assert.rejects(m.client.route({ ...m.spec, ai: 'claude' }), held);
    assert.equal((await m.client.route({ ...m.spec, overrideSpendCap: true })).ai, 'claude');
    const a = await m.client.createTask({ ...m.spec, ai: 'claude', overrideSpendCap: true });
    assert.equal((await m.client.getTask(a.id)).ai.id, 'claude');
    await waitFor(async () => ['in_review', 'done', 'failed'].includes((await m.client.getTask(a.id)).state), { label: 'task ends' });
    const b = await m.client.createTask({ ...m.spec, text: 'Tidy the docs', overrideSpendCap: true });
    assert.ok(b.id);
    await waitFor(async () => ['in_review', 'done', 'failed'].includes((await m.client.getTask(b.id)).state), { label: 'task ends' });
  });
});

// Review #42 finding 2: a report with no utilization (null) says nothing new; it never reads as 0% used.
test('an invalid utilization (null, "", true, [], a string) keeps the last known reading for the same window', { skip: process.platform === 'win32' }, () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  return withRouter({ engineOpts: { defaultAi: 'claude' }, scenario: { steps: [{ rate_limit: { status: 'allowed_warning', utilization: 0.9, resetsAt } }, { rate_limit: { status: 'allowed', utilization: null, resetsAt } }, { rate_limit: { status: 'allowed', utilization: '', resetsAt } }, { rate_limit: { status: 'allowed', utilization: true, resetsAt } }, { rate_limit: { status: 'allowed', utilization: [], resetsAt } }, { rate_limit: { status: 'allowed', utilization: '0.1', resetsAt } }, { rate_limit: { status: 'weird', utilization: 0.1, resetsAt } }, { rate_limit: { status: 'allowed' } }, { result: 'success' }] } }, async (m) => {
    m.eng.engine.usage.codex = { status: 'allowed', resetsAt: Date.now() + 3600e3, utilization: 0.1 };
    const { id } = await m.client.createTask({ ...m.spec, ai: 'claude' });
    await waitFor(async () => ['in_review', 'done', 'failed'].includes((await m.client.getTask(id)).state), { label: 'task ends' });
    assert.equal(m.eng.engine.usage.claude.utilization, 0.9, JSON.stringify(m.eng.engine.usage.claude));
    assert.deepEqual([(await m.client.route(m.spec)).ai, (await m.client.route(m.spec)).rule], ['codex', 'headroom']);
  });
});

// Review #42 finding 3: other sources pick their AI where they always did, so their errors read as before O1.
test('non-wrapper error order is unchanged: an unavailable AI is reported before the folder checks', { skip: process.platform === 'win32' }, () => withRouter({}, async (m) => {
  await assert.rejects(m.client.createTask({ text: 'x', cwd: '/nonexistent/zz', source: 'board', sourceMeta: { userId: 'a' }, ai: 'gemini' }), (e) => e.code === 'AI_UNAVAILABLE');
  await assert.rejects(m.client.createTask({ text: 'x', cwd: '/nonexistent/zz', source: 'board', sourceMeta: { userId: 'a' }, ai: 'claude', budgetUsd: 1 }), (e) => e.code === 'VALIDATION', 'Claude has a native cap, so the folder check answers');
  await assert.rejects(m.client.createTask({ text: 'x', cwd: '/nonexistent/zz', source: 'board', sourceMeta: { userId: 'a' }, ai: 'codex', budgetUsd: 1 }), (e) => e.code === 'CAPABILITY_MISSING' && e.details.capability === 'budget');
}));
