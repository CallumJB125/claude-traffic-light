'use strict';
// Separate plugin domain and non-secret schema. Setups recipe manifests and
// PFSEAL02 stores cannot be reinterpreted as plugin installation authority.
const crypto = require('node:crypto');
const { closed, canonical, hash, SHA, strictJSON, descriptorValid, compatible } = require('./index-verify');
const { findSecrets } = require('../../board/shared/secret-patterns.mjs');
const MAGIC = 'PFPLUG01', UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LIMITS = Object.freeze({ manifest: 512 * 1024, record: 2 * 1024 * 1024, total: 8 * 1024 * 1024, events: 32 });
const fail = () => { throw new Error('Plugin recovery record is unavailable'); };
const clone = value => JSON.parse(canonical(value));
function contextValid(c) {
  if (!closed(c, ['id', 'profile_hash', 'owner_hash', 'plan_hash']) || !UUID.test(c.id ?? '') || ![c.profile_hash, c.owner_hash, c.plan_hash].every(v => SHA.test(v ?? ''))) fail();
}
function metadataValid(m) {
  if (!closed(m, ['descriptor', 'marketplace', 'enabled']) || !descriptorValid(m.descriptor) || typeof m.enabled !== 'boolean' || m.marketplace !== `plexiform-${m.descriptor.package_sha256.slice(0, 24)}`) fail();
  // Only previously verified package metadata may be backed up. Never copy a
  // live provider table, config bytes, argv/output or runtime cache contents.
  // Typed SHA-256 fields intentionally contain 64 hex characters. Scan the
  // descriptor's human/source strings rather than misclassifying its validated
  // digest fields as the shared scrubber's likely hex-secret heuristic.
  const d = m.descriptor;
  if (findSecrets([d.id, d.catalog_id, d.name, d.version, d.host_min, d.source.path, d.source.attribution, ...d.files.map(f => f.path)].join('\n'), { docExamples: false }).length) fail();
}
function manifestValid(m) {
  if (!closed(m, ['schema', 'operation', 'created_at', 'index_hash', 'after', 'before']) || m.schema !== 1 || !['install', 'update'].includes(m.operation) || !Number.isSafeInteger(m.created_at) || m.created_at < 0 || !SHA.test(m.index_hash ?? '')) fail();
  metadataValid(m.after); if (m.after.enabled !== false) fail();
  if (m.before !== null) metadataValid(m.before);
  if ((m.operation === 'update') !== (m.before !== null) || (m.before && m.before.descriptor.name !== m.after.descriptor.name)) fail();
  // This schema cannot later be opened as remote-MCP/provider restoration
  // authority. Only the skills-only source family is implemented here.
  if ([m.after, ...(m.before ? [m.before] : [])].some(x => x.descriptor.components.mcp.length || !x.descriptor.components.skills.length)) fail();
  if (m.before && (m.before.descriptor.id !== m.after.descriptor.id || m.before.descriptor.catalog_id !== m.after.descriptor.catalog_id || canonical(m.before.descriptor.source) !== canonical(m.after.descriptor.source) || m.before.descriptor.version === m.after.descriptor.version || !compatible(m.after.descriptor.version, m.before.descriptor.version))) fail();
  if (Buffer.byteLength(canonical(m)) > LIMITS.manifest) fail();
}
const phases = Object.freeze({ prepared: ['staged'], staged: ['install_intent'], install_intent: ['observed'], observed: ['verified'], verified: ['undo_intent'], undo_intent: ['undone'], undone: [] });
function eventValid(event, previousPhase) {
  if (!closed(event, ['phase', 'receipt_hash']) || !phases[previousPhase]?.includes(event.phase) || !SHA.test(event.receipt_hash ?? '')) fail();
}
function base64(text, max) {
  if (typeof text !== 'string' || text.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) fail();
  const bytes = Buffer.from(text, 'base64'); if (bytes.toString('base64') !== text || bytes.length > max) fail(); return bytes;
}
function seal(key, context, sequence, previous, value) {
  const nonce = crypto.randomBytes(12), aad = Buffer.from(canonical({ magic: MAGIC, context, sequence, previous }));
  const plain = Buffer.from(canonical(value));
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  } finally { plain.fill(0); aad.fill(0); }
}
function open(key, context, sequence, previous, sealed) {
  if (!closed(sealed, ['nonce', 'tag', 'ciphertext'])) fail();
  const nonce = base64(sealed.nonce, 12), tag = base64(sealed.tag, 16), ciphertext = base64(sealed.ciphertext, LIMITS.manifest), aad = Buffer.from(canonical({ magic: MAGIC, context, sequence, previous }));
  if (nonce.length !== 12 || tag.length !== 16) fail();
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(aad); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]); return strictJSON(plain, LIMITS.manifest);
  } finally { plain?.fill(0); ciphertext.fill(0); aad.fill(0); }
}
function state(key, context, manifest, previous, sequence = 1, events = [], bytes = 0) {
  return { key, context: clone(context), manifest: clone(manifest), previous, sequence, events: clone(events), bytes, phase: events.at(-1)?.phase ?? 'prepared', closed: false };
}
async function prepare({ context, manifest, wrapping, current }) {
  contextValid(context); manifestValid(manifest);
  if (typeof current !== 'function' || current() !== true || wrapping?.available() !== true) fail();
  const key = crypto.randomBytes(32), copy = Buffer.from(key); let wrapped;
  try {
    wrapped = await wrapping.wrap(copy);
    if (current() !== true || wrapping.available() !== true || !Buffer.isBuffer(wrapped) || !wrapped.length || wrapped.length > 65536 || wrapped.equals(key)) fail();
    const header = Buffer.from(canonical({ magic: MAGIC, context, wrapped: wrapped.toString('base64'), sealed: seal(key, context, 0, hash(wrapped), manifest) }));
    if (header.length > LIMITS.record) fail();
    return { header, state: state(key, context, manifest, hash(header), 1, [], header.length) };
  } catch (error) { key.fill(0); throw error; }
  finally { copy.fill(0); wrapped?.fill(0); }
}
function next(s, event) {
  if (s.closed || !Buffer.isBuffer(s.key) || s.key.length !== 32 || s.sequence > LIMITS.events) fail();
  eventValid(event, s.phase);
  const bytes = Buffer.from(canonical({ magic: MAGIC, id: s.context.id, sequence: s.sequence, previous: s.previous, sealed: seal(s.key, s.context, s.sequence, s.previous, event) }));
  if (bytes.length > LIMITS.record || s.bytes + bytes.length > LIMITS.total) fail();
  return bytes;
}
function published(s, bytes, event) {
  if (s.closed || !Buffer.isBuffer(bytes)) fail();
  const outer = strictJSON(bytes, LIMITS.record);
  if (!closed(outer, ['magic', 'id', 'sequence', 'previous', 'sealed']) || outer.magic !== MAGIC || outer.sequence !== s.sequence || outer.previous !== s.previous || outer.id !== s.context.id || bytes.length > LIMITS.record || s.bytes + bytes.length > LIMITS.total) fail();
  const decoded = open(s.key, s.context, outer.sequence, outer.previous, outer.sealed);
  if (canonical(decoded) !== canonical(event)) fail(); eventValid(event, s.phase);
  s.previous = hash(bytes); s.sequence++; s.bytes += bytes.length; s.events.push(clone(event)); s.phase = event.phase;
}
function close(s) { if (s) { s.key?.fill(0); s.closed = true; } }
async function recover({ header, records, id, profile_hash, wrapping, current }) {
  if (!Buffer.isBuffer(header) || header.length > LIMITS.record || !Array.isArray(records) || records.length > LIMITS.events || typeof current !== 'function' || current() !== true || wrapping?.available() !== true) fail();
  const outer = strictJSON(header, LIMITS.record);
  if (!closed(outer, ['magic', 'context', 'wrapped', 'sealed']) || outer.magic !== MAGIC) fail(); contextValid(outer.context);
  if (outer.context.id !== id || outer.context.profile_hash !== profile_hash) fail();
  let key, s, wrapped;
  try {
    wrapped = base64(outer.wrapped, 65536); if (!wrapped.length) fail(); key = await wrapping.unwrap(wrapped);
    if (current() !== true || wrapping.available() !== true || !Buffer.isBuffer(key) || key.length !== 32) fail();
    const manifest = open(key, outer.context, 0, hash(wrapped), outer.sealed); manifestValid(manifest);
    s = state(key, outer.context, manifest, hash(header), 1, [], header.length); key = null;
    for (const bytes of records) {
      if (current() !== true || !Buffer.isBuffer(bytes) || bytes.length > LIMITS.record || s.bytes + bytes.length > LIMITS.total) fail();
      const record = strictJSON(bytes, LIMITS.record);
      if (!closed(record, ['magic', 'id', 'sequence', 'previous', 'sealed']) || record.magic !== MAGIC || record.id !== id || record.sequence !== s.sequence || record.previous !== s.previous) fail();
      const event = open(s.key, s.context, record.sequence, record.previous, record.sealed); published(s, bytes, event);
    }
    if (current() !== true) fail(); return s;
  } catch (error) { close(s); key?.fill(0); throw error; }
  finally { wrapped?.fill(0); }
}
module.exports = { MAGIC, UUID, LIMITS, metadataValid, manifestValid, prepare, next, published, recover, close };
