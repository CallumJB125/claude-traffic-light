// A launch that hangs must release its engine slot and fail the task with a clear reason.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { TasksEngine } from '../engine.js';
import { TaskStore } from '../store.js';

const turn = () => new Promise((r) => setImmediate(r));
async function until(pred) { for (let i = 0; i < 20000 && !pred(); i++) await new Promise((r) => setImmediate(r)); assert.ok(pred(), 'condition reached'); }

async function fixture(hangFirst) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plt-')));
  const dataDir = path.join(root, 'data'), repo = path.join(root, 'app'), home = path.join(root, 'home');
  for (const d of [dataDir, repo, home]) fs.mkdirSync(d, { mode: 0o700 });
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: root, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n'); git('add', 'README.md'); git('commit', '-qm', 'fixture');
  const instances = [];
  class Hang extends EventEmitter {
    static describe() { return { id: 'gemini', label: 'Gemini', startable: true, capabilities: { structuredEvents: true, permissions: 'sandbox-flags', budget: 'none', resume: true } }; }
    static async detect() { return { installed: true, signedIn: true, version: '1', bin: path.join(root, 'never') }; }
    constructor() { super(); this.exited = true; this.stops = 0; instances.push(this); }
    start() { this.n = instances.indexOf(this); return hangFirst && this.n === 0 ? new Promise(() => {}) : Promise.resolve(); }
    async stop() { this.stops++; this.exited = true; }
  }
  const store = new TaskStore(path.join(dataDir, 'store'));
  const engine = new TasksEngine({ dataDir, store, backends: { gemini: Hang }, env, maxParallel: 1, launchTimeoutMs: 5000, log: { info() {}, warn() {}, error() {} } });
  await engine.init();
  return { engine, instances, spec: { text: 'hang', cwd: repo, ai: 'gemini' }, async cleanup() { mock.timers.reset(); await engine.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('gemini has engine slots', async () => {
  const f = await fixture(false);
  try { assert.ok(f.engine.limits.perAi.gemini > 0); } finally { await f.cleanup(); }
});

test('a hung launch times out, frees the slot, and fails with a reason; the next task starts', async () => {
  const f = await fixture(true);
  try {
    mock.timers.enable({ apis: ['setTimeout'] });
    const a = await f.engine.createTask({ requestId: 'a', spec: f.spec });
    await until(() => f.instances.length === 1);
    const b = await f.engine.createTask({ requestId: 'b', spec: f.spec });
    const ta = f.engine.tasks.get(a.id), tb = f.engine.tasks.get(b.id);
    assert.equal(ta.state, 'claimed');
    assert.equal(tb.state, 'queued');
    mock.timers.tick(5000);
    await until(() => ta.state === 'failed');
    assert.match(ta.failReason, /did not start within 5 seconds/);
    assert.equal(f.instances[0].stops, 1);
    await until(() => f.instances.length === 2);
    assert.notEqual(tb.state, 'queued');
    await turn();
  } finally { await f.cleanup(); }
});
