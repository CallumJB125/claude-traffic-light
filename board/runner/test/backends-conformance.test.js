// Adapter conformance (runner-adapters-contract.md §1-5): the same checks run
// over every registered backend. Detection runs against fake CLIs in a temp
// PATH with a temp HOME. Hook-based backends use the fake Claude protocol;
// codex-backend.test.js checks Codex exec's separate one-turn JSON protocol.
// No real AI CLI is ever spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BACKENDS, NORMALISED_EVENTS, INTERNAL_EVENTS, CAPABILITY_VALUES, describeAll } from '../backends/index.js';
import { buildEnv } from '../launch.js';
import { resolveBin, safeBinary } from '../backends/detect.js';
import { tmpDir, rm, fakeClaudeBin, readFakeLog, waitFor, alive } from './helpers.js';

const IDS = Object.keys(BACKENDS);

function fakeCli(dir, name, { version = '1.2.3', loginExit = 0, hang = false, mode = 0o755 } = {}) {
  const bin = path.join(dir, name);
  const body = hang
    ? '#!/bin/sh\nexec /bin/sleep 30\n'
    : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${name} ${version} (fake)"; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit ${loginExit}; fi\nexit 3\n`;
  fs.writeFileSync(bin, body, { mode });
  fs.chmodSync(bin, mode);
  return bin;
}

test('registry: every backend has a stable id, a label, honest capabilities and static describe()/detect()', () => {
  assert.ok(IDS.includes('claude') && IDS.includes('codex'));
  for (const [id, B] of Object.entries(BACKENDS)) {
    assert.equal(typeof B.describe, 'function', `${id}.describe`);
    assert.equal(typeof B.detect, 'function', `${id}.detect`);
    const d = B.describe();
    assert.equal(d.id, id);
    assert.match(d.id, /^[a-z]+$/);
    assert.equal(typeof d.label, 'string');
    assert.equal(typeof d.startable, 'boolean');
    assert.deepEqual(Object.keys(d.capabilities).sort(), Object.keys(CAPABILITY_VALUES).sort(), `${id} capability keys`);
    for (const [k, allowed] of Object.entries(CAPABILITY_VALUES)) assert.ok(allowed.includes(d.capabilities[k]), `${id}.${k}=${d.capabilities[k]}`);
    if (d.capabilities.budget === 'none') assert.equal(d.capabilities.budgetUnit, null, 'no budget, no unit');
    else assert.ok(['usd', 'tokens'].includes(d.capabilities.budgetUnit));
  }
  assert.deepEqual(describeAll().map((d) => d.id), IDS);
  assert.equal(BACKENDS.claude.describe().capabilities.budget, 'native');
  assert.equal(BACKENDS.claude.describe().startable, true);
  assert.equal(BACKENDS.codex.describe().startable, true);
});

for (const id of IDS) {
  test(`[${id}] detect: not installed with an empty PATH; installed + version + absolute bin with a fake CLI; no network, no credential reads`, async () => {
    const home = tmpDir('bdh-');
    const binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir);
    try {
      const none = await BACKENDS[id].detect({ env: { HOME: home, PATH: path.join(home, 'nothing-here') }, knownDirs: [] });
      assert.deepEqual({ ...none, signedIn: undefined }, { id, installed: false, version: null, signedIn: undefined, bin: null, reason: 'not_found' });
      assert.ok([true, false, 'unknown'].includes(none.signedIn));

      fakeCli(binDir, id);
      const d = await BACKENDS[id].detect({ env: { HOME: home, PATH: binDir }, knownDirs: [], timeoutMs: 15000 });
      assert.equal(d.installed, true);
      assert.equal(d.version, '1.2.3');
      assert.equal(d.bin, fs.realpathSync(path.join(binDir, id)));
      assert.ok(path.isAbsolute(d.bin));
      assert.ok([true, false, 'unknown'].includes(d.signedIn));
      assert.ok(!('reason' in d) || /^[a-z_]+$/.test(d.reason));
    } finally { rm(home); }
  });

  test(`[${id}] detect: a world-writable binary is refused; a hanging probe times out`, async () => {
    const home = tmpDir('bdh-');
    const binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir);
    try {
      fakeCli(binDir, id, { mode: 0o777 });
      const d = await BACKENDS[id].detect({ env: { HOME: home, PATH: binDir }, knownDirs: [], timeoutMs: 15000 });
      assert.equal(d.installed, false);
      assert.equal(d.bin, null);
      assert.equal(d.reason, 'unsafe_bin');

      fs.rmSync(path.join(binDir, id));
      fakeCli(binDir, id, { hang: true });
      const t0 = Date.now();
      const h = await BACKENDS[id].detect({ env: { HOME: home, PATH: binDir }, knownDirs: [], timeoutMs: 300 });
      assert.ok(Date.now() - t0 < 2500, 'probe timeout respected');
      assert.equal(h.installed, true);
      assert.equal(h.version, null);
      assert.equal(h.reason, 'probe_failed');
      assert.equal(h.signedIn, 'unknown');
    } finally { rm(home); }
  });
}

test('resolveBin: a group-writable binary or a binary under an other-writable (non-sticky) or foreign-group-writable dir is refused', async () => {
  const home = tmpDir('bdh-');
  try {
    const a = path.join(home, 'a');
    fs.mkdirSync(a);
    fakeCli(a, 'claude', { mode: 0o775 });
    assert.equal(resolveBin('claude', { PATH: a }, []).reason, 'unsafe_bin', 'group-writable file');
    fs.chmodSync(path.join(a, 'claude'), 0o755);
    assert.equal(resolveBin('claude', { PATH: a }, []).bin, fs.realpathSync(path.join(a, 'claude')));
    fs.chmodSync(a, 0o777);
    assert.equal(resolveBin('claude', { PATH: a }, []).reason, 'unsafe_bin', 'world-writable non-sticky dir');
    fs.chmodSync(a, 0o755);
    fs.chmodSync(home, 0o777);
    assert.equal(resolveBin('claude', { PATH: a }, []).reason, 'unsafe_bin', 'world-writable ancestor');
    fs.chmodSync(home, 0o700);
    assert.ok(safeBinary('/bin/sh'), 'system binaries pass');
  } finally { fs.chmodSync(home, 0o700); rm(home); }
});

test('[codex] signed in only when its status command says so (exit 0); otherwise unknown', async () => {
  const home = tmpDir('bdh-');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  try {
    fakeCli(binDir, 'codex', { loginExit: 0 });
    assert.equal((await BACKENDS.codex.detect({ env: { HOME: home, PATH: binDir }, knownDirs: [], timeoutMs: 15000 })).signedIn, true);
    fs.rmSync(path.join(binDir, 'codex'));
    fakeCli(binDir, 'codex', { loginExit: 1 });
    assert.equal((await BACKENDS.codex.detect({ env: { HOME: home, PATH: binDir }, knownDirs: [], timeoutMs: 15000 })).signedIn, 'unknown');
  } finally { rm(home); }
});

// ── lifecycle, for every backend that can start a run ───────────────────────
const POISON = {
  HOME: process.env.HOME, PATH: process.env.PATH, LANG: 'en_US.UTF-8', TMPDIR: '/tmp',
  BOARD_DEVICE_TOKEN: 'bdt_supersecretdevicetoken', BOARD_HOME: '/tmp/x', AWS_SECRET_ACCESS_KEY: 'aws-secret', AWS_PROFILE: 'admin',
  HUB_RUNNER_TOKEN: 'brt1.aaaa.bbbb', PLEXIFORM_VAULT_KEY: 'vault', SOMETHING: 'bdt_leak', OTHER: 'brt_leak',
};
const HOSTILE = 'do the thing\n--dangerously-skip-permissions --permission-mode bypassPermissions --settings /etc/passwd $(touch /tmp/pwned) `id`';
const ALLOWED_BOARD_KEYS = new Set(['BOARD_RUN_SOCKET', 'BOARD_SUPERVISOR_PID', 'BOARD_SUPERVISOR_LSTART']);

function spawnBackend(B, dir, scenario, extra = {}) {
  const runDir = path.join(dir, 'run');
  fs.mkdirSync(path.join(runDir, 'shell'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(runDir, 'mcp.json'), '{"mcpServers":{}}');
  const env = buildEnv(POISON, { runDir, socket: path.join(runDir, 'ipc.sock'), supervisorPid: process.pid, supervisorLstart: 'x' });
  const backend = new B({
    bin: fakeClaudeBin(dir, scenario), cwd: dir, env, runDir, sessionId: '00000000-0000-4000-8000-000000000001',
    budget: { amount: 1.5, unit: 'usd' }, maxTurns: 5, systemPrompt: 'sys', interruptWaitMs: 400, stopGraceMs: 600, ...extra,
  });
  const events = [];
  const origEmit = backend.emit.bind(backend);
  backend.emit = (name, ...args) => { events.push({ name, data: args[0] }); return origEmit(name, ...args); };
  return { backend, events, runDir };
}

for (const id of IDS.filter((x) => BACKENDS[x].describe().startable && BACKENDS[x].describe().capabilities.permissions === 'hooks')) {
  test(`[${id}] lifecycle: argv is an array without the task text, env is allowlisted, events are normalised, budget is native`, async () => {
    const dir = tmpDir('bcf-');
    try {
      const { backend, events, runDir } = spawnBackend(BACKENDS[id], dir, {
        steps: [{ assistant: 'hello' }, { tool: 'Read', input: { file_path: 'README.md' } }, { result: 'success', cost: 0.02 }],
      });
      const argv = backend.argv();
      assert.ok(Array.isArray(argv) && argv.every((a) => typeof a === 'string'));
      backend.start(HOSTILE);
      await waitFor(() => events.some((e) => e.name === 'result'), { what: 'result' });
      const start = readFakeLog(runDir).find((l) => l.ev === 'start');
      assert.deepEqual(start.argv, argv, 'argv passed as an array, unchanged');
      assert.ok(!start.argv.some((a) => a.includes('do the thing') || a.includes('pwned')), 'task text never in argv');
      assert.equal(start.argv.filter((a) => a === '--permission-mode').length, 1);
      assert.ok(!start.argv.includes('bypassPermissions') && !start.argv.some((a) => /dangerously/.test(a)));
      assert.equal(start.cwd, fs.realpathSync(dir));
      const env = start.env;
      for (const [k, v] of Object.entries(env)) {
        assert.ok(!/^AWS_/.test(k), `no ${k}`);
        assert.ok(!/bdt_|brt1?[._]/.test(String(v)), `no token-shaped value in ${k}`);
        if (/^BOARD_/.test(k)) assert.ok(ALLOWED_BOARD_KEYS.has(k), `no inherited ${k}`);
      }
      assert.ok(!('PLEXIFORM_VAULT_KEY' in env));
      const stdin = readFakeLog(runDir).find((l) => l.ev === 'stdin');
      assert.equal(stdin.msg.message.content[0].text, HOSTILE, 'the task text arrives as data on stdin');
      const i = argv.indexOf('--max-budget-usd');
      assert.equal(argv[i + 1], '1.5', 'native budget passed to the CLI');

      const names = new Set(events.map((e) => e.name));
      for (const n of names) assert.ok(NORMALISED_EVENTS.includes(n) || INTERNAL_EVENTS.includes(n), `unexpected event ${n}`);
      const ev = (n) => events.filter((e) => e.name === n).map((e) => e.data);
      assert.equal(typeof ev('init')[0].session_id, 'string');
      assert.deepEqual(ev('assistant')[0], { text: 'hello' });
      const ts = ev('tool_start')[0];
      assert.equal(ts.name, 'Read');
      assert.equal(typeof ts.id, 'string');
      assert.equal(typeof ts.input, 'object');
      assert.deepEqual(ev('tool_end')[0], { id: ts.id, ok: true });
      const u = ev('usage')[0];
      assert.ok(Number.isInteger(u.inputTokens) && Number.isInteger(u.outputTokens));
      assert.equal(u.costUsd, 0.02);
      const r = ev('result')[0];
      assert.equal(r.subtype, 'success');
      assert.equal(r.is_error, false);
      assert.equal(r.terminal_reason, null);
      backend.endInput();
      await waitFor(() => backend.exited, { what: 'exit after EOF' });
      const x = ev('exit')[0];
      assert.deepEqual(Object.keys(x).sort(), ['code', 'error', 'sawResult', 'signal']);
      assert.equal(x.sawResult, true);
    } finally { rm(dir); }
  });

  test(`[${id}] budget exceeded → result.terminal_reason === 'budget'`, async () => {
    const dir = tmpDir('bcf-');
    try {
      const { backend, events } = spawnBackend(BACKENDS[id], dir, { steps: [{ result: 'error_max_budget_usd', cost: 1.6 }] });
      backend.start('go');
      const r = await waitFor(() => events.find((e) => e.name === 'result')?.data, { what: 'result' });
      assert.equal(r.terminal_reason, 'budget');
      assert.equal(r.is_error, true);
      await backend.stop();
    } finally { rm(dir); }
  });

  test(`[${id}] stop recipe: interrupt → grace → SIGTERM → SIGKILL; tool process groups are reaped`, async () => {
    const dir = tmpDir('bcf-');
    try {
      const { backend, events, runDir } = spawnBackend(BACKENDS[id], dir, {
        ignore_interrupt: true, ignore_term: true, ignore_eof: true, steps: [{ tool: 'Bash', input: { command: 'sleep 300' }, ms: 60000, grandchild: true }],
      });
      backend.start('go');
      const gc = await waitFor(() => readFakeLog(runDir).find((l) => l.ev === 'grandchild')?.pid, { what: 'grandchild' });
      await waitFor(() => events.some((e) => e.name === 'tool_start'), { what: 'tool start' });
      backend.refreshTree?.();
      const pid = backend.pid;
      assert.equal(await backend.stop(), true);
      assert.equal(backend.exited, true);
      assert.equal(alive(pid), false, 'CLI gone');
      await waitFor(() => !alive(gc), { what: 'grandchild reaped', timeout: 3000 });
      const log = readFakeLog(runDir);
      assert.ok(log.some((l) => l.ev === 'stdin' && l.msg.type === 'control_request'), 'interrupt sent first');
      assert.ok(log.some((l) => l.ev === 'signal' && l.sig === 'SIGTERM'), 'then SIGTERM');
    } finally { rm(dir); }
  });
}

for (const id of IDS.filter((x) => !BACKENDS[x].describe().startable)) {
  test(`[${id}] not startable yet: start() throws a fixed NOT_AVAILABLE error and spawns nothing`, () => {
    const b = new BACKENDS[id]({ bin: '/bin/false', cwd: '/tmp', env: {}, runDir: '/tmp', sessionId: 's' });
    assert.throws(() => b.start('anything'), (e) => e.code === 'NOT_AVAILABLE' && !/\//.test(e.message));
    assert.equal(b.pid, null);
    assert.equal(b.exited, true);
  });
}
