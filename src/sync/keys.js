// Keys for encrypted sync (W3-C). node:crypto only, audited primitives only:
// ECDH P-256, HKDF-SHA-256, AES-256-GCM, scrypt. Nothing home-made. Same
// suite as the relay envelope (src/e2e/relay-envelope.js, W2-A).
//
// Keyring. One per user, created on the first device:
//   {v, uid, rev, current, keys: {epoch: 32 random bytes}, devices: {id: pub}, recovery: pub}
// `keys` holds every content-key generation ever made (old ops stay readable);
// `current` is the one new ops are sealed with. `devices` is the set of device
// public keys this user approved, and `recovery` the recovery key's public
// half: the keyring itself says who it may be wrapped to, so a hub that lists
// a substituted key never gets the keyring wrapped to it by rotation.
//
// Wrap. The keyring sealed to one public key (ECIES): an ephemeral ECDH
// P-256 key, HKDF(shared, salt 32 random bytes, "plexiform.sync.v1|wrap") ->
// AES-256-GCM, AAD = ["plexiform.sync.wrap", 1, uid, recipient id, rev, eph].
// Format: "w1.<rev>.<eph>.<salt>.<iv>.<ct>" (base64url; rev in the clear so
// a device can skip an older wrap without opening it), opaque to the hub.
//
// Recovery code. 160 random bits in Crockford base32 (32 characters, shown
// once). It never leaves the device: scrypt(code, uid) seeds a P-256 private
// key whose public half is the keyring's `recovery`, so any device can rewrap
// to it after a rotation without knowing the code.
//
// Blob. A batch of ops: HKDF(content key of epoch e, salt 32 random bytes,
// "plexiform.sync.v1|blob") -> AES-256-GCM, AAD = ["plexiform.sync.blob", 1,
// uid, device id, e]. The hub sees the device, the epoch, the size and the time.
//
// Revocation rotates: a new content key, current = e + 1, the revoked device
// dropped from `devices`, rev + 1, rewrapped to every remaining device and the
// recovery key. The revoked device keeps what it already had, never a new key.
'use strict';

const crypto = require('crypto');

const V = 1;
const CURVE = 'prime256v1';
const B64 = /^[A-Za-z0-9_-]*$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_WRAP = 8192;
const MAX_BLOB = 512 * 1024;
const RECOVERY_BYTES = 20;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SCRYPT = Object.freeze({ N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

class SyncKeyError extends Error {
  constructor(code, message = code) { super(message); this.name = 'SyncKeyError'; this.code = code; }
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
function unb64(s, max = MAX_BLOB * 2) {
  if (typeof s !== 'string' || !B64.test(s) || s.length > max || s.length % 4 === 1) throw new SyncKeyError('malformed');
  return Buffer.from(s, 'base64url');
}
const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), 32));
const aad = (parts) => Buffer.from(JSON.stringify(parts), 'utf8');

function seal(key, plain, ad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(ad);
  return { iv, ct: Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]) };
}
function open(key, iv, ct, ad) {
  if (iv.length !== 12 || ct.length < 16) throw new SyncKeyError('malformed');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(ad);
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch { throw new SyncKeyError('decrypt'); }
}

function ecdhFrom(privB64) {
  const e = crypto.createECDH(CURVE);
  try { e.setPrivateKey(unb64(privB64, 64)); } catch { throw new SyncKeyError('bad-key'); }
  return e;
}
function shared(ecdh, pubB64) {
  try { return ecdh.computeSecret(unb64(pubB64, 200)); } catch { throw new SyncKeyError('bad-key'); }
}

/** A new device key-agreement key: {priv, pub} (base64url raw scalar / uncompressed point). */
function createDeviceKey() {
  const e = crypto.createECDH(CURVE);
  e.generateKeys();
  return { priv: b64(e.getPrivateKey()), pub: b64(e.getPublicKey(null, 'uncompressed')) };
}

/** A short human-comparable fingerprint of a public key: "ABCD-EFGH-JKMN-PQRS". */
function fingerprint(pub) {
  const h = crypto.createHash('sha256').update(unb64(pub, 200)).digest();
  return base32(h.subarray(0, 10)).match(/.{4}/g).join('-');
}

function base32(buf) {
  let bits = 0; let v = 0; let out = '';
  for (const byte of buf) {
    v = (v << 8) | byte; bits += 8;
    while (bits >= 5) { out += CROCKFORD[(v >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += CROCKFORD[(v << (5 - bits)) & 31];
  return out;
}

/** A fresh recovery code (160 bits): "XXXX-XXXX-…" (8 groups of 4). Shown once, never stored. */
function newRecoveryCode() {
  return base32(crypto.randomBytes(RECOVERY_BYTES)).match(/.{4}/g).join('-');
}

/** Code text as typed -> its 20 bytes, or throws 'bad-code'. Case, spaces and dashes are ignored; O→0, I/L→1. */
function parseRecoveryCode(text) {
  const s = String(text ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 32 || [...s].some((ch) => !CROCKFORD.includes(ch))) throw new SyncKeyError('bad-code');
  const out = Buffer.alloc(RECOVERY_BYTES);
  let bits = 0; let v = 0; let i = 0;
  for (const ch of s) {
    v = (v << 5) | CROCKFORD.indexOf(ch); bits += 5;
    if (bits >= 8) { out[i++] = (v >>> (bits - 8)) & 255; bits -= 8; }
  }
  return out;
}

/** The recovery key pair a code derives for this user: {priv, pub}. */
function recoveryKey(code, uid) {
  const bytes = parseRecoveryCode(code);
  const seed = crypto.scryptSync(bytes, `plexiform.sync.recovery.v1|${uid}`, 32, SCRYPT);
  for (let ctr = 0; ctr < 16; ctr++) {
    const d = hkdf(seed, Buffer.alloc(0), `plexiform.sync.v1|recovery|${ctr}`);
    const e = crypto.createECDH(CURVE);
    try { e.setPrivateKey(d); } catch { continue; } // d >= n: probability ~2^-32, take the next
    return { priv: b64(d), pub: b64(e.getPublicKey(null, 'uncompressed')) };
  }
  throw new SyncKeyError('bad-code');
}

/** Seal a keyring to one recipient public key. to: the device id, or 'recovery'. */
function wrapKeyring(ring, recipientPub, to) {
  const eph = crypto.createECDH(CURVE);
  eph.generateKeys();
  const epk = b64(eph.getPublicKey(null, 'uncompressed'));
  const salt = crypto.randomBytes(32);
  const key = hkdf(shared(eph, recipientPub), salt, 'plexiform.sync.v1|wrap');
  const { iv, ct } = seal(key, Buffer.from(JSON.stringify(ring), 'utf8'), aad(['plexiform.sync.wrap', V, ring.uid, to, ring.rev, epk]));
  return ['w1', String(ring.rev), epk, b64(salt), b64(iv), b64(ct)].join('.');
}

/** The revision a wrap claims (in the clear, bound in its AAD), or null. */
function wrapRev(wrap) {
  const m = typeof wrap === 'string' ? /^w1\.([1-9]\d{0,8})\./.exec(wrap) : null;
  return m ? Number(m[1]) : null;
}

/** Open a wrap with this recipient's private key; checks it names this user, recipient and revision. */
function unwrapKeyring(wrap, priv, { uid, to }) {
  if (typeof wrap !== 'string' || wrap.length > MAX_WRAP) throw new SyncKeyError('malformed');
  const parts = wrap.split('.');
  const rev = wrapRev(wrap);
  if (parts.length !== 6 || rev === null) throw new SyncKeyError('malformed');
  const [, , epk, salt, iv, ct] = parts;
  const key = hkdf(shared(ecdhFrom(priv), epk), unb64(salt, 64), 'plexiform.sync.v1|wrap');
  let ring;
  try { ring = JSON.parse(open(key, unb64(iv, 32), unb64(ct, MAX_WRAP), aad(['plexiform.sync.wrap', V, uid, to, rev, epk])).toString('utf8')); } catch (e) { if (e instanceof SyncKeyError) throw e; throw new SyncKeyError('bad-keyring'); }
  if (ring?.rev !== rev) throw new SyncKeyError('bad-keyring');
  return checkKeyring(ring, uid);
}

function checkKeyring(ring, uid) {
  const ok = ring && typeof ring === 'object' && ring.v === V && ring.uid === uid
    && Number.isSafeInteger(ring.rev) && ring.rev >= 1 && Number.isSafeInteger(ring.current) && ring.current >= 1
    && ring.keys && typeof ring.keys === 'object' && typeof ring.keys[ring.current] === 'string'
    && Object.entries(ring.keys).every(([e, k]) => /^[1-9]\d{0,8}$/.test(e) && typeof k === 'string' && unb64(k, 64).length === 32)
    && ring.devices && typeof ring.devices === 'object' && Object.entries(ring.devices).every(([id, pub]) => ID.test(id) && typeof pub === 'string')
    && typeof ring.recovery === 'string';
  if (!ok) throw new SyncKeyError('bad-keyring');
  return ring;
}


const randomKey = () => b64(crypto.randomBytes(32));

/** The first device's keyring: epoch 1, this device and the recovery key. */
function newKeyring({ uid, deviceId, devicePub, recoveryPub }) {
  if (!ID.test(String(deviceId))) throw new SyncKeyError('bad-device');
  return checkKeyring({ v: V, uid, rev: 1, current: 1, keys: { 1: randomKey() }, devices: { [deviceId]: devicePub }, recovery: recoveryPub }, uid);
}

const clone = (ring) => JSON.parse(JSON.stringify(ring));

/** Approve a device (or re-add this one after recovery): same content key, rev + 1. */
function addDevice(ring, deviceId, pub) {
  if (!ID.test(String(deviceId))) throw new SyncKeyError('bad-device');
  unb64(pub, 200);
  const next = clone(ring);
  next.devices[deviceId] = pub;
  next.rev += 1;
  return next;
}

/** A new recovery key (the old code stops working once every wrap is replaced): rev + 1. */
function setRecovery(ring, recoveryPub) {
  const next = clone(ring);
  next.recovery = recoveryPub;
  next.rev += 1;
  return next;
}

/** Revocation: a fresh content key as epoch current + 1, the device dropped, rev + 1. */
function rotate(ring, { revoke } = {}) {
  const next = clone(ring);
  if (revoke !== undefined) delete next.devices[revoke];
  next.current += 1;
  next.keys[next.current] = randomKey();
  next.rev += 1;
  return next;
}

/**
 * Merge a keyring received from the hub into the local one: the higher
 * revision wins for devices/recovery/current, and keys are the union (a key
 * once held is never dropped, so old ops stay readable). Different users throw.
 */
function mergeKeyring(local, incoming) {
  if (!local) return clone(incoming);
  if (local.uid !== incoming.uid) throw new SyncKeyError('bad-keyring');
  const win = incoming.rev > local.rev ? incoming : local;
  const lose = win === incoming ? local : incoming;
  const next = clone(win);
  for (const [e, k] of Object.entries(lose.keys)) if (!next.keys[e]) next.keys[e] = k;
  return next;
}

/** Wraps of a keyring for each device it trusts and for its recovery key. */
function wrapAll(ring) {
  const wraps = {};
  for (const [id, pub] of Object.entries(ring.devices)) wraps[id] = wrapKeyring(ring, pub, id);
  return { wraps, recovery_wrap: wrapKeyring(ring, ring.recovery, 'recovery') };
}

/** Seal one blob (bytes) with the current content key. → Buffer (the envelope JSON, utf-8). */
function sealBlob(ring, { uid, deviceId }, plain) {
  const epoch = ring.current;
  const salt = crypto.randomBytes(32);
  const key = hkdf(unb64(ring.keys[epoch], 64), salt, 'plexiform.sync.v1|blob');
  const { iv, ct } = seal(key, Buffer.from(plain), aad(['plexiform.sync.blob', V, uid, deviceId, epoch]));
  return { epoch, bytes: Buffer.from(JSON.stringify({ v: V, e: epoch, salt: b64(salt), iv: b64(iv), ct: b64(ct) }), 'utf8') };
}

/** Open a blob uploaded by deviceId. Throws 'no-key' when this keyring lacks its epoch. */
function openBlob(ring, { uid, deviceId }, bytes) {
  let env;
  try { env = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new SyncKeyError('malformed'); }
  if (!env || env.v !== V || !Number.isSafeInteger(env.e) || env.e < 1) throw new SyncKeyError('malformed');
  const k = ring.keys[env.e];
  if (typeof k !== 'string') throw new SyncKeyError('no-key');
  const key = hkdf(unb64(k, 64), unb64(env.salt, 64), 'plexiform.sync.v1|blob');
  return open(key, unb64(env.iv, 32), unb64(env.ct), aad(['plexiform.sync.blob', V, uid, deviceId, env.e]));
}

module.exports = {
  SyncKeyError, createDeviceKey, fingerprint, newRecoveryCode, parseRecoveryCode, recoveryKey,
  wrapKeyring, unwrapKeyring, wrapRev, newKeyring, addDevice, setRecovery, rotate, mergeKeyring, checkKeyring, wrapAll,
  sealBlob, openBlob, MAX_WRAP, MAX_BLOB,
};
