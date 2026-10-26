import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBackend, codexConfig } from '../backends/codex.js';
import { tmpDir, rm, waitFor, alive } from './helpers.js';
const fixture = fileURLToPath(new URL('./fixtures/fake-codex.js', import.meta.url));
function setup(dir, scenario, extra = {}) {
 const runDir = path.join(dir, 'run'); fs.mkdirSync(runDir); const scenarioFile = path.join(dir, 'scenario.json'); fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
 const log = path.join(dir, 'fake.log'); const bin = path.join(dir, 'codex'); fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
 const env = { HOME: dir, PATH: process.env.PATH, TMPDIR: dir, PLEXIFORM_FAKE_CODEX_SCENARIO: scenarioFile, PLEXIFORM_FAKE_CODEX_LOG: log };
 return { backend: new CodexBackend({ bin, cwd: dir, env, runDir, sessionId: '00000000-0000-4000-8000-000000000001', systemPrompt: 'trusted scope', stopGraceMs: 300, ...extra }), log, read: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('Codex subscription turn: raw prompt only stdin, isolated argv, normalized events and real resume UUID', async () => {
 const dir = tmpDir('px-codex-');
 try {
  const f = setup(dir, { write: true, text: 'done' }); const events = []; for (const n of ['init','tool_start','tool_end','assistant','usage','result','exit']) f.backend.on(n, (data) => events.push({ n, data }));
  const prompt = 'task $(touch /tmp/forged) --dangerously-bypass-approvals-and-sandbox'; const argv = f.backend.argv(); f.backend.start(prompt);
  await waitFor(() => f.backend.exited, { what: 'Codex completion' });
  assert.ok(!argv.some((a) => a.includes(prompt))); assert.ok(argv.includes('--ignore-user-config') && argv.includes('--ignore-rules') && argv.includes('--strict-config'));
  assert.equal(f.read().find((x) => x.kind === 'prompt').prompt, prompt);
  assert.equal(f.backend.sessionId, '00000000-0000-4000-8000-000000000159');
  assert.equal(events.find((e) => e.n === 'result').data.subtype, 'success'); assert.equal(events.find((e) => e.n === 'usage').data.costUsd, null);
  assert.equal(events.find((e) => e.n === 'tool_start').data.name, 'Write'); assert.equal(f.backend.send('next'), false);
  f.backend.resume = true; assert.equal(f.backend.argv().at(-2), f.backend.sessionId);
 } finally { rm(dir); }
});

test('Codex unavailable budget and approval routing fail before spawn; failed turns normalize', async () => {
 const dir = tmpDir('px-codex-');
 try {
  const f = setup(dir, { error: 'rate limit exceeded' });
  f.backend.budget = { amount: 1, unit: 'usd' }; assert.throws(() => f.backend.start('go'), (e) => e.code === 'NOT_AVAILABLE'); assert.equal(f.backend.pid, null);
  f.backend.budget = null; f.backend.permissionMode = 'default'; assert.throws(() => f.backend.start('go'), (e) => e.code === 'NOT_AVAILABLE');
  f.backend.permissionMode = 'acceptEdits'; let r; f.backend.on('result', (e) => r = e); f.backend.start('go'); await waitFor(() => f.backend.exited, { what: 'failed turn' }); assert.equal(r.subtype, 'error'); assert.match(r.result, /rate limit/);
 } finally { rm(dir); }
});

test('Codex stop terminates own process group', async () => {
 const dir = tmpDir('px-codex-'); let b;
 try { const f = setup(dir, { wait: true }); b = f.backend; let tool = false; b.on('tool_start', () => tool = true); b.start('go'); await waitFor(() => tool, { what: 'tool started' }); const pid = b.pid; await b.stop(); assert.equal(b.exited, true); assert.equal(alive(pid), false); }
 finally { await b?.stop(); rm(dir); }
});

test('Codex stop waits for SIGKILL when its CLI ignores SIGTERM', async () => {
 const dir = tmpDir('px-codex-'); let b;
 try { const f = setup(dir, { wait: true, ignoreTerm: true }); b = f.backend; let tool = false; b.on('tool_start', () => tool = true); b.start('go'); await waitFor(() => tool); const pid = b.pid; assert.equal(await b.stop(), true); assert.equal(b.exited, true); assert.equal(alive(pid), false); }
 finally { await b?.stop(); rm(dir); }
});

test('Codex profile narrows writes, denies authority/auth files and never enables network or Unix sockets', () => {
 const c = codexConfig({ cwd: '/repo-wt', dataDir: '/private/tasks', cacheDir: '/tmp/task-cache', commonGitDir: '/repo/.git', env: { HOME: '/home/user', CODEX_HOME: '/private/auth', PATH: '/usr/bin' } }).join('\n');
 for (const p of ['/private/tasks','/private/auth','/home/user/.ssh','/home/user/.aws']) assert.ok(c.includes(`${JSON.stringify(p)}="deny"`));
 for (const p of ['/repo-wt/AGENTS.md','/repo/.git/config','/repo/.git/hooks']) assert.ok(c.includes(`${JSON.stringify(p)}="read"`));
 assert.ok(c.includes('network.enabled=false')); assert.ok(c.includes('dangerously_allow_all_unix_sockets=false')); assert.ok(!c.includes('"/tmp"="write"'));
});

test('Codex Git writes are restricted to objects, private metadata and the authorized branch', () => {
 const opts = { cwd: '/repo-wt', cacheDir: '/tmp/task-cache', gitDir: '/repo/.git/worktrees/task', commonGitDir: '/repo/.git', gitRef: 'refs/heads/buddy/task' };
 const profile = codexConfig(opts).join('\n');
 for (const p of ['/repo/.git/objects', '/repo/.git/worktrees/task', '/repo/.git/refs/heads/buddy/task', '/repo/.git/refs/heads/buddy/task.lock', '/repo/.git/logs/refs/heads/buddy/task']) assert.ok(profile.includes(`${JSON.stringify(p)}="write"`), p);
 assert.ok(profile.includes('"/repo/.git"="read"')); assert.ok(!profile.includes('"/repo/.git/refs"="write"')); assert.ok(!profile.includes('"/repo/.git/refs/heads/main"="write"'));
 assert.ok(profile.includes('"/repo/.git/worktrees/task/config.worktree"="read"'));
 const plan = codexConfig({ ...opts, readOnly: true }).join('\n');
 assert.ok(!plan.includes('"/repo/.git/objects"="write"')); assert.ok(!plan.includes('"/repo/.git/refs/heads/buddy/task"="write"'));
 for (const gitRef of ['refs/heads/../../config', 'refs/heads/main.lock', 'refs/heads/.hidden', 'refs/heads/main\n']) {
  const invalid = codexConfig({ ...opts, gitRef }).join('\n');
  assert.ok(!invalid.includes('"/repo/.git/refs/heads/'), gitRef);
 }
});

// PR 3 (A8, C16, D26): the user's provider rides as -c values; its key value only in the CLI env.
test('Codex provider overrides: -c after the profile, key value only in the CLI process env, never in a tool shell or the board MCP env', async () => {
 const dir = tmpDir('px-codex-');
 try {
  const KEY = 'plexlab-fake-key-0123456789abcdef';
  const providerOverrides = ['model_provider="plexlab"', 'model_providers.plexlab.base_url="http://10.0.0.5:4001/v1"', 'model_providers.plexlab.env_key="PLEXLAB_KEY"'];
  const f = setup(dir, { text: 'done' }, { providerOverrides, model: 'glm-5.3-flash', boardRunDir: path.join(dir, 'run') });
  f.backend.env = { ...f.backend.env, PLEXLAB_KEY: KEY };
  const argv = f.backend.argv();
  for (const o of providerOverrides) assert.equal(argv[argv.indexOf(o) - 1], '-c', o);
  assert.ok(argv.indexOf(providerOverrides[0]) > argv.findIndex((a) => a.startsWith('shell_environment_policy.set=')), 'the profile comes first');
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'glm-5.3-flash']);
  assert.ok(!argv.some((a) => a.includes(KEY)), 'no key value on argv');
  const set = argv.find((a) => a.startsWith('shell_environment_policy.set='));
  assert.ok(argv.includes('shell_environment_policy.inherit="none"'));
  assert.ok(!set.includes('PLEXLAB_KEY') && !set.includes(KEY), 'the tool shell env is the explicit set only');
  const mcpEnv = argv.find((a) => a.startsWith('mcp_servers.board.env='));
  assert.ok(mcpEnv && !mcpEnv.includes('PLEXLAB_KEY'));
  assert.ok(argv.includes('mcp_servers.board.env_vars=[]'));
  f.backend.start('go');
  await waitFor(() => f.backend.exited, { what: 'Codex completion' });
  assert.equal(f.read().find((x) => x.kind === 'start').env.PLEXLAB_KEY, KEY, 'the CLI process itself gets the key');
 } finally { rm(dir); }
});

test('Codex profile on Linux reads distro-packaged npm tools (C17); macOS is unchanged', () => {
 const linux = codexConfig({ cwd: '/w', env: { HOME: '/home/u' }, platform: 'linux' }).join('\n');
 assert.ok(linux.includes('"/usr/lib/node_modules"="read"'));
 const mac = codexConfig({ cwd: '/w', env: { HOME: '/Users/u' }, platform: 'darwin' }).join('\n');
 assert.ok(!mac.includes('/usr/lib/node_modules'));
});
