// src/plugins/catalog-load.js: signature, pinned key, schema and replay checks on the plugin
// catalogue, fail-closed install gating, and search. Temp keys and temp dirs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/plugins/catalog-load.js');

const ROOT = path.join(__dirname, '..');
const BUNDLED = path.join(ROOT, 'build', 'plugin-catalog', 'catalog.json');
const SNAP_BYTES = fs.readFileSync(BUNDLED);
const SNAP = JSON.parse(SNAP_BYTES.toString('utf8'));
const NOW = Date.parse(SNAP.generatedAt) + 3600000;
// Public half of the dev key (as in test/catalog-dev-key.test.js).
const DEV_SPKI = 'MCowBQYDK2VwAyEAdbTdafsJzmNJGPig+DFihbepWtZdhIb3z88ZSaTHPAM=';
const DEV_PEM = crypto.createPublicKey({ key: Buffer.from(DEV_SPKI, 'base64'), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' });

const pem = (k) => k.export({ type: 'spki', format: 'pem' });
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const KEYS = L.keysFromPems([pem(publicKey)]);
const sigFor = (bytes, key = privateKey) => JSON.stringify({ alg: 'ed25519', keyId: L.keyId(crypto.createPublicKey(key)), sig: crypto.sign(null, bytes, key).toString('base64') });
const bytesOf = (over) => Buffer.from(JSON.stringify({ ...SNAP, ...over }));
const open = (bytes, sig, opts = {}) => L.openCatalog(bytes, sig, { keys: KEYS, now: NOW, ...opts });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-catalog-'));

test('a good signature from a pinned key verifies, and only then may install', () => {
  const r = open(SNAP_BYTES, sigFor(SNAP_BYTES), { floor: SNAP.generatedAt });
  assert.equal(r.status, 'verified');
  assert.equal(r.reason, null);
  assert.equal(r.catalog.entries.length, SNAP.entries.length);
  assert.equal(L.canInstall(r), true);
});

test('a bad signature, another key, or a wrong keyId is refused before parsing', () => {
  const bad = JSON.parse(sigFor(SNAP_BYTES));
  bad.sig = crypto.sign(null, Buffer.from('something else'), privateKey).toString('base64');
  assert.deepEqual(open(SNAP_BYTES, JSON.stringify(bad)), { status: 'unverified', catalog: null, reason: 'bad-signature' });
  assert.equal(open(SNAP_BYTES, sigFor(SNAP_BYTES, other.privateKey)).reason, 'unknown-key');
  const relabelled = { ...JSON.parse(sigFor(SNAP_BYTES, other.privateKey)), keyId: KEYS[0].keyId };
  assert.equal(open(SNAP_BYTES, JSON.stringify(relabelled)).reason, 'bad-signature');
  for (const s of ['not json', '{}', JSON.stringify({ alg: 'rsa', keyId: KEYS[0].keyId, sig: 'x' }), JSON.stringify({ alg: 'ed25519', keyId: 'zz', sig: 'x' }), 'x'.repeat(2000)]) {
    assert.equal(open(SNAP_BYTES, s).reason, 'bad-signature-file', s.slice(0, 40));
  }
  assert.equal(open(SNAP_BYTES, null).reason, 'unsigned');
});

test('nothing is parsed when the signature fails and allowUnverified is off', (t) => {
  const parse = t.mock.method(JSON, 'parse');
  const r = open(Buffer.from('{"schemaVersion":1}'), null);
  assert.equal(r.catalog, null);
  assert.equal(parse.mock.calls.length, 0);
});

test('one tampered byte fails verification', () => {
  const sig = sigFor(SNAP_BYTES);
  const tampered = Buffer.from(SNAP_BYTES.toString('utf8').replace('"official":true', '"official":false'));
  assert.equal(open(tampered, sig).reason, 'bad-signature');
  const flipped = Buffer.from(SNAP_BYTES);
  flipped[flipped.length >> 1] ^= 1;
  assert.equal(open(flipped, sig).status, 'unverified');
});

test('replay floor: an older generatedAt is refused, even when properly signed', () => {
  const old = bytesOf({ generatedAt: new Date(Date.parse(SNAP.generatedAt) - 1000).toISOString() });
  assert.equal(open(old, sigFor(old), { floor: SNAP.generatedAt }).reason, 'replayed');
  assert.equal(open(SNAP_BYTES, sigFor(SNAP_BYTES), { floor: 'not a date' }).reason, 'replayed');
  const newer = bytesOf({ generatedAt: new Date(NOW).toISOString() });
  assert.equal(open(newer, sigFor(newer), { floor: SNAP.generatedAt }).status, 'verified');
});

test('more than a day in the future is refused', () => {
  const ahead = bytesOf({ generatedAt: new Date(NOW + 25 * 3600000).toISOString() });
  assert.equal(open(ahead, sigFor(ahead)).reason, 'from-the-future');
  const skew = bytesOf({ generatedAt: new Date(NOW + 23 * 3600000).toISOString() });
  assert.equal(open(skew, sigFor(skew)).status, 'verified');
});

test('oversized or empty input is refused without verifying or parsing', () => {
  const big = Buffer.alloc(L.MAX_CATALOG_BYTES + 1, 0x20);
  assert.equal(open(big, sigFor(big)).reason, 'too-large');
  assert.equal(open(Buffer.alloc(0), null).reason, 'missing');
  assert.equal(open('a string', null).reason, 'missing');
});

test('schema violations and unsupported versions are refused, even when properly signed', () => {
  const v2 = bytesOf({ schemaVersion: 2 });
  assert.equal(open(v2, sigFor(v2)).reason, 'unsupported-schema');
  const extra = bytesOf({ surprise: true });
  assert.equal(open(extra, sigFor(extra)).reason, 'schema');
  const entries = SNAP.entries.map((e, i) => (i === 0 ? { ...e, type: 'virus' } : e));
  const badEntry = bytesOf({ entries });
  const r = open(badEntry, sigFor(badEntry));
  assert.equal(r.reason, 'schema');
  assert.match(r.detail, /entries\[0\]\.type/);
  const proto = Buffer.from(JSON.stringify({ ...SNAP, constructor: 1 }));
  assert.equal(open(proto, sigFor(proto)).reason, 'schema');
  const arr = Buffer.from('[1]');
  assert.equal(open(arr, sigFor(arr)).reason, 'not-json');
});

test('no pinned key: unverified, browse-only, canInstall false', () => {
  const dir = tmp();
  assert.deepEqual(L.loadPinnedKeys({ dir }), []);
  const r = L.openCatalog(SNAP_BYTES, sigFor(SNAP_BYTES), { keys: L.loadPinnedKeys({ dir }), now: NOW });
  assert.equal(r.status, 'unverified');
  assert.equal(r.reason, 'no-pinned-key');
  assert.equal(r.catalog, null, 'not parsed without allowUnverified');
  const browse = L.openCatalog(SNAP_BYTES, sigFor(SNAP_BYTES), { keys: [], now: NOW, allowUnverified: true });
  assert.equal(browse.status, 'unverified');
  assert.ok(browse.catalog.entries.length > 0);
  assert.equal(L.canInstall(browse), false);
  for (const r2 of [null, undefined, {}, { status: 'unverified', catalog: SNAP, reason: 'unsigned' }, { status: 'verified', catalog: null, reason: null }]) assert.equal(L.canInstall(r2), false);
});

test('pinned keys come only from build/catalog-key.pub.pem and build/catalog-key-next.pub.pem', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'catalog-ed25519.pub.pem'), pem(publicKey));
  fs.writeFileSync(path.join(dir, 'update-key.pub.pem'), pem(publicKey));
  assert.deepEqual(L.loadPinnedKeys({ dir }), [], 'other names are ignored');
  fs.writeFileSync(path.join(dir, 'catalog-key.pub.pem'), pem(publicKey));
  fs.writeFileSync(path.join(dir, 'catalog-key-next.pub.pem'), pem(other.publicKey));
  const keys = L.loadPinnedKeys({ dir });
  assert.deepEqual(keys.map((k) => k.keyId), [L.keyId(publicKey), L.keyId(other.publicKey)]);
  assert.equal(L.openCatalog(SNAP_BYTES, sigFor(SNAP_BYTES, other.privateKey), { keys, now: NOW }).status, 'verified', 'the next key verifies, for a rotation');
  fs.writeFileSync(path.join(dir, 'catalog-key.pub.pem'), pem(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey));
  assert.throws(() => L.loadPinnedKeys({ dir }), /not ed25519/);
  assert.deepEqual(L.KEY_FILES, ['catalog-key.pub.pem', 'catalog-key-next.pub.pem']);
  assert.equal(L.BUILD_DIR, path.join(ROOT, 'build'));
});

test('the dev key is never trusted: not from build/, not if pinned by mistake, not by keyId', () => {
  assert.ok(!L.loadPinnedKeys().some((k) => L.DEV_KEY_IDS.has(k.keyId)), 'build/ pins no dev key');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'catalog-key.pub.pem'), DEV_PEM);
  assert.deepEqual(L.loadPinnedKeys({ dir }), [], 'pinning the dev key trusts nothing');
  const devSig = JSON.stringify({ alg: 'ed25519', keyId: [...L.DEV_KEY_IDS][0], sig: Buffer.alloc(64).toString('base64') });
  assert.equal(open(SNAP_BYTES, devSig).reason, 'dev-key');
  const devKeyObj = { keyId: [...L.DEV_KEY_IDS][0], key: crypto.createPublicKey(DEV_PEM) };
  assert.equal(L.openCatalog(SNAP_BYTES, devSig, { keys: [devKeyObj], now: NOW }).reason, 'dev-key', 'even if smuggled into the keys');
});

test('the bundled snapshot loads as unverified and browse-only until the production key exists', () => {
  const r = L.loadBundled({ now: NOW });
  assert.equal(r.status, 'unverified');
  assert.ok(['no-pinned-key', 'unsigned'].includes(r.reason), r.reason);
  assert.equal(r.catalog.entries.length, SNAP.entries.length);
  assert.equal(L.canInstall(r), false);
});

test('loadBundled: missing file, signed with a pinned key, and a pinned key that is not ed25519', () => {
  const empty = tmp();
  assert.deepEqual(L.loadBundled({ dir: empty, keysDir: empty, now: NOW }), { status: 'unverified', catalog: null, reason: 'missing' });
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'catalog.json'), SNAP_BYTES);
  fs.writeFileSync(path.join(dir, 'catalog.json.sig'), sigFor(SNAP_BYTES));
  fs.writeFileSync(path.join(dir, 'catalog-key.pub.pem'), pem(publicKey));
  const r = L.loadBundled({ dir, keysDir: dir, now: NOW });
  assert.equal(r.status, 'verified');
  assert.equal(L.canInstall(r), true);
  fs.writeFileSync(path.join(dir, 'catalog-key.pub.pem'), pem(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey));
  const bad = L.loadBundled({ dir, keysDir: dir, now: NOW });
  assert.equal(bad.status, 'unverified');
  assert.equal(L.canInstall(bad), false);
});

test('the bundled snapshot is the catalog/ snapshot, and ships in the package', () => {
  const src = path.join(ROOT, 'catalog', 'snapshot', 'catalog.json');
  if (fs.existsSync(src)) assert.ok(fs.readFileSync(src).equals(SNAP_BYTES), 'copy catalog/snapshot/catalog.json to build/plugin-catalog/');
  const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build.files;
  assert.ok(files.includes('build/plugin-catalog/**/*'));
  assert.ok(files.includes('build/catalog-key*.pub.pem'));
  assert.ok(!files.some((f) => /^catalog\b/.test(f)), 'catalog/ itself never ships');
});

test('the validator and schema are copies of catalog/\'s, and the app never imports catalog/', () => {
  const pairs = [['src/plugins/schema-check.js', 'catalog/src/schema-check.js'], ['src/plugins/catalog.schema.json', 'catalog/schema/catalog.schema.json']];
  for (const [mine, theirs] of pairs) {
    if (fs.existsSync(path.join(ROOT, theirs))) assert.ok(fs.readFileSync(path.join(ROOT, mine)).equals(fs.readFileSync(path.join(ROOT, theirs))), `${mine} differs from ${theirs}`);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'plugins')).filter((n) => n.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src', 'plugins', f), 'utf8'), /require\([^)]*catalog\//, f);
  }
});

const entry = (id, over = {}) => ({
  id, type: 'plugin', name: id, displayName: null, description: null, trust: 'community', tags: [],
  security: { level: 'low' }, requires: { os: null }, score: { total: 50, rank: 50 }, ...over,
});

test('search: query over name, display name, description and tags; every word must match', () => {
  const cat = { entries: [
    entry('a', { name: 'git-helper', description: 'Commit messages' }),
    entry('b', { displayName: 'Postgres Explorer', tags: ['database'] }),
    entry('c', { description: 'Talks to GIT and Postgres' }),
  ] };
  assert.deepEqual(L.search(cat, { q: 'GIT' }).map((e) => e.id).sort(), ['a', 'c']);
  assert.deepEqual(L.search(cat, { q: 'postgres' }).map((e) => e.id).sort(), ['b', 'c']);
  assert.deepEqual(L.search(cat, { q: 'git postgres' }).map((e) => e.id), ['c']);
  assert.deepEqual(L.search(cat, { q: 'database' }).map((e) => e.id), ['b']);
  assert.deepEqual(L.search(cat, { q: '  ' }).length, 3);
  assert.deepEqual(L.search(cat, { q: 'x'.repeat(10000) }), []);
});

test('search: filters by tags, type, trust, security level and OS', () => {
  const cat = { entries: [
    entry('p', { tags: ['Git', 'cli'], security: { level: 'high' }, requires: { os: ['macos'] } }),
    entry('m', { type: 'mcp-server', trust: 'anthropic', tags: ['git'], requires: { os: ['linux', 'windows'] } }),
    entry('s', { type: 'skill', security: { level: 'medium' } }),
  ] };
  const ids = (f) => L.search(cat, f).map((e) => e.id).sort();
  assert.deepEqual(ids({ tags: ['git'] }), ['m', 'p']);
  assert.deepEqual(ids({ tags: ['git', 'cli'] }), ['p']);
  assert.deepEqual(ids({ type: 'mcp-server' }), ['m']);
  assert.deepEqual(ids({ type: ['skill', 'plugin'] }), ['p', 's']);
  assert.deepEqual(ids({ trust: 'anthropic' }), ['m']);
  assert.deepEqual(ids({ level: ['low', 'medium'] }), ['m', 's']);
  assert.deepEqual(ids({ os: 'macos' }), ['p', 's'], 'an entry that states no OS is kept');
  assert.deepEqual(ids({ os: 'windows' }), ['m', 's']);
  assert.deepEqual(ids({}), ['m', 'p', 's']);
});

test('search: sorted by score.rank, then total, name and id, whatever the input order', () => {
  const list = [
    entry('z', { score: { total: 70, rank: 90 } }),
    entry('b', { name: 'same', score: { total: 60, rank: 95 } }),
    entry('a', { name: 'same', score: { total: 60, rank: 95 } }),
    entry('y', { score: { total: 80, rank: 90 } }),
    entry('n', { score: { total: 99 } }),
  ];
  const want = ['a', 'b', 'y', 'z', 'n'];
  assert.deepEqual(L.search({ entries: list }).map((e) => e.id), want);
  assert.deepEqual(L.search({ entries: [...list].reverse() }).map((e) => e.id), want);
  assert.equal(list[0].id, 'z', 'the input is not reordered');
});

test('search on the bundled snapshot: ranks sort within the whole list, filters narrow it', () => {
  const all = L.search(SNAP);
  assert.equal(all.length, SNAP.entries.length);
  for (let i = 1; i < all.length; i++) assert.ok(L.compareEntries(all[i - 1], all[i]) <= 0);
  const mcp = L.search(SNAP, { type: 'mcp-server' });
  assert.ok(mcp.length > 0 && mcp.every((e) => e.type === 'mcp-server'));
});
