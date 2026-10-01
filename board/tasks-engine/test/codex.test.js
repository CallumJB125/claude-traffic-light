// Real task engine, transport and Codex adapter; only the external AI CLI is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBackend } from '../../runner/backends/codex.js';
import { tmpDir, rm, makeRepo, startEngine, waitFor } from './helpers.js';

const fixture = fileURLToPath(new URL('../../runner/test/fixtures/fake-codex.js', import.meta.url));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
async function setup(scenario) {
  const dir = tmpDir('pxct-'); const repo = makeRepo(dir);
  const scenarioFile = path.join(dir, 'scenario.json'); fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  const log = path.join(dir, 'codex.log'); const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nexport PLEXIFORM_FAKE_CODEX_SCENARIO=${quote(scenarioFile)}\nexport PLEXIFORM_FAKE_CODEX_LOG=${quote(log)}\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 });
  class FakeCodex extends CodexBackend { static async detect() { return { id: 'codex', installed: true, version: '0.159.2', signedIn: true, bin }; } }
  class ForbiddenClaude { static async detect() { throw new Error('Claude was invoked'); } }
  const h = await startEngine({ dir, engineOpts: { backends: { codex: FakeCodex, claude: ForbiddenClaude }, enabledAis: ['codex'], defaultAi: 'codex' } });
  return { ...h, repo, log: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } }, task: (id) => h.eng.tasks.get(id),
    async cleanup() { await h.close(); rm(dir); } };
}

test('Codex default: real socket creates a worktree, observes edits/evidence, and rejects unsupported caps and approvals', async () => {
  const h = await setup({ write: true, text: 'Created a fixture edit' });
  try {
    const ais = await h.client.detectAIs(); assert.deepEqual(ais.map((a) => a.id), ['codex']); assert.equal(ais[0].capabilities.background, true);
    await assert.rejects(h.client.createTask({ text: 'cap', cwd: h.repo.checkout, ai: 'codex', budgetUsd: 1 }), (e) => e.code === 'CAPABILITY_MISSING');
    await assert.rejects(h.client.createTask({ text: 'ask', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'ask' }), (e) => e.code === 'CAPABILITY_MISSING');
    const { id } = await h.client.createTask({ text: 'Edit a fixture', cwd: h.repo.checkout, ai: 'auto', permissionLevel: 'auto-edits' });
    const t = await waitFor(() => h.task(id)?.state === 'in_review' && h.task(id));
    assert.equal(t.ai.id, 'codex'); assert.equal(t.sessionId, '00000000-0000-4000-8000-000000000159');
    assert.equal(fs.readFileSync(path.join(t.worktree, 'codex-result.txt'), 'utf8'), 'fixture edit\n'); assert.equal(fs.existsSync(path.join(h.repo.checkout, 'codex-result.txt')), false);
    assert.match(t.evidence.summary, /fixture edit/); assert.ok(t.touched.includes('codex-result.txt')); assert.equal(t.cost.budgetUsd, null);
    assert.equal(fs.existsSync(path.join(h.dataDir, 'run', id, 'ipc.sock')), false); assert.equal(fs.existsSync(path.join(h.dataDir, 'run', id, 'hook.token')), false);
    const started = h.log().find((x) => x.kind === 'start'); assert.ok(started.argv.includes('--ignore-user-config')); assert.ok(!('BOARD_DEVICE_TOKEN' in started.env));
  } finally { await h.cleanup(); }
});

test('Codex plan gate persists and approval resumes the actual session with editable sandbox', async () => {
  const h = await setup({ writeOnResume: true, text: 'A small plan' });
  try {
    const { id } = await h.client.createTask({ text: 'Plan then edit', cwd: h.repo.checkout, ai: 'codex', planFirst: true, permissionLevel: 'auto-edits' });
    const t = await waitFor(() => h.task(id)?.openAsk && h.task(id));
    assert.equal(fs.existsSync(path.join(t.worktree, 'codex-result.txt')), false);
    const first = h.log().find((x) => x.kind === 'start'); assert.ok(first.argv.some((s) => s.includes('":workspace_roots"="read"')));
    await h.client.act(id, 'answer', { askId: t.openAsk.askId, answer: 'yes' });
    await waitFor(() => h.task(id)?.state === 'in_review');
    const runs = h.log().filter((x) => x.kind === 'start'); assert.equal(runs.length, 2); assert.ok(runs[1].argv.includes('resume')); assert.ok(runs[1].argv.includes(t.sessionId)); assert.ok(runs[1].argv.some((s) => s.includes('":workspace_roots"="write"')));
  } finally { await h.cleanup(); }
});

test('Codex pause kills a turn and resume uses its session; queued user messages go to the next turn', async () => {
  const h = await setup({ wait: true, waitFirstOnly: true, writeOnResume: true });
  try {
    const { id } = await h.client.createTask({ text: 'Wait for instructions', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    await h.client.act(id, 'message', { body: 'include this after pause' });
    await h.client.act(id, 'pause'); await waitFor(() => h.task(id)?.state === 'parked');
    await h.client.act(id, 'resume'); await waitFor(() => h.task(id)?.state === 'in_review');
    assert.ok(h.log().filter((x) => x.kind === 'prompt').at(-1).prompt.includes('include this after pause'));
    assert.equal(h.log().filter((x) => x.kind === 'start').length, 2);
  } finally { await h.cleanup(); }
});

test('Codex terminal takeover and handback preserve the sandbox and actual session', async () => {
  const h = await setup({ wait: true, waitFirstOnly: true });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    const r = await h.client.act(id, 'takeover', { mode: 'print' });
    assert.ok(r.takeover.argv.includes('resume')); assert.ok(r.takeover.argv.includes(h.task(id).sessionId)); assert.ok(r.takeover.argv.includes('--ignore-user-config')); assert.ok(r.takeover.argv.some((s) => s.includes('network.enabled=false'))); assert.ok(!JSON.stringify(r.takeover).includes('btk_'));
    assert.equal(h.task(id).state, 'handed_over');
    await h.client.act(id, 'handback'); await waitFor(() => h.task(id)?.state === 'in_review');
  } finally { await h.cleanup(); }
});
