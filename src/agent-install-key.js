'use strict';
// The key Find agents signs its ledger with (src/agent-install.js), sealed by
// safeStorage (the OS keychain). Unlike the approval counter's secret there is
// no unsealed fallback: a key stored in the clear next to the ledger would not
// stop a forgery, so without safeStorage Find agents does not write.
// A new key is made only when there is no file. A sealed key that won't
// decrypt is never replaced: reading throws, and keeps throwing for this run.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// On Linux, safeStorage falls back to a hard-coded password (basic_text) when
// no keyring is running; that, or an unknown backend, counts as unavailable.
const WEAK_LINUX_BACKENDS = new Set(['basic_text', 'unknown']);

function createLedgerKeyStore({ file, safeStorage, fsApi = fs, platform = process.platform }) {
  let failed = null, key = null;
  const fail = (msg) => { failed = new Error(msg); throw failed; };
  return function ledgerKey() {
    if (key) return key;
    if (failed) throw failed;
    const sealable = (() => {
      try {
        if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
        return platform !== 'linux' || !WEAK_LINUX_BACKENDS.has(safeStorage.getSelectedStorageBackend?.() ?? 'unknown');
      } catch { return false; }
    })();
    if (!sealable) fail('agent ledger key needs safeStorage, which is not available');
    let text = null;
    try { text = fsApi.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') fail(`agent ledger key unreadable (${e.code || 'error'})`); }
    if (text !== null) {
      let hex = null;
      try { const d = JSON.parse(text); hex = safeStorage.decryptString(Buffer.from(String(d.data), 'base64')); } catch { hex = null; }
      if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) fail('agent ledger key unreadable');
      return (key = Buffer.from(hex, 'hex'));
    }
    const hex = crypto.randomBytes(32).toString('hex');
    fsApi.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fsApi.writeFileSync(tmp, JSON.stringify({ v: 1, data: safeStorage.encryptString(hex).toString('base64') }), { mode: 0o600, flag: 'wx' });
    // link, not rename: a key another run made first is kept, not replaced.
    try { fsApi.linkSync(tmp, file); } catch (e) { if (e.code !== 'EEXIST') { fsApi.unlinkSync(tmp); throw e; } fsApi.unlinkSync(tmp); failed = null; return ledgerKey(); }
    fsApi.unlinkSync(tmp);
    return (key = Buffer.from(hex, 'hex'));
  };
}

module.exports = { createLedgerKeyStore };
