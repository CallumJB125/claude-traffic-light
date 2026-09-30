// Desktop-side verification of a WebAuthn (passkey) assertion over a remote
// decision — the R1 upgrade in THREAT_MODEL.md. The phone asks the platform
// authenticator to sign challenge = sha256(canonical decision payload) with a
// user-verified (Face ID / Touch ID) ES256 passkey; the desktop checks:
//   clientDataJSON: type 'webauthn.get', challenge, origin ∈ pinned origins,
//                   not cross-origin
//   authenticatorData: rpIdHash == sha256(rpId), UP and UV set, sign count
//                   not regressed
//   signature: ES256 (DER from WebAuthn → r‖s for WebCrypto) over
//              authenticatorData ‖ sha256(clientDataJSON)
// Isomorphic (WebCrypto only). The PWA side comes with the PWA.
import { b64url, fromB64url, utf8, concatBytes } from './encoding.js';
import { importPublicRaw } from './keys.js';

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

export function webauthnChallengeFor(decisionPayloadText) {
  return sha256(utf8(decisionPayloadText));
}

// Strict DER ECDSA-Sig-Value → 64-byte r‖s. Throws on anything non-minimal.
export function derToRaw(der) {
  const fail = () => { throw new TypeError('bad DER signature'); };
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) fail();
  let i = 2;
  const int = () => {
    if (der[i] !== 0x02) fail();
    const len = der[i + 1];
    if (len < 1 || len > 33 || i + 2 + len > der.length) fail();
    let v = der.slice(i + 2, i + 2 + len);
    if (v[0] & 0x80) fail(); // negative
    if (len > 1 && v[0] === 0 && !(v[1] & 0x80)) fail(); // non-minimal
    if (v[0] === 0) v = v.slice(1);
    if (v.length > 32) fail();
    i += 2 + len;
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = int();
  const s = int();
  if (i !== der.length) fail();
  return concatBytes(r, s);
}

// → { ok: true, signCount } or { ok: false, reason }
export async function verifyAssertion({ publicKey, rpId, origins, expectedChallenge, authenticatorData, clientDataJSON, signature, prevSignCount = 0 }) {
  let cdBytes, ad, der;
  try {
    cdBytes = fromB64url(clientDataJSON);
    ad = fromB64url(authenticatorData);
    der = fromB64url(signature);
  } catch { return { ok: false, reason: 'malformed' }; }

  let cd;
  try { cd = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cdBytes)); } catch { return { ok: false, reason: 'malformed-client-data' }; }
  if (!cd || cd.type !== 'webauthn.get') return { ok: false, reason: 'wrong-type' };
  if (typeof cd.challenge !== 'string' || cd.challenge !== b64url(expectedChallenge)) return { ok: false, reason: 'wrong-challenge' };
  if (!Array.isArray(origins) || !origins.includes(cd.origin)) return { ok: false, reason: 'wrong-origin' };
  if (cd.crossOrigin === true || cd.topOrigin !== undefined) return { ok: false, reason: 'cross-origin' };

  if (ad.length < 37) return { ok: false, reason: 'malformed-authenticator-data' };
  const rpIdHash = await sha256(utf8(rpId));
  for (let k = 0; k < 32; k++) if (ad[k] !== rpIdHash[k]) return { ok: false, reason: 'wrong-rp-id' };
  const flags = ad[32];
  if (!(flags & UP)) return { ok: false, reason: 'user-not-present' };
  if (!(flags & UV)) return { ok: false, reason: 'user-not-verified' };
  if (flags & AT) return { ok: false, reason: 'unexpected-attested-data' };
  const signCount = ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36];
  if ((signCount !== 0 || prevSignCount !== 0) && signCount <= prevSignCount) return { ok: false, reason: 'sign-count-regressed' };

  let raw;
  try { raw = derToRaw(der); } catch { return { ok: false, reason: 'bad-signature-encoding' }; }
  let key = publicKey;
  try { if (typeof key === 'string') key = await importPublicRaw(key); } catch { return { ok: false, reason: 'bad-key' }; }
  const signed = concatBytes(ad, await sha256(cdBytes));
  let ok = false;
  try { ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, signed); } catch { ok = false; }
  return ok ? { ok: true, signCount } : { ok: false, reason: 'bad-signature' };
}
