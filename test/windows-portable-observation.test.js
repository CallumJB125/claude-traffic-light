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

function packaged() {
  const file = path.join(__dirname, '../scripts/smoke-installed.js');
  const module = { exports: {} }, timers = new Map(), cleared = [], child = new EventEmitter();
  child.pid = 51; let kills = 0, now = 1770000000000, spawned;
  child.kill = () => { kills++; return true; };
  const realRequire = createRequire(file), require = id => {
    if (id === 'child_process') return { spawn: (...args) => { spawned = args; return child; } };
    if (id === 'fs') return { existsSync: () => true, readFileSync: () => '{"ok":true}' };
    if (id === 'net') return { createServer: () => ({ once() {}, listen(_port, _host, ready) { ready(); }, address: () => ({ port: 41234 }), close: done => done() }) };
    return realRequire(id);
  };
  require.main = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require, module, __dirname: path.dirname(file), process: { platform: 'win32', env: { ELECTRON_RUN_AS_NODE: '1' } }, Date: { now: () => now }, console: { log() {}, error() {} }, setTimeout: (fn, ms) => { timers.set(ms, fn); return ms; }, clearTimeout: ms => { cleared.push(ms); timers.delete(ms); } });
  return { run: module.exports.runPackagedSmoke, child, timers, cleared, spawned: () => spawned, kills: () => kills, fire: ms => { now += ms; const fn = timers.get(ms); assert.equal(typeof fn, 'function'); timers.delete(ms); fn(); return fn; } };
}
const options = { exe: 'C:\\fixture\\portable.exe', home: 'C:\\fixture\\home', data: 'C:\\fixture\\data', userData: 'C:\\fixture\\profile', report: 'C:\\fixture\\report.json' };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('portable observer receives exact spawned identity once at55s without entering args or environment', async () => {
  const f = packaged(), seen = [], pending = f.run({ ...options, observeBeforeTimeout: value => seen.push(value) });
  await tick();
  assert.deepEqual([...f.timers.keys()], [120000, 55000]);
  const callback = f.fire(55000); await tick(); callback(); await tick();
  assert.equal(seen.length, 1); assert.equal(seen[0].pid, 51); assert.equal(seen[0].exe, options.exe);
  assert.equal(seen[0].started, 1770000000000); assert.equal(seen[0].elapsedMs, 55000);
  const spawn = f.spawned(); assert.equal(spawn[0], options.exe); assert.equal(spawn[2].stdio, 'inherit');
  assert.equal(Object.hasOwn(spawn[2], 'observeBeforeTimeout'), false);
  assert.equal(Object.hasOwn(spawn[2].env, 'observeBeforeTimeout'), false);
  assert.equal(Object.hasOwn(spawn[2].env, 'ELECTRON_RUN_AS_NODE'), false);
  f.child.emit('exit', 0); assert.equal((await pending).ok, true); assert.equal(f.kills(), 0);
});
test('observer rejection cannot turn success into failure or extend120s timeout', async () => {
  const f = packaged(), pending = f.run({ ...options, observeBeforeTimeout: async () => { throw new Error('private diagnostic failure'); } });
  await tick(); f.fire(55000); await tick(); f.fire(120000);
  await assert.rejects(pending, /FAILED \(exit 124\)/); assert.equal(f.kills(), 1);
  f.child.emit('exit', 0); assert.equal(f.kills(), 1);
});
test('inflight observation does not block the original successful smoke result', async () => {
  const f = packaged(); let entered = false, release;
  const pending = f.run({ ...options, observeBeforeTimeout: () => { entered = true; return new Promise(resolve => { release = resolve; }); } });
  await tick(); f.fire(55000); await tick(); assert.equal(entered, true);
  f.child.emit('exit', 0); assert.equal((await pending).ok, true); release();
  assert.ok(f.cleared.includes(120000));
});
for (const event of ['exit', 'error']) test(`early ${event} cancels observation, including queued callback`, async () => {
  const f = packaged(); let calls = 0;
  const pending = f.run({ ...options, observeBeforeTimeout: () => { calls++; } });
  await tick(); f.fire(55000);
  f.child.emit(event, event === 'exit' ? 0 : new Error('fixture failure'));
  if (event === 'exit') assert.equal((await pending).ok, true); else await assert.rejects(pending, /exit 1/);
  await tick(); assert.equal(calls, 0); assert.ok(f.cleared.includes(120000)); assert.ok(f.cleared.includes(55000));
});
test('ordinary packaged smoke creates no observer timer', async () => {
  const f = packaged(), pending = f.run(options); await tick();
  assert.deepEqual([...f.timers.keys()], [120000]); f.child.emit('exit', 0); await pending;
});

function fixture(t, observe) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-observation-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(root, 'installer.exe'), portable = path.join(root, 'portable.exe'), calls = [], smokeCalls = [];
  let installDir;
  const run = async (file, args) => {
    if (file === installer) {
      installDir = args.at(-1).slice('/D='.length); fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, `${Brand.name}.exe`), 'synthetic app');
      fs.writeFileSync(path.join(installDir, `Uninstall ${Brand.name}.exe`), 'synthetic uninstaller');
    } else { require('../adapters/uninstall-all').run({ home: path.join(root, 'fixture', 'home') }); fs.rmSync(installDir, { recursive: true }); }
  };
  const smoke = async f => {
    smokeCalls.push(f);
    Adapters.get('claude').install({ home: f.home, runtime: Adapters.Runtime.make({ execPath: f.exe, dataDir: f.data, hooksDir: path.join(root, 'hooks') }) });
    if (f.observeBeforeTimeout) await f.observeBeforeTimeout({ pid: 51, started: 1770000000000, elapsedMs: 55000, exe: f.exe });
    return { ok: true };
  };
  return { root, installer, portable, calls, smokeCalls, run, smoke, observe, env: { SystemRoot: 'C:\\Windows' }, diagnostics: async () => ({ ok: true, images: [] }), runHook: async (_command, payload, { env }) => { fs.writeFileSync(path.join(env.CLAUDE_TRAFFIC_LIGHT_HOME, 'sessions', `${payload.session_id}.json`), '{}'); return { code: 0 }; }, actualAppData: path.join(root, 'appdata'), receipt: path.join(root, 'lifecycle.json') };
}
test('lifecycle observes portable only and receipt contains no launcher path or environment', async t => {
  let f, observed = 0;
  const metadata = { ok: true, processes: [{ pid: 51, parentPid: 1, created: '2026-10-02T07:00:00.000Z', image: 'installer', depth: 0 }], windows: [{ pid: 51, class: 'Chrome_WidgetWin_1', visible: true }], truncated: false };
  f = fixture(t, async (receipt, { env }) => { observed++; assert.equal(receipt.exe, f.portable); assert.equal(env.HOME, path.join(f.root, 'fixture', 'home')); assert.equal(env.SystemRoot, 'C:\\Windows'); return metadata; });
  const result = await Lifecycle.runLifecycle(f);
  assert.equal(result.stages.length, 7); assert.equal(observed, 1);
  assert.deepEqual(f.smokeCalls.map(f => typeof f.observeBeforeTimeout), ['undefined', 'undefined', 'function']);
  const text = fs.readFileSync(path.join(f.root, 'portable-before-timeout.json'), 'utf8'), report = JSON.parse(text);
  assert.equal(report.phase, 'portable-before-timeout'); assert.deepEqual(report.observation, metadata);
  assert.deepEqual(report.processReceipt, { pid: 51, started: 1770000000000, elapsedMs: 55000 });
  assert.equal(text.includes(f.root), false); assert.equal(text.includes('SystemRoot'), false);
});
for (const kind of ['throw', 'oversize', 'circular']) test(`portable receipt ${kind} observation cannot replace lifecycle result or expose raw failure`, async t => {
  const f = fixture(t, async () => {
    if (kind === 'throw') throw new Error('private path/payload');
    if (kind === 'oversize') return { raw: 'private path/payload'.repeat(5000) };
    const circular = {}; circular.self = circular; return circular;
  });
  assert.equal((await Lifecycle.runLifecycle(f)).stages.length, 7);
  const file = path.join(f.root, 'portable-before-timeout.json');
  if (kind === 'circular') { assert.equal(fs.existsSync(file), false); return; }
  const text = fs.readFileSync(file, 'utf8'); assert.ok(Buffer.byteLength(text) <= 32768); assert.doesNotMatch(text, /private path\/payload/);
  assert.equal(JSON.parse(text).observation.ok, false);
});
