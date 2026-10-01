// The trust check for every update: pure functions over bytes, no I/O.
//
// A release publishes release.json and release.json.sig (Ed25519 over the
// exact bytes of release.json, base64). Each channel has its own key: the
// private halves exist only as secrets of the GitHub `release` environment;
// the public halves ship in the app (build/update-key.pub.pem for stable,
// build/update-key-beta.pub.pem for beta). A download is installed only if:
//   - the signature verifies with a key of the channel this install follows,
//     and the manifest says that same channel (a beta key never opens a
//     stable manifest, and the reverse)
//   - product matches
//   - the version is newer, unless the manifest is a signed rollback that
//     names this version in rollbackFrom, or the person explicitly asked to
//     revert to exactly that version
//   - issuedAt is not older than the floor: the last manifest this channel
//     accepted, or this build's own build time, whichever is later (stops a
//     replay of an old signed manifest, also on a fresh install)
//   - issuedAt is not more than a day in the future, and a rollback has not
//     passed its expiresAt
//   - the file's size and sha512 equal the signed entry
// scripts/release-sign.js writes the same format; its tests round-trip here.
const crypto = require('crypto');

const PRODUCT = 'plexiform';
const CHANNELS = ['stable', 'beta'];
const KINDS = ['nsis', 'appimage', 'deb', 'mac-zip', 'dmg'];
const PLATFORMS = ['darwin', 'win32', 'linux'];
const ARCHES = ['x64', 'arm64', 'universal'];
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
// A bare file name: it becomes a URL path segment and a file on disk.
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_NOTES = 20000;
const MAX_ROLLBACK_FROM = 50;
const DAY_MS = 24 * 3600000;
// How far ahead of this machine's clock a manifest may say it was issued.
const MAX_CLOCK_SKEW_MS = DAY_MS;
const isDate = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s));

class UpdateError extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
    this.detail = detail;
  }
}
const fail = (code, detail) => { throw new UpdateError(code, detail); };

function parseVersion(v) {
  const m = typeof v === 'string' && VERSION.exec(v);
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
}

// semver precedence: 1.0.0-beta.2 < 1.0.0-beta.10 < 1.0.0 < 1.0.1
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new UpdateError('verify', `not a version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : (pa.pre.length ? -1 : 1);
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return +x < +y ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// PEM strings → Ed25519 KeyObjects. More than one allows a key rotation.
function loadKeys(pems) {
  const keys = pems.map((pem) => crypto.createPublicKey(pem));
  for (const k of keys) if (k.asymmetricKeyType !== 'ed25519') throw new Error(`update key is ${k.asymmetricKeyType}, not ed25519`);
  if (!keys.length) throw new Error('no update key');
  return keys;
}

// { stable: [pem], beta: [pem] } → { stable: [KeyObject], beta: [KeyObject] }.
// A channel with no key opens nothing (fails closed).
function loadKeyring(pemsByChannel) {
  const ring = {};
  for (const ch of CHANNELS) {
    const pems = pemsByChannel?.[ch] || [];
    ring[ch] = pems.length ? loadKeys(pems) : [];
  }
  return ring;
}

function verifySignature(bytes, sigB64, keys) {
  const sig = Buffer.from(String(sigB64 || '').trim(), 'base64');
  if (sig.length !== 64) return false;
  return keys.some((k) => { try { return crypto.verify(null, bytes, k, sig); } catch { return false; } });
}

function validateManifest(m) {
  const bad = (what) => fail('verify', `release.json: ${what}`);
  if (!m || typeof m !== 'object' || Array.isArray(m)) bad('not an object');
  if (typeof m.product !== 'string') bad('no product');
  if (!CHANNELS.includes(m.channel)) bad('unknown channel');
  if (!parseVersion(m.version)) bad('bad version');
  if (!isDate(m.issuedAt)) bad('bad issuedAt');
  if (!isDate(m.expiresAt) || Date.parse(m.expiresAt) <= Date.parse(m.issuedAt)) bad('bad expiresAt');
  if (typeof m.rollback !== 'boolean') bad('bad rollback flag');
  if (m.rollback) {
    const from = m.rollbackFrom;
    if (!Array.isArray(from) || !from.length || from.length > MAX_ROLLBACK_FROM) bad('a rollback must name the versions it rolls back from');
    for (const v of from) if (!parseVersion(v) || compareVersions(v, m.version) <= 0) bad(`bad rollbackFrom version ${JSON.stringify(v)}`);
  } else if (m.rollbackFrom !== undefined) bad('rollbackFrom on a manifest that is not a rollback');
  if (m.notes != null && (typeof m.notes !== 'string' || m.notes.length > MAX_NOTES)) bad('bad notes');
  if (!Array.isArray(m.files) || !m.files.length) bad('no files');
  const names = new Set();
  for (const f of m.files) {
    if (!f || typeof f !== 'object') bad('bad file entry');
    if (typeof f.name !== 'string' || !FILE_NAME.test(f.name)) bad(`bad file name ${JSON.stringify(f.name)}`);
    if (names.has(f.name)) bad(`duplicate file ${f.name}`);
    names.add(f.name);
    if (typeof f.sha512 !== 'string' || !SHA512_B64.test(f.sha512)) bad(`bad sha512 for ${f.name}`);
    if (!Number.isSafeInteger(f.size) || f.size <= 0) bad(`bad size for ${f.name}`);
    if (!PLATFORMS.includes(f.platform)) bad(`bad platform for ${f.name}`);
    if (!ARCHES.includes(f.arch)) bad(`bad arch for ${f.name}`);
    if (!KINDS.includes(f.kind)) bad(`bad kind for ${f.name}`);
  }
  return m;
}

/**
 * Signature (with the channel's own keys only), then shape, then product and
 * channel. Returns the parsed manifest.
 * bytes: Buffer of release.json exactly as served; sig: the .sig text;
 * keyring: loadKeyring(); channel: the channel this install follows.
 */
function openManifest(bytes, sig, keyring, { channel, product = PRODUCT } = {}) {
  if (!CHANNELS.includes(channel)) throw new Error(`openManifest: channel must be one of ${CHANNELS.join(', ')}`);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MANIFEST_BYTES) fail('verify', 'release.json is missing or too large');
  if (!verifySignature(bytes, sig, keyring?.[channel] || [])) fail('signature', `release.json is not signed with Plexiform's ${channel} key`);
  let m;
  try { m = JSON.parse(bytes.toString('utf8')); } catch { fail('verify', 'release.json is not JSON'); }
  validateManifest(m);
  if (m.product !== product) fail('verify', `release.json is for ${m.product}, not ${product}`);
  if (m.channel !== channel) fail('verify', `release.json is for the ${m.channel} channel, not ${channel}`);
  return m;
}

const later = (a, b) => (!a ? b || null : !b ? a : (Date.parse(a) >= Date.parse(b) ? a : b));

/**
 * Whether this signed manifest may be offered to this install.
 * → { update: false, expired } when it is the running version, else
 *   { update: true, rollback, expired }. expired: past expiresAt, so the feed
 *   may be frozen on an old release (the caller says so; it is not a refusal).
 * Throws UpdateError('downgrade' | 'verify' | 'expired') when it must be refused.
 *   lastIssuedAt: the newest issuedAt this channel accepted (null: none yet)
 *   builtAt: when this build was made (build/release-floor.json; null in dev)
 *   revertTo: the version the person explicitly asked to go back to (skips the
 *   downgrade, replay and expiry rules for exactly that version and nothing else)
 */
function decide(m, { channel, currentVersion, lastIssuedAt = null, builtAt = null, revertTo = null, now = Date.now() }) {
  if (m.channel !== channel) fail('verify', `release.json is for the ${m.channel} channel, not ${channel}`);
  const issued = Date.parse(m.issuedAt);
  if (issued > now + MAX_CLOCK_SKEW_MS) fail('verify', `release.json says it was issued ${m.issuedAt}, in the future (check this computer's clock)`);
  if (revertTo) {
    if (m.version !== revertTo) fail('verify', `asked to revert to ${revertTo}, the server offered ${m.version}`);
    return { update: true, rollback: true, expired: false };
  }
  const floor = later(lastIssuedAt, builtAt);
  if (floor && issued < Date.parse(floor)) {
    fail('verify', `release.json was issued ${m.issuedAt}, before ${floor === lastIssuedAt ? 'one already seen' : 'this version was built'} (${floor}): an old release replayed`);
  }
  const expired = now > Date.parse(m.expiresAt);
  const cmp = compareVersions(m.version, currentVersion);
  if (cmp === 0) return { update: false, expired };
  if (cmp < 0) {
    if (!m.rollback) fail('downgrade', `the server offers ${m.version}, older than ${currentVersion}, and it is not a signed rollback`);
    if (!m.rollbackFrom.includes(currentVersion)) fail('downgrade', `the rollback to ${m.version} is for ${m.rollbackFrom.join(', ')}, not ${currentVersion}`);
    // A rollback signed at or before this build was made cannot be meant for it.
    if (builtAt && issued <= Date.parse(builtAt)) fail('verify', `the rollback to ${m.version} was issued ${m.issuedAt}, before this version was built (${builtAt})`);
    if (expired) fail('expired', `the rollback to ${m.version} expired ${m.expiresAt}`);
  }
  return { update: true, rollback: cmp < 0, expired };
}

// The installer for this machine, or null.
function pickFile(m, { platform, arch, kind }) {
  const mine = m.files.filter((f) => f.platform === platform && f.kind === kind);
  return mine.find((f) => f.arch === arch) || mine.find((f) => f.arch === 'universal') || null;
}

// Stream-friendly: pass a Hash you updated yourself, or a whole Buffer.
function sha512Base64(buf) {
  return crypto.createHash('sha512').update(buf).digest('base64');
}

function checkFile(entry, { size, sha512 }) {
  if (size !== entry.size) fail('verify', `${entry.name}: ${size} bytes, the release says ${entry.size}`);
  if (sha512 !== entry.sha512) fail('verify', `${entry.name}: checksum does not match the signed release`);
}

/**
 * electron-updater's update-available info against the signed manifest,
 * before downloadUpdate(). Every file it would fetch must be in the manifest
 * with the same sha512 (and size when it gives one), and the versions agree.
 */
function checkUpdateInfo(info, m, { base = null } = {}) {
  if (!info || typeof info !== 'object') fail('verify', 'no update info');
  if (info.version !== m.version) fail('verify', `the feed offers ${info.version}, the signed release is ${m.version}`);
  // NSIS web-installer packages are fetched from their own URLs and not in the manifest.
  if (info.packages != null) fail('verify', 'the feed names installer packages, which the signed release does not cover');
  const files = Array.isArray(info.files) ? info.files : [];
  if (!files.length) fail('verify', 'the feed names no files');
  const origin = base ? new URL(base).origin : null;
  const sameOrigin = (u) => { try { return new URL(u, base).origin === origin; } catch { return false; } };
  if (origin && info.path != null && !sameOrigin(String(info.path))) fail('verify', 'the feed points at another server');
  const byName = new Map(m.files.map((f) => [f.name, f]));
  for (const f of files) {
    if (origin && !sameOrigin(String(f?.url || ''))) fail('verify', 'the feed points at another server');
    const name = String(f?.url || '').split(/[?#]/)[0].split('/').pop();
    let decoded = name;
    try { decoded = decodeURIComponent(name); } catch { /* keep as is */ }
    const signed = byName.get(decoded);
    if (!signed) fail('verify', `the feed names ${decoded}, which is not in the signed release`);
    if (f.sha512 !== signed.sha512) fail('verify', `${decoded}: the feed's checksum does not match the signed release`);
    if (f.size != null && f.size !== signed.size) fail('verify', `${decoded}: the feed's size does not match the signed release`);
  }
  if (info.sha512 && !files.some((f) => f.sha512 === info.sha512)) fail('verify', 'the feed\'s top-level checksum is not one of its files');
  return true;
}

module.exports = {
  PRODUCT, CHANNELS, KINDS, PLATFORMS, ARCHES, UpdateError, DAY_MS,
  parseVersion, compareVersions, loadKeys, loadKeyring, verifySignature, validateManifest, openManifest, decide, pickFile, sha512Base64, checkFile, checkUpdateInfo,
};
