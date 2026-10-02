// Explicit operator tool. No scheduler, live cutover, key generation or cloud
// provisioning is performed by this command. JSON stdout contains metadata only.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AgeCipher } from './age.mjs';
import { S3Store } from './s3.mjs';
import { prepare, upload, retrieve, forkPrepared, pruneConfirmed } from './offsite-lib.mjs';
import { fail, keyId, uuid, limits } from './schema.mjs';
import { open, readJson } from './files.mjs';

function key(file, privateKey = false) {
  const { fd } = open(file, 16384);
  try { const v = (privateKey ? createPrivateKey : createPublicKey)(fs.readFileSync(fd));
    if (v.type !== (privateKey ? 'private' : 'public') || v.asymmetricKeyType !== 'ed25519') fail('KEY'); return v;
  } catch { fail('KEY'); } finally { fs.closeSync(fd); }
}
export async function main(args, report = (value) => process.stdout.write(JSON.stringify(value) + '\n')) {
  const [mode, configFile, source, destination, ...extra] = args;
  if (extra.length || !['--prepare','--upload','--retrieve','--fork','--prune'].includes(mode) || !configFile || !source
    || ((mode === '--retrieve') !== Boolean(destination))) fail('USAGE');
  const c = readJson(configFile, 65536);
  const allowed = ['installation_id','outbox','recipient_id','public_recipient','age_executable','recovery_identity','signing_key_id','signing_private_key','trusted_signing_keys','policy','storage'];
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !allowed.includes(k))) fail('CONFIG');
  uuid(c.installation_id); const policy = limits(c.policy ?? {}), trustedKeys = new Map();
  if (!c.trusted_signing_keys || typeof c.trusted_signing_keys !== 'object' || Array.isArray(c.trusted_signing_keys) || Object.keys(c.trusted_signing_keys).length < 1 || Object.keys(c.trusted_signing_keys).length > 16) fail('CONFIG');
  for (const [id, file] of Object.entries(c.trusted_signing_keys)) trustedKeys.set(keyId(id), key(file));
  const common = { installation: c.installation_id, outbox: c.outbox, trustedKeys, policy };
  let result, store, cipher;
  const terminate = signal => { store?.close(); cipher?.close(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  const interrupt = () => terminate('SIGINT'), stop = () => terminate('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', stop);
  try {
    if (mode === '--prepare' || mode === '--fork') {
      const signingKey = key(c.signing_private_key, true); keyId(c.signing_key_id);
      if (!trustedKeys.has(c.signing_key_id) || !createPublicKey(signingKey).equals(trustedKeys.get(c.signing_key_id))) fail('KEY');
      const options = { ...common, signingKeyId: c.signing_key_id, signingKey };
      if (mode === '--prepare') cipher = new AgeCipher({ executable: c.age_executable, publicRecipient: c.public_recipient });
      result = mode === '--fork' ? await forkPrepared({ ...options, transport: source }) : await prepare({ ...options, bundle: source, recipientId: c.recipient_id, cipher });
    } else {
      if (!c.storage || Object.keys(c.storage).some(k => !['endpoint','bucket','accessKeyId','secretAccessKey','sessionToken'].includes(k))) fail('CONFIG');
      store = new S3Store(c.storage);
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
