// The per-install secret the approval counter keys its HMACs with
// (src/approval-nudge.js), kept encrypted by safeStorage (the OS keychain)
// where it can be, otherwise as a random salt in a 0600 file.
// A new secret is made only when there is no file or it isn't JSON. A sealed
// secret that won't decrypt is never swapped for an unsealed one: reading
// throws (counting is skipped), and keeps throwing for this run.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createSecretStore({ file, safeStorage, log = () => {} }) {
  let failed = null;
  return function secret() {
    if (failed) throw failed;
    let d = null;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { d = null; }
    if (d && typeof d === 'object') {
      let hex = null;
      try { hex = d.sealed ? safeStorage.decryptString(Buffer.from(String(d.data), 'base64')) : String(d.data); } catch { hex = null; }
      if (typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
      failed = new Error('approval counter secret unreadable: not counting this run');
      log(failed.message);
      throw failed;
    }
    const sealable = (() => { try { return !!safeStorage && safeStorage.isEncryptionAvailable(); } catch { return false; } })();
    const hex = crypto.randomBytes(32).toString('hex');
    const out = sealable ? { v: 1, sealed: true, data: safeStorage.encryptString(hex).toString('base64') } : { v: 1, sealed: false, data: hex };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A temp file then rename: a crash mid-write can't leave invalid JSON (which would reset the counts), and the secret is never readable at another mode.
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    return Buffer.from(hex, 'hex');
  };
}

module.exports = { createSecretStore };
