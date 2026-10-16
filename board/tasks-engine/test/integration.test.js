// Real disposable Git repositories; no provider, remote, user checkout or app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createTaskIntegration } from '../integration.js';
import { makeRepo, tmpDir, rm, startEngine, waitFor } from './helpers.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const bin = process.platform === 'win32' ? null : execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const posix = process.platform === 'win32' ? test.skip : test;
function fixture(t) {
  const dir = fs.realpathSync(tmpDir('bti-')); t.after(() => rm(dir));
  const { checkout } = makeRepo(dir), baseSha = git(checkout, 'rev-parse', 'HEAD');
  const wt = path.join(dir, 'task'); git(checkout, 'worktree', 'add', '-q', '-b', 'task', wt);
  const task = { id: 'task-1', state: 'in_review', stateSince: 1, sessionId: 'session-1', repo: { root: checkout }, worktree: wt, branch: 'task', gitRef: 'refs/heads/task', gitDir: git(wt, 'rev-parse', '--absolute-git-dir'), baseSha, worktreeCreated: true, workInPlace: false };
  let clock = Date.now();
  const coordination = { epoch: 'fixture-engine', taskId: task.id, repoRoot: checkout, decisionVersion: 0, claims: [] };
  const helper = createTaskIntegration({ bin, dataDir: path.join(dir, 'data'), now: () => clock, readCoordination: () => coordination });
  const write = (name, text, root = wt) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
  return { dir, checkout, wt, task, helper, coordination, write, advance: ms => clock += ms,
    preview: () => helper.preview(task), apply: r => helper.apply(task, r.id, r.hash),
    status: root => git(root, 'status', '--porcelain'), head: root => git(root, 'rev-parse', 'HEAD') };
}

posix('reviewed integration includes committed and uncommitted task work, preserves source/index, and requires explicit apply', async t => {
  const f = fixture(t); f.write('README.md', '# first\n'); git(f.wt, 'add', 'README.md'); git(f.wt, 'commit', '-qm', 'first');
  f.write('README.md', '# reviewed\n'); f.write('new.js', 'export const ready = true;\n');
  const sourceHead = f.head(f.wt), destinationHead = f.head(f.checkout), sourceIndex = fs.readFileSync(path.join(f.task.gitDir, 'index'));
  const r = await f.preview(); assert.equal(r.status, 'review'); assert.equal(r.canApply, true); assert.match(r.patch, /export const ready/);
  assert.equal(f.head(f.checkout), destinationHead); assert.equal(fs.existsSync(path.join(f.checkout, 'new.js')), false);
  assert.ok(fs.readFileSync(path.join(f.task.gitDir, 'index')).equals(sourceIndex));
  const result = await f.apply(r); assert.equal(result.status, 'merged'); assert.equal(f.head(f.checkout), result.commit);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'README.md'), 'utf8'), '# reviewed\n'); assert.equal(f.status(f.checkout), '');
  assert.equal(f.head(f.wt), sourceHead); assert.ok(fs.readFileSync(path.join(f.task.gitDir, 'index')).equals(sourceIndex));
  assert.equal(git(f.checkout, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'local merge commit has reviewed destination and task snapshot parents');
  await assert.rejects(f.apply(r), e => e.code === 'CONFLICT');
});
for (const kind of ['tracked', 'untracked', 'staged']) posix(`dirty ${kind} checkout is preserved and cannot be integrated`, async t => {
  const f = fixture(t); f.write('new.js', 'task\n'); f.write(kind === 'tracked' ? 'README.md' : 'person.txt', 'keep mine\n', f.checkout);
  if (kind === 'staged') git(f.checkout, 'add', 'person.txt');
  const before = f.status(f.checkout), head = f.head(f.checkout), r = await f.preview();
  assert.equal(r.status, 'dirty'); assert.equal(r.canApply, false); assert.equal(r.id, undefined);
  assert.equal(f.status(f.checkout), before); assert.equal(f.head(f.checkout), head);
});
posix('conflict preview leaves source and destination unchanged', async t => {
  const f = fixture(t); f.write('README.md', '# from task\n'); f.write('README.md', '# from person\n', f.checkout);
  git(f.checkout, 'add', '.'); git(f.checkout, 'commit', '-qm', 'person');
  const before = [f.head(f.checkout), f.status(f.checkout), f.head(f.wt), f.status(f.wt)];
  const r = await f.preview(); assert.equal(r.status, 'conflict'); assert.equal(r.canApply, false);
  assert.deepEqual([f.head(f.checkout), f.status(f.checkout), f.head(f.wt), f.status(f.wt)], before);
});
for (const kind of ['source-text', 'source-staging', 'source-branch', 'destination-text', 'destination-head', 'destination-branch', 'task-session', 'expiry']) posix(`${kind} changes retire the reviewed integration`, async t => {
  const f = fixture(t); f.write('new.js', 'reviewed\n'); const r = await f.preview(); assert.equal(r.canApply, true);
  if (kind === 'source-text') f.write('new.js', 'different\n');
  if (kind === 'source-staging') git(f.wt, 'add', 'new.js');
  if (kind === 'source-branch') git(f.wt, 'switch', '-qc', 'different-task');
  if (kind === 'destination-text') f.write('mine.txt', 'keep\n', f.checkout);
  if (kind === 'destination-head') { f.write('mine.txt', 'keep\n', f.checkout); git(f.checkout, 'add', '.'); git(f.checkout, 'commit', '-qm', 'person'); }
  if (kind === 'destination-branch') git(f.checkout, 'switch', '-qc', 'another');
  if (kind === 'task-session') f.task.sessionId = 'replacement';
  if (kind === 'expiry') f.advance(300_001);
  const head = f.head(f.checkout), status = f.status(f.checkout);
  await assert.rejects(f.apply(r), e => e.code === 'CONFLICT');
  assert.equal(f.head(f.checkout), head); assert.equal(f.status(f.checkout), status); assert.equal(fs.existsSync(path.join(f.checkout, 'new.js')), false);
});
posix('unrelated committed destination change merges while preserving both contributions', async t => {
  const f = fixture(t); f.write('new.js', 'task\n'); f.write('mine.txt', 'mine\n', f.checkout); git(f.checkout, 'add', '.'); git(f.checkout, 'commit', '-qm', 'person');
  const r = await f.preview(); assert.equal(r.canApply, true); await f.apply(r);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'mine.txt'), 'utf8'), 'mine\n'); assert.equal(fs.readFileSync(path.join(f.checkout, 'new.js'), 'utf8'), 'task\n');
});
for (const setting of ['filter.evil.clean', 'merge.evil.driver', 'include.path']) posix(`repository ${setting} is refused without running configuration commands`, async t => {
  const f = fixture(t), sentinel = path.join(f.dir, 'executed'); f.write('new.js', 'task\n');
  git(f.checkout, 'config', setting, setting === 'include.path' ? path.join(f.dir, 'missing') : `touch ${sentinel}`);
  await assert.rejects(f.preview(), e => e.code === 'POLICY_DENIED'); assert.equal(fs.existsSync(sentinel), false);
});
posix('configured hooks and fsmonitor cannot execute during preview or integration', async t => {
  const f = fixture(t), hooks = path.join(f.dir, 'hooks'), sentinel = path.join(f.dir, 'executed'); fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'post-merge'), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o700 });
  git(f.checkout, 'config', 'core.hooksPath', hooks); git(f.checkout, 'config', 'core.fsmonitor', `touch ${sentinel}`);
  git(f.checkout, 'config', 'merge.verifySignatures', 'true'); git(f.checkout, 'config', 'gpg.program', `touch ${sentinel}`);
  f.write('new.js', 'task\n'); const r = await f.preview(); await f.apply(r); assert.equal(fs.existsSync(sentinel), false);
});
posix('unsafe worktree-specific configuration is refused as well as common config', async t => {
  const f = fixture(t), sentinel = path.join(f.dir, 'executed'); f.write('new.js', 'task\n');
  git(f.checkout, 'config', 'extensions.worktreeConfig', 'true'); git(f.wt, 'config', '--worktree', 'filter.evil.clean', `touch ${sentinel}`);
  await assert.rejects(f.preview(), e => e.code === 'POLICY_DENIED'); assert.equal(fs.existsSync(sentinel), false);
});
posix('binary changes are held for manual review rather than exposing an incomplete diff', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.wt, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(f.preview(), e => e.code === 'POLICY_DENIED'); assert.equal(fs.existsSync(path.join(f.checkout, 'binary.dat')), false);
});
posix('untracked credential-shaped files are refused before snapshotting', async t => {
  const f = fixture(t); f.write('.env', 'SYNTHETIC=not-a-secret\n'); await assert.rejects(f.preview(), e => e.code === 'POLICY_DENIED');
});
posix('symlink changes are held for manual integration', async t => {
  const f = fixture(t); fs.symlinkSync('README.md', path.join(f.wt, 'link')); await assert.rejects(f.preview(), e => e.code === 'POLICY_DENIED');
});
posix('ignored user-file collision is preserved by Git refusal', async t => {
  const f = fixture(t); f.write('.gitignore', 'local.txt\n', f.checkout); git(f.checkout, 'add', '.'); git(f.checkout, 'commit', '-qm', 'ignore');
  git(f.wt, 'merge', '--ff-only', 'main'); f.write('local.txt', 'task\n'); git(f.wt, 'add', '-f', 'local.txt'); f.write('local.txt', 'keep private local\n', f.checkout);
  const r = await f.preview(); assert.equal(r.canApply, true); const head = f.head(f.checkout);
  await assert.rejects(f.apply(r), e => e.code === 'CONFLICT'); assert.equal(f.head(f.checkout), head);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'local.txt'), 'utf8'), 'keep private local\n');
});
posix('real engine exposes reviewed merge, refuses unreviewed requests and integrates through its actual socket', async t => {
  const dir = tmpDir('bti-'), repo = makeRepo(dir); t.after(() => rm(dir));
  const m = await startEngine({ dir }); t.after(() => m.close());
  const { id } = await m.client.createTask({ text: 'Disposable integration task', cwd: repo.checkout, ai: 'claude' });
  const detail = await waitFor(async () => { const t = await m.client.getTask(id); return t.state === 'in_review' && t; });
  assert.equal(detail.actions.includes('merge'), true); assert.equal(detail.actions.includes('openPr'), m.eng.engine.pullRequests.available);
  await assert.rejects(m.eng.engine.act({ id, action: 'merge', payload: { phase: 'preview' }, requestId: crypto.randomUUID() }, { principal: { kind: 'relay', id: 'synthetic-relay', source: 'phone', userId: 'person', taskIds: [id] } }), e => e.code === 'POLICY_DENIED');
  fs.writeFileSync(path.join(detail.worktree, 'accepted.js'), 'export const accepted = true;\n');
  await assert.rejects(m.client.act(id, 'merge', {}), e => e.code === 'VALIDATION');
  const r = await m.client.act(id, 'merge', { phase: 'preview' }); assert.equal(r.integration.canApply, true);
  const requestId = crypto.randomUUID(), applied = await m.client.act(id, 'merge', { phase: 'apply', reviewId: r.integration.id, reviewHash: r.integration.hash, confirm: true }, { requestId });
  assert.equal(applied.task.state, 'done'); assert.equal(applied.task.outcome, 'merged'); assert.ok(fs.existsSync(detail.worktree));
  assert.equal(fs.readFileSync(path.join(repo.checkout, 'accepted.js'), 'utf8'), 'export const accepted = true;\n');
});

for (const kind of ['overlap', 'ancestor', 'case-alias', 'unknown', 'truncated', 'in-place']) posix(`coordination blocks ${kind} claims with an actionable review and no Git effects`, async t => {
  const f = fixture(t); f.write('src/shared.js', 'task\n');
  const p = { taskId: 'peer-task', state: 'running', sessionId: 'peer-session', paths: ['src/shared.js'], workInPlace: false, pathsTruncated: false };
  if (kind === 'ancestor') p.paths = ['src'];
  if (kind === 'case-alias') p.paths = ['SRC/SHARED.JS'];
  if (kind === 'unknown') p.paths = [];
  if (kind === 'truncated') { p.paths = ['elsewhere.js']; p.pathsTruncated = true; }
  if (kind === 'in-place') { p.paths = ['elsewhere.js']; p.workInPlace = true; }
  f.coordination.claims.push(p);
  const head = f.head(f.checkout), r = await f.preview();
  assert.equal(r.status, 'ownership'); assert.equal(r.canApply, false); assert.equal(r.id, undefined);
  assert.equal(r.coordination.conflicts[0].taskId, p.taskId); assert.equal(r.coordination.scope, 'local-tasks');
  assert.equal(f.head(f.checkout), head); assert.equal(f.status(f.checkout), ''); assert.equal(fs.existsSync(path.join(f.checkout, 'src/shared.js')), false);
});
posix('a disjoint observed peer claim permits reviewed integration without losing either worktree', async t => {
  const f = fixture(t); f.write('src/shared.js', 'task\n');
  f.coordination.claims.push({ taskId: 'peer-task', state: 'running', paths: ['src/shared-other.js'] });
  const r = await f.preview(); assert.equal(r.canApply, true); assert.equal(r.coordination.observedClaims, 1); assert.deepEqual(r.coordination.conflicts, []);
  await f.apply(r); assert.equal(fs.readFileSync(path.join(f.checkout, 'src/shared.js'), 'utf8'), 'task\n');
});
for (const kind of ['decision-version', 'decision-content', 'source-authority', 'new-peer', 'peer-paths', 'peer-session', 'peer-decision', 'engine-epoch']) posix(`${kind} invalidates an exact integration review before mutation`, async t => {
  const f = fixture(t); f.write('src/shared.js', 'task\n');
  f.task.checkpoint = { version: 1, decisions: ['Reviewed decision'] }; f.coordination.decisionVersion = 1;
  f.coordination.claims.push({ taskId: 'peer-task', state: 'running', paths: ['other.js'], sessionId: 'peer-session', decisionVersion: 1 });
  const r = await f.preview(); assert.equal(r.canApply, true);
  if (kind === 'decision-version') { f.task.checkpoint.version++; f.coordination.decisionVersion++; }
  if (kind === 'decision-content') f.task.checkpoint.decisions[0] = 'Changed with same version';
  if (kind === 'source-authority') f.task.sourceMeta = { userId: 'replacement' };
  if (kind === 'new-peer') f.coordination.claims.push({ taskId: 'new-peer', state: 'running', paths: ['third.js'] });
  if (kind === 'peer-paths') f.coordination.claims[0].paths.push('src/shared.js');
  if (kind === 'peer-session') f.coordination.claims[0].sessionId = 'replaced';
  if (kind === 'peer-decision') f.coordination.claims[0].decisionVersion++;
  if (kind === 'engine-epoch') f.coordination.epoch = 'replacement-engine';
  const head = f.head(f.checkout); await assert.rejects(f.apply(r), e => e.code === 'CONFLICT');
  assert.equal(f.head(f.checkout), head); assert.equal(f.status(f.checkout), ''); assert.equal(fs.existsSync(path.join(f.checkout, 'src/shared.js')), false);
  await assert.rejects(f.apply(r), e => e.code === 'CONFLICT', 'stale review remains single-use');
});
posix('coordination changes during asynchronous Git revalidation refuse apply before checkout effects', async t => {
  const f = fixture(t); f.write('src/shared.js', 'task\n'); const r = await f.preview(); let calls = 0;
  const current = () => { if (++calls === 5) f.coordination.claims.push({ taskId: 'new-peer', state: 'running', paths: ['src/shared.js'] }); return true; };
  const head = f.head(f.checkout);
  await assert.rejects(f.helper.apply(f.task, r.id, r.hash, current), e => e.code === 'CONFLICT');
  assert.ok(calls >= 5); assert.equal(f.head(f.checkout), head); assert.equal(fs.existsSync(path.join(f.checkout, 'src/shared.js')), false);
});
posix('integration refuses missing coordination authority instead of treating it as an empty inventory', async t => {
  const f = fixture(t); f.write('task.js', 'task\n');
  const helper = createTaskIntegration({ bin, dataDir: path.join(f.dir, 'no-authority') });
  await assert.rejects(helper.preview(f.task), e => e.code === 'POLICY_DENIED');
});
