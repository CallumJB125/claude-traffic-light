'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAccountStorageProcess } = require('../buddy-window/account-storage-process');

const MAX_FRAME_BYTES = 1024 * 1024;
const safeError = error => { assert.equal(error.message, 'Secure account storage is unavailable.'); return true; };
const turn = () => new Promise(resolve => setImmediate(resolve));

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter();
  child.writes = []; child.kills = []; child.destroyedPipes = [];
  child.stdin.write = (frame, callback) => { child.writes.push(Buffer.from(frame)); callback?.(); return true; };
  child.stdin.destroy = () => child.destroyedPipes.push('stdin');
  child.stdout.destroy = () => child.destroyedPipes.push('stdout');
  child.kill = signal => { child.kills.push(signal); return true; };
  return child;
}

function fixture(options = {}) {
  const children = [], spawns = [];
  const transport = createAccountStorageProcess({ execPath: '/fixture/Plexiform',
    env: { HOME: '/fixture/home', PATH: '/fixture/bin', LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', ELECTRON_RUN_AS_NODE: '1', GOOGLE_SECRET: 'synthetic-secret' },
    spawn: (...args) => { spawns.push(args); const child = fakeChild(); children.push(child); return child; }, ...options });
  return { transport, children, spawns };
}

const sent = (child, index = 0) => JSON.parse(child.writes[index].toString('utf8'));
const emit = (child, object) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(object)}\n`));
const success = (child, request, bytes) => emit(child, { id: request.id, ok: true, data: bytes.toString('base64') });

test('transport starts lazily with the same executable, private pipes and no credential environment', async () => {
  const f = fixture();
  assert.equal(f.spawns.length, 0);
  const pending = f.transport.encryptAsync('synthetic-private-plain');
  assert.equal(f.spawns.length, 1);
  const [executable, args, options] = f.spawns[0];
  assert.equal(executable, '/fixture/Plexiform');
  assert.deepEqual(args, ['--plexiform-account-storage-worker']);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(options.env.GOOGLE_SECRET, undefined);
  assert.deepEqual(options.env, { HOME: '/fixture/home', PATH: '/fixture/bin', LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8' });
  assert.doesNotMatch(JSON.stringify(f.spawns), /synthetic-private-plain|synthetic-secret/);
  const child = f.children[0], request = sent(child);
  assert.equal(request.op, 'encrypt');
  assert.equal(Buffer.from(request.data, 'base64').toString(), 'synthetic-private-plain');
  const encrypted = Buffer.from([0x76, 0x31, 0x30, 0x00, 0xff]);
  success(child, request, encrypted);
  assert.deepEqual(await pending, encrypted);
  f.transport.close();
});

test('one child routes concurrent request ids and decodes UTF8 plaintext independently of response order', async () => {
  const f = fixture();
  const encrypt = f.transport.encryptAsync('synthetic'), decrypt = f.transport.decryptAsync(Buffer.from([0, 0xff, 1]));
  const child = f.children[0], first = sent(child, 0), second = sent(child, 1);
  assert.equal(f.children.length, 1);
  assert.notEqual(first.id, second.id);
  assert.equal(second.op, 'decrypt');
  assert.deepEqual(Buffer.from(second.data, 'base64'), Buffer.from([0, 0xff, 1]));
  assert.equal(f.transport.pendingCount(), 2);
  success(child, second, Buffer.from('synthetic unicode ✓'));
  assert.equal(await decrypt, 'synthetic unicode ✓');
  assert.equal(f.transport.pendingCount(), 1);
  success(child, first, Buffer.from('sealed-synthetic'));
  assert.deepEqual(await encrypt, Buffer.from('sealed-synthetic'));
  assert.equal(f.transport.pendingCount(), 0);
  f.transport.close();
});

test('partial frames and multiple frames in one chunk are parsed without corrupting responses', async () => {
  const f = fixture();
  const first = f.transport.encryptAsync('one'), second = f.transport.encryptAsync('two');
  const child = f.children[0];
  const a = `${JSON.stringify({ id: sent(child, 0).id, ok: true, data: Buffer.from('sealed-one').toString('base64') })}\n`;
  const b = `${JSON.stringify({ id: sent(child, 1).id, ok: true, data: Buffer.from('sealed-two').toString('base64') })}\n`;
  child.stdout.emit('data', Buffer.from(a.slice(0, 7)));
  assert.equal(f.transport.pendingCount(), 2);
  child.stdout.emit('data', Buffer.from(a.slice(7) + b));
  assert.equal((await first).toString(), 'sealed-one');
  assert.equal((await second).toString(), 'sealed-two');
  f.transport.close();
});

test('a native denial rejects only its own request and keeps the working child reusable', async () => {
  const f = fixture();
  const first = f.transport.encryptAsync('one'), rejected = assert.rejects(first, safeError);
  const second = f.transport.decryptAsync(Buffer.from('sealed-two'));
  const child = f.children[0];
  emit(child, { id: sent(child, 0).id, ok: false, error: 'private native detail synthetic-secret' });
  await rejected;
  success(child, sent(child, 1), Buffer.from('two'));
  assert.equal(await second, 'two');
  assert.deepEqual(child.kills, []);
  const third = f.transport.encryptAsync('three');
  assert.equal(f.children.length, 1);
  success(child, sent(child, 2), Buffer.from('sealed-three'));
  await third;
  f.transport.close();
});

test('malformed, noncanonical or unexpected responses fail the whole process with safe errors', async () => {
  for (const malformed of [
    () => Buffer.from('not-json\n'),
    () => Buffer.from('\n'),
    () => Buffer.from('[]\n'),
    request => Buffer.from(`${JSON.stringify({ id: request.id, ok: 'true', data: 'eA==' })}\n`),
    request => Buffer.from(`${JSON.stringify({ id: request.id + 100, ok: true, data: 'eA==' })}\n`),
    request => Buffer.from(`${JSON.stringify({ id: request.id, ok: true })}\n`),
    request => Buffer.from(`${JSON.stringify({ id: request.id, ok: true, data: 'eA' })}\n`),
    request => Buffer.from(`${JSON.stringify({ id: request.id, ok: true, data: 'eA==!' })}\n`),
    request => Buffer.from(`${JSON.stringify({ id: request.id, ok: true, data: '' })}\n`),
  ]) {
    const f = fixture();
    const one = assert.rejects(f.transport.encryptAsync('one'), safeError);
    const two = assert.rejects(f.transport.encryptAsync('two'), safeError);
    const child = f.children[0];
    child.stdout.emit('data', malformed(sent(child)));
    await Promise.all([one, two]);
    assert.equal(f.transport.pendingCount(), 0);
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(f.children.length, 1, 'protocol failure never restarts automatically');
    f.transport.close();
  }
});

test('decrypted invalid UTF8 is rejected while valid empty plaintext remains representable', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.transport.decryptAsync(Buffer.from('sealed')), safeError);
  const child = f.children[0];
  success(child, sent(child), Buffer.from([0xff]));
  await rejected;
  child.emit('exit', 1);
  const empty = f.transport.decryptAsync(Buffer.from('sealed-empty'));
  success(f.children[1], sent(f.children[1]), Buffer.alloc(0));
  assert.equal(await empty, '');
  f.transport.close();
});

test('oversized outgoing frames fail before spawn and oversized incoming frames kill outstanding work', async () => {
  const f = fixture();
  await assert.rejects(f.transport.encryptAsync('x'.repeat(MAX_FRAME_BYTES)), safeError);
  assert.equal(f.children.length, 0);
  const pending = assert.rejects(f.transport.encryptAsync('synthetic'), safeError);
  const child = f.children[0];
  child.stdout.emit('data', Buffer.alloc(MAX_FRAME_BYTES, 0x78));
  assert.deepEqual(child.kills, []);
  child.stdout.emit('data', Buffer.from('x'));
  await pending;
  assert.deepEqual(child.kills, ['SIGKILL']);
  child.emit('exit', 1);
  const again = assert.rejects(f.transport.encryptAsync('synthetic'), safeError);
  const next = f.children[1];
  next.stdout.emit('data', Buffer.concat([Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78), Buffer.from('\n')]));
  await again;
  assert.deepEqual(next.kills, ['SIGKILL']);
  f.transport.close();
});

test('process and pipe errors, ends and exits reject every pending operation without automatic restart', async () => {
  for (const fail of [c => c.emit('error', Error('private spawn detail')), c => c.emit('exit', 1), c => c.emit('close', 1),
    c => c.stdout.emit('error', Error('private read detail')), c => c.stdout.emit('end'), c => c.stdout.emit('close'),
    c => c.stdin.emit('error', Error('private write detail')), c => c.stdin.emit('close'), c => c.stdin.emit('finish')]) {
    const f = fixture();
    const first = assert.rejects(f.transport.encryptAsync('one'), safeError);
    const second = assert.rejects(f.transport.decryptAsync(Buffer.from('two')), safeError);
    const child = f.children[0];
    fail(child);
    await Promise.all([first, second]);
    await turn();
    assert.equal(f.children.length, 1);
    assert.equal(f.transport.pendingCount(), 0);
    child.emit('exit', 1);
    const next = f.transport.encryptAsync('next');
    assert.equal(f.children.length, 2);
    success(f.children[1], sent(f.children[1]), Buffer.from('sealed-next'));
    assert.equal((await next).toString(), 'sealed-next');
    f.transport.close();
  }
});

test('explicit retry cannot replace a killed child until its actual exit or process close', async () => {
  for (const exitEvent of ['exit', 'close']) {
    const f = fixture();
    const failed = assert.rejects(f.transport.encryptAsync('old'), safeError);
    const old = f.children[0];
    old.stdout.emit('data', Buffer.from('malformed\n'));
    await failed;
    assert.deepEqual(old.kills, ['SIGKILL']);
    await assert.rejects(f.transport.encryptAsync('during-retirement'), safeError);
    await assert.rejects(f.transport.decryptAsync(Buffer.from('during-retirement')), safeError);
    old.stdout.emit('close');
    old.stdin.emit('close');
    await assert.rejects(f.transport.encryptAsync('pipes-closed-only'), safeError);
    assert.equal(f.children.length, 1);
    old.emit(exitEvent, 1);
    await turn();
    assert.equal(f.children.length, 1, 'actual exit still never automatically retries');
    const retry = f.transport.encryptAsync('explicit-retry');
    assert.equal(f.children.length, 2);
    success(f.children[1], sent(f.children[1]), Buffer.from('sealed-retry'));
    assert.equal((await retry).toString(), 'sealed-retry');
    f.transport.close();
  }
});

test('close remains immediate while a failed child is still retiring and never permits another spawn', async () => {
  const f = fixture();
  const failed = assert.rejects(f.transport.encryptAsync('old'), safeError);
  const child = f.children[0];
  child.emit('error', Error('private failure'));
  await failed;
  assert.equal(f.transport.close(), undefined);
  await assert.rejects(f.transport.encryptAsync('before-exit'), safeError);
  child.emit('exit', 1);
  await assert.rejects(f.transport.encryptAsync('after-exit'), safeError);
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.equal(f.children.length, 1);
});

test('explicit restart retires a cached-denial worker and allows a fresh provider only after actual exit', async () => {
  const f = fixture();
  const denied = assert.rejects(f.transport.decryptAsync(Buffer.from('sealed-existing')), safeError);
  const old = f.children[0];
  emit(old, { id: sent(old).id, ok: false });
  await denied;
  assert.deepEqual(old.kills, [], 'per-request native denial preserves existing semantics');
  let restarted = false;
  const restart = f.transport.restart().then(value => { restarted = true; return value; });
  await turn();
  assert.equal(restarted, false);
  assert.deepEqual(old.kills, ['SIGKILL']);
  await assert.rejects(f.transport.decryptAsync(Buffer.from('during-retirement')), safeError);
  old.stdout.emit('close');
  await turn();
  assert.equal(restarted, false, 'pipe close alone is not process termination');
  old.emit('exit', 1);
  assert.equal(await restart, true);
  assert.equal(f.children.length, 1, 'restart itself never spawns');
  const retry = f.transport.decryptAsync(Buffer.from('sealed-existing'));
  assert.equal(f.children.length, 2);
  success(f.children[1], sent(f.children[1]), Buffer.from('synthetic-recovered'));
  assert.equal(await retry, 'synthetic-recovered');
  f.transport.close();
});

test('restart rejects outstanding work and concurrent restart callers share actual process retirement', async () => {
  const f = fixture();
  const first = assert.rejects(f.transport.encryptAsync('one'), safeError);
  const second = assert.rejects(f.transport.decryptAsync(Buffer.from('two')), safeError);
  const child = f.children[0];
  const one = f.transport.restart(), two = f.transport.restart();
  await Promise.all([first, second]);
  assert.equal(f.transport.pendingCount(), 0);
  assert.deepEqual(child.kills, ['SIGKILL']);
  child.emit('close', 1);
  assert.deepEqual(await Promise.all([one, two]), [true, true]);
  assert.equal(f.children.length, 1);
  assert.equal(await f.transport.restart(), true, 'an already absent child needs no wait or spawn');
  f.transport.close();
});

test('close settles restart waiters false immediately even if the retiring native process never exits', async () => {
  const f = fixture();
  const pending = assert.rejects(f.transport.encryptAsync('never-answers'), safeError);
  const child = f.children[0];
  const first = f.transport.restart(), second = f.transport.restart();
  await pending;
  assert.equal(f.transport.close(), undefined);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(await f.transport.restart(), false);
  assert.deepEqual(child.kills, ['SIGKILL']);
  child.emit('exit', 1);
  assert.equal(await f.transport.restart(), false);
  assert.equal(f.children.length, 1);
});

test('restart without a child is an immediate no-op and does not bypass permanent close', async () => {
  const f = fixture();
  assert.equal(await f.transport.restart(), true);
  assert.equal(f.children.length, 0);
  f.transport.close();
  assert.equal(await f.transport.restart(), false);
  assert.equal(f.children.length, 0);
});

test('incoming chunks and retained fragments are bounded before allocating concatenated frames', async () => {
  for (const useOversizedChunk of [true, false]) {
    const f = fixture();
    const pending = assert.rejects(f.transport.encryptAsync('synthetic'), safeError);
    const child = f.children[0];
    if (!useOversizedChunk) child.stdout.emit('data', Buffer.alloc(MAX_FRAME_BYTES, 0x78));
    const chunk = Buffer.alloc(useOversizedChunk ? MAX_FRAME_BYTES * 8 : 1, 0x78);
    const originalConcat = Buffer.concat;
    let concatenations = 0;
    Buffer.concat = (...args) => { concatenations++; return originalConcat(...args); };
    try { child.stdout.emit('data', chunk); }
    finally { Buffer.concat = originalConcat; }
    await pending;
    assert.equal(concatenations, 0, 'oversized bytes never allocate a concatenated frame');
    assert.deepEqual(child.kills, ['SIGKILL']);
    f.transport.close();
  }
});

test('a worker that never answers cannot block the event loop or close', async () => {
  const f = fixture();
  let settled = false;
  const pending = f.transport.encryptAsync('synthetic').finally(() => { settled = true; });
  const rejected = assert.rejects(pending, safeError);
  await turn();
  assert.equal(settled, false);
  assert.equal(f.transport.pendingCount(), 1);
  assert.equal(f.transport.close(), undefined);
  await rejected;
  assert.equal(settled, true);
  assert.equal(f.transport.pendingCount(), 0);
  assert.deepEqual(f.children[0].kills, ['SIGKILL']);
  assert.deepEqual(f.children[0].destroyedPipes, ['stdin', 'stdout']);
  await assert.rejects(f.transport.encryptAsync('later'), safeError);
  await assert.rejects(f.transport.decryptAsync(Buffer.from('later')), safeError);
  assert.equal(f.children.length, 1);
  f.transport.close();
  assert.deepEqual(f.children[0].kills, ['SIGKILL']);
});

test('late messages and errors from a failed child cannot affect its replacement', async () => {
  const f = fixture();
  const failed = assert.rejects(f.transport.encryptAsync('old'), safeError);
  const old = f.children[0], oldRequest = sent(old);
  old.emit('exit', 1); await failed;
  const current = f.transport.encryptAsync('new');
  const next = f.children[1];
  success(old, oldRequest, Buffer.from('wrong-old-result'));
  old.stdout.emit('data', Buffer.from('malformed\n'));
  old.emit('error', Error('late private detail'));
  old.stdin.emit('error', Error('late private detail'));
  assert.equal(f.transport.pendingCount(), 1);
  assert.deepEqual(next.kills, []);
  success(next, sent(next), Buffer.from('sealed-new'));
  assert.equal((await current).toString(), 'sealed-new');
  f.transport.close();
  success(next, sent(next), Buffer.from('late-after-close'));
  next.emit('error', Error('late private detail'));
  assert.equal(f.transport.pendingCount(), 0);
});

test('spawn failures and synchronous or callback write errors are sanitized and permit explicit retry', async () => {
  for (const mode of ['spawn', 'write', 'callback']) {
    let attempts = 0;
    const children = [];
    const f = fixture({ spawn: () => {
      attempts++;
      if (attempts === 1 && mode === 'spawn') throw Error('private spawn path synthetic-secret');
      const child = fakeChild(); children.push(child);
      if (attempts === 1) child.stdin.write = (frame, callback) => {
        if (mode === 'write') throw Error('private write detail');
        callback(Error('private callback detail'));
      };
      return child;
    } });
    await assert.rejects(f.transport.encryptAsync('synthetic'), safeError);
    if (children.length) children[0].emit('exit', 1);
    const pending = f.transport.encryptAsync('retry');
    const child = children.at(-1);
    success(child, sent(child), Buffer.from('sealed-retry'));
    await pending;
    assert.equal(attempts, 2);
    f.transport.close();
  }
});

test('invalid inputs and a false readiness guard fail before starting a worker', async () => {
  let ready = false;
  const f = fixture({ ready: () => ready });
  await assert.rejects(f.transport.encryptAsync('synthetic'), safeError);
  assert.equal(f.children.length, 0);
  ready = true;
  for (const value of [undefined, null, {}, Buffer.from('synthetic')]) await assert.rejects(f.transport.encryptAsync(value), safeError);
  for (const value of [undefined, null, 'synthetic', new Uint8Array([1]), Buffer.alloc(0)]) await assert.rejects(f.transport.decryptAsync(value), safeError);
  assert.equal(f.children.length, 0);
  const pending = f.transport.encryptAsync('synthetic');
  success(f.children[0], sent(f.children[0]), Buffer.from('sealed'));
  await pending;
  f.transport.close();
});

test('bounded concurrent work rejects overflow without disrupting requests already in flight', async () => {
  const f = fixture();
  const pending = Array.from({ length: 64 }, () => f.transport.encryptAsync('synthetic'));
  await assert.rejects(f.transport.encryptAsync('overflow'), safeError);
  assert.equal(f.transport.pendingCount(), 64);
  assert.equal(f.children.length, 1);
  for (let index = 0; index < 64; index++) success(f.children[0], sent(f.children[0], index), Buffer.from('sealed'));
  assert.equal((await Promise.all(pending)).length, 64);
  assert.equal(f.transport.pendingCount(), 0);
  f.transport.close();
});
