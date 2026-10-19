'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fork, execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createDetector } = require('../src/starter-pack-detector.js');
const Main = require('../src/starter-pack-main.js');
const { testTempDir } = require('./helpers/tmp');
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

const pipeFixture = t => {
  const root = testTempDir('starter-native-open-', t), fifo = path.join(root, 'blocked-read'), entry = path.join(root, 'blocked.cjs');
  execFileSync('mkfifo', [fifo]);
  fs.writeFileSync(entry, `process.once('message',m=>{process.send({type:'ready'},()=>{
    require('node:fs').openSync(m.folders[0].cwd,'r');
    process.send({type:'detected',detected:[]});process.disconnect();
  });});`);
  return { fifo, entry };
};
const waitFor = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned helper did not exit')), 2500); })]); }
  finally { clearTimeout(timer); }
};
const childFor = file => fork(file, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });

test('a native-blocked read times out without blocking main or accumulating helper processes', { skip: process.platform === 'win32' }, async t => {
  const { fifo, entry } = pipeFixture(t), ready = deferred(), exited = deferred();
  let starts = 0, child, exitSignal;
  const detector = createDetector({ timeoutMs: 1000, startProcess: () => {
    starts++; child = childFor(entry);
    child.once('message', () => ready.resolve()); child.once('exit', (_code, signal) => { exitSignal = signal; exited.resolve(); });
    return child;
  } });
  t.after(() => detector.close());
  const folders = [{ cwd: fifo, at: 1 }];
  let heartbeats = 0; const pulse = setInterval(() => heartbeats++, 5); t.after(() => clearInterval(pulse));
  const result = detector.detect(folders), began = Date.now();
  await waitFor(ready.promise);
  assert.equal(detector.detect(folders), result, 'the same underlying read is shared');
  assert.deepEqual(await result, []);
  assert.ok(Date.now() - began < 2500, 'optional read returns at a bounded deadline');
  assert.ok(heartbeats > 2, 'main event loop stayed responsive while native open blocked');
  for (let i = 0; i < 20; i++) assert.deepEqual(await detector.detect(folders), []);
  assert.equal(starts, 1, 'refresh does not accumulate processes before actual exit or during negative cache');
  await waitFor(exited.promise); assert.equal(exitSignal, 'SIGKILL', 'native open is forcibly stopped in its own process');
  assert.deepEqual(await detector.detect(folders), []); assert.equal(starts, 1, 'timed-out input backs off after exit');
  assert.deepEqual(await result, [], 'late lifecycle events cannot revive a timed-out result');
  await detector.close(); assert.deepEqual(await detector.detect(folders), []); assert.equal(starts, 1);
});

test('close kills a native-blocked child, resolves outstanding detection and remains terminal', { skip: process.platform === 'win32' }, async t => {
  const { fifo, entry } = pipeFixture(t), ready = deferred(), exited = deferred(); let starts = 0;
  const detector = createDetector({ timeoutMs: 10_000, startProcess: () => {
    starts++; const child = childFor(entry); child.once('message', () => ready.resolve()); child.once('exit', (_code, signal) => exited.resolve(signal)); return child;
  } });
  t.after(() => detector.close());
  const pending = detector.detect([{ cwd: fifo, at: 1 }]); await waitFor(ready.promise);
  const closed = detector.close();
  assert.deepEqual(await pending, []);
  assert.equal(detector.close(), closed, 'cleanup is idempotent and awaitable');
  await closed; assert.equal(await waitFor(exited.promise), 'SIGKILL'); assert.deepEqual(await detector.detect([{ cwd: fifo, at: 1 }]), []);
  assert.equal(starts, 1);
});

test('parent can exit naturally after closing a child blocked in native open', { skip: process.platform === 'win32' }, async t => {
  const { fifo, entry } = pipeFixture(t);
  const script = `const {createDetector}=require(process.argv[1]);const {fork}=require('node:child_process');
    const detector=createDetector({timeoutMs:10000,startProcess:()=>{const child=fork(process.argv[2],[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>{detector.close();process.stdout.write('closed');});return child;}});
    detector.detect([{cwd:process.argv[3],at:1}]);`;
  const result = await promisify(execFile)(process.execPath, ['-e', script, require.resolve('../src/starter-pack-detector.js'), entry, fifo], { timeout: 2500, killSignal: 'SIGKILL' });
  assert.equal(result.stdout, 'closed'); assert.equal(result.stderr, '');
});

test('production fork keeps positive marker detection and never returns project file contents', async t => {
  const root = testTempDir('starter-worker-', t), web = path.join(root, 'web'), swift = path.join(root, 'app');
  fs.mkdirSync(web); fs.mkdirSync(swift); fs.mkdirSync(path.join(swift, 'Thing.xcodeproj'));
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ dependencies: { next: '15' }, privateText: 'DO_NOT_RETURN_PROJECT_CONTENTS' }));
  const detector = createDetector(); t.after(() => detector.close());
  const result = await detector.detect([{ cwd: web, at: 2 }, { cwd: swift, at: 1 }]);
  assert.deepEqual(result, [{ cwd: web, at: 2, folder: 'web', stacks: ['nextjs', 'node'] }, { cwd: swift, at: 1, folder: 'app', stacks: ['swift'] }]);
  assert.equal(JSON.stringify(result).includes('DO_NOT_RETURN_PROJECT_CONTENTS'), false);
});

test('process startup failure drops optional suggestions without an inline filesystem fallback', async () => {
  const detector = createDetector({ startProcess: () => { throw new Error('private filesystem failure'); } });
  assert.deepEqual(await detector.detect([{ cwd: path.resolve('/synthetic/project'), at: 1 }]), []);
  await detector.close();
});

test('failure backoff follows folder paths despite changing activity timestamps', async () => {
  let time = 1, starts = 0;
  const detector = createDetector({ now: () => time, startProcess: () => { starts++; throw new Error('unavailable'); } });
  const cwd = path.resolve('/synthetic/project');
  assert.deepEqual(await detector.detect([{ cwd, at: 1 }]), []);
  for (const at of [2, 3, 4]) assert.deepEqual(await detector.detect([{ cwd, at }]), []);
  assert.equal(starts, 1, 'fresh hook timestamps do not bypass folder backoff');
  time += 45_001;
  assert.deepEqual(await detector.detect([{ cwd, at: 5 }]), []); assert.equal(starts, 2, 'a later attempt is allowed after backoff');
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
