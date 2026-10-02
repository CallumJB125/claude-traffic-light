import { createHash, sign, verify } from 'node:crypto';

export class OffsiteError extends Error {
  constructor(code) { super(`off-site recovery failed: ${code}`); this.code = code; }
}
export const fail = (code = 'INVALID_BUNDLE') => { throw new OffsiteError(code); };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export const FORMAT = 'plexiform-offsite-v1';
export const DEFAULTS = Object.freeze({ maxDatabase: 4 * 1024 ** 3, maxArtifact: 8 * 1024 ** 2, maxArtifacts: 10_000,
  maxManifest: 16 * 1024 ** 2, maxTotal: 8 * 1024 ** 3, maxOutbox: 32 * 1024 ** 3, chunkBytes: 16 * 1024 ** 2 });
export const MAX_COMPLETION = 8192;
export const MAX_WINDOW_MS = 86_400_000;
export const MAX_OBJECTS = DEFAULTS.maxArtifacts + Math.ceil(DEFAULTS.maxDatabase / DEFAULTS.chunkBytes);
export const hash = (v) => createHash('sha256').update(v).digest('hex');
export const encode = (v) => Buffer.from(JSON.stringify(v) + '\n');
export const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
export function closed(v, keys) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail();
}
export function limits(over = {}) {
  if (!over || typeof over !== 'object' || Array.isArray(over) || Object.keys(over).some(k => !Object.hasOwn(DEFAULTS, k))) fail('LIMITS');
  const v = { ...DEFAULTS, ...over };
  for (const k of Object.keys(v)) if (!integer(v[k], 1, DEFAULTS[k])) fail('LIMITS');
  return v;
}
export function uuid(v) { if (typeof v !== 'string' || !UUID.test(v)) fail(); return v; }
function stamp(v) { if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail(); return v; }
export function recipient(v) { if (typeof v !== 'string' || !/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(v)) fail('KEY'); return v; }
export function keyId(v) { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) fail('KEY'); return v; }
export const prefix = (installation, transport) => `paired/v1/${uuid(installation)}/${uuid(transport)}/`;
export const objectName = (index) => `${String(index).padStart(6, '0')}.age`;
export const cipherMax = (plain) => plain + 4096 + (Math.ceil(plain / 65536) + 1) * 16;
export function object(v, name, max) {
  closed(v, ['name', 'sha256', 'byte_length']);
  if (v.name !== name || !HASH.test(v.sha256) || !integer(v.byte_length, 1, max)) fail();
  return { name: v.name, sha256: v.sha256, byte_length: v.byte_length };
}
export function paired(v, l = DEFAULTS) {
  closed(v, ['format', 'created_at', 'database', 'artifacts']); stamp(v.created_at);
  closed(v.database, ['file', 'sha256', 'byte_length']);
  if (v.format !== 'plexiform-paired-backup-v1' || v.database.file !== 'board.db' || !HASH.test(v.database.sha256)
    || !integer(v.database.byte_length, 1, l.maxDatabase) || !Array.isArray(v.artifacts) || v.artifacts.length > l.maxArtifacts) fail('LIMITS');
  let total = v.database.byte_length, previous = '';
  for (const a of v.artifacts) {
    closed(a, ['id', 'sha256', 'byte_length', 'file']); uuid(a.id);
    if (a.id <= previous || a.file !== `client-artifacts/${a.id}.bin` || !HASH.test(a.sha256) || !integer(a.byte_length, 1, l.maxArtifact)) fail();
    previous = a.id; total += a.byte_length;
  }
  if (!integer(total, 1, l.maxTotal)) fail('LIMITS');
  return v;
}
export function internal(v, l = DEFAULTS) {
  closed(v, ['format', 'recipient_id', 'chunk_bytes', 'paired', 'files']);
  if (v.format !== `${FORMAT}-manifest` || !integer(v.chunk_bytes, 1, l.chunkBytes)) fail(); keyId(v.recipient_id); paired(v.paired, l);
  const entries = [v.paired.database, ...v.paired.artifacts];
  if (!Array.isArray(v.files) || v.files.length !== entries.length) fail();
  let index = 0;
  const objects = [];
  for (let i = 0; i < entries.length; i++) {
    const f = v.files[i], expected = entries[i]; closed(f, ['file', 'parts']);
    const count = i === 0 ? Math.ceil(expected.byte_length / v.chunk_bytes) : 1;
    if (count > MAX_OBJECTS - index) fail('LIMITS');
    if (f.file !== expected.file || !Array.isArray(f.parts) || f.parts.length !== count) fail();
    for (let j = 0; j < count; j++) {
      const p = f.parts[j]; closed(p, ['name', 'sha256', 'byte_length', 'plain_bytes']);
      const size = i === 0 ? Math.min(v.chunk_bytes, expected.byte_length - j * v.chunk_bytes) : expected.byte_length;
      if (p.plain_bytes !== size) fail();
      const wire = object({ name: p.name, sha256: p.sha256, byte_length: p.byte_length }, objectName(index++), cipherMax(size));
      objects.push(wire);
    }
  }
  return objects;
}
function unsigned(v) {
  return { format: v.format, installation_id: v.installation_id, transport_id: v.transport_id, snapshot_at: v.snapshot_at,
    created_at: v.created_at, signing_key_id: v.signing_key_id, manifest: v.manifest, object_count: v.object_count, objects_hash: v.objects_hash };
}
export function completionShape(v, l = DEFAULTS) {
  closed(v, ['format', 'installation_id', 'transport_id', 'snapshot_at', 'created_at', 'signing_key_id', 'manifest', 'object_count', 'objects_hash', 'signature']);
  if (v.format !== FORMAT || !HASH.test(v.objects_hash) || !integer(v.object_count, 1, MAX_OBJECTS)
    || typeof v.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(v.signature) || Buffer.from(v.signature, 'base64url').toString('base64url') !== v.signature) fail();
  uuid(v.installation_id); uuid(v.transport_id); stamp(v.snapshot_at); stamp(v.created_at); keyId(v.signing_key_id);
  object(v.manifest, 'manifest.age', cipherMax(l.maxManifest));
  return unsigned(v);
}
export function signedCompletion(v, privateKey) {
  if (privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') fail('KEY');
  const signed = { ...unsigned(v), signature: sign(null, encode(unsigned(v)), privateKey).toString('base64url') };
  completionShape(signed); return signed;
}
export function verifyCompletion(v, { installation, transport, trustedKeys, policy = DEFAULTS }) {
  const body = completionShape(v, policy), key = trustedKeys?.get(v.signing_key_id);
  if (v.installation_id !== uuid(installation) || v.transport_id !== uuid(transport) || key?.type !== 'public' || key.asymmetricKeyType !== 'ed25519'
    || !verify(null, encode(body), key, Buffer.from(v.signature, 'base64url'))) fail('SIGNATURE');
  return v;
}
export const objectsHash = (objects) => hash(encode(objects));
