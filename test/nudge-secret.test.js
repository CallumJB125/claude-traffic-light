// The approval counter's secret (src/nudge-secret.js): made once, sealed when
// it can be, never silently downgraded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSecretStore } = require('../src/nudge-secret.js');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-secret-')), 'approval-secret.json');
// A stand-in keychain: reversible, and able to fail.
const fakeSafe = ({ available = true, broken = false } = {}) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => { if (broken) throw new Error('keychain says no'); const s = b.toString(); if (!s.startsWith('sealed:')) throw new Error('bad'); return s.slice(7); },
});

test('made once, sealed when the keychain is there, 0600, and the same on the next read', () => {
  const file = tmpFile();
  const a = createSecretStore({ file, safeStorage: fakeSafe() })();
  assert.equal(a.length, 32);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(d.sealed, true);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.deepEqual(createSecretStore({ file, safeStorage: fakeSafe() })(), a);
});

test('no keychain: an unsealed random salt, still 0600', () => {
  const file = tmpFile();
  createSecretStore({ file, safeStorage: fakeSafe({ available: false }) })();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sealed, false);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
});

test('a sealed secret that won’t decrypt is kept, not replaced: counting is skipped, once logged', () => {
  const file = tmpFile();
  createSecretStore({ file, safeStorage: fakeSafe() })();
  const before = fs.readFileSync(file, 'utf8');
  const logs = [];
  const read = createSecretStore({ file, safeStorage: fakeSafe({ broken: true }), log: (m) => logs.push(m) });
  assert.throws(read, /not counting/);
  assert.throws(read, /not counting/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'never downgraded to an unsealed secret');
  assert.equal(logs.length, 1);
});

test('a file that isn’t JSON is replaced with a new secret', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not json');
  const s = createSecretStore({ file, safeStorage: fakeSafe() })();
  assert.equal(s.length, 32);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sealed, true);
});

test('an unreadable secret file (not missing, not bad JSON) is never replaced: counting stops', { skip: process.getuid && process.getuid() === 0 }, () => {
  const file = tmpFile();
  createSecretStore({ file, safeStorage: fakeSafe() })();
  const before = fs.readFileSync(file, 'utf8');
  fs.chmodSync(file, 0o000);
  try {
    const read = createSecretStore({ file, safeStorage: fakeSafe() });
    assert.throws(read, /not counting/);
  } finally { fs.chmodSync(file, 0o600); }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a missing file makes a new secret', () => {
  const file = tmpFile();
  assert.equal(fs.existsSync(file), false);
  assert.equal(createSecretStore({ file, safeStorage: fakeSafe() })().length, 32);
});
