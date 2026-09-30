// Desktop-side WebAuthn assertion verification, with assertions built the
// way a platform authenticator builds them (ES256, DER signature).
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAssertion, webauthnChallengeFor, derToRaw, generateSigningKey, exportPublicRaw, signDecision, createIdentity } from '../src/index.js';
import { b64url, utf8, concatBytes, fromB64url } from '../src/encoding.js';

const RP_ID = 'buddy.example.com';
const ORIGIN = 'https://buddy.example.com';
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

// P1363 r‖s → minimal DER, as authenticators emit.
function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = concatBytes(new Uint8Array([0]), v);
    return concatBytes(new Uint8Array([0x02, v.length]), v);
  };
  const body = concatBytes(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

async function assertion({ kp, challenge, rpId = RP_ID, origin = ORIGIN, type = 'webauthn.get', flags = 0x05, signCount = 7, crossOrigin, tamper } = {}) {
  const cd = { type, challenge: b64url(challenge), origin, ...(crossOrigin !== undefined ? { crossOrigin } : {}) };
  const clientDataJSON = utf8(JSON.stringify(cd));
  const ad = concatBytes(await sha256(utf8(rpId)), new Uint8Array([flags, (signCount >>> 24) & 255, (signCount >>> 16) & 255, (signCount >>> 8) & 255, signCount & 255]));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, concatBytes(ad, await sha256(clientDataJSON))));
  const a = { authenticatorData: b64url(ad), clientDataJSON: b64url(clientDataJSON), signature: b64url(rawToDer(raw)) };
  if (tamper) tamper(a);
  return a;
}

async function setup() {
  const kp = await generateSigningKey();
  const publicKey = await exportPublicRaw(kp.publicKey);
  const desk = await createIdentity();
  const { payload } = await signDecision({ device: { deviceId: 'd', privateKey: kp.privateKey }, desktopId: desk.desktopId, request: { requestId: 'r', sessionId: 's', cardId: null, toolName: 'Bash', toolInput: { command: 'npm test' } }, decision: 'allow' });
  const { canonicalize } = await import('../src/index.js');
  const challenge = await webauthnChallengeFor(canonicalize(payload));
  const verify = (a, extra = {}) => verifyAssertion({ publicKey, rpId: RP_ID, origins: [ORIGIN], expectedChallenge: challenge, ...a, ...extra });
  return { kp, challenge, verify };
}

test('a valid user-verified assertion over the decision challenge passes', async () => {
  const { kp, challenge, verify } = await setup();
  const r = await verify(await assertion({ kp, challenge }));
  assert.deepEqual(r, { ok: true, signCount: 7 });
});

test('each check fails closed', async () => {
  const { kp, challenge, verify } = await setup();
  const other = await generateSigningKey();
  const cases = [
    ['wrong-rp-id', { rpId: 'evil.example.com' }],
    ['wrong-origin', { origin: 'https://evil.example.com' }],
    ['wrong-type', { type: 'webauthn.create' }],
    ['wrong-challenge', { challenge: new Uint8Array(32) }],
    ['user-not-present', { flags: 0x04 }],
    ['user-not-verified', { flags: 0x01 }],
    ['unexpected-attested-data', { flags: 0x45 }],
    ['cross-origin', { crossOrigin: true }],
    ['bad-signature', { kp: other }],
    ['bad-signature', { tamper: (a) => { const ad = fromB64url(a.authenticatorData); ad[36] ^= 1; a.authenticatorData = b64url(ad); } }],
    ['bad-signature-encoding', { tamper: (a) => { const d = fromB64url(a.signature); a.signature = b64url(concatBytes(d, new Uint8Array([0]))); } }],
    ['malformed-authenticator-data', { tamper: (a) => { a.authenticatorData = b64url(new Uint8Array(10)); } }],
    ['malformed-client-data', { tamper: (a) => { a.clientDataJSON = b64url(utf8('{nope')); } }],
  ];
  for (const [reason, opts] of cases) {
    const r = await verify(await assertion({ kp, challenge, ...opts }));
    assert.deepEqual(r, { ok: false, reason }, reason);
  }
});

test('sign count must move forward when the authenticator keeps one', async () => {
  const { kp, challenge, verify } = await setup();
  assert.equal((await verify(await assertion({ kp, challenge, signCount: 7 }), { prevSignCount: 7 })).reason, 'sign-count-regressed');
  assert.equal((await verify(await assertion({ kp, challenge, signCount: 8 }), { prevSignCount: 7 })).ok, true);
  assert.equal((await verify(await assertion({ kp, challenge, signCount: 0 }), { prevSignCount: 0 })).ok, true, 'synced passkeys report 0');
});

test('DER → r‖s is strict', () => {
  const raw = new Uint8Array(64).fill(1);
  assert.deepEqual(derToRaw(rawToDer(raw)), raw);
  const high = new Uint8Array(64).fill(0xff);
  assert.deepEqual(derToRaw(rawToDer(high)), high);
  const der = rawToDer(raw);
  const bad = [
    der.slice(0, der.length - 1),
    concatBytes(new Uint8Array([0x31]), der.slice(1)),
    (() => { const d = der.slice(); d[3] = 0x21; return d; })(),
    concatBytes(new Uint8Array([0x30, der.length - 1, 0x02, 0x21, 0x00, 0x01]), der.slice(4 + 32)),
  ];
  for (const b of bad) assert.throws(() => derToRaw(b));
});
