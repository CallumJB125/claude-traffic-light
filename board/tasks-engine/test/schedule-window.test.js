// Scheduling windows and "after reset": a queued task only starts when its gate opens (fake clock).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { TasksEngine } from '../engine.js';
import { TaskStore } from '../store.js';

async function until(pred) { for (let i = 0; i < 20000 && !pred(); i++) await new Promise((r) => setImmediate(r)); assert.ok(pred(), 'condition reached'); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (h, m) => new Date(2026, 0, 15, h, m, 0).getTime();

async function fixture(start) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plt-')));
  const dataDir = path.join(root, 'data'), repo = path.join(root, 'app'), home = path.join(root, 'home');
  for (const d of [dataDir, repo, home]) fs.mkdirSync(d, { mode: 0o700 });
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: root, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n'); git('add', 'README.md'); git('commit', '-qm', 'fixture');
  let started = 0;
  class Fake extends EventEmitter {
    static describe() { return { id: 'gemini', label: 'Gemini', startable: true, capabilities: { structuredEvents: true, permissions: 'sandbox-flags', budget: 'none', resume: true } }; }
    static async detect() { return { installed: true, signedIn: true, version: '1', bin: path.join(root, 'never') }; }
    constructor() { super(); this.exited = true; }
    start() { started++; return Promise.resolve(); }
    async stop() { this.exited = true; }
  }
  const clock = { t: start };
  const store = new TaskStore(path.join(dataDir, 'store'));
  const engine = new TasksEngine({ dataDir, store, backends: { gemini: Fake }, env, maxParallel: 2, tickMs: 10, now: () => clock.t, log: { info() {}, warn() {}, error() {} } });
  await engine.init();
  return { engine, clock, started: () => started, spec: { text: 'night work', cwd: repo, ai: 'gemini' }, async cleanup() { await engine.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('a 22:00-07:00 window keeps a task queued at 21:59 and launches it at 22:00', async () => {
  const f = await fixture(at(21, 59));
  try {
    const { id } = await f.engine.createTask({ requestId: 'win-1', spec: { ...f.spec, window: { from: '22:00', to: '07:00' } } });
    const t = f.engine.tasks.get(id);
    await wait(60);
    assert.equal(t.state, 'queued');
    assert.match(t.queueReason, /22:00/);
    assert.equal(f.started(), 0);
    f.clock.t = at(22, 0);
    await until(() => f.started() === 1);
    assert.notEqual(t.state, 'queued');
  } finally { await f.cleanup(); }
});

test('a window that has closed again stops new starts (07:00)', async () => {
  const f = await fixture(at(7, 0));
  try {
    const { id } = await f.engine.createTask({ requestId: 'win-2', spec: { ...f.spec, window: { from: '22:00', to: '07:00' } } });
    await wait(60);
    assert.equal(f.engine.tasks.get(id).state, 'queued');
    f.clock.t = at(3, 30);
    await until(() => f.started() === 1);
  } finally { await f.cleanup(); }
});

test('startAfter holds a task until that time', async () => {
  const f = await fixture(at(12, 0));
  try {
    const { id } = await f.engine.createTask({ requestId: 'sa-1', spec: { ...f.spec, startAfter: at(13, 0) } });
    await wait(60);
    assert.equal(f.engine.tasks.get(id).state, 'queued');
    f.clock.t = at(13, 0);
    await until(() => f.started() === 1);
  } finally { await f.cleanup(); }
});

test('an "after reset" queued task waits for limitResetAt, then starts', async () => {
  const f = await fixture(at(12, 0));
  try {
    const parked = await f.engine.createTask({ requestId: 'p-1', spec: { ...f.spec, text: 'hit the limit' } });
    await until(() => f.started() === 1);
    const p = f.engine.tasks.get(parked.id);
    p.state = 'parked'; p.parkReason = 'limit'; p.limitResetAt = at(15, 0);
    const { id } = await f.engine.createTask({ requestId: 'ar-1', spec: { ...f.spec, text: 'after the reset', afterReset: true } });
    const t = f.engine.tasks.get(id);
    await wait(60);
    assert.equal(t.state, 'queued');
    assert.match(t.queueReason, /reset/);
    f.clock.t = at(15, 0);
    await until(() => f.started() === 2);
    assert.notEqual(t.state, 'queued');
  } finally { await f.cleanup(); }
});

test('an "after reset" task with no known limit starts straight away', async () => {
  const f = await fixture(at(12, 0));
  try {
    await f.engine.createTask({ requestId: 'ar-2', spec: { ...f.spec, afterReset: true } });
    await until(() => f.started() === 1);
  } finally { await f.cleanup(); }
});
