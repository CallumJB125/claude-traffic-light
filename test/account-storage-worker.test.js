'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { serve, MAX_FRAME } = require('../buddy-window/account-storage-worker');
const tick = () => new Promise(resolve => setImmediate(resolve));
const encode = text => Buffer.from(text).toString('base64');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
function fixture(options = {}) {
  const input = new PassThrough(), output = new PassThrough(), replies = [], calls = [];
  let stops = 0;
  output.on('data', chunk => replies.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  serve({ input, output, terminate: () => stops++, storage: {
    encryptAsync: async text => { calls.push(['encrypt', text]); return Buffer.from(`sealed:${text}`); },
    decryptAsync: async bytes => { calls.push(['decrypt', bytes.toString()]); return bytes.toString().slice(7); },
  }, ...options });
  return { input, output, calls, replies, stops: () => stops,
    send: value => input.write(JSON.stringify(value) + '\n') };
}
test('worker waits for readiness and carries crypto only over its private protocol', async () => {
  const ready = deferred(), f = fixture({ ready: () => ready.promise });
  f.send({ id: 1, op: 'encrypt', data: encode('synthetic-credential') });
  await tick(); assert.deepEqual(f.calls, []); assert.deepEqual(f.replies, []);
  ready.resolve(); await tick();
  assert.deepEqual(f.calls, [['encrypt', 'synthetic-credential']]);
  assert.deepEqual(f.replies, [{ id: 1, ok: true, data: encode('sealed:synthetic-credential') }]);
  f.send({ id: 2, op: 'decrypt', data: encode('sealed:synthetic-credential') });
  await tick(); assert.deepEqual(f.replies[1], { id: 2, ok: true, data: encode('synthetic-credential') });
});
test('worker accepts split frames and gives only a safe failure for native errors', async () => {
  const f = fixture({ storage: { encryptAsync: async () => { throw Error('private-native-detail'); } } });
  const line = JSON.stringify({ id: 1, op: 'encrypt', data: encode('synthetic') }) + '\n';
  f.input.write(line.slice(0, 8)); f.input.write(line.slice(8));
  await tick(); assert.deepEqual(f.replies, [{ id: 1, ok: false }]);
  assert.doesNotMatch(JSON.stringify(f.replies), /private-native-detail|synthetic/);
});
test('closing the parent pipe terminates the worker without waiting for native crypto', async () => {
  const native = deferred(), f = fixture({ storage: { decryptAsync: () => native.promise } });
  f.send({ id: 1, op: 'decrypt', data: encode('synthetic-ciphertext') });
  await tick(); f.input.end(); await tick();
  assert.equal(f.stops(), 1);
  native.resolve('late-synthetic-credential'); await tick();
  assert.deepEqual(f.replies, []);
});
test('malformed, replayed, noncanonical and oversized worker frames fail closed', async () => {
  const bad = [null, [], {}, { id: 0, op: 'encrypt', data: '' }, { id: 1, op: 'read-file', data: '' },
    { id: 1, op: 'decrypt', data: '' }, { id: 1, op: 'decrypt', data: 'invalid base64' }];
  for (const value of bad) {
    const f = fixture(); f.send(value); await tick();
    assert.equal(f.stops(), 1); assert.deepEqual(f.calls, []); assert.deepEqual(f.replies, []);
  }
  const malformed = fixture(); malformed.input.write('{bad}\n'); await tick(); assert.equal(malformed.stops(), 1);
  const oversized = fixture(); oversized.input.write('x'.repeat(MAX_FRAME + 1)); await tick(); assert.equal(oversized.stops(), 1);
  const replay = fixture(); replay.send({ id: 1, op: 'encrypt', data: encode('synthetic') }); await tick();
  replay.send({ id: 1, op: 'encrypt', data: encode('synthetic') }); await tick();
  assert.equal(replay.stops(), 1); assert.equal(replay.calls.length, 1);
});
test('private pipe errors terminate once and suppress late native responses', async () => {
  for (const which of ['input', 'output']) {
    const native = deferred(), f = fixture({ storage: { encryptAsync: () => native.promise } });
    f.send({ id: 1, op: 'encrypt', data: encode('synthetic') }); await tick();
    f[which].emit('error', Error('private-pipe-detail'));
    f.input.emit('error', Error('second-error'));
    native.resolve(Buffer.from('late')); await tick();
    assert.equal(f.stops(), 1); assert.deepEqual(f.replies, []);
  }
});
