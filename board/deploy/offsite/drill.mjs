// Disposable recovery acceptance drill. It copies one verified paired bundle
// into a private drill directory, encrypts/uploads it with the uploader
// credential, proves that credential cannot delete and the recovery credential
// cannot write or delete, removes every local drill copy, then retrieves with
// the recovery credential, decrypts, hash-verifies and restores into a fresh
// temporary data directory. The operator's original bundle is never modified.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { stageRestore, validateBackup } from '../pi/backup-lib.mjs';
import { AgeCipher } from './age.mjs';
import { prepare, upload, retrieve } from './offsite-lib.mjs';
import { fail, hash, prefix, uuid } from './schema.mjs';
import { directory, json, syncDir } from './files.mjs';

const FORMAT = 'plexiform-offsite-drill-receipt-v1';
export const NOT_PROVEN = 'NOT_PROVEN';
export const REAL_PASSED = 'REAL_R2_DRILL_PASSED_PENDING_INDEPENDENT_REVIEW';

async function readAll(store, key, max = 1024) {
  const { body } = await store.get(key); const parts = []; let size = 0;
  try { for await (const b of body) { size += b.length; if (size > max) fail('BYTES'); parts.push(Buffer.from(b)); } }
  finally { body.destroy?.(); }
  return Buffer.concat(parts);
}
async function missing(store, key) {
  try { await readAll(store, key); return false; } catch (e) { if (e.code === 'MISSING') return true; throw e; }
}
// Deletion is issued only as a negative probe against this drill's own canary.
// The production adapter keeps no delete method.
async function deleteRefused(store, key) {
  if (!store.client) fail('PROBE_INCONCLUSIVE');
  try { await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: key })); return false; }
  catch (e) { const status = e?.$metadata?.httpStatusCode; if (!(status >= 400 && status < 500) || status === 404) fail('PROBE_INCONCLUSIVE'); return true; }
}

export async function drill({ bundle, workDir, installation, recipientId, signingKeyId, signingKey, trustedKeys,
  encryptCipher, decryptCipher, uploaderStore, recoveryStore, policy = {}, clock = Date.now }) {
  uuid(installation); directory(workDir);
  if (!uploaderStore || !recoveryStore || uploaderStore === recoveryStore) fail('CONFIG');
  const id = randomUUID(), dir = path.join(workDir, `drill-${id}`), receiptFile = path.join(workDir, `drill-${id}.receipt.json`);
  const started = new Date(clock()).toISOString(), steps = {}, probes = {};
  let step = 'copy-source', transport = null, source = null, prepared = null, error = null;
  try {
    directory(dir, { create: true }); syncDir(workDir);
    const sourceCopy = path.join(dir, 'source'), outbox = path.join(dir, 'outbox');
    stageRestore({ bundle, destination: sourceCopy }); source = validateBackup(sourceCopy); steps.source_copied = true;

    step = 'encrypt'; prepared = await prepare({ bundle: sourceCopy, outbox, installation, recipientId, signingKeyId, signingKey, cipher: encryptCipher, policy, clock });
    transport = prepared.transport_id; steps.encrypted = true;
    step = 'upload'; const options = { outbox, installation, transport, trustedKeys, policy, clock };
    await upload({ ...options, store: uploaderStore }); steps.uploaded_and_read_back = true;

    step = 'privilege-probes';
    const base = prefix(installation, transport), canaryKey = base + 'drill-canary.bin', canary = randomBytes(32), canaryFile = path.join(dir, 'canary.bin');
    fs.writeFileSync(canaryFile, canary, { mode: 0o600, flag: 'wx' });
    await uploaderStore.put(canaryKey, canaryFile, { byte_length: canary.length });
    if (!(await readAll(recoveryStore, canaryKey)).equals(canary)) fail('BYTES');
    probes.uploader_delete_refused = await deleteRefused(uploaderStore, canaryKey);
    if (!probes.uploader_delete_refused || !(await readAll(recoveryStore, canaryKey)).equals(canary)) fail('UPLOADER_CAN_DELETE');
    const writeKey = base + `drill-recovery-write-${randomUUID()}.bin`;
    try { await recoveryStore.put(writeKey, canaryFile, { byte_length: canary.length }); probes.recovery_write_refused = false; }
    catch (e) { if (e.code !== 'AUTH') fail('PROBE_INCONCLUSIVE'); probes.recovery_write_refused = true; }
    if (!probes.recovery_write_refused || !(await missing(recoveryStore, writeKey))) fail('RECOVERY_CAN_WRITE');
    probes.recovery_delete_refused = await deleteRefused(recoveryStore, canaryKey);
    if (!probes.recovery_delete_refused || !(await readAll(recoveryStore, canaryKey)).equals(canary)) fail('RECOVERY_CAN_DELETE');

    step = 'delete-local-source';
    fs.rmSync(sourceCopy, { recursive: true }); fs.rmSync(outbox, { recursive: true }); fs.rmSync(canaryFile); syncDir(dir);
    if (fs.readdirSync(dir).length) fail('LOCAL_SOURCE_REMAINS'); steps.local_source_deleted = true;

    step = 'retrieve-decrypt-verify'; const retrieved = path.join(dir, 'retrieved');
    await retrieve({ installation, transport, trustedKeys, policy, store: recoveryStore, cipher: decryptCipher, destination: retrieved });
    const got = validateBackup(retrieved);
    if (JSON.stringify(got) !== JSON.stringify(source)) fail('BYTES'); steps.decrypted_hashes_match_source = true;

    step = 'restore-temp-data-dir'; const data = path.join(dir, 'restored-data');
    stageRestore({ bundle: retrieved, destination: data });
    const db = new DatabaseSync(path.join(data, 'board.db'), { readOnly: true });
    try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') fail('RESTORE_INTEGRITY'); } finally { db.close(); }
    steps.restored_integrity_ok = true; step = 'done';
  } catch (e) { error = typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code) ? e.code : 'IO'; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const real = !error && uploaderStore.kind === 'r2' && recoveryStore.kind === 'r2'
    && encryptCipher instanceof AgeCipher && decryptCipher instanceof AgeCipher;
  const receipt = {
    format: FORMAT, result: error ? 'failed' : 'passed', failed_step: error ? step : null, error,
    offsite_acceptance: real ? REAL_PASSED : NOT_PROVEN,
    acceptance_basis: real ? 'validated R2 origin for both credentials, genuine age, all steps and privilege probes passed'
      : error ? 'drill failed' : `non-production storage or cipher (uploader=${uploaderStore.kind ?? 'unknown'}, recovery=${recoveryStore.kind ?? 'unknown'}, age=${encryptCipher instanceof AgeCipher && decryptCipher instanceof AgeCipher})`,
    started_at: started, finished_at: new Date(clock()).toISOString(), installation_id: installation, transport_id: transport,
    snapshot_at: source?.created_at ?? null, object_count: prepared?.object_count ?? null,
    database_sha256: source?.database.sha256 ?? null, artifact_count: source?.artifacts.length ?? null,
    source_manifest_sha256: source ? hash(JSON.stringify(source)) : null,
    steps, probes, original_bundle_modified: false, local_drill_plaintext_removed: !fs.existsSync(dir),
    remote_objects: transport ? `paired/v1/${installation}/${transport}/ retained under bucket lock/lifecycle; this tool never deletes them` : null,
  };
  json(receiptFile, receipt);
  return { receipt, receiptFile };
}
