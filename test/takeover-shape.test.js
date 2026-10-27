'use strict';
// PR 0s: the take-over shape (plan-agent-terminal §R3.2.2, §R3.11, §R3.14 widening).
// The real engine's take-over output passes checkTakeover for each Claude
// variant, and every widening of it fails (plan-pr0s §6 ruling 3). The board
// engine is driven the way test/awareness-notes-e2e.test.js drives board code.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { checkTakeover, SHAPE } = require('../src/keeper-protocol/takeover-shape');

const posix = process.platform !== 'win32';
const ROOT = path.join(__dirname, '..');
const board = (p) => import(path.join(ROOT, 'board', p));
const SECRET_ENV = /(TOKEN|SECRET|KEY|PASSWORD)/i; // src/tasks-guard.js:294

// The engine's take-over → the keeper spawn T3 sends.
const spawnOf = (t, id) => ({ kind: 'takeover', argv: t.argv, cwd: t.cwd, env: t.env, origin: { by: 'plexiform', taskId: id }, cols: 120, rows: 32, reveal: true });

async function takeover({ spec = {}, carry = null, failStart = false } = {}) {
  const H = await board('tasks-engine/test/helpers.js');
  const dir = H.tmpDir('pr0s-');
  const repo = H.makeRepo(dir);
  const engineOpts = {};
  if (carry) {
    const { fixtureCarry } = await board('shared/test-support/claude-carry-fixture.js');
    engineOpts.claudeCarry = fixtureCarry(carry).carry;
  }
  if (failStart) {
    const backends = H.fakeBackends(dir, { steps: [{ result: 'success' }] });
    engineOpts.backends = { ...backends, claude: class extends backends.claude { async start() { throw new Error('fixture: the launch failed'); } } };
  }
  const m = await H.startEngine({ dir, scenario: { steps: [{ result: 'success', delayMs: 30000 }] }, engineOpts });
  H.writePolicy(m.dataDir, { repos: { [repo.checkout]: { remote_tasks: true } } });
  try {
    const { id } = await m.client.createTask({ text: 'Fix the README', cwd: repo.checkout, ...spec });
    await H.waitFor(async () => ['running', 'failed'].includes((await m.client.getTask(id)).state), { label: 'running or failed' });
    const t = (await m.client.act(id, 'takeover', { mode: 'print' })).takeover;
    return { spawn: spawnOf(t, id), t, dataDir: m.dataDir };
  } finally { await m.close().catch(() => {}); H.rm(dir); }
}

const customDir = { env: { CLAUDE_CONFIG_DIR: '/work/claude-cfg' } };
const withModel = async () => {
  const { settingsFile } = await board('shared/test-support/claude-carry-fixture.js');
  return { ...customDir, files: { '/work/claude-cfg/settings.json': settingsFile({ model: 'glm-5.3-flash' }) } };
};

test('the real engine\'s Claude take-overs fit the shape', { skip: !posix, timeout: 120000 }, async (t) => {
  const cases = {
    resumed: { spec: {} },
    'plan mode': { spec: { permissionLevel: 'plan' } },
    fresh: { failStart: true },
    'custom config dir and the person\'s model': { carry: await withModel() },
  };
  for (const [name, opts] of Object.entries(cases)) await t.test(name, async () => {
    const { spawn, t: out, dataDir } = await takeover(opts);
    assert.equal(checkTakeover(spawn, { dataDir }), null, name);
    if (name === 'fresh') assert.equal(out.argv[1], '--session-id');
    else assert.equal(out.argv[1], '--resume');
    if (name === 'plan mode') assert.equal(out.argv.at(-1), 'plan');
    if (name.startsWith('custom')) {
      assert.equal(out.env.CLAUDE_CONFIG_DIR, '/work/claude-cfg');
      assert.equal(out.argv[out.argv.indexOf('--model') + 1], 'glm-5.3-flash');
    }
  });
});

test('every widening of a real take-over fails, naming only the field', { skip: !posix, timeout: 60000 }, async () => {
  const { spawn, dataDir } = await takeover();
  const id = spawn.origin.taskId;
  const runDir = path.join(dataDir, 'run', id);
  const at = (argv, flag) => argv.indexOf(flag);
  const mutate = (fn) => { const s = structuredClone(spawn); fn(s); return checkTakeover(s, { dataDir }); };
  const fails = {
    'an extra flag': (s) => s.argv.push('--verbose'),
    '-p': (s) => s.argv.splice(at(s.argv, '--permission-mode'), 0, '-p'),
    '--dangerously-skip-permissions among the tools': (s) => s.argv.splice(at(s.argv, '--permission-mode'), 0, '--dangerously-skip-permissions'),
    'a prompt after the flags': (s) => s.argv.push('do something else'),
    '--settings outside the run dir': (s) => { s.argv[at(s.argv, '--settings') + 1] = '/tmp/settings.json'; },
    '--mcp-config outside the run dir': (s) => { s.argv[at(s.argv, '--mcp-config') + 1] = path.join(dataDir, 'run', 'tsk_000000000000', 'mcp.json'); },
    'setting sources not empty': (s) => { s.argv[at(s.argv, '--setting-sources') + 1] = 'user'; },
    'bypass permissions': (s) => { s.argv[at(s.argv, '--permission-mode') + 1] = 'bypassPermissions'; },
    'no deny rules': (s) => { const i = at(s.argv, '--disallowedTools'); s.argv.splice(i + 1, at(s.argv, '--permission-mode') - i - 1); },
    'a relative binary': (s) => { s.argv[0] = 'claude'; },
    'an extra env name': (s) => { s.env.NODE_OPTIONS = '--require /tmp/x.js'; },
    'ANTHROPIC_BASE_URL': (s) => { s.env.ANTHROPIC_BASE_URL = 'https://gw.example/v1'; },
    'a socket outside the run dir': (s) => { s.env.BOARD_RUN_SOCKET = '/tmp/ipc.sock'; },
    'another task\'s id': (s) => { s.env.BUDDY_TASK_ID = 'tsk_000000000000'; },
    'a missing required env name': (s) => { delete s.env.BOARD_RUN_SOCKET; },
    'a relative cwd': (s) => { s.cwd = 'app'; },
    'another kind': (s) => { s.kind = 'claude'; },
    'driver-originated': (s) => { s.origin.by = 'terminal'; },
  };
  for (const [name, fn] of Object.entries(fails)) {
    const r = mutate(fn);
    assert.ok(r && typeof r.field === 'string', name);
    assert.deepEqual(Object.keys(r), ['field'], `${name}: names the field only`);
  }
  assert.equal(mutate((s) => { s.argv[at(s.argv, '--settings') + 1] = path.join(runDir, 'settings.json'); }), null);
  // The §R3.14 widening: MCP tool names carry hyphens.
  assert.equal(mutate((s) => s.argv.splice(at(s.argv, '--permission-mode'), 0, 'mcp__srv-2__tool')), null);
  assert.equal(checkTakeover(spawn, { dataDir: 'relative' })?.field, 'dataDir');
});

test('a flag can never pass as a tool, and no allowed env name is secret-like', () => {
  const tool = new RegExp(SHAPE.patterns.tool);
  for (const flag of ['-p', '--dangerously-skip-permissions', '--model', '-', '']) assert.ok(!tool.test(flag), flag);
  for (const ok of ['WebFetch', 'Bash(git push --force*)', 'Read(~/.ssh/**)', 'mcp__srv-2__tool', 'Read(//proc/**)']) assert.ok(tool.test(ok), ok);
  for (const name of SHAPE.env.allow) assert.ok(!SECRET_ENV.test(name), name);
  assert.equal(SHAPE.codex, null, 'Codex\'s shape arrives with PR 0');
});
