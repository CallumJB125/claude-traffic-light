'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecureStorage, storageHelp } = require('../buddy-window/secure-storage');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(platform = 'darwin', backend = 'gnome_libsecret') {
  const calls = [];
  const sync = name => () => { calls.push(name); throw new Error('sync crypto must not run'); };
  const native = {
    isEncryptionAvailable: sync('sync availability'),
    encryptString: sync('sync encrypt'),
    decryptString: sync('sync decrypt'),
    setUsePlainTextEncryption: sync('plaintext fallback'),
    getSelectedStorageBackend: () => backend,
    isAsyncEncryptionAvailable: async () => { calls.push('async availability'); return true; },
    encryptStringAsync: async text => { calls.push('async encrypt'); return Buffer.from(`v11:${text}`); },
    decryptStringAsync: async () => { calls.push('async decrypt'); return { result: 'synthetic', shouldReEncrypt: false }; },
  };
  return { native, calls, storage: createSecureStorage(native, platform), setBackend: value => { backend = value; } };
}

function safeError(error, platform) {
  assert.equal(error.message, `Secure storage is unavailable. ${storageHelp(platform)}`);
  assert.doesNotMatch(error.message, /private native detail|synthetic-secret|secret-path/);
  return true;
}

test('async wrapper stays lazy and never reaches synchronous availability or cryptography', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform);
    assert.deepEqual(f.calls, []);
    assert.equal(await f.storage.availableAsync(), true);
    const encrypted = await f.storage.encryptAsync('synthetic');
    assert.equal(await f.storage.decryptAsync(encrypted), 'synthetic');
    assert.deepEqual(f.calls, ['async availability', 'async availability', 'async encrypt', 'async availability', 'async decrypt']);
  }
});

test('a blocked async initialization leaves the event loop responsive without dispatching crypto', async () => {
  const f = fixture();
  const gate = deferred();
  f.native.isAsyncEncryptionAvailable = () => { f.calls.push('async availability'); return gate.promise; };
  let settled = false;
  const pending = f.storage.encryptAsync('synthetic').finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(f.calls, ['async availability']);
  gate.resolve(true);
  assert.equal((await pending).toString(), 'v11:synthetic');
  assert.deepEqual(f.calls, ['async availability', 'async encrypt']);
});

test('pending native encrypt and decrypt operations allow unrelated event-loop work', async () => {
  for (const operation of ['encrypt', 'decrypt']) {
    const f = fixture();
    const gate = deferred();
    f.native[`${operation}StringAsync`] = () => { f.calls.push(`async ${operation}`); return gate.promise; };
    let settled = false;
    const pending = (operation === 'encrypt' ? f.storage.encryptAsync('synthetic') : f.storage.decryptAsync(Buffer.from('v11:synthetic')))
      .finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(f.calls, ['async availability', `async ${operation}`]);
    gate.resolve(operation === 'encrypt' ? Buffer.from('v11:synthetic') : { result: 'synthetic', shouldReEncrypt: false });
    assert.equal((await pending).toString(), operation === 'encrypt' ? 'v11:synthetic' : 'synthetic');
  }
});

test('Linux async APIs fail closed for insecure, unknown and reviewed sync backend names', async () => {
  for (const backend of ['basic_text', 'unknown', 'future-unreviewed', undefined, null, '', 'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    const f = fixture('linux', backend);
    f.setBackend(backend);
    assert.equal(await f.storage.availableAsync(), false);
    await assert.rejects(f.storage.encryptAsync('synthetic'), error => safeError(error, 'linux'));
    await assert.rejects(f.storage.decryptAsync(Buffer.from('v11:synthetic')), error => safeError(error, 'linux'));
    assert.deepEqual(f.calls, []);
  }
});

test('Linux never consults sync availability or backend selection to initialize an async provider', async () => {
  const f = fixture('linux');
  f.native.getSelectedStorageBackend = () => { throw new Error('sync backend must not be consulted'); };
  assert.equal(await f.storage.availableAsync(), false);
  await assert.rejects(f.storage.encryptAsync('synthetic'), error => safeError(error, 'linux'));
  await assert.rejects(f.storage.decryptAsync(Buffer.from('legacy-ciphertext')), error => safeError(error, 'linux'));
  assert.deepEqual(f.calls, []);
});

test('unreviewed platforms cannot use the async credential path', async () => {
  for (const platform of ['freebsd', 'openbsd', 'unreviewed']) {
    const f = fixture(platform);
    assert.equal(await f.storage.availableAsync(), false);
    await assert.rejects(f.storage.encryptAsync('synthetic'), error => safeError(error, platform));
    await assert.rejects(f.storage.decryptAsync(Buffer.from('legacy-ciphertext')), error => safeError(error, platform));
    assert.deepEqual(f.calls, []);
  }
});

test('missing async APIs fail closed without trying the legacy synchronous API', async () => {
  for (const method of ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) {
    const f = fixture();
    delete f.native[method];
    assert.equal(await f.storage.availableAsync(), false);
    await assert.rejects(f.storage.encryptAsync('synthetic'), error => safeError(error, 'darwin'));
    await assert.rejects(f.storage.decryptAsync(Buffer.from('legacy-ciphertext')), error => safeError(error, 'darwin'));
    assert.deepEqual(f.calls, []);
  }
  const absent = createSecureStorage(undefined, 'darwin');
  assert.equal(await absent.availableAsync(), false);
  await assert.rejects(absent.encryptAsync('synthetic'), error => safeError(error, 'darwin'));
});

test('unavailable, rejected or thrown native initialization exposes only safe recovery guidance', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const unavailable of [async () => false, async () => 'true', async () => { throw Error('private native detail synthetic-secret'); }, () => { throw Error('secret-path'); }]) {
      const f = fixture(platform);
      f.native.isAsyncEncryptionAvailable = unavailable;
      assert.equal(await f.storage.availableAsync(), false);
      await assert.rejects(f.storage.encryptAsync('synthetic'), error => safeError(error, platform));
      await assert.rejects(f.storage.decryptAsync(Buffer.from('v11:synthetic')), error => safeError(error, platform));
      assert.deepEqual(f.calls, []);
    }
  }
});

test('malformed encrypt results never become a credential buffer', async () => {
  for (const value of [undefined, null, '', 'synthetic-secret', new Uint8Array([1, 2]), Buffer.alloc(0), {}]) {
    const f = fixture();
    f.native.encryptStringAsync = async () => value;
    await assert.rejects(f.storage.encryptAsync('synthetic'), error => safeError(error, 'darwin'));
  }
});

test('malformed async decrypt result is rejected without leaking native details', async () => {
  for (const value of [undefined, null, 'synthetic-secret', {}, { result: 'synthetic-secret' }, { result: 1, shouldReEncrypt: false }, { result: 'synthetic-secret', shouldReEncrypt: 'false' }]) {
    const f = fixture();
    f.native.decryptStringAsync = async () => value;
    await assert.rejects(f.storage.decryptAsync(Buffer.from('legacy-ciphertext')), error => safeError(error, 'darwin'));
  }
});

test('async crypto exceptions and malformed inputs are sanitized without sync fallback', async () => {
  for (const operation of ['encrypt', 'decrypt']) {
    const f = fixture();
    f.native[`${operation}StringAsync`] = () => { throw Error('private native detail synthetic-secret secret-path'); };
    await assert.rejects(operation === 'encrypt' ? f.storage.encryptAsync('synthetic') : f.storage.decryptAsync(Buffer.from('legacy-ciphertext')), error => safeError(error, 'darwin'));
    assert.deepEqual(f.calls, ['async availability']);
  }
  const f = fixture();
  await assert.rejects(f.storage.encryptAsync({ secret: 'synthetic' }), error => safeError(error, 'darwin'));
  await assert.rejects(f.storage.decryptAsync('synthetic'), error => safeError(error, 'darwin'));
  assert.deepEqual(f.calls, []);
});

test('legacy ciphertext decrypts asynchronously and rotation advice never rewrites or retries it', async () => {
  const f = fixture();
  const ciphertext = Buffer.from('v10:synthetic-legacy-ciphertext');
  const before = Buffer.from(ciphertext);
  const response = Object.freeze({ result: 'synthetic', shouldReEncrypt: true });
  f.native.decryptStringAsync = async received => {
    assert.equal(received, ciphertext);
    f.calls.push('async decrypt');
    return response;
  };
  assert.equal(await f.storage.decryptAsync(ciphertext), 'synthetic');
  assert.deepEqual(ciphertext, before);
  assert.deepEqual(f.calls, ['async availability', 'async decrypt']);
});
