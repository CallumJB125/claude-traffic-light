'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLoginShellEnv, spawnLoginEnvUnfiltered, filter, withoutBlocked, invalidate, CACHE_MS, FAIL_CACHE_MS } = require('../src/login-shell-env');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plx-lse-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test.beforeEach(() => invalidate());

// Fake shells never read an rc file. `eval "$4"` runs the real -c command
// (START marker, /usr/bin/env -0, END marker) in the cleaned env the reader built.
function fake(name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}
const noisy = (exports_ = '') => fake('noisy', `echo "welcome banner"; echo "rc noise" >&2\n${exports_}\neval "$4"\necho "trailing noise"`);
const parent = { USER: 'fixture', LOGNAME: 'fixture', HOME: '/nonexistent', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', ELECTRON_FOO: 'x' };
const base = { home, shells: null, env: parent };
const okExec = (body) => async () => ({ code: 0, stdout: `\0__PLX_ENV__\0${body}\0\0__PLX_END__\0`, timedOut: false });
const gone = async (pid) => {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return true; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

test('parses the env block between the markers and ignores rc noise', async () => {
  const shell = noisy('export GATEWAY_URL=https://gw.example/v1\nexport MULTI="a=b c"\nexport ML="line1\nline2"');
  const r = await readLoginShellEnv({ ...base, shell, names: ['GATEWAY_URL', 'MULTI', 'ML'] });
  assert.deepEqual(r, { env: { GATEWAY_URL: 'https://gw.example/v1', MULTI: 'a=b c', ML: 'line1\nline2' }, ok: true, reason: null });
});

test('text printed after the command cannot inject a variable', async () => {
  const shell = fake('trail', `eval "$4"\nprintf 'FAKE_KEY=injected'`);
  const r = await readLoginShellEnv({ ...base, shell, names: ['FAKE_KEY'] });
  assert.deepEqual(r, { env: {}, ok: true, reason: null });
  invalidate();
  const none = await readLoginShellEnv({ ...base, shell, names: ['FAKE_KEY'], exec: async () => ({ code: 0, stdout: '\0__PLX_ENV__\0A=1\0FAKE_KEY=injected', timedOut: false }) });
  assert.deepEqual(none, { env: {}, ok: false, reason: 'no_sentinel' });
});

test('a background job holding stdout open does not turn success into a timeout', async () => {
  const pidFile = path.join(root, 'bg.pid');
  const shell = fake('bg', `( sleep 8 ) &\necho $! > "${pidFile}"\nexport KEEP=1\neval "$4"`);
  const t0 = Date.now();
  const r = await readLoginShellEnv({ ...base, shell, names: ['KEEP'] });
  assert.deepEqual(r, { env: { KEEP: '1' }, ok: true, reason: null });
  assert.ok(Date.now() - t0 < 2500, 'returned well before the 4 s timeout');
  assert.ok(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'the background job was cleaned up');
});

test('returns only allowlisted names, plus * prefixes', async () => {
  const shell = noisy('export KEEP_ME=1 OTHER_SECRET=nope VERTEX_REGION_A=eu VERTEX_REGION_B=us');
  const r = await readLoginShellEnv({ ...base, shell, names: ['KEEP_ME', 'VERTEX_REGION_*'] });
  assert.deepEqual(r.env, { KEEP_ME: '1', VERTEX_REGION_A: 'eu', VERTEX_REGION_B: 'us' });
  assert.equal(JSON.stringify(r).includes('nope'), false);
});

test('a name not set in the shell is simply absent', async () => {
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: noisy(), names: ['NOT_SET'] }), { env: {}, ok: true, reason: null });
});

test('bad names fail closed; an empty list spawns nothing', async () => {
  let runs = 0;
  const exec = async () => { runs++; return {}; };
  for (const names of [null, undefined, 'KEEP', { KEEP: 1 }]) {
    assert.deepEqual(await readLoginShellEnv({ ...base, shell: noisy(), exec, names }), { env: {}, ok: false, reason: 'bad_names' });
  }
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: noisy(), exec, names: [] }), { env: {}, ok: true, reason: null });
  assert.equal(runs, 0);
});

test('the shell starts with a cleaned env: no Electron or Node vars, even if requested', async () => {
  const calls = [];
  const exec = async (file, args, opts) => { calls.push({ file, args, opts }); return okExec('ELECTRON_RUN_AS_NODE=1\0NODE_OPTIONS=--x\0KEEP=1')(); };
  const r = await readLoginShellEnv({ ...base, shell: noisy(), exec, names: ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'KEEP'] });
  assert.deepEqual(r.env, { KEEP: '1' });
  assert.deepEqual(Object.keys(calls[0].opts.env).sort(), ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']);
  assert.deepEqual(calls[0].args.slice(0, 3), ['-l', '-i', '-c']);
  assert.equal(calls[0].opts.cwd, home);
  assert.equal(calls[0].opts.timeout, 4000);
});

test('LANG, LC_* and TMPDIR pass through; USER falls back to the account name', async () => {
  const calls = [];
  const exec = async (file, args, opts) => { calls.push(opts.env); return okExec('A=1')(); };
  const env = { ...parent, USER: '', LOGNAME: '', LANG: 'en_ZA.UTF-8', LC_ALL: 'C', TMPDIR: '/tmp/x', LCX: 'no', OTHER: 'no' };
  await readLoginShellEnv({ ...base, env, shell: noisy(), exec, names: ['A'] });
  assert.deepEqual(Object.keys(calls[0]).sort(), ['HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER']);
  assert.equal(calls[0].USER, os.userInfo().username);
  assert.equal(calls[0].LOGNAME, os.userInfo().username);
});

test('a real spawn never lets parent Electron/Node vars into the shell', async () => {
  const shell = fake('dump', 'eval "$4"');
  const { ok, all } = await spawnLoginEnvUnfiltered({ ...base, shell });
  assert.equal(ok, true);
  assert.equal(Object.keys(all).some((k) => k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS'), false);
  assert.equal(all.HOME, home);
  assert.equal(all.TERM, 'dumb');
});

test('timeout kills the whole process group and reports not found', async () => {
  const pidFile = path.join(root, 'child.pid');
  const shell = fake('hang', `sleep 30 &\necho $! > "${pidFile}"\nsleep 30`);
  const t0 = Date.now();
  const r = await readLoginShellEnv({ ...base, shell, names: ['X'], timeoutMs: 3000 });
  assert.deepEqual(r, { env: {}, ok: false, reason: 'timeout' });
  assert.ok(Date.now() - t0 < 6000);
  assert.ok(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'grandchild is gone');
});

test('exit status, missing markers and a missing shell give distinct reasons', async () => {
  const bad = fake('bad', 'echo "oops"; exit 3');
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: bad, names: ['X'] }), { env: {}, ok: false, reason: 'exit_nonzero' });
  const none = fake('none', 'echo "no env here"');
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: none, names: ['X'] }), { env: {}, ok: false, reason: 'no_sentinel' });
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: path.join(root, 'missing'), names: ['X'] }), { env: {}, ok: false, reason: 'bad_shell' });
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: 'zsh', names: ['X'] }), { env: {}, ok: false, reason: 'bad_shell' });
  invalidate();
  const boom = async () => { throw new Error('secret-ish'); };
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: bad, exec: boom, names: ['X'] }), { env: {}, ok: false, reason: 'spawn_failed' });
});

test('spawn failures (not executable, missing home) report spawn_failed', async () => {
  const noexec = path.join(root, 'noexec');
  fs.writeFileSync(noexec, '#!/bin/sh\n', { mode: 0o644 });
  assert.deepEqual(await readLoginShellEnv({ ...base, shell: noexec, names: ['X'] }), { env: {}, ok: false, reason: 'spawn_failed' });
  assert.deepEqual(await readLoginShellEnv({ ...base, home: path.join(root, 'no-such-home'), shell: noisy(), names: ['X'] }), { env: {}, ok: false, reason: 'spawn_failed' });
});

test('output over the cap is bounded and reported as too_large', async () => {
  const shell = fake('big', 'head -c 3000000 /dev/zero');
  assert.deepEqual(await readLoginShellEnv({ ...base, shell, names: ['X'] }), { env: {}, ok: false, reason: 'too_large' });
});

test('/etc/shells: unlisted fallbacks are refused without a spawn; a listed one is used', async () => {
  const shell = noisy('export KEEP=1');
  const calls = [];
  const exec = async (file) => { calls.push(file); return okExec('KEEP=1')(); };
  const refused = await readLoginShellEnv({ ...base, shell: undefined, env: { ...parent, SHELL: shell }, shells: ['/nonexistent/sh'], exec, names: ['KEEP'], platform: 'linux' });
  assert.deepEqual(refused, { env: {}, ok: false, reason: 'bad_shell' });
  assert.equal(calls.length, 0);
  invalidate();
  const listed = await readLoginShellEnv({ ...base, shell: undefined, env: { ...parent, SHELL: shell }, shells: [shell], exec, names: ['KEEP'], platform: 'linux' });
  assert.deepEqual(listed, { env: { KEEP: '1' }, ok: true, reason: null });
  assert.deepEqual(calls, [shell]);
  // an explicit shell is the caller's choice and needs no listing
  invalidate();
  assert.equal((await readLoginShellEnv({ ...base, shell, shells: ['/nonexistent/sh'], names: ['KEEP'] })).ok, true);
});

test('win32 is unsupported and spawns nothing', async () => {
  let spawned = false;
  const exec = async () => { spawned = true; return {}; };
  assert.deepEqual(await readLoginShellEnv({ platform: 'win32', exec, names: ['X'] }), { env: {}, ok: false, reason: 'unsupported' });
  assert.equal(spawned, false);
});

test('results are cached for 5 minutes per shell, home and name set; invalidate() clears', async () => {
  let runs = 0, clock = 1000;
  const exec = async () => { runs++; return okExec(`KEEP=${runs}`)(); };
  const shell = noisy();
  const args = { ...base, shell, exec, names: ['KEEP'], now: () => clock };
  assert.equal((await readLoginShellEnv(args)).env.KEEP, '1');
  clock += CACHE_MS - 1;
  assert.equal((await readLoginShellEnv(args)).env.KEEP, '1');
  assert.equal(runs, 1);
  await readLoginShellEnv({ ...args, names: ['KEEP', 'OTHER'] });
  assert.equal(runs, 2);
  await readLoginShellEnv({ ...args, home: path.join(root, 'other-home') });
  assert.equal(runs, 3);
  await readLoginShellEnv({ ...args, shell: noisy('export Z=1') });
  assert.equal(runs, 3, 'same file path, so the same key');
  await readLoginShellEnv({ ...args, shell: fake('second', 'eval "$4"') });
  assert.equal(runs, 4);
  clock += 1;
  assert.equal((await readLoginShellEnv(args)).env.KEEP, '5');
  invalidate();
  await readLoginShellEnv(args);
  assert.equal(runs, 6);
});

test('cached results are copies', async () => {
  const args = { ...base, shell: noisy(), exec: okExec('KEEP=1'), names: ['KEEP'] };
  const first = await readLoginShellEnv(args);
  first.env.KEEP = 'changed';
  assert.equal((await readLoginShellEnv(args)).env.KEEP, '1');
});

test('concurrent identical calls share one spawn', async () => {
  let runs = 0;
  const exec = async () => { runs++; await new Promise((resolve) => setTimeout(resolve, 30)); return okExec('KEEP=1')(); };
  const args = { ...base, shell: noisy(), exec, names: ['KEEP'] };
  const all = await Promise.all([readLoginShellEnv(args), readLoginShellEnv(args), readLoginShellEnv(args)]);
  assert.equal(runs, 1);
  assert.deepEqual(all.map((r) => r.env.KEEP), ['1', '1', '1']);
});

test('invalidate() during an in-flight call does not let the old call evict the new one', async () => {
  let runs = 0;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const exec = async () => { const n = ++runs; await wait(n === 1 ? 30 : 200); return okExec('KEEP=1')(); };
  const args = { ...base, shell: noisy(), exec, names: ['KEEP'] };
  const a = readLoginShellEnv(args);
  invalidate();
  const b = readLoginShellEnv(args);
  await a;
  const c = readLoginShellEnv(args);
  await Promise.all([b, c]);
  assert.equal(runs, 2);
});

test('timeout, non-zero exit and no-sentinel failures are cached for 60 s; other failures are not', async () => {
  let runs = 0, clock = 1000;
  const results = [{ code: null, timedOut: true }, { code: 1, stdout: '' }, { code: 0, stdout: 'nothing' }, { code: null, error: 'spawn_failed' }];
  for (const [i, result] of results.entries()) {
    invalidate();
    runs = 0;
    const exec = async () => { runs++; return result; };
    const args = { ...base, shell: noisy(), exec, names: ['KEEP'], now: () => clock };
    await readLoginShellEnv(args);
    clock += FAIL_CACHE_MS - 1;
    await readLoginShellEnv(args);
    assert.equal(runs, i < 3 ? 1 : 2, `case ${i}`);
    if (i < 3) { clock += 1; await readLoginShellEnv(args); assert.equal(runs, 2, `case ${i} expires`); }
  }
  runs = 0;
  const exec = async () => { runs++; return { code: 1, stdout: '' }; };
  const args = { ...base, shell: noisy(), exec, names: ['KEEP'] };
  await readLoginShellEnv(args);
  invalidate();
  await readLoginShellEnv(args);
  assert.equal(runs, 2, 'invalidate() clears failures');
});

test('filter: copies, non-names dropped, a bare * matches nothing, blocked names never return', () => {
  const all = { A: '1', B: '2', ELECTRON_X: 'e', npm_config_x: 'n', NODE_PATH: 'p', NODE_EXTRA_CA_CERTS: 'c', NODE_OPTIONS: 'o' };
  const out = filter(all, ['A', 5, '', '*', 'ELECTRON_*', 'npm_*', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS']);
  assert.deepEqual(out, { A: '1' });
  out.A = 'changed';
  assert.equal(all.A, '1');
});

test('withoutBlocked drops the Electron/Node variables and keeps the rest', () => {
  const all = Object.assign(Object.create(null), { A: '1', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: 'o', NODE_PATH: 'p', NODE_EXTRA_CA_CERTS: 'c', npm_config_x: 'n', PATH: '/x' });
  assert.deepEqual(withoutBlocked(all), { A: '1', PATH: '/x' });
});

test('a __proto__ export is kept as an own property, not lost', async () => {
  const r = await readLoginShellEnv({ ...base, shell: noisy(), exec: okExec('__proto__=x'), names: ['__proto__'] });
  assert.equal(Object.hasOwn(r.env, '__proto__'), true);
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
