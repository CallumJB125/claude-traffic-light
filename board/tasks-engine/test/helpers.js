// Tasks engine test harness: short temp dirs (AF_UNIX paths stay < 104 bytes
// on macOS), a local git repo with no remote (nothing reaches the network),
// and fake AI backends that drive the real ClaudeBackend through the fake
// claude CLI. No real `claude`/`codex` is ever spawned.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeBackend } from '../../runner/backends/claude.js';
import { CodexBackend } from '../../runner/backends/codex.js';
import { fakeClaudeBin } from '../../runner/test/helpers.js';
import { connect } from '../../tasks-api/client.js';
import { makeLogger } from '../../runner/util.js';

export function tmpDir(prefix = 'bte-') {
  return fs.realpathSync(fs.mkdtempSync(path.join('/tmp', prefix)));
}

export function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function makeRepo(root) {
  const co = path.join(root, 'app');
  fs.mkdirSync(co);
  git(co, 'init', '-q', '-b', 'main');
  git(co, 'config', 'user.email', 't@example.com');
  git(co, 'config', 'user.name', 'T');
  git(co, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(co, 'README.md'), '# app\n');
  git(co, 'add', '-A');
  git(co, 'commit', '-q', '-m', 'init');
  return { checkout: co, git: (...a) => git(co, ...a) };
}

/** {claude, codex} registry: claude = the real backend on a fake CLI; codex = installed but not startable. */
export function fakeBackends(dir, scenario, { claudeInstalled = true } = {}) {
  const bin = fakeClaudeBin(dir, scenario);
  class FakeClaude extends ClaudeBackend {
    static async detect() {
      return claudeInstalled ? { id: 'claude', installed: true, version: '9.9.9', signedIn: true, bin } : { id: 'claude', installed: false, version: null, signedIn: 'unknown', bin: null, reason: 'not_found' };
    }
  }
  class FakeCodex extends CodexBackend {
    static describe() { return { ...super.describe(), startable: false }; }
    static async detect() { return { id: 'codex', installed: true, version: '0.1.0', signedIn: true, bin: '/bin/false' }; }
  }
  FakeClaude.bin = bin;
  return { claude: FakeClaude, codex: FakeCodex };
}

export const ENV = { HOME: process.env.HOME, USER: process.env.USER, PATH: process.env.PATH, TMPDIR: '/tmp', LANG: 'en_US.UTF-8' };

/** Engine on a temp data dir + a connected client. */
export async function startEngine({ scenario = { steps: [{ result: 'success' }] }, dir = tmpDir(), engineOpts = {}, backendOpts } = {}) {
  const { startTasksEngine } = await import('../index.js');
  const dataDir = path.join(dir, 'data');
  const backends = engineOpts.backends ?? fakeBackends(dir, scenario, backendOpts);
  const eng = await startTasksEngine({
    dataDir, backends, env: ENV, log: makeLogger(process.stderr, { quiet: !process.env.BOARD_TEST_LOG }),
    interruptWaitMs: 400, stopGraceMs: 600, hbMs: 200, buddyHome: null, ...engineOpts,
  });
  const client = await connect({ socketPath: eng.socketPath, tokenPath: eng.tokenPath });
  return {
    eng, client, dir, dataDir, backends,
    async close(opts) { client.close(); await eng.close(opts); },
  };
}

/** policy.json in the engine data dir (0600), e.g. {accept_from:[…], repos:{<path|canonical>:{remote_tasks:true}}}. */
export function writePolicy(dataDir, policy) {
  const f = path.join(dataDir, 'policy.json');
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(policy), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

export async function waitFor(fn, { timeoutMs = 10000, stepMs = 20, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function fakeLog(runDir) {
  try { return fs.readFileSync(path.join(runDir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
