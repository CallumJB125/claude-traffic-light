// Actual local Git and durable store, with inert metadata-only backends.
// No AI executable, user profile, external repository or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { TasksEngine } from '../engine.js';
import { TaskStore } from '../store.js';
import { ipcRequest } from '../../runner/ipc.js';

const gate = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const turn = () => new Promise(r => setImmediate(r));
async function bounded(p) {
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture receipt deadline')), 5000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture({ ai = 'codex', startAllowed = false, maxParallel = 1 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pfc-')));
  const fixtureHome = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const repo = path.join(root, 'app');
  for (const dir of [fixtureHome, dataDir, repo]) fs.mkdirSync(dir, { mode: 0o700 });
  const env = { HOME: fixtureHome, PATH: process.env.PATH, TMPDIR: root, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Synthetic fixture');
  fs.writeFileSync(path.join(repo, 'README.md'), 'original\n');
  git('add', 'README.md');
  git('commit', '-qm', 'fixture');
  const started = gate();
  const instances = [];
  class InertBackend extends EventEmitter {
    static describe() { return { id: ai, label: 'Inert fixture', startable: true, capabilities: { structuredEvents: true, permissions: ai === 'codex' ? 'sandbox-flags' : 'hooks', budget: 'none', resume: true } }; }
    static async detect() { return { installed: true, signedIn: true, version: '1.0.0', bin: path.join(root, 'never-executed') }; }
    constructor() { super(); this.exited = true; this.starts = 0; this.stops = 0; instances.push(this); InertBackend.onConstruct?.(); }
    start() {
      this.starts++;
      assert.ok(startAllowed, 'backend start is forbidden during this fixture');
      this.exited = false;
      started.resolve(this);
    }
    async stop() { this.stops++; await this.stopGate?.promise; this.exited = true; this.emit('exit', {}); }
  }
  const store = new TaskStore(path.join(dataDir, 'store'));
  const storeClose = store.close.bind(store);
  let closes = 0;
  store.close = () => { closes++; storeClose(); };
  const engine = new TasksEngine({ dataDir, store, backends: { [ai]: InertBackend }, env, maxParallel, log: { info() {}, warn() {}, error() {} } });
  await engine.init();
  const releases = [];
  const receipts = [];
  const pendingGit = new Set();
  function holdGit(predicate) {
    const entered = gate();
    const release = gate();
    releases.push(release);
    const original = engine.git;
    let held = false;
    engine.git = (cwd, args, opts) => {
      const operation = (async () => {
        const output = await original(cwd, args, opts);
        receipts.push({ cwd, args: [...args], output });
        if (!held && predicate(args)) { held = true; entered.resolve(); await release.promise; }
        return output;
      })();
      pendingGit.add(operation);
      operation.then(() => pendingGit.delete(operation), () => pendingGit.delete(operation));
      return operation;
    };
    return { entered: entered.promise, release: release.resolve };
  }
  const spec = { text: 'Synthetic shutdown check', cwd: repo, ai };
  return {
    engine, store, root, repo, git, spec, instances, Backend: InertBackend, started: started.promise, receipts, holdGit,
    get closes() { return closes; },
    async cleanup() {
      for (const g of releases) g.resolve();
      // Also join held receipts on the unchanged implementation when the
      // premature-close assertion fails. Never delete a live fixture tree.
      for (;;) { await Promise.allSettled([...pendingGit, ...engine.locks.values(), ...[...engine.createCache.values()].map(e => e.pending)]); await turn(); if (!pendingGit.size) break; }
      await engine.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('close joins admitted real Git workspace preparation before teardown; concurrent callers share completion', async () => {
  const f = await fixture();
  try {
    const head = f.git('rev-parse', 'HEAD');
    const hold = f.holdGit(a => a[0] === 'worktree' && a[1] === 'add');
    const { id } = await f.engine.createTask({ requestId: 'prepare-1', spec: f.spec });
    await bounded(hold.entered);
    const task = f.engine.tasks.get(id);
    assert.ok(fs.existsSync(path.join(task.worktree, '.git')), 'actual child Git created its own worktree');
    let firstDone = false, secondDone = false;
    const first = f.engine.close().then(() => { firstDone = true; });
    const second = f.engine.close().then(() => { secondDone = true; });
    await turn();
    assert.equal(firstDone || secondDone, false, 'close cannot finish while admitted preparation is held');
    assert.notEqual(f.store.taskFd, null, 'store stays open for admitted work and recovery state');
    hold.release();
    await bounded(Promise.all([first, second]));
    assert.equal(f.closes, 1);
    assert.equal(f.instances.length, 0, 'no backend constructed after close began');
    assert.equal(task.state, 'orphaned');
    assert.equal(task.worktreeCreated, true);
    assert.equal(fs.readFileSync(path.join(task.worktree, 'README.md'), 'utf8'), 'original\n');
    assert.equal(f.git('rev-parse', 'HEAD'), head);
    const durable = new TaskStore(path.join(f.root, 'data/store'));
    try { assert.equal(durable.load().tasks.get(id).state, 'orphaned'); } finally { durable.close(); }
    const receipts = f.receipts.length;
    await turn(); await turn();
    assert.equal(f.receipts.length, receipts, 'no Git child completes after successful close');
    assert.equal(f.store.taskFd, null);
  } finally { await f.cleanup(); }
});

test('close drains accepted creation and refuses new and replayed creation before recording tasks', async () => {
  const f = await fixture();
  try {
    const hold = f.holdGit(a => a[0] === 'rev-parse' && a[1] === '--show-toplevel');
    const request = { requestId: 'creation-1', spec: f.spec };
    const creating = f.engine.createTask(request);
    const outcome = creating.then(value => ({ value }), error => ({ error }));
    await bounded(hold.entered);
    let done = false;
    const closing = f.engine.close().then(() => { done = true; });
    await turn();
    assert.equal(done, false, 'creation owns an outstanding actual Git receipt');
    await assert.rejects(f.engine.createTask(request), e => e.code === 'INTERNAL');
    await assert.rejects(f.engine.createTask({ ...request, requestId: 'creation-2' }), e => e.code === 'INTERNAL');
    hold.release();
    const [, refused] = await bounded(Promise.all([closing, outcome]));
    assert.equal(refused.error?.code, 'INTERNAL');
    assert.equal(f.engine.tasks.size, 0);
    assert.equal(f.instances.length, 0);
  } finally { await f.cleanup(); }
});

test('close during pre-start Git discovery cleans its own partial run and real IPC without backend start', async () => {
  const f = await fixture({ ai: 'claude' });
  try {
    const hold = f.holdGit(a => a[0] === 'rev-parse' && a[1] === '--git-common-dir');
    const { id } = await f.engine.createTask({ requestId: 'spawn-1', spec: f.spec });
    await bounded(hold.entered);
    const run = f.engine.runs.get(id);
    assert.ok(run?.ipc && fs.existsSync(run.socketPath), 'owned synthetic IPC is actually listening');
    assert.equal(run.backend, null);
    let done = false;
    const closing = f.engine.close().then(() => { done = true; });
    await turn();
    assert.equal(done, false);
    const denied = await ipcRequest(run.socketPath, { type: 'hook', id: 'closing-write', token: run.token, event: 'pre', payload: { tool_name: 'Write', tool_input: { file_path: path.join(f.engine.tasks.get(id).worktree, 'late.txt') } } });
    assert.equal(denied.result.stdout.hookSpecificOutput.permissionDecision, 'deny', 'closing never grants new file work');
    hold.release();
    await bounded(closing);
    assert.equal(f.instances.length, 0);
    assert.equal(fs.existsSync(run.socketPath), false);
    assert.equal(f.engine.runs.size, 0);
    assert.equal(f.engine.tasks.get(id).state, 'orphaned');
    assert.ok(fs.existsSync(f.engine.tasks.get(id).worktree), 'prepared work remains available for retry');
  } finally { await f.cleanup(); }
});

for (const failConstruction of [false, true]) test(`a synchronous close during inert backend construction prevents start${failConstruction ? ' and cleans a failed construction' : ''}`, async () => {
  const f = await fixture();
  try {
    const constructed = gate();
    let closing;
    f.Backend.onConstruct = () => { closing = f.engine.close(); constructed.resolve(); if (failConstruction) throw new Error('synthetic constructor failure'); };
    await f.engine.createTask({ requestId: 'constructor-close', spec: f.spec });
    await bounded(constructed.promise);
    await bounded(closing);
    assert.equal(f.instances[0].starts, 0);
    assert.equal(f.engine.runs.size, 0);
    assert.equal([...f.engine.tasks.values()][0].state, 'orphaned');
  } finally { await f.cleanup(); }
});

test('close drains an admitted action and refuses a queued action and replay while shutting down', async () => {
  const f = await fixture({ startAllowed: true });
  try {
    const { id } = await f.engine.createTask({ requestId: 'action-task', spec: f.spec });
    const backend = await bounded(f.started);
    await turn();
    backend.stopGate = gate();
    const action = { id, action: 'stop', requestId: 'stop-1' };
    const stopping = f.engine.act(action);
    await turn();
    assert.equal(backend.stops, 1);
    const queued = f.engine.act({ id, action: 'stop', requestId: 'stop-2' });
    const queuedOutcome = queued.then(value => ({ value }), error => ({ error }));
    let done = false;
    const closing = f.engine.close().then(() => { done = true; });
    await turn();
    assert.equal(done, false);
    let replayOutcome;
    f.engine.act(action).then(value => { replayOutcome = { value }; }, error => { replayOutcome = { error }; });
    await turn();
    assert.equal(replayOutcome?.error?.code, 'INTERNAL');
    backend.stopGate.resolve();
    const [, rejected] = await bounded(Promise.all([stopping, queuedOutcome, closing]));
    assert.equal(rejected.error?.code, 'INTERNAL');
    assert.equal(backend.stops, 1);
    assert.equal(f.engine.tasks.get(id).state, 'failed', 'admitted human stop retains its terminal result');
  } finally { for (const b of f.instances) b.stopGate?.resolve(); await f.cleanup(); }
});

for (const leaveRuns of [false, true]) test(`close preserves ${leaveRuns ? 'leaveRuns' : 'normal stop'} semantics and existing work`, async () => {
  const f = await fixture({ startAllowed: true });
  try {
    const { id } = await f.engine.createTask({ requestId: 'live-task', spec: f.spec });
    const backend = await bounded(f.started);
    await turn();
    const task = f.engine.tasks.get(id);
    const readme = path.join(task.worktree, 'README.md');
    fs.writeFileSync(readme, 'user edits remain\n');
    await bounded(Promise.all([f.engine.close({ leaveRuns }), f.engine.close({ leaveRuns: !leaveRuns })]));
    assert.equal(backend.stops, leaveRuns ? 0 : 1, 'first caller chooses shutdown mode');
    assert.equal(task.state, leaveRuns ? 'claimed' : 'orphaned');
    assert.equal(fs.readFileSync(readme, 'utf8'), 'user edits remain\n');
    assert.equal(f.closes, 1);
    const eventSize = fs.statSync(f.store.eventsFile).size;
    backend.emit('assistant', { text: 'late event after shutdown' });
    await turn();
    assert.equal(fs.statSync(f.store.eventsFile).size, eventSize);
  } finally { await f.cleanup(); }
});

test('Windows unconfirmed stop preserves its run and workspace and refuses a stopped handover', async () => {
  const f = await fixture({ startAllowed: true });
  try {
    const { id } = await f.engine.createTask({ requestId: 'windows-stop-task', spec: f.spec });
    const backend = await bounded(f.started); await turn();
    backend.platform = 'win32'; backend.confirmStopped = async () => false;
    const task = f.engine.tasks.get(id), run = f.engine.runs.get(id), worktree = task.worktree;
    await assert.rejects(f.engine.act({ id, action: 'stop', requestId: 'unconfirmed-stop' }), e => e.code === 'NOT_AVAILABLE' && /unconfirmed/.test(e.message));
    assert.equal(f.engine.runs.get(id), run); assert.equal(task.windowsStopUnconfirmed, true); assert.match(task.failReason, /quarantined/); assert.ok(fs.existsSync(worktree));
    await assert.rejects(f.engine.act({ id, action: 'retry', requestId: 'blocked-retry' }), e => e.code === 'ILLEGAL_TRANSITION');
    assert.equal(f.engine.runs.get(id), run);
  } finally { for (const b of f.instances) b.confirmStopped = async () => true; await f.cleanup(); }
});

test('restart quarantines a persisted Windows launch even without a provider PID or surviving root', async () => {
  const f = await fixture({ startAllowed: true }); let restarted;
  try {
    const { id } = await f.engine.createTask({ requestId: 'windows-crash-task', spec: f.spec });
    await bounded(f.started); await turn();
    const task = f.engine.tasks.get(id);
    task.run = { kind: 'windows-job', pid: null, lstart: null, pgid: null };
    f.store.saveTask(task, f.engine.tasks);
    await f.engine.close({ leaveRuns: true });
    restarted = new TasksEngine({ dataDir: f.engine.dataDir, store: new TaskStore(path.join(f.engine.dataDir, 'store')), backends: { codex: f.Backend }, env: f.engine.env, log: { info() {}, warn() {}, error() {} } });
    await restarted.init();
    const recovered = restarted.tasks.get(id);
    assert.equal(recovered.windowsStopUnconfirmed, true); assert.equal(recovered.run.kind, 'windows-job'); assert.ok(fs.existsSync(recovered.worktree));
    await assert.rejects(restarted.act({ id, action: 'retry', requestId: 'quarantine-retry' }), e => e.code === 'ILLEGAL_TRANSITION');
    assert.equal(f.instances.length, 1, 'recovery and retry never create another backend');
  } finally { await restarted?.close(); await f.cleanup(); }
});
