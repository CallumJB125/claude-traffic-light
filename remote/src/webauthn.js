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
import { importPublicRaw, exportPublicRaw } from './keys.js';
import { canonicalize } from './canonical.js';

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

const val = async (v) => (typeof v === 'function' ? v() : v);

// ── Registration (W2-B) ─────────────────────────────────────────────────────
// Right after pairing, the phone creates a user-verified platform passkey and
// sends, over the end-to-end channel, its public key (getPublicKey(): SPKI),
// authenticatorData and clientDataJSON. Attestation is 'none': the passkey is
// trusted because the paired device (already authenticated by its keys) sent
// it, once, within a short window after pairing (src/remote-approvals-main.js).
// The challenge is fixed per (desktop, device), so a registration can't be
// moved to another pairing.
export function passkeyRegistrationChallenge({ desktopId, deviceId }) {
  return sha256(utf8(canonicalize({ t: 'buddy.passkey.reg', v: 1, did: desktopId, deviceId })));
}

// → { ok: true, publicKey (raw base64url), signCount } or { ok: false, reason }
// The attested credential data in a registration's authenticatorData
// (after rpIdHash, flags, counter): aaguid(16) ‖ idLen(2) ‖ id ‖ COSE key.
// Only the shape a P-256 ES256 passkey has: an EC2 map {1:2, 3:-7, -1:1,
// -2:x(32), -3:y(32)} (CTAP2 canonical CBOR). → {credentialId, raw} or null.
function attestedCredential(ad) {
  if (ad.length < 55) return null;
  const n = (ad[53] << 8) | ad[54];
  if (n < 16 || n > 1023 || ad.length < 55 + n) return null;
  const id = ad.slice(55, 55 + n);
  let i = 55 + n;
  if (ad[i++] !== 0xa5) return null;
  const want = [[0x01, [0x02]], [0x03, [0x26]], [0x20, [0x01]]];
  for (const [k, v] of want) { if (ad[i++] !== k || ad[i++] !== v[0]) return null; }
  if (ad[i++] !== 0x21 || ad[i++] !== 0x58 || ad[i++] !== 32) return null;
  const x = ad.slice(i, i + 32); i += 32;
  if (ad[i++] !== 0x22 || ad[i++] !== 0x58 || ad[i++] !== 32) return null;
  const y = ad.slice(i, i + 32); i += 32;
  if (x.length !== 32 || y.length !== 32 || i !== ad.length) return null;
  return { credentialId: b64url(id), raw: b64url(concatBytes(new Uint8Array([4]), x, y)) };
}

export async function verifyRegistration({ rpId, origins, expectedChallenge, clientDataJSON, authenticatorData, publicKey, algorithm, credentialId }) {
  if (algorithm !== -7) return { ok: false, reason: 'unsupported-algorithm' };
  let cdBytes, ad, spki;
  try {
    cdBytes = fromB64url(clientDataJSON);
    ad = fromB64url(authenticatorData);
    spki = fromB64url(publicKey);
  } catch { return { ok: false, reason: 'malformed' }; }
  let cd;
  try { cd = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cdBytes)); } catch { return { ok: false, reason: 'malformed-client-data' }; }
  if (!cd || cd.type !== 'webauthn.create') return { ok: false, reason: 'wrong-type' };
  if (typeof cd.challenge !== 'string' || cd.challenge !== b64url(expectedChallenge)) return { ok: false, reason: 'wrong-challenge' };
  if (!Array.isArray(origins) || !origins.includes(cd.origin)) return { ok: false, reason: 'wrong-origin' };
  if (cd.crossOrigin === true || cd.topOrigin !== undefined) return { ok: false, reason: 'cross-origin' };
  if (ad.length < 37) return { ok: false, reason: 'malformed-authenticator-data' };
  const rpIdHash = await sha256(utf8(rpId));
  for (let k = 0; k < 32; k++) if (ad[k] !== rpIdHash[k]) return { ok: false, reason: 'wrong-rp-id' };
  const flags = ad[32];
  if (!(flags & UP)) return { ok: false, reason: 'user-not-present' };
  if (!(flags & UV)) return { ok: false, reason: 'user-not-verified' };
  if (!(flags & AT)) return { ok: false, reason: 'no-attested-data' };
  if (spki.length > 200) return { ok: false, reason: 'bad-key' };
  let raw;
  try { raw = await exportPublicRaw(await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])); } catch { return { ok: false, reason: 'bad-key' }; }
  // The key and id the phone reports must be the ones in the authenticator's own data.
  const att = attestedCredential(ad);
  if (!att || att.raw !== raw || att.credentialId !== credentialId) return { ok: false, reason: 'credential-mismatch' };
  const signCount = ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36];
  return { ok: true, publicKey: raw, signCount };
}

// The RemoteApprovals secondFactor for passkeys: the device record's
// registered passkey must sign challenge = sha256(canonical decision payload)
// with user verification. No passkey registered → refused (never skipped).
// rpId / origins may be functions (read per decision: the pinned PWA origin).
export function passkeyFactor({ registry, rpId, origins }) {
  return async ({ device, payload, assertion }) => {
    const pk = device?.passkey;
    if (!pk || typeof pk.publicKey !== 'string') return { ok: false, reason: 'not-registered' };
    if (!assertion || typeof assertion !== 'object') return { ok: false, reason: 'missing' };
    const r = await verifyAssertion({
      publicKey: pk.publicKey, rpId: await val(rpId), origins: await val(origins), expectedChallenge: await webauthnChallengeFor(payload),
      authenticatorData: assertion.authenticatorData, clientDataJSON: assertion.clientDataJSON, signature: assertion.signature, prevSignCount: pk.signCount ?? 0,
    });
    if (!r.ok) return r;
    await registry.setSignCount(device.deviceId, r.signCount);
    return { ok: true };
  };
}
