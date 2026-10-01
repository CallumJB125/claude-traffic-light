// The trust check for the plugin catalogue: pure functions over bytes, plus
// one loader for the copy bundled in the app. Modelled on src/updater/verify.js.
//
// A catalogue is catalog.json plus catalog.json.sig, a detached Ed25519
// signature over the exact bytes: {"alg":"ed25519","keyId":"<16 hex>","sig":"<base64>"}
// (catalog/src/sign.js writes it). It is "verified" only if:
//   - it is no larger than MAX_CATALOG_BYTES
//   - the signature verifies, BEFORE the bytes are parsed, with a key pinned
//     in build/catalog-key.pub.pem (or build/catalog-key-next.pub.pem, for a
//     rotation) whose keyId the .sig names. Keys come from nowhere else, and
//     the dev key in catalog/keys/ is refused even if someone pins it.
//   - schemaVersion is supported and the whole file passes the schema
//     (a copy of catalog/'s validator and schema; the app never imports catalog/)
//   - generatedAt is not older than the floor (the bundled snapshot's), and
//     not more than a day in the future
// Anything else is "unverified". There is no production key yet, so today the
// bundled snapshot is always unverified: browse-only, and canInstall() is false
// (fail closed). Every string in a catalogue is untrusted: render with
// textContent only, and never exec install[].steps.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validate } = require('./schema-check');
const SCHEMA = require('./catalog.schema.json');

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_SIG_BYTES = 1024;
const SUPPORTED_SCHEMA_VERSIONS = [1];
const DAY_MS = 24 * 3600000;
const MAX_CLOCK_SKEW_MS = DAY_MS;
const BUILD_DIR = path.join(__dirname, '..', '..', 'build');
const KEY_FILES = ['catalog-key.pub.pem', 'catalog-key-next.pub.pem'];
const BUNDLED_DIR = path.join(BUILD_DIR, 'plugin-catalog');
// The dev signing key's id (catalog/keys/catalog-ed25519.pub.pem). Never trusted.
const DEV_KEY_IDS = new Set(['28c56176d52e3aad']);
const KEY_ID = /^[0-9a-f]{16}$/;
const MAX_QUERY = 200;

const isDate = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s));

// sha256 of the SPKI DER, first 16 hex: the same id catalog/src/sign.js writes.
function keyId(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/**
 * PEM strings → [{ keyId, key }]. Throws on a key that is not Ed25519.
 * The dev key is dropped, so pinning it by mistake trusts nothing.
 */
function keysFromPems(pems) {
  const out = [];
  for (const pem of pems) {
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`catalogue key is ${key.asymmetricKeyType}, not ed25519`);
    const id = keyId(key);
    if (!DEV_KEY_IDS.has(id)) out.push({ keyId: id, key });
  }
  return out;
}

/**
 * The pinned keys: only build/catalog-key.pub.pem and build/catalog-key-next.pub.pem.
 * A missing file is skipped; none at all → [] (nothing verifies).
 */
function loadPinnedKeys({ dir = BUILD_DIR, readFile = fs.readFileSync } = {}) {
  const pems = [];
  for (const name of KEY_FILES) {
    let pem;
    try { pem = readFile(path.join(dir, name), 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    pems.push(pem);
  }
  return keysFromPems(pems);
}

// null when the signature is good, else why not.
function checkSignature(bytes, sigText, keys) {
  if (!Array.isArray(keys) || !keys.length) return 'no-pinned-key';
  if (sigText == null) return 'unsigned';
  const text = Buffer.isBuffer(sigText) ? sigText.toString('utf8') : String(sigText);
  if (text.length > MAX_SIG_BYTES) return 'bad-signature-file';
  let s;
  try { s = JSON.parse(text); } catch { return 'bad-signature-file'; }
  if (!s || typeof s !== 'object' || s.alg !== 'ed25519' || typeof s.keyId !== 'string' || !KEY_ID.test(s.keyId) || typeof s.sig !== 'string') return 'bad-signature-file';
  if (DEV_KEY_IDS.has(s.keyId)) return 'dev-key';
  const pinned = keys.find((k) => k.keyId === s.keyId);
  if (!pinned) return 'unknown-key';
  const sig = Buffer.from(s.sig, 'base64');
  if (sig.length !== 64) return 'bad-signature';
  try { return crypto.verify(null, bytes, pinned.key, sig) ? null : 'bad-signature'; } catch { return 'bad-signature'; }
}

const refuse = (reason, detail) => ({ status: 'unverified', catalog: null, reason, ...(detail ? { detail } : {}) });

/**
 * bytes: Buffer of catalog.json exactly as read; sigText: the .sig text (null if none);
 * keys: loadPinnedKeys(); floor: the bundled snapshot's generatedAt (null for the snapshot itself).
 * allowUnverified: parse and return a catalogue whose signature did not verify, for browsing
 * only. For the copy bundled inside the app; a downloaded catalogue must leave it false,
 * so an unverified download is never parsed.
 * → { status: 'verified' | 'unverified', catalog, reason } (reason null when verified;
 *   catalog null when it must not be used at all).
 */
function openCatalog(bytes, sigText, { keys = [], floor = null, now = Date.now(), allowUnverified = false } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return refuse('missing');
  if (bytes.length > MAX_CATALOG_BYTES) return refuse('too-large', `${bytes.length} bytes, the limit is ${MAX_CATALOG_BYTES}`);
  const sigProblem = checkSignature(bytes, sigText, keys);
  if (sigProblem && !allowUnverified) return refuse(sigProblem);
  let c;
  try { c = JSON.parse(bytes.toString('utf8')); } catch { return refuse('not-json'); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return refuse('not-json');
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(c.schemaVersion)) return refuse('unsupported-schema', `schemaVersion ${JSON.stringify(c.schemaVersion)}`);
  const errors = validate(SCHEMA, c);
  if (errors.length) return refuse('schema', errors.slice(0, 5).join('; '));
  if (!isDate(c.generatedAt)) return refuse('schema', 'bad generatedAt');
  const at = Date.parse(c.generatedAt);
  if (at > now + MAX_CLOCK_SKEW_MS) return refuse('from-the-future', `generated ${c.generatedAt}`);
  if (floor != null && (!isDate(floor) || at < Date.parse(floor))) return refuse('replayed', `generated ${c.generatedAt}, before ${floor}`);
  return { status: sigProblem ? 'unverified' : 'verified', catalog: c, reason: sigProblem };
}

/**
 * The snapshot that ships with the app: build/plugin-catalog/catalog.json (+ .sig when it
 * has been signed with the production key). Unsigned or unverifiable → browse-only.
 */
function loadBundled({ dir = BUNDLED_DIR, keysDir = BUILD_DIR, now = Date.now(), readFile = fs.readFileSync } = {}) {
  let bytes, sig = null, keys;
  try { bytes = readFile(path.join(dir, 'catalog.json')); } catch { return refuse('missing'); }
  try { sig = readFile(path.join(dir, 'catalog.json.sig'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return refuse('bad-signature-file'); }
  try { keys = loadPinnedKeys({ dir: keysDir, readFile }); } catch { keys = []; }
  return openCatalog(bytes, sig, { keys, floor: null, now, allowUnverified: true });
}

// Installs need a verified catalogue. Unverified (today: always) is browse-only.
function canInstall(result) {
  return !!result && result.status === 'verified' && result.reason == null && !!result.catalog;
}

const oneOf = (want, v) => want == null || (Array.isArray(want) ? (!want.length || want.includes(v)) : want === v);
const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');

// score.rank (percentile within the type) first, then total, then name and id, so the order never depends on input order.
function compareEntries(a, b) {
  const ra = Number.isFinite(a.score?.rank) ? a.score.rank : -1;
  const rb = Number.isFinite(b.score?.rank) ? b.score.rank : -1;
  if (ra !== rb) return rb - ra;
  const ta = Number.isFinite(a.score?.total) ? a.score.total : -1;
  const tb = Number.isFinite(b.score?.total) ? b.score.total : -1;
  if (ta !== tb) return tb - ta;
  const na = lower(a.name), nb = lower(b.name);
  if (na !== nb) return na < nb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Filter and sort a catalogue's entries. Every filter is optional.
 *   q: words that must all appear in the name, display name, description or tags (any case)
 *   tags: tags the entry must all have; type, trust, level (security level): a value or a list
 *   os: 'macos' | 'linux' | 'windows'; entries that do not state an OS are kept
 * → a new array of the catalogue's entry objects, best first.
 */
function search(catalog, { q = '', tags = [], type = null, trust = null, level = null, os = null } = {}) {
  const terms = lower(String(q || '').slice(0, MAX_QUERY)).split(/\s+/).filter(Boolean);
  const wantTags = (Array.isArray(tags) ? tags : [tags]).map(lower).filter(Boolean);
  const out = (catalog?.entries || []).filter((e) => {
    if (!oneOf(type, e.type) || !oneOf(trust, e.trust) || !oneOf(level, e.security?.level)) return false;
    if (os && Array.isArray(e.requires?.os) && !e.requires.os.includes(os)) return false;
    const entryTags = (e.tags || []).map(lower);
    if (wantTags.some((t) => !entryTags.includes(t))) return false;
    if (terms.length) {
      const hay = [e.name, e.displayName, e.description, ...entryTags].map(lower).join('\n');
      if (terms.some((t) => !hay.includes(t))) return false;
    }
    return true;
  });
  return out.sort(compareEntries);
}

module.exports = {
  MAX_CATALOG_BYTES, SUPPORTED_SCHEMA_VERSIONS, KEY_FILES, BUILD_DIR, BUNDLED_DIR, DEV_KEY_IDS,
  keyId, keysFromPems, loadPinnedKeys, checkSignature, openCatalog, loadBundled, canInstall, search, compareEntries,
};
