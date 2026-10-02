// Explicit operator tool. No scheduler, live cutover, key generation or cloud
// provisioning is performed by this command. JSON stdout contains metadata only.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgeCipher, genuineAge } from './age.mjs';
import { S3Store } from './s3.mjs';
import { prepare, upload, retrieve, forkPrepared, pruneConfirmed } from './offsite-lib.mjs';
import { drill, sweepDrills } from './drill.mjs';
import { fail, keyId, uuid, limits } from './schema.mjs';
import { open, readJson } from './files.mjs';

function key(file, privateKey = false) {
  const { fd } = open(file, 16384);
  try { const v = (privateKey ? createPrivateKey : createPublicKey)(fs.readFileSync(fd));
    if (v.type !== (privateKey ? 'private' : 'public') || v.asymmetricKeyType !== 'ed25519') fail('KEY'); return v;
  } catch { fail('KEY'); } finally { fs.closeSync(fd); }
}
function load(configFile) {
  const c = readJson(configFile, 65536);
  const allowed = ['installation_id','outbox','recipient_id','public_recipient','age_executable','recovery_identity','signing_key_id','signing_private_key','trusted_signing_keys','policy','storage'];
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !allowed.includes(k))) fail('CONFIG');
  uuid(c.installation_id); const policy = limits(c.policy ?? {}), trustedKeys = new Map();
  if (!c.trusted_signing_keys || typeof c.trusted_signing_keys !== 'object' || Array.isArray(c.trusted_signing_keys) || Object.keys(c.trusted_signing_keys).length < 1 || Object.keys(c.trusted_signing_keys).length > 16) fail('CONFIG');
  for (const [id, file] of Object.entries(c.trusted_signing_keys)) trustedKeys.set(keyId(id), key(file));
  return { c, policy, trustedKeys };
}
function storage(c) {
  if (!c.storage || Object.keys(c.storage).some(k => !['endpoint','bucket','accessKeyId','secretAccessKey','sessionToken'].includes(k))) fail('CONFIG');
  return new S3Store(c.storage);
}
function signer(c, trustedKeys) {
  const signingKey = key(c.signing_private_key, true); keyId(c.signing_key_id);
  if (!trustedKeys.has(c.signing_key_id) || !createPublicKey(signingKey).equals(trustedKeys.get(c.signing_key_id))) fail('KEY');
  return signingKey;
}
// One-command disposable acceptance drill: separate uploader and recovery
// credentials, the operator's existing verified bundle (read only) and a
// private work directory that receives only the drill receipt.
async function runDrill([uploaderFile, recoveryFile, bundle, workDir, ...extra], report) {
  if (extra.length || !uploaderFile || !recoveryFile || !bundle || !workDir) fail('USAGE');
  const u = load(uploaderFile), r = load(recoveryFile);
  if (u.c.installation_id !== r.c.installation_id || !u.c.storage || !r.c.storage || u.c.storage.bucket !== r.c.storage.bucket
    || u.c.storage.endpoint !== r.c.storage.endpoint || u.c.storage.accessKeyId === r.c.storage.accessKeyId
    || u.c.recovery_identity || r.c.signing_private_key) fail('CONFIG');
  const signingKey = signer(u.c, u.trustedKeys);
  if (!r.trustedKeys.get(u.c.signing_key_id)?.equals(createPublicKey(signingKey))) fail('KEY');
  const uploaderStore = storage(u.c), recoveryStore = storage(r.c);
  let encryptCipher, decryptCipher, release;
  try {
    encryptCipher = new AgeCipher({ executable: u.c.age_executable, publicRecipient: u.c.public_recipient });
    decryptCipher = new AgeCipher({ executable: r.c.age_executable, identity: r.c.recovery_identity });
    if (!genuineAge(encryptCipher) || !genuineAge(decryptCipher)) fail('AGE_UNPINNED');
    release = guardDrill(workDir, [encryptCipher, decryptCipher, uploaderStore, recoveryStore]);
    const { receipt, receiptFile } = await drill({ bundle, workDir, installation: u.c.installation_id, recipientId: keyId(u.c.recipient_id),
      signingKeyId: u.c.signing_key_id, signingKey, trustedKeys: r.trustedKeys, encryptCipher, decryptCipher, uploaderStore, recoveryStore, policy: u.policy });
    const summary = { result: receipt.result, offsite_acceptance: receipt.offsite_acceptance, failed_step: receipt.failed_step, error: receipt.error,
      transport_id: receipt.transport_id, receipt: path.basename(receiptFile) };
    report(summary); if (receipt.result !== 'passed') process.exitCode = 1; return receipt;
  } finally { release?.(); uploaderStore.close(); recoveryStore.close(); encryptCipher?.close(); decryptCipher?.close(); }
}
// Installed before the drill writes any plaintext: on SIGINT/SIGTERM, stop age
// children and network clients, then remove this process's drill directory.
export function guardDrill(workDir, closers) {
  const terminate = signal => {
    for (const c of closers) { try { c.close(); } catch {} }
    try { sweepDrills(workDir, { own: true }); } catch {}
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const interrupt = () => terminate('SIGINT'), stop = () => terminate('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', stop);
  return () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', stop); };
}
export async function main(args, report = (value) => process.stdout.write(JSON.stringify(value) + '\n')) {
  if (args[0] === '--drill') return runDrill(args.slice(1), report);
  const [mode, configFile, source, destination, ...extra] = args;
  if (extra.length || !['--prepare','--upload','--retrieve','--fork','--prune'].includes(mode) || !configFile || !source
    || ((mode === '--retrieve') !== Boolean(destination))) fail('USAGE');
  const { c, policy, trustedKeys } = load(configFile);
  const common = { installation: c.installation_id, outbox: c.outbox, trustedKeys, policy };
  let result, store, cipher;
  const terminate = signal => { store?.close(); cipher?.close(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  const interrupt = () => terminate('SIGINT'), stop = () => terminate('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', stop);
  try {
    if (mode === '--prepare' || mode === '--fork') {
      const signingKey = signer(c, trustedKeys);
      const options = { ...common, signingKeyId: c.signing_key_id, signingKey };
      if (mode === '--prepare') cipher = new AgeCipher({ executable: c.age_executable, publicRecipient: c.public_recipient });
      result = mode === '--fork' ? await forkPrepared({ ...options, transport: source }) : await prepare({ ...options, bundle: source, recipientId: c.recipient_id, cipher });
    } else {
      store = storage(c);
      if (mode === '--retrieve') cipher = new AgeCipher({ executable: c.age_executable, identity: c.recovery_identity });
      result = mode === '--upload' ? await upload({ ...common, transport: source, store }) : mode === '--prune'
        ? await pruneConfirmed({ ...common, transport: source, store }) : await retrieve({ ...common, transport: source, destination, store, cipher });
    }
    report(result); return result;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', stop); store?.close(); cipher?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(JSON.stringify({ ok: false, error: typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'IO' }) + '\n');
    process.exitCode = 1;
  });
}
