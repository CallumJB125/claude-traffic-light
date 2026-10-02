// Disposable recovery acceptance drill. It copies one verified paired bundle
// into a private drill directory, encrypts/uploads it with the uploader
// credential, verifies every stored object is age ciphertext, proves (exact 403)
// that credential cannot overwrite or delete and the recovery credential cannot
// write or delete, removes every local drill copy, then retrieves with
// the recovery credential, decrypts, hash-verifies and restores into a fresh
// temporary data directory. The operator's original bundle is never modified.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { stageRestore, validateBackup } from '../pi/backup-lib.mjs';
import { genuineAge } from './age.mjs';
import { prepare, upload, retrieve } from './offsite-lib.mjs';
import { fail, hash, prefix, uuid } from './schema.mjs';
import { directory, json, syncDir } from './files.mjs';

const FORMAT = 'plexiform-offsite-drill-receipt-v1';
export const NOT_PROVEN = 'NOT_PROVEN';
export const REAL_PASSED = 'REAL_R2_DRILL_PASSED_PENDING_INDEPENDENT_REVIEW';
export const DRILL_MARKER = '.plexiform-offsite-drill';
const AGE_HEADER = Buffer.from('age-encryption.org/v1\n');
const PLAINTEXT_MARKERS = ['SQLite format 3\0', 'plexiform-paired-backup-v1', 'plexiform-offsite-v1-manifest'].map(s => Buffer.from(s));
const DRILL_DIR = /^drill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Removes drill working directories this tool created (identified by the marker
// file). own=true removes this process's directories (signal cleanup); otherwise
// only directories whose creating process is gone (stale after a crash/kill -9).
export function sweepDrills(workDir, { own = false } = {}) {
  let removed = 0;
  for (const name of fs.readdirSync(workDir)) {
    const dir = path.join(workDir, name);
    if (!DRILL_DIR.test(name)) continue;
    const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    let pid;
    try { pid = JSON.parse(fs.readFileSync(path.join(dir, DRILL_MARKER), 'utf8')).pid; } catch { continue; }
    if (!Number.isSafeInteger(pid) || pid < 1) continue;
    let alive = pid === process.pid;
    if (!alive) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
    if (own ? pid === process.pid : !alive) { fs.rmSync(dir, { recursive: true, force: true }); removed++; }
  }
  return removed;
}

// Pure receipt classifier: the only path to a real off-site acceptance claim.
export function classify({ error, uploaderKind, recoveryKind, encryptAge, decryptAge }) {
  const real = !error && uploaderKind === 'r2' && recoveryKind === 'r2' && encryptAge === true && decryptAge === true;
  return {
    offsite_acceptance: real ? REAL_PASSED : NOT_PROVEN,
    acceptance_basis: real ? 'validated R2 origin for both credentials, pinned genuine age, age ciphertext verified, all steps and exact-403 privilege probes passed'
      : error ? 'drill failed' : `non-production storage or cipher (uploader=${uploaderKind ?? 'unknown'}, recovery=${recoveryKind ?? 'unknown'}, pinned_age=${encryptAge === true && decryptAge === true})`,
  };
}

async function readAll(store, key, max = 1024) {
  const { body } = await store.get(key); const parts = []; let size = 0;
  try { for await (const b of body) { size += b.length; if (size > max) fail('BYTES'); parts.push(Buffer.from(b)); } }
  finally { body.destroy?.(); }
  return Buffer.concat(parts);
}
async function missing(store, key) {
  try { await readAll(store, key); return false; } catch (e) { if (e.code === 'MISSING') return true; throw e; }
}
const errorCode = e => { const c = typeof e?.Code === 'string' ? e.Code : e?.name; return typeof c === 'string' && /^[A-Za-z]{1,64}$/.test(c) ? c : 'unknown'; };
// Delete and unconditional overwrite are issued only as negative probes against
// this drill's own canary. The production adapter has neither method. Only an
// exact 403 counts as refused; throttling/server errors are retryable failures.
async function probe(store, command) {
  if (!store.client) fail('PROBE_INCONCLUSIVE');
  let result;
  try { result = await store.client.send(command); }
  catch (e) {
    const status = e?.$metadata?.httpStatusCode;
    if (status === 403) return { refused: true, http_status: 403, code: errorCode(e) };
    if (!Number.isInteger(status) || status === 429 || status >= 500) fail('RETRY');
    fail('PROBE_INCONCLUSIVE');
  }
  return { refused: false, http_status: result?.$metadata?.httpStatusCode ?? null, code: null };
}
// Every stored object except the signed plaintext completion must be age
// ciphertext and must not be (or contain) recognisable plaintext.
async function verifyCiphertext(store, base, objects, source) {
  const digests = new Set([source.database.sha256, ...source.artifacts.map(a => a.sha256)]);
  for (const o of objects) {
    const b = await readAll(store, base + o.name, o.byte_length);
    if (b.length !== o.byte_length || !b.subarray(0, AGE_HEADER.length).equals(AGE_HEADER)) fail('NOT_AGE_CIPHERTEXT');
    if (digests.has(hash(b)) || PLAINTEXT_MARKERS.some(m => b.includes(m))) fail('PLAINTEXT_UPLOADED');
  }
}

export async function drill({ bundle, workDir, installation, recipientId, signingKeyId, signingKey, trustedKeys,
  encryptCipher, decryptCipher, uploaderStore, recoveryStore, policy = {}, clock = Date.now }) {
  uuid(installation); directory(workDir);
  if (!uploaderStore || !recoveryStore || uploaderStore === recoveryStore) fail('CONFIG');
  sweepDrills(workDir);
  const id = randomUUID(), dir = path.join(workDir, `drill-${id}`), receiptFile = path.join(workDir, `drill-${id}.receipt.json`);
  const started = new Date(clock()).toISOString(), steps = {}, probes = {};
  let step = 'copy-source', transport = null, source = null, prepared = null, error = null;
  try {
    directory(dir, { create: true }); json(path.join(dir, DRILL_MARKER), { format: FORMAT, pid: process.pid }); syncDir(workDir);
    const sourceCopy = path.join(dir, 'source'), outbox = path.join(dir, 'outbox');
    stageRestore({ bundle, destination: sourceCopy }); source = validateBackup(sourceCopy); steps.source_copied = true;

    step = 'encrypt'; prepared = await prepare({ bundle: sourceCopy, outbox, installation, recipientId, signingKeyId, signingKey, cipher: encryptCipher, policy, clock, drill: true });
    transport = prepared.transport_id; steps.encrypted = true;
    step = 'upload'; const options = { outbox, installation, transport, trustedKeys, policy, clock };
    await upload({ ...options, store: uploaderStore }); steps.uploaded_and_read_back = true;
    const base = prefix(installation, transport);

    step = 'verify-remote-ciphertext';
    const ready = JSON.parse(fs.readFileSync(path.join(outbox, transport, 'ready.json'), 'utf8'));
    await verifyCiphertext(recoveryStore, base, [...ready.objects, ready.completion.manifest], source); steps.remote_objects_are_age_ciphertext = true;

    step = 'privilege-probes';
    const canaryKey = base + 'drill-canary.bin', canary = randomBytes(32), canaryFile = path.join(dir, 'canary.bin');
    const other = randomBytes(32), otherFile = path.join(dir, 'other.bin');
    fs.writeFileSync(canaryFile, canary, { mode: 0o600, flag: 'wx' }); fs.writeFileSync(otherFile, other, { mode: 0o600, flag: 'wx' });
    const intact = async () => { try { return (await readAll(recoveryStore, canaryKey)).equals(canary); } catch (e) { if (e.code === 'MISSING') return false; throw e; } };
    await uploaderStore.put(canaryKey, canaryFile, { byte_length: canary.length });
    if (!(await intact())) fail('BYTES');
    try { await uploaderStore.put(canaryKey, otherFile, { byte_length: other.length }); probes.uploader_conditional_overwrite = { refused: false, http_status: null, code: null }; }
    catch (e) { if (e.code === 'RETRY') throw e; if (e.code !== 'EXISTS') fail('PROBE_INCONCLUSIVE'); probes.uploader_conditional_overwrite = { refused: true, http_status: 412, code: 'EXISTS' }; }
    if (!probes.uploader_conditional_overwrite.refused || !(await intact())) fail('CONDITIONAL_WRITE_NOT_ENFORCED');
    probes.uploader_unconditional_overwrite = await probe(uploaderStore, new PutObjectCommand({ Bucket: uploaderStore.bucket, Key: canaryKey,
      Body: other, ContentLength: other.length, ContentType: 'application/octet-stream', CacheControl: 'no-store' }));
    if (!probes.uploader_unconditional_overwrite.refused || !(await intact())) fail('UPLOADER_CAN_OVERWRITE');
    probes.uploader_delete = await probe(uploaderStore, new DeleteObjectCommand({ Bucket: uploaderStore.bucket, Key: canaryKey }));
    if (!probes.uploader_delete.refused || !(await intact())) fail('UPLOADER_CAN_DELETE');
    const writeKey = base + `drill-recovery-write-${randomUUID()}.bin`;
    probes.recovery_write = await probe(recoveryStore, new PutObjectCommand({ Bucket: recoveryStore.bucket, Key: writeKey, Body: canary,
      ContentLength: canary.length, IfNoneMatch: '*', ContentType: 'application/octet-stream', CacheControl: 'no-store' }));
    if (!probes.recovery_write.refused || !(await missing(recoveryStore, writeKey))) fail('RECOVERY_CAN_WRITE');
    probes.recovery_delete = await probe(recoveryStore, new DeleteObjectCommand({ Bucket: recoveryStore.bucket, Key: canaryKey }));
    if (!probes.recovery_delete.refused || !(await intact())) fail('RECOVERY_CAN_DELETE');

    step = 'delete-local-source';
    fs.rmSync(sourceCopy, { recursive: true }); fs.rmSync(outbox, { recursive: true }); fs.rmSync(canaryFile); fs.rmSync(otherFile); syncDir(dir);
    if (fs.readdirSync(dir).some(n => n !== DRILL_MARKER)) fail('LOCAL_SOURCE_REMAINS'); steps.local_source_deleted = true;

    step = 'retrieve-decrypt-verify'; const retrieved = path.join(dir, 'retrieved');
    await retrieve({ installation, transport, trustedKeys, policy, store: recoveryStore, cipher: decryptCipher, destination: retrieved, drill: true });
    const got = validateBackup(retrieved);
    if (JSON.stringify(got) !== JSON.stringify(source)) fail('BYTES'); steps.decrypted_hashes_match_source = true;

    step = 'restore-temp-data-dir'; const data = path.join(dir, 'restored-data');
    stageRestore({ bundle: retrieved, destination: data });
    const db = new DatabaseSync(path.join(data, 'board.db'), { readOnly: true });
    try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') fail('RESTORE_INTEGRITY'); } finally { db.close(); }
    steps.restored_integrity_ok = true; step = 'done';
  } catch (e) { error = typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code) ? e.code : 'IO'; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const receipt = {
    format: FORMAT, result: error ? 'failed' : 'passed', failed_step: error ? step : null, error,
    ...classify({ error, uploaderKind: uploaderStore.kind, recoveryKind: recoveryStore.kind, encryptAge: genuineAge(encryptCipher), decryptAge: genuineAge(decryptCipher) }),
    started_at: started, finished_at: new Date(clock()).toISOString(), installation_id: installation, transport_id: transport, drill_backup: true,
    snapshot_at: source?.created_at ?? null, object_count: prepared?.object_count ?? null,
    database_sha256: source?.database.sha256 ?? null, artifact_count: source?.artifacts.length ?? null,
    source_manifest_sha256: source ? hash(JSON.stringify(source)) : null,
    steps, probes, original_bundle_modified: false, local_drill_plaintext_removed: !fs.existsSync(dir),
    remote_objects: transport ? `paired/v1/${installation}/${transport}/ (signed drill:true) retained under bucket lock/lifecycle; this tool never deletes them` : null,
  };
  json(receiptFile, receipt);
  return { receipt, receiptFile };
}
