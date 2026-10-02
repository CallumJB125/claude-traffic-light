'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const V = require('../src/plugins/index-verify'), T = require('../src/plugins/toml-owned'), J = require('../src/plugins/journal-codec');
const id = 'delivery-review@plexiform-1234', H = value => V.hash(value), clone = value => JSON.parse(V.canonical(value));
function manifest() {
  const files = [{ path: 'plugin.json', bytes: 2, sha256: H('{}') }, { path: 'skills/delivery-review/SKILL.md', bytes: 4, sha256: H('text') }];
  const descriptor = { id: 'delivery-review', catalog_id: 'skill:delivery-review', name: 'delivery-review', version: '1.0.0', host_min: '0.159.2', source: { type: 'bundled-directory', path: 'delivery-review', attribution: 'Synthetic curated source' }, files, package_sha256: V.packageHash(files), components: { manifest: 'plugin.json', skills: ['skills/delivery-review/SKILL.md'], mcp: [] }, capabilities: ['instructions'] };
  return { schema: 1, operation: 'install', created_at: 100, index_hash: H('index'), after: { descriptor, marketplace: `plexiform-${descriptor.package_sha256.slice(0, 24)}`, enabled: false }, before: null };
}
function wrapping(t) {
  const master = crypto.randomBytes(32); t.after(() => master.fill(0)); return { available: () => true, async wrap(key) { const nonce = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', master, nonce); return Buffer.concat([nonce, c.update(key), c.final(), c.getAuthTag()]); }, async unwrap(bytes) { const c = crypto.createDecipheriv('aes-256-gcm', master, bytes.subarray(0, 12)); c.setAuthTag(bytes.subarray(-16)); return Buffer.concat([c.update(bytes.subarray(12, -16)), c.final()]); } };
}
async function packet(t) { const w = wrapping(t), context = { id: crypto.randomUUID(), profile_hash: H('synthetic profile'), owner_hash: H('synthetic os owner'), plan_hash: H('synthetic reviewed plan') }, prepared = await J.prepare({ context, manifest: manifest(), wrapping: w, current: () => true }), records = []; for (const phase of ['staged', 'install_intent', 'observed', 'verified']) { const event = { phase, receipt_hash: H(phase) }, bytes = J.next(prepared.state, event); J.published(prepared.state, bytes, event); records.push(bytes); } t.after(() => J.close(prepared.state)); return { ...prepared, records, context, w, recover: changes => J.recover({ header: prepared.header, records, id: context.id, profile_hash: context.profile_hash, wrapping: w, current: () => true, ...changes }) }; }

test('owned TOML range replacement and Undo preserve foreign CRLF bytes including strings that contain table-looking lines', () => {
  const foreign = Buffer.from('# Human note\r\nmodel = "synthetic"\r\ntext = """\r\n[plugins.\"fake@source\"]\r\nenabled = true\r\n"""\r\n[human]\r\ncredential_location = "$ENV"\r\n');
  const installed = T.replaceOwned(foreign, id, null, false); assert.equal(T.owned(installed, id).enabled, false); assert.ok(T.owned(installed, id).foreign.equals(foreign)); assert.ok(T.replaceOwned(installed, id, false, null).equals(foreign));
  const changed = Buffer.concat([installed, Buffer.from('\r\n[after_human]\r\nnotes = "preserve"\r\n')]); const undone = T.replaceOwned(changed, id, false, null); assert.ok(undone.equals(Buffer.concat([foreign, Buffer.from('\r\n[after_human]\r\nnotes = "preserve"\r\n')])));
});
for (const [name, text] of [
  ['decoded duplicate quoted keys', `[plugins."${id}"]\nenabled = false\n"enab\\u006ced" = true\n`],
  ['decoded duplicate dotted keys', `plugins."${id}".enabled = false\nplugins.'${id}'.enabled = true\n`],
  ['inline owned value', `plugins."${id}" = { enabled = true }\n`],
  ['inline parent value', `plugins = { "${id}" = { enabled = true } }\n`],
  ['nested owned table', `[plugins."${id}".credentials]\npassword = "synthetic"\n`],
  ['unknown owned provider field', `[plugins."${id}"]\nenabled = false\nprovider_login = "synthetic"\n`],
  ['person-owned inline comment', `[plugins."${id}"]\nenabled = false # Human decision\n`],
  ['person-owned table comment', `[plugins."${id}"] # Human note\nenabled = false\n`],
  ['array tables', `[[plugins]]\nname = "synthetic"\n`],
  ['unterminated array comment', `foreign = [ 1 # interrupted`],
  ['value parent then nested table', `foreign = "value"\n[foreign.child]\na = 1\n`],
  ['value parent then dotted value', `foreign = "value"\nforeign.child = 1\n`],
  ['dotted value then parent overwrite', `foreign.child = 1\nforeign = "value"\n`],
  ['nested duplicate table', `[foreign.child]\na = 1\n[foreign.child]\nb = 2\n`],
]) test(`owned TOML refuses ${name} without mutating caller bytes`, () => { const bytes = Buffer.from(text), original = Buffer.from(bytes); assert.throws(() => T.replaceOwned(bytes, id, null, false)); assert.ok(bytes.equals(original)); });
test('owned TOML recognizes Unicode-escaped and dotted owned enable paths and preserves surrounding table bytes', () => { const text = Buffer.from(`[plugins]\n"delivery-review\\u0040plexiform-1234".enabled = false\n[foreign]\ncomment = "keep"\n`); const s = T.owned(text, id); assert.equal(s.enabled, false); assert.equal(s.foreign.toString(), '[plugins]\n[foreign]\ncomment = "keep"\n'); });
test('owned TOML refuses malformed UTF8, BOM, NUL, oversize input and unowned final separator', () => { for (const bytes of [Buffer.from([255]), Buffer.from([239, 187, 191, 10]), Buffer.from('\0'), Buffer.alloc(T.MAX_BYTES + 1), Buffer.from('# Human unterminated line')]) assert.throws(() => T.replaceOwned(bytes, id, null, false)); });
test('owned TOML conditional ownership refuses changed enabled field and cannot overwrite existing unowned entry', () => { const bytes = Buffer.from(`[plugins."${id}"]\nenabled = true\n`); assert.throws(() => T.replaceOwned(bytes, id, false, null)); assert.throws(() => T.replaceOwned(bytes, id, null, false)); });

test('encrypted plugin journal has separate domain, authenticated full manifest and strict phase chain with zeroized close', async t => { const p = await packet(t), state = await p.recover(); assert.equal(state.phase, 'verified'); assert.deepEqual(state.manifest, manifest()); assert.equal(state.events.length, 4); J.close(state); assert.ok(state.key.every(v => v === 0)); assert.throws(() => J.next(state, { phase: 'undo_intent', receipt_hash: H('u') })); assert.equal(p.header.toString().includes('Synthetic curated source'), false); });
for (const boundary of ['ciphertext', 'tag', 'nonce', 'wrapped', 'profile', 'id', 'magic', 'record-id', 'reorder', 'gap', 'extra-record', 'duplicate-key']) test(`encrypted journal refuses ${boundary} and preserves original record evidence`, async t => {
  const p = await packet(t), headerOriginal = Buffer.from(p.header), recordsOriginal = p.records.map(Buffer.from); let header = Buffer.from(p.header), records = p.records.map(Buffer.from), id = p.context.id, profile_hash = p.context.profile_hash;
  if (['ciphertext', 'tag', 'nonce', 'wrapped'].includes(boundary)) { const value = JSON.parse(header); const target = boundary === 'wrapped' ? value : value.sealed, key = boundary; const bytes = Buffer.from(target[key], 'base64'); bytes[0] ^= 1; target[key] = bytes.toString('base64'); header = Buffer.from(JSON.stringify(value)); }
  if (boundary === 'profile') profile_hash = H('other profile'); if (boundary === 'id') id = crypto.randomUUID();
  if (boundary === 'magic') { const x = JSON.parse(header); x.magic = 'PFSEAL02'; header = Buffer.from(JSON.stringify(x)); }
  if (boundary === 'record-id') { const x = JSON.parse(records[1]); x.id = crypto.randomUUID(); records[1] = Buffer.from(JSON.stringify(x)); }
  if (boundary === 'reorder') [records[0], records[1]] = [records[1], records[0]]; if (boundary === 'gap') records.splice(1, 1); if (boundary === 'extra-record') records.push(records[3]);
  if (boundary === 'duplicate-key') header = Buffer.from(header.toString().replace('"magic":', '"magic":"PFPLUG01","magic":'));
  await assert.rejects(p.recover({ header, records, id, profile_hash })); assert.ok(p.header.equals(headerOriginal)); assert.ok(p.records.every((v, i) => v.equals(recordsOriginal[i])));
});
test('journal phase intent cannot be skipped or fabricated as verified; valid interrupted prefix remains visibly unverified', async t => { const p = await packet(t); const state = await p.recover({ records: [] }); assert.equal(state.phase, 'prepared'); assert.throws(() => J.next(state, { phase: 'verified', receipt_hash: H('forged') })); assert.throws(() => J.next(state, { phase: 'staged', receipt_hash: H('x'), private_config: 'synthetic' })); J.close(state); });
test('journal metadata rejects enabled new install, foreign marketplace, provider fields and embedded recognized credentials', () => {
  for (const mutate of [m => m.after.enabled = true, m => m.after.marketplace = 'foreign-source', m => m.after.provider_login = 'synthetic', m => m.after.descriptor.source.attribution = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', m => m.before = clone(m.after)]) { const m = manifest(); mutate(m); assert.throws(() => J.manifestValid(m)); }
});
test('journal wrapping has no plaintext or unavailable fallback and invalidated asynchronous preparation wipes handed-off key bytes', async t => { const m = manifest(), context = { id: crypto.randomUUID(), profile_hash: H('p'), owner_hash: H('o'), plan_hash: H('x') }; await assert.rejects(J.prepare({ context, manifest: m, wrapping: { available: () => false }, current: () => true })); let handed, current = true; await assert.rejects(J.prepare({ context, manifest: m, current: () => current, wrapping: { available: () => true, async wrap(key) { handed = key; current = false; return Buffer.alloc(40, 1); } } })); assert.ok(handed.every(v => v === 0)); await assert.rejects(J.prepare({ context, manifest: m, current: () => true, wrapping: { available: () => true, async wrap(key) { return Buffer.from(key); } } })); });
test('closed native contracts reject every nonprimitive hash before authority or physical verification', () => {
  const A = require('../src/plugins/native-adapter-contract'), h = H('hash'), observed = { profile_root: '/private/tmp/synthetic-only', platform: 'darwin', os_user: 'synthetic-owner', generation: 0, foreground: true, host_hash: h, account: null };
  for (const value of [[h], new String(h), { toString() { throw Error('must not coerce'); } }, null, 1]) {
    assert.throws(() => A.observation({ ...observed, host_hash: value }));
    for (const field of ['package_hash', 'cache_hash', 'foreign_hash', 'receipt_hash']) { const inspection = { status: 'exact', package_hash: h, cache_hash: h, foreign_hash: h, receipt_hash: h, config_enabled: false, owned: true, live_dependents: 0 }; inspection[field] = value; assert.throws(() => A.inspection(inspection)); }
    assert.throws(() => A.inventory({ items: [], receipt_hash: value }));
    for (const field of ['helper_hash', 'roots_hash']) { let begun = 0; const attested = { kind: 'synthetic-plugin-fixture', protocol: 1, helper_hash: h, roots_hash: h, current: true }; attested[field] = value; const adapter = A.createNativePluginAdapter({ fixture: true, observe: () => observed, attest: () => attested, wrapping: { available: () => false, wrap() {}, unwrap() {} }, begin() { begun++; throw Error('must not begin'); }, verifyReceipt: () => true }); assert.throws(() => adapter.begin('inventory', {}, () => true, 100)); assert.equal(begun, 0); }
  }
});
test('journal schema rejects coerced IDs, context/manifest/event/file hashes before wrapping or publication', async t => {
  const context = { id: crypto.randomUUID(), profile_hash: H('profile'), owner_hash: H('owner'), plan_hash: H('plan') }; let available = 0; const w = { available() { available++; return true; }, wrap() { throw Error('must not wrap'); } };
  for (const field of ['id', 'profile_hash', 'owner_hash', 'plan_hash']) { const c = { ...context, [field]: [context[field]] }; await assert.rejects(J.prepare({ context: c, manifest: manifest(), wrapping: w, current: () => true })); assert.equal(available, 0); }
  const m = manifest(); m.index_hash = [m.index_hash]; assert.throws(() => J.manifestValid(m)); const files = manifest(); files.after.descriptor.files[0].sha256 = [files.after.descriptor.files[0].sha256]; files.after.descriptor.package_sha256 = V.packageHash(files.after.descriptor.files); files.after.marketplace = `plexiform-${files.after.descriptor.package_sha256.slice(0, 24)}`; assert.throws(() => J.manifestValid(files));
  const p = await packet(t); assert.throws(() => J.next(p.state, { phase: 'undo_intent', receipt_hash: [H('u')] })); await assert.rejects(J.recover({ header: p.header, records: p.records, id: [p.context.id], profile_hash: p.context.profile_hash, wrapping: w, current: () => true })); await assert.rejects(J.recover({ header: p.header, records: p.records, id: p.context.id, profile_hash: [p.context.profile_hash], wrapping: w, current: () => true })); assert.equal(available, 0);
});
