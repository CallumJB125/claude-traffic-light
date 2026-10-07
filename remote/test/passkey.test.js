// W2-B: passkey registration and the per-decision passkey second factor in
// RemoteApprovals, with a software "platform authenticator" (ES256, DER
// signatures, UP+UV flags) standing in for Face ID / Touch ID.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RemoteApprovals, MemoryPendingStore, DeviceRegistry, createIdentity, generateSigningKey, exportPublicRaw, signDecision,
  passkeyFactor, passkeyRegistrationChallenge, verifyRegistration, webauthnChallengeFor,
} from '../src/index.js';
import { fakeClock, bashRequest, virtualAuthenticator } from './helpers.js';

const RP_ID = 'hub.example.dev';
const ORIGIN = 'https://hub.example.dev';
async function rig() {
  const clock = fakeClock();
  const identity = await createIdentity();
  const registry = new DeviceRegistry({ clock });
  const pending = new MemoryPendingStore();
  const audit = [];
  const approvals = new RemoteApprovals({ identity, registry, pending, clock, audit: (e) => audit.push(e), secondFactor: passkeyFactor({ registry, rpId: () => RP_ID, origins: () => [ORIGIN] }) });
  const phone = await generateSigningKey();
  const dev = await registry.add({ publicKey: await exportPublicRaw(phone.publicKey), name: 'Alice iPhone', ownerId: 'alice' });
  const auth = await virtualAuthenticator({ rpId: RP_ID, origin: ORIGIN });
  const reg = await verifyRegistration({ rpId: RP_ID, origins: [ORIGIN], expectedChallenge: await passkeyRegistrationChallenge({ desktopId: identity.desktopId, deviceId: dev.deviceId }), ...(await auth.register(await passkeyRegistrationChallenge({ desktopId: identity.desktopId, deviceId: dev.deviceId }))) });
  assert.equal(reg.ok, true, reg.reason);
  assert.equal(await registry.setPasskey(dev.deviceId, { credentialId: auth.credentialId, publicKey: reg.publicKey, signCount: reg.signCount }), true);
  const req = pending.add(bashRequest({ toolInput: { command: 'git status' } }));
  const sign = async (decision = 'allow', request = req) => signDecision({ device: { deviceId: dev.deviceId, privateKey: phone.privateKey }, desktopId: identity.desktopId, request, decision, now: clock() });
  return { clock, identity, registry, pending, approvals, audit, phone, dev, auth, req, sign };
}

test('registration: only a user-verified webauthn.create for this device, origin and rp id', async () => {
  const { identity, dev, auth } = await rig();
  const challenge = await passkeyRegistrationChallenge({ desktopId: identity.desktopId, deviceId: dev.deviceId });
  const verify = async (a, extra = {}) => verifyRegistration({ rpId: RP_ID, origins: [ORIGIN], expectedChallenge: challenge, ...a, ...extra });
  assert.equal((await verify(await auth.register(challenge))).ok, true);
  assert.equal((await verify(await auth.register(challenge, { type: 'webauthn.get' }))).reason, 'wrong-type');
  assert.equal((await verify(await auth.register(challenge, { origin: 'https://evil.example' }))).reason, 'wrong-origin');
  assert.equal((await verify(await auth.register(challenge, { flags: 0x01 }))).reason, 'user-not-verified');
  const other = await passkeyRegistrationChallenge({ desktopId: identity.desktopId, deviceId: 'someone-else' });
  assert.equal((await verify(await auth.register(other))).reason, 'wrong-challenge');
  assert.equal((await verify(await auth.register(challenge), { algorithm: -257 })).reason, 'unsupported-algorithm');
  assert.equal((await verify(await auth.register(challenge), { rpId: 'other.example' })).reason, 'wrong-rp-id');
  // The phone must report the key and id the authenticator itself put in authenticatorData.
  const other2 = await virtualAuthenticator({ rpId: RP_ID, origin: ORIGIN });
  const swapped = await other2.register(challenge);
  assert.equal((await verify({ ...(await auth.register(challenge)), publicKey: swapped.publicKey })).reason, 'credential-mismatch');
  assert.equal((await verify({ ...(await auth.register(challenge)), credentialId: other2.credentialId })).reason, 'credential-mismatch');
  assert.equal((await verify(await auth.register(challenge, { noAttested: true }))).reason, 'no-attested-data');
});

test('a passkey is set once per pairing; a revoked device gets none', async () => {
  const { registry, dev, auth } = await rig();
  const again = await virtualAuthenticator({ rpId: RP_ID, origin: ORIGIN });
  assert.equal(await registry.setPasskey(dev.deviceId, { credentialId: again.credentialId, publicKey: (await registry.get(dev.deviceId)).passkey.publicKey }), false);
  await registry.revoke(dev.deviceId);
  assert.equal((await registry.get(dev.deviceId)).passkey.credentialId, auth.credentialId);
});

test('an approval with a fresh passkey assertion over that decision is applied', async () => {
  const r = await rig();
  const { envelope } = await r.sign();
  const assertion = await r.auth.assert(await webauthnChallengeFor(envelope.payload));
  const out = await r.approvals.handleDecision(envelope, { channelDevice: r.dev.deviceId, assertion });
  assert.equal(out.status, 'applied', out.reason);
  assert.equal(r.pending.settledOf(r.req.requestId).decision, 'allow');
});

test('no assertion, a reused assertion, a wrong origin or no user verification: refused, nothing settles', async () => {
  const r = await rig();
  const cases = [
    ['missing', async () => null],
    ['wrong-challenge', async () => r.auth.assert(await webauthnChallengeFor((await r.sign('allow', r.pending.add(bashRequest()))).envelope.payload))],
    ['wrong-origin', async (p) => r.auth.assert(await webauthnChallengeFor(p), { origin: 'https://evil.example' })],
    ['user-not-verified', async (p) => r.auth.assert(await webauthnChallengeFor(p), { flags: 0x01 })],
  ];
  for (const [why, make] of cases) {
    const { envelope } = await r.sign();
    const out = await r.approvals.handleDecision(envelope, { channelDevice: r.dev.deviceId, assertion: await make(envelope.payload) });
    assert.equal(out.status, 'rejected', why);
    assert.equal(out.reason, 'passkey-required', why);
    assert.equal(out.event.passkeyReason, why);
  }
  assert.equal(r.pending.settledOf(r.req.requestId), null);
});

test('a device with no passkey can never approve, even with a valid signature', async () => {
  const r = await rig();
  const phone2 = await generateSigningKey();
  const dev2 = await r.registry.add({ publicKey: await exportPublicRaw(phone2.publicKey), name: 'Old phone', ownerId: 'alice' });
  const { envelope } = await signDecision({ device: { deviceId: dev2.deviceId, privateKey: phone2.privateKey }, desktopId: r.identity.desktopId, request: r.req, decision: 'allow', now: r.clock() });
  const out = await r.approvals.handleDecision(envelope, { channelDevice: dev2.deviceId, assertion: await r.auth.assert(await webauthnChallengeFor(envelope.payload)) });
  assert.deepEqual([out.status, out.reason, out.event.passkeyReason], ['rejected', 'passkey-required', 'not-registered']);
});

test('a decision must come through the signing device\'s own end-to-end channel', async () => {
  const r = await rig();
  const { envelope } = await r.sign();
  const out = await r.approvals.handleDecision(envelope, { channelDevice: 'another-paired-device', assertion: await r.auth.assert(await webauthnChallengeFor(envelope.payload)) });
  assert.deepEqual([out.status, out.reason], ['rejected', 'channel-mismatch']);
});

test('a decision is never valid more than 120 s from now, even issued "in the future" within the skew', async () => {
  const r = await rig();
  const { signDecision: sd } = await import('../src/index.js');
  const { envelope } = await sd({ device: { deviceId: r.dev.deviceId, privateKey: r.phone.privateKey }, desktopId: r.identity.desktopId, request: r.req, decision: 'allow', now: r.clock() + 29_000, ttlMs: 120_000 });
  const out = await r.approvals.handleDecision(envelope, { channelDevice: r.dev.deviceId, assertion: null });
  assert.equal(out.reason, 'bad-expiry');
});

test('the passkey is checked after expiry and replay: an expired decision is refused as expired', async () => {
  const r = await rig();
  const { envelope } = await r.sign();
  r.clock.advance(121_000);
  const out = await r.approvals.handleDecision(envelope, { channelDevice: r.dev.deviceId, assertion: null });
  assert.equal(out.reason, 'expired');
});

test('a revoked device is refused before any passkey check', async () => {
  const r = await rig();
  const { envelope } = await r.sign();
  await r.registry.revoke(r.dev.deviceId);
  const out = await r.approvals.handleDecision(envelope, { channelDevice: r.dev.deviceId, assertion: await r.auth.assert(await webauthnChallengeFor(envelope.payload)) });
  assert.equal(out.reason, 'revoked');
});

test('a counter that goes backwards is refused once it has started counting', async () => {
  const r = await rig();
  let { envelope } = await r.sign();
  assert.equal((await r.approvals.handleDecision(envelope, { channelDevice: r.dev.deviceId, assertion: await r.auth.assert(await webauthnChallengeFor(envelope.payload), { count: 5 }) })).status, 'applied');
  assert.equal((await r.registry.get(r.dev.deviceId)).passkey.signCount, 5);
  const req2 = r.pending.add(bashRequest());
  ({ envelope } = await r.sign('allow', req2));
  const out = await r.approvals.handleDecision(envelope, { channelDevice: r.dev.deviceId, assertion: await r.auth.assert(await webauthnChallengeFor(envelope.payload), { count: 3 }) });
  assert.deepEqual([out.reason, out.event.passkeyReason], ['passkey-required', 'sign-count-regressed']);
});
