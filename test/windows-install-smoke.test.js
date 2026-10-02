'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const Lifecycle = require('../scripts/windows-install-smoke');
const Adapters = require('../adapters');
const Brand = require('../brand');

function rig(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-lifecycle-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(root, 'installer.exe'), portable = path.join(root, 'portable.exe'), calls = [];
  let installDir;
  const run = async (file, args, env, options) => {
    calls.push({ file, args, env, options });
    if (file === installer) {
      installDir = args.at(-1).slice('/D='.length);
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, `${Brand.name}.exe`), 'Synthetic app');
      fs.writeFileSync(path.join(installDir, `Uninstall ${Brand.name}.exe`), 'Synthetic uninstaller');
    } else {
      require('../adapters/uninstall-all').run({ home: env.USERPROFILE });
      fs.rmSync(installDir, { recursive: true });
    }
    mutate({ file, args, env, root });
  };
  const smoke = async f => {
    Adapters.get('claude').install({ home: f.home, runtime: Adapters.Runtime.make({ execPath: f.exe, dataDir: f.data, hooksDir: path.join(root, 'hooks') }) });
    return { ok: true };
  };
  const runHook = async (_command, payload, { env }) => {
    fs.writeFileSync(path.join(env.CLAUDE_TRAFFIC_LIGHT_HOME, 'sessions', `${payload.session_id}.json`), JSON.stringify(payload));
    return { code: 0 };
  };
  return { root, installer, portable, calls, run, smoke, runHook, diagnostics: async () => ({ ok: true, images: [] }), actualAppData: path.join(root, 'appdata'), receipt: path.join(root, 'receipt.json') };
}

test('real installer acceptance requires GitHub-hosted Windows and refuses missing or self-hosted provenance', () => {
  const hosted = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_ENVIRONMENT: 'github-hosted' };
  assert.equal(Lifecycle.allowedRunner('win32', hosted), true);
  for (const [platform, env] of [
    ['darwin', hosted], ['win32', {}], ['win32', { ...hosted, GITHUB_ACTIONS: 'false' }],
    ['win32', { ...hosted, RUNNER_OS: 'Linux' }],
    ['win32', { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows' }],
    ['win32', { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }],
    ['win32', { ...hosted, RUNNER_ENVIRONMENT: 'GitHub-Hosted' }],
  ]) assert.equal(Lifecycle.allowedRunner(platform, env), false);
});

for (const provenance of ['self-hosted', undefined]) test(`actual CLI refuses ${provenance ?? 'missing'} runner provenance before touching files or processes`, async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/windows-install-smoke.js'), 'utf8');
  const touches = [], messages = [], module = { exports: {} };
  const forbidden = kind => () => { touches.push(kind); throw new Error('Synthetic unsafe operation refused'); };
  const fakeRequire = id => {
    if (id === 'node:fs') return new Proxy({}, { get: (_, name) => forbidden(`fs.${String(name)}`) });
    if (id === 'node:path') return path;
    if (id === 'node:os') return { tmpdir: forbidden('os.tmpdir') };
    if (id === 'node:child_process') return { spawn: forbidden('spawn') };
    return {};
  };
  fakeRequire.main = module;
  const process = { platform: 'win32', env: { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', ...(provenance ? { RUNNER_ENVIRONMENT: provenance } : {}), APPDATA: 'C:\\synthetic-profile' }, exitCode: 0 };
  vm.runInNewContext(source, { require: fakeRequire, module, process, console: { log() {}, error: message => messages.push(message) }, __dirname: '/synthetic-repo/scripts', setTimeout, clearTimeout });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(touches, []);
  assert.equal(process.exitCode, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /requires.*GitHub-hosted Windows/);
});

test('source harness retains foreign configuration and binary data across install, upgrade mode and uninstall', async t => {
  const f = rig(t), result = await Lifecycle.runLifecycle(f);
  assert.deepEqual(result.stages, ['installed', 'installed-launch-hooks-window-quit', 'update-mode-data-retained', 'updated-launch-hooks-window-quit', 'uninstalled-hooks-removed-data-retained', 'portable-launch-hooks-window-quit', 'portable-hook-after-exit']);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls.slice(0, 2)) assert.equal(call.args.at(-1), `/D=${f.calls[2].args.at(-1).slice('_?='.length)}`);
  assert.ok(f.calls[1].args.includes('--updated'));
  assert.ok(f.calls[2].args.includes('/S'));
  assert.equal(f.calls.every(call => call.env.USERPROFILE.startsWith(f.root) && call.env.CLAUDE_TRAFFIC_LIGHT_HOME.startsWith(f.root)), true);
});

test('uninstall waits for an exact exclusive copy outside the installation directory and cwd', async t => {
  const f = rig(t), run = f.run;
  f.run = async (file, args, env, options) => {
    if (args.at(-1).startsWith('_?=')) {
      const installDir = args.at(-1).slice('_?='.length);
      assert.notEqual(path.dirname(file), installDir);
      assert.equal(fs.readFileSync(file, 'utf8'), 'Synthetic uninstaller');
      assert.equal(fs.readFileSync(path.join(installDir, `Uninstall ${Brand.name}.exe`), 'utf8'), 'Synthetic uninstaller');
      assert.ok(options?.cwd && options.cwd !== installDir);
      assert.match(installDir, / /, 'actual fixture installation path contains spaces');
    }
    await run(file, args, env, options);
  };
  await Lifecycle.runLifecycle(f);
});

test('uninstaller copy directory collision refuses before uninstall and preserves foreign bytes', async t => {
  const f = rig(t), dir = path.join(f.root, 'uninstaller-copy'), marker = path.join(dir, 'foreign.bin');
  fs.mkdirSync(dir); fs.writeFileSync(marker, 'Foreign bytes');
  await assert.rejects(Lifecycle.runLifecycle(f), /exist|collision/i);
  assert.equal(f.calls.length, 2);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'Foreign bytes');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)).stages, ['installed', 'installed-launch-hooks-window-quit', 'update-mode-data-retained', 'updated-launch-hooks-window-quit']);
});

test('closed Windows NSIS serialization preserves final unquoted spaced path and safely quoted argv0', () => {
  const exe = 'C:\\fixture space\\installer.exe', dir = 'C:\\fixture space\\installed app', cwd = 'C:\\fixture space';
  for (const operation of ['install', 'update', 'uninstall']) {
    const spec = Lifecycle.nsisLaunch(exe, operation, dir, cwd, 'win32');
    assert.deepEqual(spec.args, [...(operation === 'update' ? ['/S', '--updated', '/currentuser'] : ['/S', '/currentuser']), `${operation === 'uninstall' ? '_?=' : '/D='}${dir}`]);
    assert.equal(spec.options.argv0, `"${exe}"`);
    assert.equal(spec.options.windowsVerbatimArguments, true);
    assert.equal(spec.options.shell, false);
    assert.equal(spec.options.cwd, cwd);
    assert.ok(!spec.args.at(-1).includes('"'));
  }
  for (const operation of ['portable', '--delete-app-data', '__proto__']) assert.throws(() => Lifecycle.nsisLaunch(exe, operation, dir, cwd, 'win32'), /Unsupported/);
  for (const value of ['relative', 'C:\\fixture"inject', 'C:\\fixture\n/S', 'C:\\fixture\0x']) {
    for (const index of [0, 1, 2]) { const paths = [exe, dir, cwd]; paths[index] = value; assert.throws(() => Lifecycle.nsisLaunch(paths[0], 'uninstall', paths[1], paths[2], 'win32'), /Invalid/); }
  }
  for (const inside of [dir, `${dir}\\child`]) assert.throws(() => Lifecycle.nsisLaunch(exe, 'uninstall', dir, inside, 'win32'), /outside/);
});

test('actual copy verification refuses changed copied bytes before executing it', async t => {
  const f = rig(t);
  f.diagnostics = async () => { fs.writeFileSync(path.join(f.root, 'uninstaller-copy', 'uninstaller.exe'), 'Changed uninstaller'); return { ok: true, images: [] }; };
  await assert.rejects(Lifecycle.runLifecycle(f), /Copied uninstaller changed/);
  assert.equal(f.calls.length, 2);
  assert.equal(fs.readFileSync(path.join(f.root, 'installed app with spaces', `Uninstall ${Brand.name}.exe`), 'utf8'), 'Synthetic uninstaller');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'uninstall-failed.json'))).phase, 'failed');
});

test('actual exclusive copy refuses destination-file collision without deleting foreign bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsis-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.exe'); fs.writeFileSync(source, Buffer.from([0, 1, 2, 255]));
  const original = fs.openSync; let injected = false;
  try {
    fs.openSync = (file, ...args) => {
      if (!injected && file === path.join(root, 'uninstaller-copy', 'uninstaller.exe')) { injected = true; fs.writeFileSync(file, 'Foreign collision'); }
      return original(file, ...args);
    };
    assert.throws(() => Lifecycle.verifiedUninstaller(source, root), /exist/i);
  } finally { fs.openSync = original; }
  assert.deepEqual(fs.readFileSync(source), Buffer.from([0, 1, 2, 255]));
  assert.equal(fs.readFileSync(path.join(root, 'uninstaller-copy', 'uninstaller.exe'), 'utf8'), 'Foreign collision');
});

test('copy verification refuses a nonregular installed uninstaller', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsis-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.exe'); fs.mkdirSync(source);
  assert.throws(() => Lifecycle.verifiedUninstaller(source, root), /bounded regular/);
  assert.equal(fs.existsSync(path.join(root, 'uninstaller-copy')), false);
});

function descriptorFixture(t, size = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsis-descriptor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.exe'); fs.writeFileSync(source, Buffer.alloc(size, 17));
  return { root, source };
}

for (const kind of ['directory', 'oversized']) test(`descriptor verification refuses a post-lstat ${kind} replacement before reading bytes`, t => {
  const { root, source } = descriptorFixture(t), replacement = path.join(root, 'replacement');
  if (kind === 'directory') fs.mkdirSync(replacement);
  else { fs.writeFileSync(replacement, 'x'); fs.truncateSync(replacement, 32 * 1024 * 1024 + 1); }
  const stat = fs.lstatSync, open = fs.openSync, read = fs.readSync, readFile = fs.readFileSync; let swapped = false, fd = null, bytes = 0;
  try {
    fs.lstatSync = (file, ...args) => { const st = stat(file, ...args); if (file === source && !swapped) { swapped = true; fs.renameSync(source, path.join(root, 'retained-original')); fs.renameSync(replacement, source); } return st; };
    fs.openSync = (file, ...args) => { const result = open(file, ...args); if (file === source) fd = result; return result; };
    fs.readSync = (...args) => { const n = read(...args); if (args[0] === fd) bytes += n; return n; };
    fs.readFileSync = (file, ...args) => { const result = readFile(file, ...args); if (file === source) bytes += result.length; return result; };
    assert.throws(() => Lifecycle.verifiedUninstaller(source, root));
  } finally { fs.lstatSync = stat; fs.openSync = open; fs.readSync = read; fs.readFileSync = readFile; }
  assert.equal(swapped, true); assert.equal(bytes, 0); assert.equal(fs.existsSync(path.join(root, 'uninstaller-copy')), false);
  if (fd !== null) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
});

test('descriptor verification refuses name replacement after open and closes the retained original handle', t => {
  const { root, source } = descriptorFixture(t), replacement = path.join(root, 'replacement'); fs.writeFileSync(replacement, Buffer.alloc(4, 18));
  const open = fs.openSync; let fd = null, swapped = false;
  try {
    fs.openSync = (file, ...args) => { const result = open(file, ...args); if (file === source && !swapped) { fd = result; swapped = true; fs.renameSync(source, path.join(root, 'retained-original')); fs.renameSync(replacement, source); } return result; };
    assert.throws(() => Lifecycle.verifiedUninstaller(source, root), /changed/);
  } finally { fs.openSync = open; }
  assert.equal(swapped, true); assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
  assert.deepEqual(fs.readFileSync(path.join(root, 'retained-original')), Buffer.alloc(4, 17));
});

test('descriptor verification refuses growth at the ceiling without consuming beyond 32 MiB', t => {
  const maximum = 32 * 1024 * 1024, { root, source } = descriptorFixture(t, maximum);
  const open = fs.openSync, read = fs.readSync; let fd = null, grew = false, consumed = 0, biggest = 0;
  try {
    fs.openSync = (file, ...args) => { const result = open(file, ...args); if (file === source && fd === null) fd = result; return result; };
    fs.readSync = (...args) => { const n = read(...args); if (args[0] === fd) { consumed += n; biggest = Math.max(biggest, args[3]); if (!grew && n) { grew = true; fs.truncateSync(source, maximum + 1); } } return n; };
    assert.throws(() => Lifecycle.verifiedUninstaller(source, root), /changed/);
  } finally { fs.openSync = open; fs.readSync = read; }
  assert.equal(grew, true); assert.equal(consumed, maximum); assert.ok(biggest <= 64 * 1024); assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
});

test('descriptor verification refuses truncation during reading without accepting a partial capture', t => {
  const { root, source } = descriptorFixture(t, 128 * 1024), open = fs.openSync, read = fs.readSync; let fd = null, truncated = false;
  try {
    fs.openSync = (file, ...args) => { const result = open(file, ...args); if (file === source && fd === null) fd = result; return result; };
    fs.readSync = (...args) => { const n = read(...args); if (args[0] === fd && !truncated && n) { truncated = true; fs.truncateSync(source, 64 * 1024); } return n; };
    assert.throws(() => Lifecycle.verifiedUninstaller(source, root), /changed/);
  } finally { fs.openSync = open; fs.readSync = read; }
  assert.equal(truncated, true); assert.equal(fs.existsSync(path.join(root, 'uninstaller-copy')), false); assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
});

test('exclusive capture copy never copies a later oversized source pathname replacement', t => {
  const { root, source } = descriptorFixture(t), replacement = path.join(root, 'replacement'); fs.writeFileSync(replacement, 'x'); fs.truncateSync(replacement, 32 * 1024 * 1024 + 1);
  const mkdir = fs.mkdirSync; let swapped = false;
  try {
    fs.mkdirSync = (dir, ...args) => { const result = mkdir(dir, ...args); if (dir === path.join(root, 'uninstaller-copy')) { swapped = true; fs.renameSync(replacement, source); } return result; };
    assert.throws(() => Lifecycle.verifiedUninstaller(source, root));
  } finally { fs.mkdirSync = mkdir; }
  const copied = path.join(root, 'uninstaller-copy', 'uninstaller.exe');
  assert.equal(swapped, true); assert.equal(fs.statSync(copied).size, 4); assert.deepEqual(fs.readFileSync(copied), Buffer.alloc(4, 17));
  assert.equal(fs.statSync(source).size, 32 * 1024 * 1024 + 1);
});

for (const operation of ['read', 'write']) test(`descriptor verification closes owned handles after an injected ${operation} I/O failure`, t => {
  const { root, source } = descriptorFixture(t), destination = path.join(root, 'uninstaller-copy', 'uninstaller.exe');
  const open = fs.openSync, io = fs[`${operation}Sync`]; let fd = null;
  try {
    fs.openSync = (file, ...args) => { const result = open(file, ...args); if (file === (operation === 'read' ? source : destination)) fd = result; return result; };
    fs[`${operation}Sync`] = (...args) => { if (args[0] === fd) throw Object.assign(new Error('Injected descriptor I/O refusal'), { code: 'EIO' }); return io(...args); };
    assert.throws(() => Lifecycle.verifiedUninstaller(source, root), { code: 'EIO' });
  } finally { fs.openSync = open; fs[`${operation}Sync`] = io; }
  assert.notEqual(fd, null); assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' }); assert.deepEqual(fs.readFileSync(source), Buffer.alloc(4, 17));
});

test('descriptor capture remains bounded for a trusted regular fixture with optional POSIX flags absent', t => {
  const { root, source } = descriptorFixture(t), file = path.join(__dirname, '../scripts/windows-install-smoke.js');
  const real = createRequire(file), module = { exports: {} }, fixtureFs = { ...fs, constants: { ...fs.constants, O_NOFOLLOW: 0, O_NONBLOCK: undefined } };
  const require = id => id === 'node:fs' ? fixtureFs : real(id);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require, module, process, Buffer, __dirname: path.dirname(file), console, setTimeout, clearTimeout });
  const copy = module.exports.verifiedUninstaller(source, root); copy.verify();
  assert.deepEqual(fs.readFileSync(copy.exe), Buffer.alloc(4, 17)); assert.deepEqual(fs.readFileSync(source), Buffer.alloc(4, 17));
});

for (const kind of ['nonzero', 'timeout']) test(`uninstaller ${kind} retains actual app/data and failure metadata without a success stage`, async t => {
  const f = rig(t), run = f.run;
  const processReceipt = { pid: 123, code: kind === 'nonzero' ? 1 : null, timedOut: kind === 'timeout' };
  f.run = async (file, args, env, options) => {
    if (args.at(-1).startsWith('_?=')) { f.calls.push({ file, args, env, options }); throw Object.assign(new Error(`Synthetic ${kind} refusal`), { processReceipt }); }
    return run(file, args, env, options);
  };
  await assert.rejects(Lifecycle.runLifecycle(f), new RegExp(kind));
  assert.ok(fs.existsSync(path.join(f.root, 'installed app with spaces', `${Brand.name}.exe`)));
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).stages.length, 4);
  const report = JSON.parse(fs.readFileSync(path.join(f.root, 'uninstall-failed.json')));
  assert.deepEqual(report.processReceipt, processReceipt);
  assert.ok(report.files.entries.some(e => e.name === `${Brand.name}.exe`));
  assert.equal(fs.readFileSync(path.join(f.actualAppData, Brand.name, 'preserved-board.db'), 'utf8'), 'Synthetic retained bytes: preserved-board.db\r\n');
});

test('exit0 with a remaining app executable fails and retains original exit metadata', async t => {
  const f = rig(t), run = f.run;
  f.run = async (file, args, env, options) => {
    if (args.at(-1).startsWith('_?=')) return { pid: 123, code: 0, timedOut: false };
    return run(file, args, env, options);
  };
  await assert.rejects(Lifecycle.runLifecycle(f), /left the app executable behind/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'uninstall-failed.json'))).processReceipt.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).stages.length, 4);
});

test('unavailable or oversized diagnostics fail before uninstall and retain bounded reports', async t => {
  for (const oversized of [false, true]) {
    const f = rig(t); f.diagnostics = async () => oversized ? { ok: true, text: 'x'.repeat(70000) } : { ok: false, error: 'Synthetic query failure' };
    await assert.rejects(Lifecycle.runLifecycle(f), /diagnostics are incomplete/);
    assert.equal(f.calls.length, 2);
    for (const phase of ['before', 'failed']) {
      const file = path.join(f.root, `uninstall-${phase}.json`);
      assert.ok(fs.statSync(file).size <= 65536);
      const report = JSON.parse(fs.readFileSync(file));
      if (oversized) assert.equal(report.truncated, true); else assert.equal(report.diagnostics.ok, false);
    }
  }
});

test('actual bounded remaining-file inventory refuses truncation before uninstall', async t => {
  const f = rig(t), run = f.run;
  f.run = async (file, args, env, options) => {
    await run(file, args, env, options);
    if (args.includes('--updated')) for (let i = 0; i < 33; i++) fs.writeFileSync(path.join(args.at(-1).slice('/D='.length), `remaining-${i}.bin`), 'Synthetic bytes');
  };
  await assert.rejects(Lifecycle.runLifecycle(f), /diagnostics are incomplete/);
  assert.equal(f.calls.length, 2);
  const report = JSON.parse(fs.readFileSync(path.join(f.root, 'uninstall-before.json')));
  assert.equal(report.files.truncated, true); assert.equal(report.files.entries.length, 32);
});

function injectedExecutor(spawn, timer = setTimeout) {
  const file = path.join(__dirname, '../scripts/windows-install-smoke.js'), module = { exports: {} }, realRequire = createRequire(file);
  const require = name => name === 'node:child_process' ? { spawn } : realRequire(name);
  require.main = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require, module, process: { platform: process.platform, pid: 789, env: {} }, __dirname: path.dirname(file), console, Buffer, setTimeout: timer, clearTimeout });
  return module.exports;
}

test('actual default executor awaits copied direct child exit before accepting uninstall', async t => {
  const f = rig(t), entered = Promise.withResolvers();
  let held;
  const instance = injectedExecutor((file, args, options) => {
    const child = new EventEmitter(); child.pid = 123; child.kill = () => { throw new Error('kill forbidden'); };
    if (args.at(-1).startsWith('_?=')) { held = { file, args, options, child }; entered.resolve(); }
    else queueMicrotask(async () => { await f.run(file, args, options.env, options); child.emit('exit', 0, null); });
    return child;
  });
  let finished = false;
  const pending = instance.runLifecycle({ ...f, run: undefined }).then(value => { finished = true; return value; });
  await entered.promise;
  assert.equal(finished, false);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).stages.length, 4);
  assert.ok(fs.existsSync(held.file));
  await f.run(held.file, held.args, held.options.env, held.options);
  held.child.emit('exit', 0, null);
  assert.equal((await pending).stages.length, 7);
  const report = JSON.parse(fs.readFileSync(path.join(f.root, 'uninstall-after.json')));
  assert.equal(report.processReceipt.pid, 123); assert.equal(report.processReceipt.code, 0); assert.equal(report.processReceipt.timedOut, false);
});

test('actual default executor deadline refuses without claiming child termination or removing data', async t => {
  const f = rig(t);
  let timerCallback, killed = 0, third = false;
  const instance = injectedExecutor((file, args, options) => {
    const child = new EventEmitter(); child.pid = 123; child.kill = () => { killed++; return false; };
    third = args.at(-1).startsWith('_?=');
    if (!third) queueMicrotask(async () => { await f.run(file, args, options.env, options); child.emit('exit', 0, null); });
    else queueMicrotask(() => timerCallback());
    return child;
  }, (callback, ms) => { if (ms === 90000) return undefined; assert.equal(ms, 120000); timerCallback = callback; return undefined; });
  await assert.rejects(instance.runLifecycle({ ...f, run: undefined }), /exceeded 120000 ms/);
  assert.equal(killed, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).stages.length, 4);
  assert.ok(fs.existsSync(path.join(f.root, 'installed app with spaces', `${Brand.name}.exe`)));
  const report = JSON.parse(fs.readFileSync(path.join(f.root, 'uninstall-failed.json')));
  assert.equal(report.processReceipt.timedOut, true); assert.equal(report.processReceipt.terminationRequested, false);
});

test('lifecycle evidence fails when a real operation loses a retained database', async t => {
  const f = rig(t, ({ args, env }) => { if (args.includes('--updated')) fs.unlinkSync(path.join(env.CLAUDE_TRAFFIC_LIGHT_HOME, 'preserved-board.db')); });
  await assert.rejects(Lifecycle.runLifecycle(f), /Data changed:/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)).stages, ['installed', 'installed-launch-hooks-window-quit']);
});

test('lifecycle evidence fails if a hook only works while the portable app is open', async t => {
  const f = rig(t); f.runHook = async () => ({ code: 1 });
  await assert.rejects(Lifecycle.runLifecycle(f), /Portable hook did not survive app exit/);
});

test('installer smoke refuses an existing AppData profile without altering its bytes', async t => {
  const f = rig(t), dir = path.join(f.actualAppData, Brand.name), file = path.join(dir, 'existing.bin');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, 'Existing profile');
  await assert.rejects(Lifecycle.runLifecycle(f), /existing Plexiform AppData profile/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Existing profile');
  assert.equal(f.calls.length, 0);
});


for (const kind of ['nonzero', 'timeout']) test(`update ${kind} preserves the direct-child receipt and scoped observations before later lifecycle stages`, async t => {
  const f = rig(t), run = f.run;
  const processReceipt = { pid: 321, code: kind === 'nonzero' ? 1 : null, timedOut: kind === 'timeout', terminationRequested: false };
  const failure = Object.assign(new Error(`Synthetic update ${kind}`), { processReceipt });
  f.run = async (file, args, env, options) => {
    if (args.includes('--updated')) { f.calls.push({ file, args, env, options }); throw failure; }
    return run(file, args, env, options);
  };
  await assert.rejects(Lifecycle.runLifecycle(f), error => error === failure);
  const report = JSON.parse(fs.readFileSync(path.join(f.root, 'update-failed.json')));
  assert.equal(report.phase, 'update-failed'); assert.deepEqual(report.processReceipt, processReceipt);
  assert.equal(report.diagnostics.ok, true);
  assert.ok(report.files.entries.some(entry => entry.name === `${Brand.name}.exe`));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)).stages, ['installed', 'installed-launch-hooks-window-quit']);
  assert.equal(f.calls.length, 2);
  assert.equal(fs.readFileSync(path.join(f.actualAppData, Brand.name, 'preserved-board.db'), 'utf8'), 'Synthetic retained bytes: preserved-board.db\r\n');
});

test('failed update retains its original error when scoped diagnostics are unavailable or oversized', async t => {
  for (const oversized of [false, true]) {
    const f = rig(t), run = f.run, failure = new Error('Synthetic original update failure');
    f.run = async (file, args, env, options) => { if (args.includes('--updated')) throw failure; return run(file, args, env, options); };
    f.diagnostics = async () => { if (oversized) return { ok: true, text: 'x'.repeat(70000) }; throw new Error('Synthetic collector failure'); };
    await assert.rejects(Lifecycle.runLifecycle(f), error => error === failure);
    const file = path.join(f.root, 'update-failed.json'); assert.ok(fs.statSync(file).size <= 65536);
    const report = JSON.parse(fs.readFileSync(file)); assert.equal(report.phase, 'update-failed');
    if (oversized) assert.equal(report.truncated, true); else assert.equal(report.diagnostics.ok, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)).stages, ['installed', 'installed-launch-hooks-window-quit']);
  }
});

test('update-only pre-timeout observer persists bounded owned metadata without advancing lifecycle stages', async t => {
  const f = rig(t), original = f.run;
  let observations = 0;
  f.observe = async (receipt, options) => { observations++; assert.equal(receipt.pid, 456); assert.equal(options.env.HOME, path.join(f.root, 'fixture', 'home')); return { ok: true, processes: [{ pid: 456, image: 'installer' }], windows: [{ pid: 456, class: '#32770', visible: true }], truncated: false }; };
  f.run = async (file, args, env, options) => {
    if (args.includes('--updated')) {
      assert.equal(typeof options.observeBeforeTimeout, 'function');
      await options.observeBeforeTimeout({ pid: 456, started: 1000, elapsedMs: 90000, exe: file });
      assert.equal(JSON.parse(fs.readFileSync(f.receipt)).stages.length, 2);
    } else assert.equal(options.observeBeforeTimeout, undefined);
    return original(file, args, env, options);
  };
  assert.equal((await Lifecycle.runLifecycle(f)).stages.length, 7);
  assert.equal(observations, 1);
  const report = JSON.parse(fs.readFileSync(path.join(f.root, 'update-before-timeout.json')));
  assert.equal(report.phase, 'update-before-timeout'); assert.deepEqual(report.processReceipt, { pid: 456, started: 1000, elapsedMs: 90000 });
  assert.equal(report.observation.windows[0].class, '#32770'); assert.ok(fs.statSync(path.join(f.root, 'update-before-timeout.json')).size <= 32768);
});

test('pre-timeout observer refusal or oversize is explicit and never replaces original update failure', async t => {
  for (const oversized of [false, true]) {
    const f = rig(t), original = f.run, failure = new Error('Original update fixture failure');
    f.observe = async () => { if (oversized) return { ok: true, data: 'x'.repeat(40000) }; throw new Error('private observer details'); };
    f.run = async (file, args, env, options) => {
      if (args.includes('--updated')) { await options.observeBeforeTimeout({ pid: 456, started: 1000, elapsedMs: 90000, exe: file }); throw failure; }
      return original(file, args, env, options);
    };
    await assert.rejects(Lifecycle.runLifecycle(f), error => error === failure);
    const file = path.join(f.root, 'update-before-timeout.json'), text = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(text) <= 32768); assert.equal(JSON.parse(text).observation.ok, false); assert.doesNotMatch(text, /private observer details/);
    assert.equal(JSON.parse(fs.readFileSync(f.receipt)).stages.length, 2);
  }
});
