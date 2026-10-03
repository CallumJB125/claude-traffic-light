'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Private = require('../board/shared/windows-private-directory.cjs');
const receipt = { ok: true, volume: '0123456789abcdef', fileId: '0123456789abcdef0123456789abcdef' };
const success = { status: 0, signal: null, stdout: JSON.stringify(receipt) };

test('Windows directory startup sends a bounded private stdin frame to the fixed helper with a process deadline', () => {
  let calls = 0, retained;
  const client = Private.createClient({ platform: 'win32', executable: 'C:\\Plexiform\\native\\windows-private-directory.exe', execute(exe, args, options) {
    calls++;
    assert.equal(exe, 'C:\\Plexiform\\native\\windows-private-directory.exe');
    assert.deepEqual(args, []);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 1024);
    assert.equal(options.input.readUInt32LE(0), options.input.length - 4);
    assert.equal(options.input.subarray(4).toString('utf16le'), 'C:\\Users\\synthetic\\private');
    retained = options.input;
    return success;
  } });
  assert.deepEqual(client.ensureDirectory('C:\\Users\\synthetic\\private'), { volume: receipt.volume, fileId: receipt.fileId });
  assert.equal(calls, 1); assert.ok(retained.every(b => b === 0));
});

for (const value of [null, '', 'relative', '\\\\server\\share', 'C:/private', 'C:\\bad\0name', 'C:\\bad\nname', 'C:\\' + 'x'.repeat(4096)]) {
  test(`Windows directory startup refuses malformed path ${JSON.stringify(value)?.slice(0, 70)}`, () => {
    const client = Private.createClient({ platform: 'win32', execute() { assert.fail('must not start helper'); } });
    assert.throws(() => client.ensureDirectory(value), /Invalid private directory path/);
  });
}

for (const [name, result] of Object.entries({ timeout: { ...success, error: { code: 'ETIMEDOUT' } }, killed: { ...success, signal: 'SIGTERM' }, failed: { ...success, status: 1 }, noStatus: { stdout: success.stdout }, malformed: { ...success, stdout: 'bad' }, falseSuccess: { ...success, stdout: JSON.stringify({ ...receipt, ok: false }) }, extraField: { ...success, stdout: JSON.stringify({ ...receipt, path: 'private' }) }, arrayIdentity: { ...success, stdout: JSON.stringify({ ...receipt, volume: [receipt.volume] }) }, invalidIdentity: { ...success, stdout: JSON.stringify({ ...receipt, fileId: 'bad' }) } })) {
  test(`Windows directory startup refuses ${name} without returning an identity`, () => {
    const client = Private.createClient({ platform: 'win32', execute: () => result });
    assert.throws(() => client.ensureDirectory('C:\\private'), /private directory/);
  });
}

test('Windows directory helper cannot replace POSIX ownership validation', () => {
  const client = Private.createClient({ platform: 'linux', execute() { assert.fail('must not start helper'); } });
  assert.throws(() => client.ensureDirectory('C:\\private'), /requires Windows/);
});

test('desktop and runner startup require the native verifier on Windows and propagate refusal', async () => {
  const { ensurePrivateDir: desktop } = require('../buddy-window/device');
  const { ensurePrivateDir: runner } = await import('../board/runner/util.js');
  let calls = 0;
  const windowsPrivate = { ensureDirectory(dir) { assert.equal(dir, 'C:\\synthetic\\private'); calls++; return receipt; } };
  assert.equal(desktop('C:\\synthetic\\private', { platform: 'win32', windowsPrivate }), null);
  assert.equal(runner('C:\\synthetic\\private', { platform: 'win32', windowsPrivate }), 'C:\\synthetic\\private');
  assert.equal(calls, 2);
  const refusal = { ensureDirectory() { throw new Error('refused'); } };
  assert.equal(desktop('C:\\synthetic\\private', { platform: 'win32', windowsPrivate: refusal }), 'unusable');
  assert.throws(() => runner('C:\\synthetic\\private', { platform: 'win32', windowsPrivate: refusal }), /refused/);
});


test('native helper location follows the trusted module in dev, packaged main and unpacked utility processes', () => {
  const path = require('node:path');
  const root = path.resolve('synthetic-helper-location');
  for (const folder of ['app.asar', 'app.asar.unpacked']) {
    assert.equal(Private.helperPath(path.join(root, 'resources', folder, 'board', 'shared')), path.join(root, 'resources', 'native', 'windows-private-directory.exe'));
  }
  assert.equal(Private.helperPath(path.join(root, 'board', 'shared')), path.join(root, 'native', 'bin', 'windows-private-directory.exe'));
});
