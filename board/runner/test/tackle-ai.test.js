// "Tackle with AI" runner side: no-budget runs carry no spend flag (D-4), a
// turn limit is never "Budget reached" (D-5), offers name their AI and a
// runner that can't run it ignores them without declining (D-7), and the AI
// list rides on hello/advertise without paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildArgv } from '../launch.js';
import { runBudget, aiOf } from '../supervisor.js';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor } from './helpers.js';

const base = { runDir: '/r', sessionId: 's' };

test('D-4: no budget → no --max-budget-usd; a number → the flag', () => {
  assert.ok(!buildArgv(base).includes('--max-budget-usd'));
  assert.ok(!buildArgv({ ...base, budgetUsd: null }).includes('--max-budget-usd'));
  const a = buildArgv({ ...base, budgetUsd: 2 });
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '2');
});

test('D-4: the run budget is the card budget capped by the local cap; only a local cap → the local cap', () => {
  assert.deepEqual(runBudget(undefined, undefined), { usd: undefined, scope: null });
  assert.deepEqual(runBudget(null, 0), { usd: undefined, scope: null });
  assert.deepEqual(runBudget(3, undefined), { usd: 3, scope: 'card' });
  assert.deepEqual(runBudget(undefined, 1.5), { usd: 1.5, scope: 'device' });
  assert.deepEqual(runBudget(3, 1.5), { usd: 1.5, scope: 'device' });
  assert.deepEqual(runBudget(1, 4), { usd: 1, scope: 'card' });
});

test('D-7: aiOf — omitted = claude; a bad value is no AI at all', () => {
  assert.equal(aiOf({}), 'claude');
  assert.equal(aiOf({ ai: 'codex' }), 'codex');
  assert.equal(aiOf({ ai: 7 }), null);
  assert.equal(aiOf({ ai: '../x' }), null);
});

const AIS = [
  { id: 'claude', label: 'Claude Code', installed: true, version: '2.1.0', signedIn: 'unknown', capabilities: { budget: 'native' }, bin: '/Users/someone/.local/bin/claude' },
  { id: 'codex', label: 'Codex', installed: true, startable: false, version: '0.1.0', signedIn: true, capabilities: { budget: 'none' }, bin: '/opt/homebrew/bin/codex' },
];

async function withRunner(scenario, fn, { repoPolicy } = {}) {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario, repoPolicy, opts: { detectAis: async () => AIS } });
  try { await fn({ hub, sup }); } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
}

test('hello and advertise carry ai:[{id,label,installed,version,signedIn,capabilities}] and no paths', () => withRunner(null, async ({ hub }) => {
  const hello = await waitFor(() => hub.of('hello')[0], { what: 'hello' });
  const adv = await waitFor(() => hub.of('advertise')[0], { what: 'advertise' });
  for (const f of [hello, adv]) {
    assert.deepEqual(f.ai.map((a) => a.id), ['claude', 'codex']);
    for (const a of f.ai) assert.deepEqual(Object.keys(a).sort(), ['capabilities', 'id', 'installed', 'label', 'signedIn', 'version']);
  }
  assert.ok(!hub.raw.some((s) => s.includes('/opt/homebrew') || s.includes('/Users/someone')), 'no bin path on the wire');
}));

test('D-7: an offer for an AI this runner cannot run is ignored, never declined', () => withRunner({ steps: [{ result: 'success' }] }, async ({ hub, sup }) => {
  await waitFor(() => sup.connected, { what: 'connected' });
  hub.send({ ...offerFor({ key: 'X-1' }), ai: 'codex' });       // installed, but not startable yet
  hub.send({ ...offerFor({ key: 'X-2' }), ai: 'gemini' });      // not registered
  hub.send({ ...offerFor({ key: 'X-3' }), ai: 42 });            // malformed
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(hub.of('decline').length, 0, 'no decline');
  assert.equal(hub.of('claim').length, 0, 'no claim');
  assert.equal(sup.runs.size, 0);
}));

test('D-5: error_max_turns → run.failed{error, max_turns}, never budget', () => withRunner({ steps: [{ result: 'error_max_turns' }] }, async ({ hub, sup }) => {
  await claimRun(sup, hub, offerFor({ key: 'T-5' }));
  const f = await waitFor(() => hub.outs('run.failed')[0], { what: 'failed' });
  assert.equal(f.fail_kind, 'error');
  assert.equal(f.reason, 'max_turns');
}));

test('a real budget stop stays fail(budget) and says whose cap it was', () => withRunner({ steps: [{ result: 'error_max_budget_usd' }] }, async ({ hub, sup }) => {
  await claimRun(sup, hub, offerFor({ key: 'T-6' }));
  const f = await waitFor(() => hub.outs('run.failed')[0], { what: 'failed' });
  assert.equal(f.fail_kind, 'budget');
  assert.equal(f.budget_scope, 'card');
}));

test('a local cap below the card budget binds: device scope', () => withRunner({ steps: [{ result: 'error_max_budget_usd' }] }, async ({ hub, sup }) => {
  await claimRun(sup, hub, offerFor({ key: 'T-7' }));
  const f = await waitFor(() => hub.outs('run.failed')[0], { what: 'failed' });
  assert.equal(f.budget_scope, 'device');
}, { repoPolicy: { budget_per_run: 0.5 } }));
