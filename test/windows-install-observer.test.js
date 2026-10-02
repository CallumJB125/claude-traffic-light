'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const Observer = require('../scripts/windows-install-observer');
const started = Date.parse('2026-10-02T06:00:00.000Z');
const receipt = { pid: 42, started, exe: 'C:\\fixture\\Plexiform-1.0.1-win-x64.exe' };
const row = (pid, parentPid, image, offset = 0) => ({ pid, parentPid, image, created: new Date(started + offset).toISOString() });
const payload = () => ({ truncated: false, processes: [row(42, 12, receipt.exe), row(43, 42, 'C:\\temp\\NSIS-owned\\old-uninstaller.exe', 100)], windows: [{ pid: 42, class: '#32770', visible: true }, { pid: 43, class: 'NSISDialog', visible: false }] });
const canonicalize = value => value;

test('owned installer graph exposes bounded process/window metadata without fixture or unrelated paths', () => {
  const out = Observer.scope(payload(), receipt, canonicalize);
  assert.equal(out.ok, true); assert.deepEqual(out.processes.map(p => [p.pid, p.image, p.depth]), [[42, 'installer', 0], [43, 'old-uninstaller.exe', 1]]);
  assert.deepEqual(out.windows, payload().windows);
  assert.equal(JSON.stringify(out).includes('C:'), false);
});
test('missing root is incomplete, while PID reuse/image replacement cannot adopt descendants', () => {
  assert.equal(Observer.scope({ ...payload(), processes: [], windows: [] }, receipt, canonicalize).ok, false);
  for (const mutation of [p => p.processes[0].image = 'C:\\unrelated\\Plexiform.exe', p => p.processes[0].created = new Date(started - 2000).toISOString(), p => p.processes[0].created = new Date(started + 11000).toISOString()]) {
    const p = payload(); mutation(p); assert.throws(() => Observer.scope(p, receipt, canonicalize));
  }
});
test('foreign windows, reused child PID, malformed inventories and overflows refuse', () => {
  for (const mutation of [p => p.windows[0].pid = 999, p => p.processes[1].created = new Date(started - 10).toISOString(), p => p.processes.push({ ...p.processes[0] }), p => p.windows[0].title = 'private text', p => p.processes[0].commandLine = 'private command', p => p.processes = Array(65).fill(p.processes[0]), p => p.windows = Array(65).fill(p.windows[0])]) {
    const p = payload(); mutation(p); assert.throws(() => Observer.scope(p, receipt, canonicalize));
  }
  const truncated = Observer.scope({ ...payload(), truncated: true }, receipt, canonicalize);
  assert.equal(truncated.ok, false); assert.equal(truncated.truncated, true);
});
test('process depth is explicitly bounded, and inaccessible image identity stays unavailable', () => {
  const p = payload(); p.windows = []; p.processes = [p.processes[0]];
  for (let depth = 1; depth <= 9; depth++) p.processes.push(row(42 + depth, 41 + depth, `C:\\temp\\child-${depth}.exe`, depth));
  assert.throws(() => Observer.scope(p, receipt, canonicalize));
  assert.throws(() => Observer.scope(payload(), receipt, () => { throw new Error('private path detail'); }));
});
test('collector pins system PowerShell, uses five-second/32KiB bounds and never queries text or command lines', async () => {
  let calls = 0;
  const out = await Observer.collect(receipt, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, canonicalize, run: async (exe, args, options) => {
    calls++; assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 32768); assert.equal(options.shell, false); assert.equal(options.env.PLEXIFORM_OBSERVER_PID, '42');
    assert.doesNotMatch(args.at(-1), /GetWindowText|CommandLine|WM_GETTEXT|SendMessage/);
    assert.match(args.at(-1), /GetWindowThreadProcessId/); return JSON.stringify(payload());
  } });
  assert.equal(calls, 1); assert.equal(out.ok, true);
});
test('collector failure, oversize and malformed output return no raw stderr or private metadata', async () => {
  for (const run of [async () => { throw new Error('secret stderr'); }, async () => 'secret output'.repeat(4000), async () => JSON.stringify({ ...payload(), windows: [{ ...payload().windows[0], title: 'private title' }] })]) {
    const out = await Observer.collect(receipt, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, canonicalize, run });
    assert.deepEqual(out, { ok: false, reason: 'owned installer observation failed' });
    assert.doesNotMatch(JSON.stringify(out), /secret|private title/);
  }
});
function executor() {
  const file = path.join(__dirname, '../scripts/windows-install-smoke.js'), module = { exports: {} }, timers = new Map(), cleared = [];
  const child = new EventEmitter(); child.pid = 42; child.kill = () => false;
  let spawned;
  const realRequire = createRequire(file), require = name => name === 'node:child_process' ? { spawn: (...args) => { spawned = args; return child; } } : realRequire(name);
  require.main = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.testExecutor = execute;', { require, module, process: { platform: 'win32', pid: 1, env: {} }, __dirname: path.dirname(file), console, Buffer, setTimeout: (fn, ms) => { timers.set(ms, fn); return ms; }, clearTimeout: value => cleared.push(value) });
  return { run: module.exports.testExecutor, child, timers, cleared, spawned: () => spawned };
}
test('actual executor captures owned child at90s without changing120s refusal or passing observer into spawn', async () => {
  const f = executor(), seen = [];
  const pending = f.run(receipt.exe, ['/S'], {}, { cwd: 'C:\\fixture', observeBeforeTimeout: async value => seen.push(value) });
  assert.equal(typeof f.spawned()[2].observeBeforeTimeout, 'undefined');
  f.timers.get(90000)(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.length, 1); assert.equal(seen[0].pid, 42); assert.equal(seen[0].exe, receipt.exe);
  f.timers.get(120000)(); await assert.rejects(pending, error => error.processReceipt.timedOut && error.processReceipt.terminationRequested === false);
});
test('successful direct exit cancels both timers and observer failures cannot turn exit into failure', async () => {
  const f = executor(); const pending = f.run(receipt.exe, [], {}, { observeBeforeTimeout: async () => { throw new Error('observer refused'); } });
  f.timers.get(90000)(); await new Promise(resolve => setImmediate(resolve)); f.child.emit('exit', 0, null);
  assert.equal((await pending).code, 0); assert.ok(f.cleared.includes(90000)); assert.ok(f.cleared.includes(120000));
});
