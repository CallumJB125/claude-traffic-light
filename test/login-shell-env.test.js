'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLoginShellEnv, spawnLoginEnv, filter, invalidate, CACHE_MS } = require('../src/login-shell-env');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plx-lse-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test.beforeEach(() => invalidate());

// Fake shells never read an rc file. `eval "$4"` runs the real -c command
// (printf sentinel, then /usr/bin/env -0) in the cleaned env the reader built.
function fake(name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}
const noisy = (exports_ = '') => fake('noisy', `echo "welcome banner"; echo "rc noise" >&2\n${exports_}\neval "$4"\necho "trailing noise"`);
const parent = { USER: 'fixture', LOGNAME: 'fixture', HOME: '/nonexistent', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', ELECTRON_FOO: 'x' };
const base = { home, shells: null, env: parent };

test('parses the env block after the sentinel and ignores rc noise', async () => {
  const shell = noisy('export GATEWAY_URL=https://gw.example/v1\nexport MULTI="a=b c"');
  const r = await readLoginShellEnv({ ...base, shell, names: ['GATEWAY_URL', 'MULTI'] });
  assert.deepEqual(r, { env: { GATEWAY_URL: 'https://gw.example/v1', MULTI: 'a=b c' }, ok: true, reason: null });
});

test('returns only allowlisted names, plus * prefixes', async () => {
  const shell = noisy('export KEEP_ME=1 OTHER_SECRET=nope VERTEX_REGION_A=eu VERTEX_REGION_B=us');
  const r = await readLoginShellEnv({ ...base, shell, names: ['KEEP_ME', 'VERTEX_REGION_*'] });
  assert.deepEqual(r.env, { KEEP_ME: '1', VERTEX_REGION_A: 'eu', VERTEX_REGION_B: 'us' });
  assert.equal(JSON.stringify(r).includes('nope'), false);
});

test('a name not set in the shell is simply absent', async () => {
  const r = await readLoginShellEnv({ ...base, shell: noisy(), names: ['NOT_SET'] });
  assert.deepEqual(r, { env: {}, ok: true, reason: null });
});

test('the shell starts with a cleaned env: no Electron or Node vars, even if requested', async () => {
  const calls = [];
  const exec = async (file, args, opts) => { calls.push({ file, args, opts }); return { code: 0, stdout: '\0__PLX_ENV__\0ELECTRON_RUN_AS_NODE=1\0NODE_OPTIONS=--x\0KEEP=1\0', timedOut: false }; };
  const shell = noisy();
  const r = await readLoginShellEnv({ ...base, shell, exec, names: ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'KEEP'] });
  assert.deepEqual(r.env, { KEEP: '1' });
  assert.deepEqual(Object.keys(calls[0].opts.env).sort(), ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']);
  assert.deepEqual(calls[0].args.slice(0, 3), ['-l', '-i', '-c']);
  assert.equal(calls[0].opts.cwd, home);
  assert.equal(calls[0].opts.timeout, 4000);
});

test('a real spawn never lets parent Electron/Node vars into the shell', async () => {
  const shell = fake('dump', 'eval "$4"');
  const { ok, all } = await spawnLoginEnv({ ...base, shell });
  assert.equal(ok, true);
  assert.equal(Object.keys(all).some((k) => k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS'), false);
  assert.equal(all.HOME, home);
  assert.equal(all.TERM, 'dumb');
});

test('timeout kills the whole process group and reports not found', async () => {
  const pidFile = path.join(root, 'child.pid');
  const shell = fake('hang', `sleep 30 &\necho $! > "${pidFile}"\nsleep 30`);
  const t0 = Date.now();
  const r = await readLoginShellEnv({ ...base, shell, names: ['X'], timeoutMs: 1000 });
  assert.deepEqual(r, { env: {}, ok: false, reason: 'timeout' });
  assert.ok(Date.now() - t0 < 3000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('non-zero exit, no sentinel, and a missing shell are all "not found"', async () => {
  const bad = fake('bad', 'echo "oops"; exit 3');
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: bad, names: ['X'] }), { env: {}, ok: false, reason: 'exit_nonzero' });
  const none = fake('none', 'echo "no env here"');
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: none, names: ['X'] }), { env: {}, ok: false, reason: 'no_sentinel' });
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: path.join(root, 'missing'), names: ['X'] }), { env: {}, ok: false, reason: 'bad_shell' });
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: 'zsh', names: ['X'] }), { env: {}, ok: false, reason: 'bad_shell' });
  const boom = async () => { throw new Error('secret-ish'); };
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: bad, exec: boom, names: ['X'] }), { env: {}, ok: false, reason: 'spawn_failed' });
});

test('a shell must be listed in /etc/shells unless the caller names it', async () => {
  const shell = noisy('export KEEP=1');
  const listed = await readLoginShellEnv({ ...base, shell, shells: [shell], names: ['KEEP'] });
  assert.equal(listed.ok, true);
  const calls = [];
  const exec = async (file) => { calls.push(file); return { code: 0, stdout: '\0__PLX_ENV__\0KEEP=1\0', timedOut: false }; };
  await readLoginShellEnv({ ...base, shell: undefined, env: { ...parent, SHELL: shell }, shells: ['/bin/sh'], exec, names: ['KEEP'], platform: 'linux' });
  assert.notEqual(calls[0], shell);
});

test('win32 is unsupported and spawns nothing', async () => {
  let spawned = false;
  const exec = async () => { spawned = true; return {}; };
  assert.deepEqual(await readLoginShellEnv({ platform: 'win32', exec, names: ['X'] }), { env: {}, ok: false, reason: 'unsupported' });
  assert.equal(spawned, false);
});

test('results are cached for 5 minutes per name set, then re-read; invalidate() clears', async () => {
  let runs = 0, clock = 1000;
  const exec = async () => { runs++; return { code: 0, stdout: `\0__PLX_ENV__\0KEEP=${runs}\0`, timedOut: false }; };
  const shell = noisy();
  const args = { ...base, shell, exec, names: ['KEEP'], now: () => clock };
  assert.equal((await readLoginShellEnv(args)).env.KEEP, '1');
  clock += CACHE_MS - 1;
  assert.equal((await readLoginShellEnv(args)).env.KEEP, '1');
  assert.equal(runs, 1);
  await readLoginShellEnv({ ...args, names: ['KEEP', 'OTHER'] });
  assert.equal(runs, 2);
  clock += 1;
  assert.equal((await readLoginShellEnv(args)).env.KEEP, '3');
  invalidate();
  await readLoginShellEnv(args);
  assert.equal(runs, 4);
});

test('failures are not cached', async () => {
  let runs = 0;
  const exec = async () => { runs++; return runs === 1 ? { code: 1, stdout: '', timedOut: false } : { code: 0, stdout: '\0__PLX_ENV__\0KEEP=1\0', timedOut: false }; };
  const args = { ...base, shell: noisy(), exec, names: ['KEEP'] };
  assert.equal((await readLoginShellEnv(args)).ok, false);
  assert.equal((await readLoginShellEnv(args)).ok, true);
});

test('filter drops non-names and returns copies', () => {
  assert.deepEqual(filter({ A: '1', B: '2' }, ['A', 5, '']), { A: '1' });
});

test('nothing is logged: console stays silent, values only in the return', async () => {
  const secret = 'sk-fixture-value-123';
  const shell = noisy(`export API_KEY=${secret} OTHER=${secret}-other`);
  const seen = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = methods.map((m) => console[m]);
  methods.forEach((m) => { console[m] = (...a) => seen.push(a.join(' ')); });
  let r;
  try {
    r = await readLoginShellEnv({ ...base, shell, names: ['API_KEY'] });
    await readLoginShellEnv({ ...base, shell: path.join(root, 'missing'), names: ['API_KEY'] });
  } finally {
    methods.forEach((m, i) => { console[m] = saved[i]; });
  }
  assert.equal(r.env.API_KEY, secret);
  assert.deepEqual(seen, []);
});
