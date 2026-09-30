// ECDSA P-256 / SHA-256 through WebCrypto (globalThis.crypto.subtle), the
// only signature algorithm available on every target: iOS/iPadOS Safari
// 16.4+ home-screen PWAs have no Ed25519 (WebKit added it in Safari 17), and
// Node ≥22 implements the same API. Signatures are IEEE P1363 (r‖s, 64 bytes),
// which is what WebCrypto produces on both sides.
import { b64url, fromB64url, utf8 } from './encoding.js';
import { canonicalize } from './canonical.js';

const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

// The phone keeps its private key non-extractable (stored as a CryptoKey in
// IndexedDB, never as bytes). The desktop needs extractable to persist it.
export function generateSigningKey({ extractable = false } = {}) {
  return crypto.subtle.generateKey(ALG, extractable, ['sign', 'verify']);
}

export async function exportPublicRaw(publicKey) {
  return b64url(await crypto.subtle.exportKey('raw', publicKey));
}

// Uncompressed SEC1 point only; WebCrypto rejects points not on the curve.
export async function importPublicRaw(rawB64) {
  const raw = fromB64url(rawB64);
  if (raw.length !== 65 || raw[0] !== 0x04) throw new TypeError('expected an uncompressed P-256 public key');
  return crypto.subtle.importKey('raw', raw, ALG, true, ['verify']);
}

export async function exportPrivateJwk(privateKey) {
  return crypto.subtle.exportKey('jwk', privateKey);
}

export async function importKeyPairJwk(privateJwk) {
  const { d, ...pub } = privateJwk;
  if (!d) throw new TypeError('not a private JWK');
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk, ALG, false, ['sign']);
  const publicKey = await crypto.subtle.importKey('jwk', { ...pub, key_ops: ['verify'] }, ALG, true, ['verify']);
  return { privateKey, publicKey };
}

// A key's id: SHA-256 of the raw public key, base64url, 32 chars (192 bits).
// Device and desktop ids are derived from their keys, so an id can never be
// re-pointed at a different key.
export async function fingerprint(rawB64) {
  return b64url(await crypto.subtle.digest('SHA-256', fromB64url(rawB64))).slice(0, 32);
}

export async function signBytes(privateKey, bytes) {
  return b64url(await crypto.subtle.sign(SIGN, privateKey, bytes));
}

export async function verifyBytes(publicKey, sigB64, bytes) {
  let sig;
  try { sig = fromB64url(sigB64); } catch { return false; }
  if (sig.length !== 64) return false;
  try { return await crypto.subtle.verify(SIGN, publicKey, sig, bytes); } catch { return false; }
}

// A signed object travels as the exact canonical text that was signed, so
// the verifier checks the bytes it received rather than a re-serialisation.
export async function signObject(privateKey, obj) {
  const payload = canonicalize(obj);
  return { payload, sig: await signBytes(privateKey, utf8(payload)) };
}

// Returns the parsed object, or null. Rejects payloads that aren't in
// canonical form (duplicate keys, whitespace, reordered keys), so two
// parsers can never disagree about what was signed.
export async function verifyObject(publicKey, env, { maxBytes = 16384 } = {}) {
  if (!env || typeof env !== 'object' || typeof env.payload !== 'string' || typeof env.sig !== 'string') return null;
  const bytes = utf8(env.payload);
  if (bytes.length > maxBytes) return null;
  if (!(await verifyBytes(publicKey, env.sig, bytes))) return null;
  return parseCanonical(env.payload);
}

export function parseCanonical(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  try { if (canonicalize(obj) !== text) return null; } catch { return null; }
  return obj;
}

// The desktop's long-term identity: { privateKey, publicKey, publicRaw,
// desktopId, jwk }. `jwk` is what node/file-store.js persists (0600).
export async function createIdentity() {
  const kp = await generateSigningKey({ extractable: true });
  return identityFromJwk(await exportPrivateJwk(kp.privateKey));
}

export async function identityFromJwk(jwk) {
  const { privateKey, publicKey } = await importKeyPairJwk(jwk);
  const publicRaw = await exportPublicRaw(publicKey);
  return { privateKey, publicKey, publicRaw, desktopId: await fingerprint(publicRaw), jwk };
}
