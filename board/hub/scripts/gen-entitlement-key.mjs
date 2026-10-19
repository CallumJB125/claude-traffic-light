#!/usr/bin/env node
// Make the hub's entitlement signing key (Ed25519). OWNER-GATED: run it once
// on the hub host, never commit its output file.
//
//   node board/hub/scripts/gen-entitlement-key.mjs --out /path/outside/the/repo/entitlement-key.pem
//
// Writes the PRIVATE key (PKCS#8 PEM, mode 0600, refuses to overwrite) to
// --out; point the hub at it with BOARD_ENTITLEMENT_KEY_FILE. Prints only the
// PUBLIC key, ready to paste into the app's src/entitlement-keys.js so every
// install can verify tokens offline. Rotating: add the new public key next to
// the old one in a release, switch the hub's file, drop the old key later.

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = at >= 0 ? args[at + 1] : null;
if (!out) {
  process.stderr.write('usage: gen-entitlement-key.mjs --out <private-key-file>\n');
  process.exit(2);
}
const file = resolve(out);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
try {
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
} catch (e) {
  process.stderr.write(`could not write ${file}: ${e.code === 'EEXIST' ? 'it already exists (refusing to overwrite a signing key)' : e.message}\n`);
  process.exit(1);
}
const pem = publicKey.export({ type: 'spki', format: 'pem' }).trim();
process.stdout.write(`Private key written to ${file} (set BOARD_ENTITLEMENT_KEY_FILE=${file} on the hub).\n\n`);
process.stdout.write(`Public key to pin in src/entitlement-keys.js:\n\n${pem}\n\n`);
process.stdout.write(`  ENTITLEMENT_KEYS = Object.freeze([\n    ${JSON.stringify(`${pem}\n`)},\n  ]);\n`);
