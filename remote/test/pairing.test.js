import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingClient, parsePairingQr, InMemoryHub, generateSigningKey, exportPublicRaw, signObject, createIdentity, PAIRING_TTL_MS } from '../src/index.js';
import { makeDesktop, pairPhone } from './helpers.js';

async function startOnPhone(desk, opts = {}) {
  const { qrText, pid, qr: raw } = await desk.pairing.start();
  const qr = parsePairingQr(qrText, { now: desk.clock() });
  const phone = await PairingClient.begin(qr, { deviceName: 'Alice iPhone', ...opts });
  return { pid, qr, raw, phone };
}
const send = (desk, kind, body) => desk.hub.forward({ v: 1, to: desk.identity.desktopId, kind, body });

test('happy path: QR → init → challenge → reveal → matching SAS → confirm → device registered', async () => {
  const desk = await makeDesktop();
  const { pid, qr, phone } = await startOnPhone(desk);
  assert.equal(qr.hub, 'https://hub.example.ts.net');
  assert.equal(qr.dpk, desk.identity.publicRaw);

  const r1 = await send(desk, 'pair-init', phone.init);
  assert.equal(r1.status, 'delivered');
  assert.equal(r1.body.ok, true);
  const { reveal, sas } = await phone.onChallenge(r1.body.challenge);
  assert.match(sas, /^\d{6}$/);

  const r2 = await send(desk, 'pair-reveal', reveal);
  assert.equal(r2.body.ok, true);
  assert.equal(r2.body.sas, sas, 'both screens show the same code');
  assert.equal(r2.body.deviceName, 'Alice iPhone');

  assert.deepEqual((await send(desk, 'pair-poll', { pid })).body, { ok: true, state: 'waiting' });
  const done = await desk.pairing.confirm(pid, true);
  assert.equal(done.ok, true);

  const r3 = await send(desk, 'pair-poll', { pid });
  const paired = await phone.onComplete(r3.body.complete);
  assert.equal(paired.deviceId, done.device.deviceId);
  assert.equal(paired.ownerId, 'alice');
  assert.equal(paired.desktopId, desk.identity.desktopId);

  const [dev] = await desk.registry.list();
  assert.equal(dev.name, 'Alice iPhone');
  assert.equal(dev.ownerId, 'alice');
  assert.equal(dev.createdAt, desk.clock());
  assert.equal(dev.lastUsedAt, null);
  assert.equal(dev.revokedAt, null);
  assert.ok(desk.audit.some((e) => e.type === 'remote.pair.completed' && e.deviceId === dev.deviceId));

  // The hub relayed everything but never saw the pairing secret.
  const seen = JSON.stringify(desk.hub.log);
  assert.ok(!seen.includes(qr.s), 'pairing secret crossed the hub');
});

test('the QR is single-use: a replayed init after pairing is refused', async () => {
  const desk = await makeDesktop();
  const { pid, phone } = await startOnPhone(desk);
  const r1 = await send(desk, 'pair-init', phone.init);
  const { reveal } = await phone.onChallenge(r1.body.challenge);
  await send(desk, 'pair-reveal', reveal);
  await desk.pairing.confirm(pid, true);
  const again = await send(desk, 'pair-init', phone.init);
  assert.equal(again.body.ok, false);
  assert.equal(again.body.reason, 'unknown-pairing');
  assert.equal((await desk.registry.list()).length, 1);
});

test('relay MITM without the QR secret: swapping in its own key fails the MAC and burns the pairing', async () => {
  const desk = await makeDesktop();
  const { pid, phone } = await startOnPhone(desk);
  const attacker = await generateSigningKey();
  const forged = { ...phone.init, devicePub: await exportPublicRaw(attacker.publicKey) };
  const r = await send(desk, 'pair-init', forged);
  assert.deepEqual([r.body.ok, r.body.reason], [false, 'bad-mac']);
  // Burned: the real phone's init no longer works either (user re-scans).
  const real = await send(desk, 'pair-init', phone.init);
  assert.equal(real.body.ok, false);
  assert.equal((await desk.registry.list()).length, 0);
  assert.ok(desk.audit.some((e) => e.type === 'remote.pair.failed' && e.pid === pid && e.reason === 'bad-mac'));
});

test('relay MITM WITH a leaked QR secret: the phone detects the swap and the codes differ', async () => {
  const desk = await makeDesktop();
  const { pid, qr, phone } = await startOnPhone(desk);
  // The attacker photographed the QR and controls the hub: it holds back the
  // phone's init and runs its own pairing with the same QR.
  const mallory = await PairingClient.begin(qr, { deviceName: 'Alice iPhone' });
  const r1 = await send(desk, 'pair-init', mallory.init);
  assert.equal(r1.body.ok, true);
  // It passes the desktop's challenge on to the real phone: the desktop signed
  // Mallory's key, so the phone refuses and never shows a code.
  await assert.rejects(phone.onChallenge(r1.body.challenge), /tampered/);
  // Mallory finishes its own side; the desktop shows Mallory's code, which the
  // phone (showing nothing / an error) cannot match. The human says no.
  const { reveal, sas: mallorySas } = await mallory.onChallenge(r1.body.challenge);
  const r2 = await send(desk, 'pair-reveal', reveal);
  assert.equal(r2.body.sas, mallorySas);
  const refused = await desk.pairing.confirm(pid, false);
  assert.deepEqual([refused.ok, refused.reason], [false, 'codes-did-not-match']);
  assert.equal((await desk.registry.list()).length, 0);
});

test('commit/reveal: a reveal that does not match the committed nonce is refused', async () => {
  const desk = await makeDesktop();
  const { phone } = await startOnPhone(desk);
  const r1 = await send(desk, 'pair-init', phone.init);
  const { reveal } = await phone.onChallenge(r1.body.challenge);
  // A relay can't pick nP after seeing nD: changing it breaks the MAC…
  const r2 = await send(desk, 'pair-reveal', { ...reveal, nP: reveal.nP.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) });
  assert.equal(r2.body.ok, false);
  assert.equal(r2.body.reason, 'bad-mac');
});

test('commit/reveal: even with the QR secret, a different nP than committed is refused', async () => {
  const desk = await makeDesktop();
  const { phone } = await startOnPhone(desk);
  const r1 = await send(desk, 'pair-init', phone.init);
  await phone.onChallenge(r1.body.challenge);
  const { canonicalize } = await import('../src/canonical.js');
  const { b64url, utf8 } = await import('../src/encoding.js');
  const nP = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const key = await crypto.subtle.importKey('raw', phone.secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = b64url(await crypto.subtle.sign('HMAC', key, utf8(canonicalize({ t: 'pair-reveal', pid: phone.qr.pid, nP }))));
  const r2 = await send(desk, 'pair-reveal', { t: 'pair-reveal', pid: phone.qr.pid, nP, mac });
  assert.deepEqual([r2.body.ok, r2.body.reason], [false, 'commit-mismatch']);
});

test('a challenge or completion not signed by the QR desktop key is rejected by the phone', async () => {
  const desk = await makeDesktop();
  const { phone } = await startOnPhone(desk);
  const r1 = await send(desk, 'pair-init', phone.init);
  const imposter = await createIdentity();
  const fake = await signObject(imposter.privateKey, JSON.parse(r1.body.challenge.payload));
  await assert.rejects(phone.onChallenge(fake), /not signed by this desktop/);
  const { reveal } = await phone.onChallenge(r1.body.challenge);
  await send(desk, 'pair-reveal', reveal);
  const fakeDone = await signObject(imposter.privateKey, { t: 'pair-complete', pid: phone.qr.pid, did: phone.qr.did, devicePub: phone.devicePub, deviceId: 'x', ownerId: 'mallory' });
  await assert.rejects(phone.onComplete(fakeDone), /not valid/);
});

test('a QR whose desktop key does not match its id is refused by the phone', async () => {
  const desk = await makeDesktop();
  const { qr } = await startOnPhone(desk);
  const other = await createIdentity();
  await assert.rejects(PairingClient.begin({ ...qr, dpk: other.publicRaw }), /inconsistent/);
});

test('expired QR: refused on the phone, and by the desktop if it arrives late', async () => {
  const desk = await makeDesktop();
  const { qrText } = await desk.pairing.start();
  assert.throws(() => parsePairingQr(qrText, { now: desk.clock() + PAIRING_TTL_MS + 1 }), /expired/);

  const { phone } = await startOnPhone(desk);
  desk.clock.advance(PAIRING_TTL_MS + 1);
  const r = await send(desk, 'pair-init', phone.init);
  assert.equal(r.body.ok, false);
  assert.ok(['expired', 'unknown-pairing'].includes(r.body.reason));
  assert.equal((await desk.registry.list()).length, 0);
});

test('a pairing that expires while awaiting confirm cannot be confirmed', async () => {
  const desk = await makeDesktop();
  const { pid, phone } = await startOnPhone(desk);
  const r1 = await send(desk, 'pair-init', phone.init);
  const { reveal } = await phone.onChallenge(r1.body.challenge);
  await send(desk, 'pair-reveal', reveal);
  desk.clock.advance(PAIRING_TTL_MS + 1);
  const c = await desk.pairing.confirm(pid, true);
  assert.equal(c.ok, false);
  assert.equal((await desk.registry.list()).length, 0);
});

test('non-https hub URLs and junk QR codes are refused', async () => {
  const desk = await makeDesktop();
  const { qr } = await desk.pairing.start();
  assert.throws(() => parsePairingQr(JSON.stringify({ ...qr, hub: 'http://evil.example' }), { now: desk.clock() }), /https/);
  assert.throws(() => parsePairingQr('hello', { now: desk.clock() }), /not a Buddy/);
  assert.throws(() => parsePairingQr(JSON.stringify({ ...qr, t: 'other' }), { now: desk.clock() }), /not a Buddy/);
});

test('pairing confirm is not reachable through the relay', async () => {
  const desk = await makeDesktop();
  const { pid } = await desk.pairing.start();
  const r = await desk.hub.forward({ v: 1, to: desk.identity.desktopId, kind: 'pair-confirm', body: { pid, codesMatch: true } });
  assert.equal(r.status, 'bad-request');
});

test('device names are cleaned of control and bidi characters', async () => {
  const desk = await makeDesktop();
  await pairPhone(desk, { deviceName: 'Evil‮enohp\u0007 ' + 'x'.repeat(100) });
  const [dev] = await desk.registry.list();
  assert.doesNotMatch(dev.name, /[‮\u0007]/);
  assert.ok(dev.name.length <= 64);
});

test('revoke one device, then revoke all', async () => {
  const hub = new InMemoryHub();
  const desk = await makeDesktop({ hub });
  const a = await pairPhone(desk, { deviceName: 'phone A' });
  const b = await pairPhone(desk, { deviceName: 'phone B' });
  assert.equal(await desk.registry.revoke(a.deviceId), true);
  assert.equal(await desk.registry.revoke(a.deviceId), false, 'already revoked');
  assert.equal(await desk.registry.activeKey(a.deviceId), null);
  assert.ok(await desk.registry.activeKey(b.deviceId));
  assert.equal(await desk.registry.revokeAll(), 1);
  assert.equal(await desk.registry.activeKey(b.deviceId), null);
  const list = await desk.registry.list();
  assert.equal(list.length, 2, 'revoked records are kept for the audit trail');
  assert.ok(list.every((d) => d.revokedAt));
});

test('open pairings are capped', async () => {
  const desk = await makeDesktop();
  for (let i = 0; i < 4; i++) await desk.pairing.start();
  await assert.rejects(desk.pairing.start(), /too many/);
});
