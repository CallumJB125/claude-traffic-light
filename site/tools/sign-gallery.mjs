// The owner's offline gallery signer. Run after `node site/gallery-build.js
// --write`, on the machine that holds the private key, then commit
// gallery/index.json and gallery/index.json.sig together. The Pages build
// and CI never sign.
//
//   node site/tools/sign-gallery.mjs gallery/index.json <private.pem>
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const V = require('../../src/plugins/index-verify.js');
const S = require('../../src/gallery-schema.js');
const { check } = require('../gallery-build.js');

const [indexFile, keyFile] = process.argv.slice(2);
if (!indexFile || !keyFile) { console.error('usage: node site/tools/sign-gallery.mjs gallery/index.json <private.pem>'); process.exit(2); }
const bytes = fs.readFileSync(indexFile);
// Only ever sign the index built from gallery/items as committed now.
let built;
try { built = check(); } catch (e) { console.error(e.message); process.exit(1); }
if (built.stale || !bytes.equals(Buffer.from(built.text))) { console.error('refusing to sign: this is not the index built from gallery/items. Run node site/gallery-build.js --write first.'); process.exit(1); }
const parsed = V.parseUnsigned(bytes, { maxBytes: S.LIMITS.indexBytes, validateIndex: S.validateIndex });
if (parsed.status !== 'unsigned') { console.error(`not a gallery index (${parsed.reason})`); process.exit(1); }
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
if (privateKey.asymmetricKeyType !== 'ed25519') { console.error(`key is ${privateKey.asymmetricKeyType}, not ed25519`); process.exit(1); }
const publicKey = crypto.createPublicKey(privateKey);
// keysFromPems drops the legacy dev key, so an empty result means it was that key.
if (!V.keysFromPems([publicKey.export({ type: 'spki', format: 'pem' })]).length) { console.error('refusing to sign with the dev key'); process.exit(1); }
const sig = { alg: 'ed25519', keyId: V.keyId(publicKey), sig: crypto.sign(null, bytes, privateKey).toString('base64') };
fs.writeFileSync(`${indexFile}.sig`, JSON.stringify(sig));
console.log(`[gallery] signed ${indexFile} with key ${sig.keyId}: wrote ${indexFile}.sig`);
