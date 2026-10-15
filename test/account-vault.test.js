'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountVault } = require('../buddy-window/account-vault');

const ORIGIN = 'https://hub.example';
const record = name => ({ hub: ORIGIN, token: `synthetic-${name}`, user: { id: name } });
const seal = value => Buffer.from(`sealed:${JSON.stringify(value)}`);
const unseal = bytes => bytes.toString().slice('sealed:'.length);
const turn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, { saved, ready = () => true, whenReady = async () => {}, io = {}, onChange } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-account-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'accounts', 'hub.bin');
  if (saved !== undefined) { fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, seal(saved), { mode: 0o600 }); }
  const calls = [], events = [];
  const storage = {
    encryptAsync: async text => { calls.push('encrypt'); return Buffer.from(`sealed:${text}`); },
    decryptAsync: async bytes => { calls.push('decrypt'); return unseal(bytes); },
  };
  const vault = createAccountVault({ origin: ORIGIN, file, storage, ready, whenReady,
    io: { ...fs, ...io }, onChange: event => { events.push(event); onChange?.(event); } });
  return { vault, storage, calls, events, dir, file, disk: () => fs.readFileSync(file), names: () => fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)) : [] };
}

const unavailable = error => { assert.equal(error.message, 'Secure account storage is unavailable.'); return true; };
const cancelled = error => { assert.equal(error.message, 'Account storage operation was cancelled.'); return true; };

test('load is cache-only, waits for app readiness and performs one shared restore', async t => {
  const gate = deferred();
  let appReady = false, readyWaits = 0;
  const f = fixture(t, { saved: record('existing'), ready: () => appReady, whenReady: () => { readyWaits++; return gate.promise; } });
  assert.equal(f.vault.load(), null);
  assert.equal(f.vault.load(), null);
  assert.equal(f.vault.state(), 'restoring');
  const pending = f.vault.retry();
  assert.equal(f.vault.retry(), pending);
  await turn();
  assert.equal(readyWaits, 1);
  assert.deepEqual(f.calls, []);
  appReady = true; gate.resolve();
  assert.deepEqual(await pending, record('existing'));
  assert.deepEqual(f.vault.load(), record('existing'));
  assert.equal(f.vault.state(), 'ready');
  assert.deepEqual(f.calls, ['decrypt']);
  assert.deepEqual(await f.vault.retry(), record('existing'));
  assert.deepEqual(f.calls, ['decrypt']);
});

test('native restore can stay pending while unrelated event-loop work completes', async t => {
  const f = fixture(t, { saved: record('existing') });
  const gate = deferred();
  f.storage.decryptAsync = () => { f.calls.push('decrypt'); return gate.promise; };
  let settled = false;
  const pending = f.vault.retry().finally(() => { settled = true; });
  await turn();
  assert.equal(settled, false);
  assert.equal(f.vault.load(), null);
  assert.deepEqual(f.calls, ['decrypt']);
  gate.resolve(JSON.stringify(record('existing')));
  assert.deepEqual(await pending, record('existing'));
});

test('missing credentials do not initialize native storage or poll for another read', async t => {
  const f = fixture(t);
  assert.equal(await f.vault.retry(), null);
  assert.equal(f.vault.state(), 'empty');
  assert.equal(f.vault.load(), null);
  assert.equal(await f.vault.retry(), null);
  assert.deepEqual(f.calls, []);
});

test('failed restore preserves ciphertext and retries only when explicitly requested', async t => {
  const f = fixture(t, { saved: record('existing') });
  const original = f.disk();
  f.storage.decryptAsync = async () => { f.calls.push('denied'); throw Error('private native detail synthetic-secret'); };
  assert.equal(await f.vault.retry(), null);
  assert.equal(f.vault.state(), 'locked');
  for (let i = 0; i < 5; i++) assert.equal(f.vault.load(), null);
  await turn();
  assert.deepEqual(f.calls, ['denied']);
  assert.deepEqual(f.disk(), original);
  assert.doesNotMatch(JSON.stringify(f.events), /private native detail|synthetic-secret/);
  f.storage.decryptAsync = async bytes => { f.calls.push('recovered'); return unseal(bytes); };
  assert.deepEqual(await f.vault.retry(), record('existing'));
  assert.deepEqual(f.calls, ['denied', 'recovered']);
  assert.deepEqual(f.disk(), original);
});

test('readiness and file-read failures remain locked without changing encrypted data', async t => {
  for (const failAt of ['ready', 'read']) {
    const f = fixture(t, { saved: record(failAt),
      ready: () => failAt !== 'ready', whenReady: async () => { throw Error('private readiness detail'); },
      io: failAt === 'read' ? { readFileSync: () => { throw Error('private read path'); } } : {} });
    const before = f.disk();
    assert.equal(await f.vault.retry(), null);
    assert.equal(f.vault.state(), 'locked');
    assert.deepEqual(f.disk(), before);
    assert.deepEqual(f.calls, []);
  }
});

test('wrong-hub and malformed decrypted credentials never reach the cache or overwrite their file', async t => {
  for (const text of ['not-json', 'null', '[]', '{}', JSON.stringify({ ...record('wrong'), hub: 'https://other.example' }), JSON.stringify({ hub: ORIGIN, token: '' }), JSON.stringify({ hub: ORIGIN, token: 42 })]) {
    const f = fixture(t, { saved: record('original') });
    const before = f.disk();
    f.storage.decryptAsync = async () => text;
    assert.equal(await f.vault.retry(), null);
    assert.equal(f.vault.load(), null);
    assert.equal(f.vault.state(), 'locked');
    assert.deepEqual(f.disk(), before);
  }
});

test('save waits for readiness and async encryption then publishes a private whole file', async t => {
  const readyGate = deferred(), cryptoGate = deferred();
  let appReady = false;
  const f = fixture(t, { ready: () => appReady, whenReady: () => readyGate.promise });
  f.storage.encryptAsync = () => { f.calls.push('encrypt'); return cryptoGate.promise; };
  const pending = f.vault.save(record('new'));
  await turn();
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.file), false);
  appReady = true; readyGate.resolve();
  await turn();
  assert.deepEqual(f.calls, ['encrypt']);
  assert.equal(f.vault.load(), null);
  assert.equal(fs.existsSync(f.file), false);
  cryptoGate.resolve(seal(record('new')));
  await pending;
  assert.deepEqual(f.vault.load(), record('new'));
  assert.deepEqual(f.disk(), seal(record('new')));
  assert.equal(f.vault.state(), 'ready');
  assert.deepEqual(f.names(), ['hub.bin']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test('save failure exposes only safe errors and preserves an existing credential', async t => {
  for (const result of [() => { throw Error('private native detail synthetic-secret'); }, () => Promise.reject(Error('private native detail')), () => null, () => Buffer.alloc(0), () => 'synthetic-secret']) {
    const f = fixture(t, { saved: record('existing') });
    await f.vault.retry();
    const before = f.disk();
    f.storage.encryptAsync = result;
    await assert.rejects(f.vault.save(record('new')), unavailable);
    assert.deepEqual(f.disk(), before);
    assert.deepEqual(f.vault.load(), record('existing'));
    assert.deepEqual(f.names(), ['hub.bin']);
    assert.doesNotMatch(JSON.stringify(f.events), /private native detail|synthetic-secret/);
  }
});

test('wrong-hub or malformed save records are rejected before native storage or publication', async t => {
  for (const value of [null, [], {}, { ...record('other'), hub: 'https://other.example' }, { hub: ORIGIN, token: '' }, { hub: ORIGIN, token: 12 }]) {
    const f = fixture(t, { saved: record('existing') });
    const before = f.disk();
    await assert.rejects(f.vault.save(value), unavailable);
    assert.deepEqual(f.disk(), before);
    assert.deepEqual(f.calls, []);
  }
});

test('clear immediately signs out and prevents a pending restore from resurrecting credentials', async t => {
  const f = fixture(t, { saved: record('existing') });
  const gate = deferred();
  f.storage.decryptAsync = () => gate.promise;
  const pending = f.vault.retry();
  await turn();
  f.vault.clear();
  assert.equal(f.vault.load(), null);
  assert.equal(f.vault.state(), 'empty');
  assert.equal(fs.existsSync(f.file), false);
  gate.resolve(JSON.stringify(record('existing')));
  assert.equal(await pending, null);
  assert.equal(f.vault.load(), null);
  assert.equal(f.vault.state(), 'empty');
  assert.equal(fs.existsSync(f.file), false);
});

test('clear cancels a pending save without leaving ciphertext or temp files behind', async t => {
  const f = fixture(t, { saved: record('existing') });
  const gate = deferred();
  f.storage.encryptAsync = () => gate.promise;
  const pending = f.vault.save(record('new'));
  await turn();
  f.vault.clear();
  gate.resolve(seal(record('new')));
  await assert.rejects(pending, cancelled);
  assert.equal(f.vault.load(), null);
  assert.equal(f.vault.state(), 'empty');
  assert.deepEqual(f.names(), []);
});

test('close does not join native promises and rejects all late restore or save effects', async t => {
  for (const operation of ['restore', 'save']) {
    const f = fixture(t, { saved: record('existing') });
    const before = f.disk(), gate = deferred();
    f.storage[operation === 'restore' ? 'decryptAsync' : 'encryptAsync'] = () => gate.promise;
    const pending = operation === 'restore' ? f.vault.retry() : f.vault.save(record('new'));
    await turn();
    assert.equal(f.vault.close(), undefined);
    assert.equal(f.vault.load(), null);
    assert.equal(f.vault.state(), 'closed');
    const eventCount = f.events.length;
    await turn();
    assert.equal(f.events.length, eventCount);
    gate.resolve(operation === 'restore' ? JSON.stringify(record('existing')) : seal(record('new')));
    if (operation === 'restore') assert.equal(await pending, null); else await assert.rejects(pending, cancelled);
    assert.equal(f.vault.load(), null);
    assert.equal(await f.vault.retry(), null);
    assert.equal(f.vault.state(), 'closed');
    assert.deepEqual(f.disk(), before);
    assert.deepEqual(f.names(), ['hub.bin']);
    assert.equal(f.events.length, eventCount);
    await assert.rejects(f.vault.save(record('later')), cancelled);
  }
});

test('an old restore cannot overwrite a newer successful save', async t => {
  const f = fixture(t, { saved: record('old') });
  const gate = deferred();
  f.storage.decryptAsync = () => gate.promise;
  const oldRestore = f.vault.retry();
  await turn();
  await f.vault.save(record('new'));
  gate.resolve(JSON.stringify(record('old')));
  assert.equal(await oldRestore, null);
  assert.deepEqual(f.vault.load(), record('new'));
  assert.deepEqual(f.disk(), seal(record('new')));
  assert.equal(f.vault.state(), 'ready');
});

test('concurrent saves keep the newest-started owner regardless of native completion order', async t => {
  for (const finishNewestFirst of [false, true]) {
    const f = fixture(t, { saved: record('existing') });
    const older = deferred(), newer = deferred();
    f.storage.encryptAsync = text => JSON.parse(text).user.id === 'older' ? older.promise : newer.promise;
    const first = f.vault.save(record('older'));
    const rejectedFirst = assert.rejects(first, cancelled);
    const second = f.vault.save(record('newer'));
    if (finishNewestFirst) {
      newer.resolve(seal(record('newer'))); await second;
      older.resolve(seal(record('older'))); await rejectedFirst;
    } else {
      older.resolve(seal(record('older'))); await rejectedFirst;
      assert.deepEqual(f.disk(), seal(record('existing')));
      newer.resolve(seal(record('newer'))); await second;
    }
    assert.deepEqual(f.vault.load(), record('newer'));
    assert.deepEqual(f.disk(), seal(record('newer')));
    assert.equal(f.vault.state(), 'ready');
    assert.deepEqual(f.names(), ['hub.bin']);
  }
});

test('keep invalidation after the private temp write prevents atomic rename and cleans the temp file', async t => {
  let keep = true, renames = 0;
  const f = fixture(t, { saved: record('existing'), io: {
    writeFileSync: (...args) => { fs.writeFileSync(...args); keep = false; },
    renameSync: (...args) => { renames++; fs.renameSync(...args); },
  } });
  await f.vault.retry();
  await assert.rejects(f.vault.save(record('new'), { keep: () => keep }), cancelled);
  assert.equal(renames, 0);
  assert.deepEqual(f.disk(), seal(record('existing')));
  assert.deepEqual(f.vault.load(), record('existing'));
  assert.equal(f.vault.state(), 'ready');
  assert.deepEqual(f.names(), ['hub.bin']);
});

test('cancelling an in-flight sign-in save leaves an older sealed account available for explicit restore', async t => {
  const f = fixture(t, { saved: record('existing') });
  let keep = true;
  const gate = deferred();
  f.storage.encryptAsync = () => gate.promise;
  const pending = f.vault.save(record('new'), { keep: () => keep });
  await turn();
  keep = false;
  gate.resolve(seal(record('new')));
  await assert.rejects(pending, cancelled);
  assert.deepEqual(f.disk(), seal(record('existing')));
  assert.deepEqual(await f.vault.retry(), record('existing'));
  assert.deepEqual(f.vault.load(), record('existing'));
  assert.equal(f.vault.state(), 'ready');
});

test('false or throwing keep ownership never invokes crypto or publishes a file', async t => {
  for (const keep of [() => false, () => { throw Error('private owner detail'); }, () => 'true']) {
    const f = fixture(t);
    await assert.rejects(f.vault.save(record('new'), { keep }), cancelled);
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(f.vault.load(), null);
  }
});

test('publication failures preserve the last credential and remove abandoned private temp files', async t => {
  for (const failAt of ['write', 'rename']) {
    const f = fixture(t, { saved: record('existing'), io: failAt === 'write' ? {
      writeFileSync: (...args) => { fs.writeFileSync(...args); throw Error('private native path'); },
    } : { renameSync: () => { throw Error('private native path'); } } });
    await f.vault.retry();
    await assert.rejects(f.vault.save(record('new')), unavailable);
    assert.deepEqual(f.vault.load(), record('existing'));
    assert.deepEqual(f.disk(), seal(record('existing')));
    assert.deepEqual(f.names(), ['hub.bin']);
  }
});
