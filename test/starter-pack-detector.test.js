'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createDetector } = require('../src/starter-pack-detector.js');
const Main = require('../src/starter-pack-main.js');
const { testTempDir } = require('./helpers/tmp');
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('a genuinely blocked worker times out without blocking main or accumulating refresh workers', async t => {
  const gate = new SharedArrayBuffer(4), ready = deferred(), exited = deferred();
  let starts = 0, worker;
  const detector = createDetector({ timeoutMs: 150, startWorker: data => {
    starts++;
    worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      parentPort.postMessage({type:'blocked'});
      Atomics.wait(new Int32Array(workerData.gate),0,0);
      parentPort.postMessage({type:'detected',detected:workerData.folders.map(f=>({...f,folder:require('node:path').basename(f.cwd),stacks:['node']}))});
      parentPort.close();`, { eval: true, workerData: { ...data, gate } });
    worker.once('message', () => ready.resolve()); worker.once('exit', () => exited.resolve());
    return worker;
  } });
  t.after(() => detector.close());
  const folders = [{ cwd: path.resolve('/synthetic/project'), at: 1 }];
  let heartbeats = 0; const pulse = setInterval(() => heartbeats++, 5); t.after(() => clearInterval(pulse));
  const result = detector.detect(folders), began = Date.now();
  await ready.promise;
  assert.equal(detector.detect(folders), result, 'the same underlying read is shared');
  assert.deepEqual(await result, []);
  assert.ok(Date.now() - began < 2000, 'optional read returns at a bounded deadline');
  assert.ok(heartbeats > 2, 'main event loop stayed responsive while the worker blocked');
  for (let i = 0; i < 20; i++) assert.deepEqual(await detector.detect(folders), []);
  assert.deepEqual(await detector.detect([{ cwd: path.resolve('/synthetic/other'), at: 2 }]), []);
  assert.equal(starts, 1, 'timeouts and changed inputs do not create replacement workers');
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  await exited.promise;
  assert.deepEqual(await result, [], 'late success cannot revive a timed-out result');
  await detector.close(); assert.deepEqual(await detector.detect(folders), []); assert.equal(starts, 1);
});

test('close resolves outstanding detection and permanently prevents another worker', async t => {
  let starts = 0;
  const detector = createDetector({ timeoutMs: 10_000, startWorker: () => {
    starts++; return new Worker(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)`, { eval: true });
  } });
  t.after(() => detector.close());
  const pending = detector.detect([{ cwd: path.resolve('/synthetic/project'), at: 1 }]);
  const closed = detector.close();
  assert.deepEqual(await pending, []);
  assert.equal(detector.close(), closed, 'cleanup is idempotent and awaitable');
  await closed; assert.deepEqual(await detector.detect([{ cwd: path.resolve('/synthetic/project'), at: 1 }]), []);
  assert.equal(starts, 1);
});

test('production worker keeps positive marker detection and never returns project file contents', async t => {
  const root = testTempDir('starter-worker-', t), web = path.join(root, 'web'), swift = path.join(root, 'app');
  fs.mkdirSync(web); fs.mkdirSync(swift); fs.mkdirSync(path.join(swift, 'Thing.xcodeproj'));
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ dependencies: { next: '15' }, privateText: 'DO_NOT_RETURN_PROJECT_CONTENTS' }));
  const detector = createDetector(); t.after(() => detector.close());
  const result = await detector.detect([{ cwd: web, at: 2 }, { cwd: swift, at: 1 }]);
  assert.deepEqual(result, [{ cwd: web, at: 2, folder: 'web', stacks: ['nextjs', 'node'] }, { cwd: swift, at: 1, folder: 'app', stacks: ['swift'] }]);
  assert.equal(JSON.stringify(result).includes('DO_NOT_RETURN_PROJECT_CONTENTS'), false);
});

test('worker startup failure drops optional suggestions without an inline filesystem fallback', async () => {
  const detector = createDetector({ startWorker: () => { throw new Error('private filesystem failure'); } });
  assert.deepEqual(await detector.detect([{ cwd: path.resolve('/synthetic/project'), at: 1 }]), []);
  await detector.close();
});

const detected = [{ cwd: path.resolve('/synthetic/project'), at: 1, folder: 'project', stacks: ['node'] }];
function fixture({ state = {}, turns = async () => [{ cwd: detected[0].cwd, ts: 1 }], detect = async () => detected, confirm = async () => true } = {}) {
  let connected = true, installed = false, calls = 0, scans = 0, closes = 0, added = 0;
  const recipe = { id: 'recipe/explain', kind: 'recipe', title: 'Explain', slug: 'explain', payload: { tool: 'auto', title: 'Explain', prompt: 'Explain', edits: false } };
  const pack = { id: 'pack/node', kind: 'pack', title: 'Node pack', sha256: 'a'.repeat(64), stacks: ['node'], author: { name: 'Author' }, license: 'CC0', payload: { members: [recipe.id] } };
  const recipes = { mine: () => installed ? [{ id: 'old' }] : [], originOf: () => installed ? { gallery_id: 'old' } : null, addFromGallery: () => { added++; return { ok: true }; } };
  const store = { get: () => ({ dismissed: state.dismissed === true, added: state.added ?? null }), dismiss: () => { state.dismissed = true; }, markAdded: id => { state.added = id; } };
  const main = Main.create({ store, gallery: { entries: () => [pack, recipe], fetchIndex: async () => ({ ok: true }) }, recipes,
    characters: { list: () => [] }, tasks: () => { throw new Error('must not start task'); }, confirm,
    turns: async () => { calls++; return turns(); }, tools: () => [{ connected }],
    detector: { detect: async rows => { scans++; return detect(rows); }, close: async () => { closes++; } } });
  return { main, state, disconnect: () => { connected = false; }, install: () => { installed = true; }, stats: () => ({ calls, scans, closes, added }) };
}

test('ineligible Home cards do not load usage or start detection', async t => {
  for (const kind of ['dismissed', 'added', 'installed', 'disconnected']) {
    const f = fixture({ state: kind === 'dismissed' ? { dismissed: true } : kind === 'added' ? { added: 'pack/old' } : {} });
    if (kind === 'installed') f.install(); if (kind === 'disconnected') f.disconnect();
    assert.equal(await f.main.view(), null, kind); assert.equal(f.stats().calls, 0, kind); assert.equal(f.stats().scans, 0, kind);
    await f.main.close();
  }
});

test('dismissal while usage is pending prevents even a worker scan', async () => {
  const usage = deferred(), f = fixture({ turns: () => usage.promise });
  const reading = f.main.view(); await tick();
  await f.main.act('dismiss'); usage.resolve([{ cwd: detected[0].cwd, ts: 1 }]);
  assert.equal(await reading, null); assert.equal(f.stats().scans, 0); await f.main.close();
});

test('late detector results cannot revive dismissed, installed, disconnected, retired or closed suggestions', async () => {
  for (const change of ['dismiss', 'add', 'install', 'disconnect', 'authority', 'close']) {
    const scan = deferred(), f = fixture({ detect: () => scan.promise }); let authorized = true;
    const reading = f.main.view(() => authorized); await tick(); assert.equal(f.stats().scans, 1, change);
    if (change === 'dismiss') await f.main.act('dismiss');
    if (change === 'add') f.state.added = 'pack/other';
    if (change === 'install') f.install();
    if (change === 'disconnect') f.disconnect();
    if (change === 'authority') authorized = false;
    if (change === 'close') await f.main.close();
    scan.resolve(detected); assert.equal(await reading, null, change);
    await f.main.close();
    const before = f.stats().calls; assert.equal(await f.main.view(), null); assert.equal(f.stats().calls, before, 'closed cannot restart');
  }
});

test('dismissal or authority loss during native Add confirmation causes no installation', async () => {
  for (const change of ['dismiss', 'authority', 'close']) {
    const consent = deferred(), f = fixture({ confirm: () => consent.promise }); let authorized = true;
    const adding = f.main.act('add', {}, () => authorized); await tick();
    if (change === 'dismiss') await f.main.act('dismiss');
    if (change === 'authority') authorized = false;
    if (change === 'close') await f.main.close();
    consent.resolve(true); assert.equal((await adding).ok, false, change); assert.equal(f.stats().added, 0, change); await f.main.close();
  }
});

test('IPC does not return a suggestion after its originating Home authority changes', async () => {
  const scan = deferred(), f = fixture({ detect: () => scan.promise }), handlers = new Map(); let allowed = true;
  Main.register({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, allowed: () => allowed, starter: f.main });
  const reading = handlers.get('home:starter')({}); await tick(); allowed = false; scan.resolve(detected);
  assert.equal(await reading, null); await f.main.close();
});
