import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateFixtureDirectory } from '../../shared/test-support/windows-acl.js';
import { startMockServer, SCHEMA } from '../mock-server.js';
import { connect } from '../client.js';
import { validate } from '../validate.js';

export { SCHEMA };

export function tmpDir() {
  // Short base: AF_UNIX paths are capped at 104 bytes on macOS.
  return privateFixtureDirectory(path.join(os.platform() === 'darwin' ? '/tmp' : os.tmpdir(), 'bt-'));
}

export async function startMock(opts = {}) {
  const dir = opts.dir ?? tmpDir();
  const srv = await startMockServer({ dir, speed: 50, hbMs: 200, ...opts });
  const client = await connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  return {
    srv, client, dir,
    async close() {
      client.close();
      await srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Conformance: the same assertions run against the mock and the real engine
// (board/tasks-engine) driving the real ClaudeBackend through the fake claude CLI.
export const TARGETS = ['mock', 'engine'];

const ENGINE_SCENARIO = {
  steps: [
    { assistant: "I'll start by reading the README." }, { tool: 'Read', input: { file_path: 'README.md' } },
    { tool: 'Write', input: { file_path: 'src/theme.js', content: 'export const THEMES = [];\n' } },
    { tool: 'Bash', input: { command: 'npm test' }, ms: 1500 }, { result: 'success', text: 'Added a theme module. Tests pass.', cost: 0.42 },
  ],
  resume_steps: [{ assistant: 'Resumed.' }, { tool: 'Bash', input: { command: 'npm test' }, ms: 1500 }, { result: 'success', text: 'Done after resume.', cost: 0.1 }],
};

/**
 * startTarget('mock'|'engine', opts) → {target, srv, client, dir, spec, close(), dispose()}
 * srv: {socketPath, tokenPath, token, tasks, close()}; dir: the 0700 dir holding the socket and token;
 * spec: a TaskSpec whose cwd exists for this target. dispose() closes the server (if still open) and removes everything.
 */
export async function startTarget(target, opts = {}) {
  if (target === 'mock') {
    const m = await startMock(opts);
    let closed = false;
    return {
      ...m, target, spec: { text: 'Rename the helper and update its callers', cwd: '/tmp/repo-x' },
      async dispose() { if (!closed) { closed = true; m.client.close(); await m.srv.close(); } fs.rmSync(m.dir, { recursive: true, force: true }); },
    };
  }
  const { startTasksEngine } = await import('../../tasks-engine/index.js');
  const { fakeBackends, makeRepo, ENV } = await import('../../tasks-engine/test/helpers.js');
  const root = privateFixtureDirectory(path.join(os.platform() === 'darwin' ? '/tmp' : os.tmpdir(), 'bc-'));
  const repo = makeRepo(root);
  const dir = path.join(root, 'd');
  const srv = await startTasksEngine({
    dataDir: dir, backends: fakeBackends(root, opts.scenario ?? ENGINE_SCENARIO), env: ENV, hbMs: opts.hbMs ?? 200,
    log: { info() {}, warn() {}, error() {}, debug() {} }, interruptWaitMs: 400, stopGraceMs: 600, buddyHome: null,
  });
  // Remote work in this repo is opted in, as the user would in policy.json.
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ repos: { [repo.checkout]: { remote_tasks: true } } }), { mode: 0o600 });
  const client = await connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  let closed = false;
  const shut = async () => { if (closed) return; closed = true; client.close(); await srv.close(); };
  return {
    target, srv, client, dir, repo, spec: { text: 'Rename the helper and update its callers', cwd: repo.checkout },
    async close() { await shut(); fs.rmSync(root, { recursive: true, force: true }); },
    async dispose() { await shut(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

export function assertValid(def, value, label = def) {
  const e = validate(SCHEMA, def, value);
  if (e) throw new Error(`${label} does not match ${def}: ${e.path}: ${e.message}\n${JSON.stringify(value).slice(0, 600)}`);
}

export async function waitFor(fn, { timeoutMs = 8000, stepMs = 10, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export async function stateOf(client, id) {
  return (await client.getTask(id)).state;
}

export function byScript(srv, script) {
  return [...srv.tasks.values()].find((t) => t.script === script);
}
