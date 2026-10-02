'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const Observer = require('../scripts/windows-install-observer');
const tick = () => new Promise(resolve => setImmediate(resolve));
const START = 1790927577679;
function clock() {
  let now = START, id = 0;
  const timers = new Map();
  class ClockDate extends Date { static now() { return now; } }
  return { Date: ClockDate, timers, now: () => now,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms, ms }); return key; },
    clearTimeout(key) { timers.delete(key); },
    async advance(ms) { const end = now + ms; while (true) { const next = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); await tick(); } now = end; await tick(); },
  };
}
function packaged(t, { existing = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-hook-observer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(__dirname, '../scripts/smoke-installed.js'), module = { exports: {} };
  const c = clock(), child = new EventEmitter(), realRequire = createRequire(file);
  child.pid = 51; let kills = 0, spawnArgs;
  child.kill = () => { kills++; };
  const exe = path.join(dir, 'portable.exe'), report = path.join(dir, 'portable.json'), receipt = path.join(dir, 'portable-hook-start.json');
  fs.writeFileSync(exe, 'inert synthetic image'); fs.writeFileSync(report, '{"ok":true}');
  if (existing) fs.writeFileSync(receipt, '{}');
  const require = id => id === 'child_process' ? { spawn: (...args) => { spawnArgs = args; return child; } } : id === 'net' ? { createServer: () => ({ once() {}, listen(_p, _h, fn) { fn(); }, address: () => ({ port: 40001 }), close(fn) { fn(); } }) } : realRequire(id);
  require.main = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require, module, __dirname: path.dirname(file), process: { platform: 'win32', env: {} }, Date: c.Date, Buffer, console: { log() {}, error() {} }, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  return { ...c, child, receipt, exe, report, kills: () => kills, spawned: () => spawnArgs, options: { exe, report, home: path.join(dir, 'home'), data: path.join(dir, 'data'), userData: path.join(dir, 'profile') }, run: module.exports.runPackagedSmoke, write(value) { fs.writeFileSync(receipt, JSON.stringify(value)); } };
}
const valid = (started = START) => ({ schema: 1, phase: 'portable-hook-start', pid: 92, parentPid: 73, started, image: 'cmd.exe' });
test('inner observer follows actual late hook spawn and runs at8s, with original120s deadline and no input arguments', async t => {
  const f = packaged(t), seen = [], pending = f.run({ ...f.options, observeInnerHook: value => seen.push(value) });
  await tick(); await f.advance(26000); f.write(valid(f.now())); await f.advance(8250);
  assert.equal(seen.length, 1); assert.equal(seen[0].started, START + 26000); assert.equal(seen[0].elapsedMs, 8000);
  assert.equal(seen[0].launcher.pid, 51); assert.equal(seen[0].launcher.exe, f.exe); assert.equal(seen[0].current(), true);
  assert.equal(f.spawned()[2].env.PLEXIFORM_PORTABLE_HOOK_OBSERVE, '1'); assert.equal(f.spawned()[2].stdio, 'inherit');
  assert.ok([...f.timers.values()].some(v => v.at === START + 120000));
  f.child.emit('exit', 0); await pending; assert.equal(seen[0].current(), false); assert.equal(f.timers.size, 0); assert.equal(f.kills(), 0);
});
for (const [name, mutate] of [
  ['array PID', r => ({ ...r, pid: [92] })], ['foreign phase', r => ({ ...r, phase: 'other' })],
  ['extra path', r => ({ ...r, path: 'private' })], ['old timestamp', r => ({ ...r, started: START - 1 })],
  ['future timestamp', r => ({ ...r, started: START + 1000 })], ['invalid image', r => ({ ...r, image: 'other.exe' })],
]) test(`malicious inner receipt ${name} cannot start observation`, async t => {
  const f = packaged(t); let calls = 0;
  const pending = f.run({ ...f.options, observeInnerHook: () => { calls++; } }); await tick(); f.write(mutate(valid())); await f.advance(14000);
  assert.equal(calls, 0); f.child.emit('exit', 0); await pending; assert.equal(f.kills(), 0);
});
for (const kind of ['symlink', 'oversize', 'already present']) test(`inner receipt ${kind} refuses without observer side effects`, async t => {
  const f = packaged(t, { existing: kind === 'already present' }); let calls = 0;
  const pending = f.run({ ...f.options, observeInnerHook: () => { calls++; } }); await tick();
  if (kind === 'symlink') fs.symlinkSync(f.report, f.receipt);
  if (kind === 'oversize') fs.writeFileSync(f.receipt, 'x'.repeat(513));
  await f.advance(14000); assert.equal(calls, 0); f.child.emit('exit', 0); await pending;
  if (kind === 'already present') assert.equal(f.spawned()[2].env.PLEXIFORM_PORTABLE_HOOK_OBSERVE, undefined);
});
test('queued inner observer loses authority on exit before its microtask', async t => {
  const f = packaged(t); let calls = 0;
  const pending = f.run({ ...f.options, observeInnerHook: () => { calls++; } }); await tick(); f.write(valid()); await f.advance(250);
  const [key, timer] = [...f.timers].find(([, v]) => v.at === START + 8000); f.timers.delete(key); timer.fn(); f.child.emit('exit', 0);
  await pending; await tick(); assert.equal(calls, 0);
});
test('hung/rejected inner observation cannot delay original120s termination or successful exit', async t => {
  const f = packaged(t); let entered = false;
  const pending = f.run({ ...f.options, observeInnerHook: () => { entered = true; return new Promise(() => {}); } }); await tick(); f.write(valid()); await f.advance(8000);
  assert.equal(entered, true); const refused = assert.rejects(pending, /exit 124/); await f.advance(112000); await refused; assert.equal(f.kills(), 1);
  const g = packaged(t), success = g.run({ ...g.options, observeInnerHook: async () => { throw new Error('private'); } }); await tick(); g.write(valid()); await g.advance(8000); g.child.emit('exit', 0); assert.equal((await success).ok, true);
});
function hook(t, enabled) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-hook-owned-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), data = path.join(home, 'data'); fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  const settings = path.join(home, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'inert synthetic hook command' }] }] } }));
  fs.writeFileSync(path.join(data, 'sessions', 'smoke-73.json'), '{}');
  const file = path.join(__dirname, '../src/smoke.js'), module = { exports: {} }, c = clock(), child = new EventEmitter();
  child.pid = 92; child.stderr = new EventEmitter(); let input, args, kills = 0;
  child.stdin = { end: value => { input = value; } }; child.kill = () => { kills++; };
  const realRequire = createRequire(file), require = id => id === 'child_process' ? { spawn: (...values) => { args = values; return child; } } : id === 'os' ? { homedir: () => home, tmpdir: () => os.tmpdir() } : realRequire(id);
  const env = { CLAUDE_TRAFFIC_LIGHT_HOME: data, ...(enabled ? { PLEXIFORM_PORTABLE_HOOK_OBSERVE: '1' } : {}) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require, module, process: { pid: 73, platform: 'win32', arch: 'x64', env }, Buffer, URL, Date: c.Date, console: { error() {} }, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: () => 1, clearInterval() {} });
  return { ...c, dir, child, input: () => input, args: () => args, kills: () => kills, run: module.exports.run, runHook: module.exports.runHook, env, deps: { app: { isPackaged: true, getVersion: () => '1.0.1', exit() {} }, settingsPath: settings, sessionsDir: path.join(data, 'sessions'), reportPath: path.join(dir, 'portable.json'), installHooks() {}, areHooksInstalled: () => true, createWindow() {}, getWindow: () => ({ webContents: { getURL: () => 'file:///index.html', isLoading: () => false, on() {}, removeListener() {} } }) } };
}
test('actual smoke-owned spawn writes fixed receipt only after exact original stdin and only explicit portable enable', async t => {
  for (const enabled of [true, false]) {
    const f = hook(t, enabled), pending = f.run(f.deps); await tick();
    assert.equal(f.args()[1].shell, true); assert.deepEqual(Array.from(f.args()[1].stdio), ['pipe', 'pipe', 'pipe']);
    assert.equal(JSON.parse(f.input()).session_id, 'smoke-73');
    assert.ok([...f.timers.values()].some(v => v.ms === 15000));
    const file = path.join(f.dir, 'portable-hook-start.json'); assert.equal(fs.existsSync(file), enabled);
    if (enabled) assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema: 1, phase: 'portable-hook-start', pid: 92, parentPid: 73, started: START, image: 'cmd.exe' });
    f.child.emit('exit', 0); await pending; assert.equal(f.kills(), 0);
  }
});
test('spawn observer throw/hang cannot change hook stdin or15s timeout', async t => {
  const f = hook(t, false), payload = { session_id: 'isolated fixture', nested: { retained: true } };
  const pending = f.runHook('inert command', payload, { env: f.env, onSpawn: () => { throw new Error('private'); } });
  assert.equal(f.input(), JSON.stringify(payload)); await f.advance(15000); assert.equal((await pending).code, null); assert.equal(f.kills(), 1);
});
const launcher = { pid: 51, started: START, exe: 'C:\\fixture\\portable.exe' };
const owned = { pid: 92, parentPid: 73, started: START + 26000, exe: 'C:\\Windows\\System32\\cmd.exe' };
const payload = () => ({ truncated: false, processes: [
  { pid: 51, parentPid: 1, created: new Date(START).toISOString(), image: launcher.exe },
  { pid: 73, parentPid: 51, created: new Date(START + 25000).toISOString(), image: 'C:\\fixture\\plexiform.exe' },
  { pid: 92, parentPid: 73, created: new Date(owned.started).toISOString(), image: owned.exe },
], windows: [] });
test('single owned launcher query binds actual cmd PID/start/image/parent and retains5s32KiB budget', async () => {
  let queries = 0;
  const result = await Observer.collect(launcher, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, childReceipt: owned, canonicalize: value => value, run: async (_exe, _args, options) => { queries++; assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 32768); return JSON.stringify(payload()); } });
  assert.equal(queries, 1); assert.equal(result.ok, true); assert.equal(result.processes.find(r => r.pid === 92).image, 'cmd.exe');
  assert.doesNotMatch(JSON.stringify(result), /System32|fixture|portable\.exe/);
});
for (const [name, change] of [
  ['unbound PID', p => { p.processes[2].parentPid = 999; }], ['changed parent', p => { p.processes[2].parentPid = 51; }],
  ['stale spawn', p => { p.processes[2].created = new Date(owned.started - 1001).toISOString(); }],
  ['foreign cmd path', p => { p.processes[2].image = 'C:\\foreign\\cmd.exe'; }],
]) test(`launcher-bound inner ${name} fails closed`, () => {
  const p = payload(); change(p); assert.throws(() => Observer.scope(p, launcher, value => value, owned), /unbound|identity/);
});
test('malformed optional child contract refuses before PowerShell query', async () => {
  for (const childReceipt of [{ ...owned, pid: [92] }, { ...owned, exe: 'C:\\foreign\\cmd.exe' }, { ...owned, raw: 'private' }]) {
    let calls = 0;
    assert.equal((await Observer.collect(launcher, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, childReceipt, run: async () => { calls++; return '{}'; } })).ok, false);
    assert.equal(calls, 0);
  }
});
function lifecycle(t, kind) {
  const Lifecycle = require('../scripts/windows-install-smoke'), Adapters = require('../adapters'), Brand = require('../brand');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-hook-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(root, 'installer.exe'), portable = path.join(root, 'portable.exe'); let installDir, observed = 0, current = true;
  const observation = { ok: true, processes: [{ pid: 92, parentPid: 73, created: new Date(owned.started).toISOString(), image: 'cmd.exe', depth: 2 }], windows: [], truncated: false };
  const run = async (file, args) => {
    if (file === installer) { installDir = args.at(-1).slice(3); fs.mkdirSync(installDir, { recursive: true }); fs.writeFileSync(path.join(installDir, `${Brand.name}.exe`), 'inert'); fs.writeFileSync(path.join(installDir, `Uninstall ${Brand.name}.exe`), 'inert'); }
    else { require('../adapters/uninstall-all').run({ home: path.join(root, 'fixture', 'home') }); fs.rmSync(installDir, { recursive: true }); }
  };
  const smoke = async f => {
    Adapters.get('claude').install({ home: f.home, runtime: Adapters.Runtime.make({ execPath: f.exe, dataDir: f.data, hooksDir: path.join(root, 'hooks') }) });
    if (f.exe !== portable) { assert.equal(f.observeInnerHook, undefined); return { ok: true }; }
    assert.equal(typeof f.observeInnerHook, 'function');
    await f.observeInnerHook({ ...valid(owned.started), elapsedMs: 8000, launcher: { ...launcher, exe: portable }, current: () => current });
    if (kind === 'portable failure') throw new Error('original portable hook15s failure');
    return { ok: true };
  };
  const observe = async (receipt, options) => {
    observed++; assert.equal(receipt.pid, 51); assert.equal(receipt.exe, portable); assert.equal(options.childReceipt.pid, 92); assert.equal(options.childReceipt.parentPid, 73); assert.equal(options.childReceipt.exe, 'C:\\Windows\\System32\\cmd.exe');
    if (kind === 'exits during query') current = false;
    if (kind === 'throws') throw new Error('private provider input/path');
    return observation;
  };
  return { run: () => Lifecycle.runLifecycle({ root, installer, portable, actualAppData: path.join(root, 'appdata'), receipt: path.join(root, 'lifecycle.json'), env: { SystemRoot: 'C:\\Windows' }, run, smoke, observe, diagnostics: async () => ({ ok: true, images: [] }), runHook: async (_command, payload, { env }) => { fs.writeFileSync(path.join(env.CLAUDE_TRAFFIC_LIGHT_HOME, 'sessions', `${payload.session_id}.json`), '{}'); return { code: 0 }; } }), root, observed: () => observed, observation };
}
for (const kind of ['success', 'portable failure', 'exits during query', 'throws']) test(`complete lifecycle inner observation ${kind} preserves original outcome and closed receipt`, async t => {
  const f = lifecycle(t, kind);
  if (kind === 'portable failure') await assert.rejects(f.run(), /original portable hook15s failure/);
  else assert.equal((await f.run()).stages.length, 7);
  assert.equal(f.observed(), 1);
  const file = path.join(f.root, 'portable-hook-before-timeout.json');
  assert.equal(fs.existsSync(file), kind === 'success' || kind === 'portable failure');
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8'), report = JSON.parse(text);
    assert.equal(report.phase, 'portable-hook-before-timeout'); assert.deepEqual(report.observation, f.observation);
    assert.deepEqual(report.processReceipt, { pid: 92, parentPid: 73, started: owned.started, elapsedMs: 8000, image: 'cmd.exe' });
    assert.ok(Buffer.byteLength(text) <= 32768); assert.doesNotMatch(text, /System32|SystemRoot|fixture|private|launcher|"exe"/);
  }
});
test('late receipt cannot launch a query that might cross the15s hook deadline', async t => {
  const f = packaged(t); let calls = 0;
  const pending = f.run({ ...f.options, observeInnerHook: () => { calls++; } }); await tick(); await f.advance(11000); f.write(valid()); await f.advance(250);
  assert.equal(calls, 0); f.child.emit('exit', 0); await pending;
});
test('explicit diagnostic enable cannot create receipt on ordinary report or unsafe fixture', async t => {
  const f = hook(t, true); f.deps.reportPath = path.join(f.dir, 'ordinary.json');
  const pending = f.run(f.deps); await tick(); f.child.emit('exit', 0); await pending;
  assert.equal(fs.existsSync(path.join(f.dir, 'portable-hook-start.json')), false);
  const g = hook(t, true); g.env.CLAUDE_TRAFFIC_LIGHT_HOME = '/not-a-private-temp-root'; await g.run(g.deps);
  assert.equal(g.args(), undefined); assert.equal(fs.existsSync(path.join(g.dir, 'portable-hook-start.json')), false);
});
