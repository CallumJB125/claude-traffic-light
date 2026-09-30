// Sealed connector secrets (D41). AES-256-GCM under a key that never lives in
// the hub DB: backups copy the DB, so a key stored beside its ciphertext would
// protect nothing. The key comes from BOARD_ENC_KEY (base64/hex, 32 bytes), a
// keyfile outside the data dir, or (local mode) the desktop app over
// parentPort. No key → no connections.
//
// AAD binds each ciphertext to its row (connection id, kind, key id), so a
// sealed value can't be copied into another row and decrypt there.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFileSync, statSync, realpathSync, existsSync } from 'node:fs';
import { dirname, basename, join, sep } from 'node:path';
import { HubError } from './db.js';

const KEY_BYTES = 32;
const TAG_BYTES = 16;

// Hex (64 chars) or canonical base64 (43 chars + '='): Buffer.from(…, 'base64')
// silently skips junk, so anything else is refused rather than half-decoded.
function decodeKey(text) {
  const t = String(text ?? '').trim();
  let buf = null;
  if (/^[0-9a-f]{64}$/i.test(t)) buf = Buffer.from(t, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=$/.test(t)) buf = Buffer.from(t, 'base64');
  if (!buf || buf.length !== KEY_BYTES) throw new Error(`encryption key must be ${KEY_BYTES} bytes (hex or base64)`);
  return buf;
}

// Short, non-secret id: lets rows name the key they were sealed with.
export const keyIdOf = (key) => createHash('sha256').update('board-vault-key-id').update(key).digest('hex').slice(0, 12);

// Resolve symlinks and `..` so a keyfile can't sneak into the data dir; a
// path that doesn't exist yet resolves through its parent.
function real(p) {
  if (existsSync(p)) return realpathSync(p);
  const parent = dirname(p);
  return parent === p ? p : join(real(parent), basename(p));
}

/**
 * loadKey({env, dataDir, hasParentPort}) → Buffer | null
 * A keyfile inside the data dir is refused: it would ride along in backups.
 * Under the desktop app (parentPort) the key only ever arrives over
 * parentPort (hub.setVaultKey), never from env. A key read from env is
 * removed from it, so nothing started later can see it.
 */
export function loadKey({ env = process.env, dataDir = null, hasParentPort = !!process.parentPort } = {}) {
  if ((env.BOARD_ENC_KEY || env.BOARD_ENC_KEY_FILE) && hasParentPort) {
    throw new Error('BOARD_ENC_KEY(_FILE) is refused under the desktop app: the key comes over parentPort');
  }
  if (env.BOARD_ENC_KEY) {
    const key = decodeKey(env.BOARD_ENC_KEY);
    delete env.BOARD_ENC_KEY;
    return key;
  }
  if (env.BOARD_ENC_KEY_FILE) {
    const file = real(env.BOARD_ENC_KEY_FILE);
    if (dataDir) {
      const dir = real(dataDir);
      if (file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep)) {
        throw new Error('BOARD_ENC_KEY_FILE must live outside BOARD_DATA_DIR (backups copy the data dir)');
      }
    }
    const mode = statSync(file).mode & 0o077;
    if (mode) throw new Error('BOARD_ENC_KEY_FILE must not be readable by group or others (chmod 600)');
    return decodeKey(readFileSync(file, 'utf8'));
  }
  return null;
}

export function createVault(key) {
  const keyBuf = key ? Buffer.from(key) : null;
  if (keyBuf && keyBuf.length !== KEY_BYTES) throw new Error(`encryption key must be ${KEY_BYTES} bytes`);
  const keyId = keyBuf ? keyIdOf(keyBuf) : null;
  const aad = (connectionId, kind, kid) => Buffer.from(`${connectionId}|${kind}|${kid}`, 'utf8');
  const need = () => {
    if (!keyBuf) throw new HubError('POLICY_DENIED', 'integrations need an encryption key (BOARD_ENC_KEY) on this hub');
  };

  return {
    available: !!keyBuf,
    keyId,
    seal(connectionId, kind, plaintext) {
      need();
      const nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', keyBuf, nonce);
      c.setAAD(aad(connectionId, kind, keyId));
      const body = Buffer.concat([c.update(Buffer.from(String(plaintext), 'utf8')), c.final()]);
      return { key_id: keyId, nonce, ciphertext: Buffer.concat([body, c.getAuthTag()]) };
    },
    open(connectionId, kind, row) {
      need();
      if (!row) return null;
      if (row.key_id !== keyId) {
        throw new HubError('INTERNAL', 'secret was sealed with a different key (rotate/re-seal needed)');
      }
      const ct = Buffer.from(row.ciphertext);
      if (ct.length < TAG_BYTES) throw new HubError('INTERNAL', 'sealed secret is truncated');
      const d = createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(row.nonce), { authTagLength: TAG_BYTES });
      d.setAAD(aad(connectionId, kind, row.key_id));
      d.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
      return Buffer.concat([d.update(ct.subarray(0, ct.length - TAG_BYTES)), d.final()]).toString('utf8');
    },
  };
}
