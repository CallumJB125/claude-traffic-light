// The relay's end-to-end envelope (src/envelope.js → src/e2e/relay-envelope.js):
// keys from a real pairing, then a desktop channel and a device channel
// talking through a pipe that plays a hostile hub (records, tampers, replays,
// forges). WebCrypto only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDesktopChannel, createDeviceChannel, generateAgreementKey, exportAgreementPublic, importAgreementPublic,
  seal, open, checkShape, E2EError, PairingClient, parsePairingQr, createIdentity,
} from '../src/index.js';
import { makeDesktop, pairPhone } from './helpers.js';

const uuid = () => crypto.randomUUID();
const CANARY = 'canary-91be plaintext fixture';

// A paired phone + desktop, and a hub pipe: the device channel's send() goes
// through `hub` (which may rewrite the request or the answer) to the desktop
// channel and a toy op handler.
async function pair({ clock } = {}) {
  const desk = await makeDesktop();
  const paired = await pairPhone(desk);
  let t = 1_000_000;
  const now = clock ?? (() => t);
  const mkDesk = () => createDesktopChannel({ did: desk.identity.desktopId, privateKey: desk.identity.agreePrivateKey, peer: (dev) => desk.registry.activeAgreeKey(dev), now });
  const ctx = { desk, paired, wire: [], desktop: mkDesk(), tamper: null, answer: null, ran: [] };
  ctx.restart = () => { ctx.desktop = mkDesk(); };
  ctx.advance = (ms) => { t += ms; };
  ctx.phone = createDeviceChannel({ did: paired.desktopId, dev: paired.deviceId, privateKey: paired.agreeKeyPair.privateKey, peerPublic: paired.desktopAgree });
  ctx.send = async (rid, op, enc) => {
    let req = { request_id: rid, op, enc };
    ctx.wire.push(JSON.stringify(req));
    if (ctx.tamper) req = ctx.tamper(req) ?? req;
    const o = await ctx.desktop.open({ rid: req.request_id, op: req.op, enc: req.enc });
    let result;
    if (!o.ok) result = { ok: false, status: 'e2e', error: 'refused', e2e: o.code };
    else if (o.hello) result = { enc: o.reply };
    else { ctx.ran.push({ op: req.op, args: o.args }); result = { enc: await o.seal({ ok: true, echo: o.args }) }; }
    const body = { host: 'h1', result };
    ctx.wire.push(JSON.stringify(body));
    return { status: 200, body: ctx.answer ? ctx.answer(body) : body };
  };
  return ctx;
}

test('pairing exchanges both ECDH keys; the phone key is non-extractable; the desktop registry serves it as peer', async () => {
  const c = await pair();
  assert.equal(c.paired.agreeKeyPair.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', c.paired.agreeKeyPair.privateKey));
  assert.equal(c.paired.desktopAgree, c.desk.identity.agreePublicRaw);
  const rec = await c.desk.registry.get(c.paired.deviceId);
  assert.equal(rec.agreeKey, await exportAgreementPublic(c.paired.agreeKeyPair.publicKey));
  assert.equal(await c.desk.registry.activeAgreeKey(c.paired.deviceId), rec.agreeKey);
});

test('a call round-trips sealed: the wire never carries the args or the answer in plaintext', async () => {
  const c = await pair();
  const r = await c.phone.call('send', { text: CANARY }, c.send, uuid);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.result, { ok: true, echo: { text: CANARY } });
  assert.deepEqual(c.ran, [{ op: 'send', args: { text: CANARY } }]);
  assert.ok(c.wire.length >= 4, 'hello + call, both ways');
  for (const line of c.wire) assert.ok(!line.includes('canary-91be'), `plaintext on the wire: ${line.slice(0, 120)}`);
  // What the hub does see: routing metadata only.
  const req = JSON.parse(c.wire.at(-2));
  assert.deepEqual(Object.keys(req.enc).sort(), ['ct', 'dev', 'iv', 'salt', 'seq', 'sid', 'v']);
  assert.equal(req.enc.dev, c.paired.deviceId);
  assert.equal(req.enc.seq, 1);
});

test('tampering with anything the AAD binds (rid, op, seq, dev, sid) or with the ciphertext, salt or iv fails to open', async () => {
  const c = await pair();
  await c.phone.call('state', { session: 'x' }, c.send, uuid); // session open
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  const cases = {
    rid: (q) => ({ ...q, request_id: uuid() }),
    op: (q) => ({ ...q, op: 'close' }),
    ct: (q) => ({ ...q, enc: { ...q.enc, ct: flip(q.enc.ct) } }),
    salt: (q) => ({ ...q, enc: { ...q.enc, salt: flip(q.enc.salt) } }),
    iv: (q) => ({ ...q, enc: { ...q.enc, iv: flip(q.enc.iv) } }),
  };
  for (const [name, fn] of Object.entries(cases)) {
    c.ran.length = 0;
    c.tamper = fn;
    const r = await c.phone.call('send', { text: CANARY }, c.send, uuid);
    assert.equal(r.status, 502, name);
    assert.equal(r.body.error.code, 'E2E', name);
    assert.equal(r.body.error.reason, 'rejected', name);
    assert.deepEqual(c.ran, [], `${name}: nothing ran`);
    c.tamper = null;
    await c.phone.call('state', { session: 'x' }, c.send, uuid); // reopen after the phone dropped its session
  }

  // seq/dev/sid are both in the envelope and the AAD: open() refuses a mismatch directly too.
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const ctx = { dir: 'p2d', did: 'd1', dev: 'p1', sid: 'A'.repeat(22), seq: 5, rid: 'r1', op: 'send' };
  const enc = await seal(secret, ctx, { text: CANARY });
  assert.deepEqual(await open(secret, ctx, enc), { text: CANARY });
  for (const k of ['seq', 'rid', 'op', 'did', 'dev', 'sid']) {
    const wrong = { ...ctx, [k]: k === 'seq' ? 6 : k === 'sid' ? 'B'.repeat(22) : 'other' };
    await assert.rejects(open(secret, wrong, enc), (e) => e instanceof E2EError && e.code === 'rejected', k);
  }
  // A phone→desktop envelope does not open as desktop→phone (no reflection).
  await assert.rejects(open(secret, { ...ctx, dir: 'd2p' }, enc), /rejected/);
});

test('replay: the same envelope is accepted once; far-behind seqs are refused; a desktop restart forgets every session', async () => {
  const c = await pair();
  let captured = null;
  c.tamper = (q) => { captured = q; };
  assert.equal((await c.phone.call('send', { text: 'one' }, c.send, uuid)).status, 200);
  c.tamper = null;
  c.ran.length = 0;
  // The hub replays the exact request (same rid, same envelope).
  const again = await c.desktop.open({ rid: captured.request_id, op: captured.op, enc: captured.enc });
  assert.deepEqual(again, { ok: false, code: 'replayed' });
  assert.deepEqual(c.ran, []);

  // Out-of-order within the window is fine; below the window is refused.
  for (let i = 0; i < 300; i++) await c.phone.call('state', {}, c.send, uuid);
  const old = await c.desktop.open({ rid: captured.request_id, op: captured.op, enc: captured.enc });
  assert.deepEqual(old, { ok: false, code: 'replayed' });

  // A restarted desktop has no sessions: the captured envelope is useless, and
  // the phone's next read re-handshakes once and goes through.
  c.restart();
  assert.deepEqual(await c.desktop.open({ rid: captured.request_id, op: captured.op, enc: captured.enc }), { ok: false, code: 'no-session' });
  const r = await c.phone.call('state', { n: 1 }, c.send, uuid);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.result.echo, { n: 1 });
});

test('a forgotten session is not retried for a mutating op: the hub cannot make a send run twice', async () => {
  const c = await pair();
  await c.phone.call('state', {}, c.send, uuid);
  c.ran.length = 0;
  // The hub lets the send through, then answers with a fake "no-session".
  c.answer = () => ({ host: 'h1', result: { ok: false, e2e: 'no-session' } });
  const r = await c.phone.call('send', { text: 'once' }, c.send, uuid);
  assert.equal(r.status, 502);
  assert.equal(r.body.error.reason, 'no-session');
  assert.match(r.body.error.message, /may not have been handled/);
  assert.equal(c.ran.length, 1, 'ran once, not repeated');
});

test('the phone never shows an answer that does not open: forged plaintext success, swapped answers', async () => {
  const c = await pair();
  await c.phone.call('state', {}, c.send, uuid);
  c.answer = () => ({ host: 'h1', result: { ok: true, state: { forged: true } } });
  let r = await c.phone.call('state', {}, c.send, uuid);
  assert.equal(r.status, 502);
  assert.equal(r.body.error.reason, 'answer');
  // The answer to one request swapped in for another's.
  c.answer = null;
  let prev = null;
  c.answer = (b) => { const out = prev ?? b; prev = b; return out; };
  await c.phone.call('state', { a: 1 }, c.send, uuid);
  r = await c.phone.call('state', { a: 2 }, c.send, uuid);
  assert.equal(r.status, 502);
  assert.equal(r.body.error.reason, 'answer');
  // Hub errors (offline host, 429) pass through untouched.
  const offline = await c.phone.call('state', {}, async () => ({ status: 404, body: { error: { code: 'NOT_FOUND' } } }), uuid);
  assert.equal(offline.status, 404);
});

test('revocation: an unknown or revoked device is refused and its sessions dropped', async () => {
  const c = await pair();
  assert.equal((await c.phone.call('state', {}, c.send, uuid)).status, 200);
  assert.equal(c.desktop.sessionCount(), 1);
  await c.desk.registry.revoke(c.paired.deviceId);
  const r = await c.phone.call('state', {}, c.send, uuid);
  assert.equal(r.status, 502);
  assert.equal(r.body.error.reason, 'unknown-device');
  assert.equal(c.desktop.sessionCount(), 0);
});

test('a stranger with the desktop public key but no pairing cannot open a session; sessions expire when idle', async () => {
  const c = await pair();
  const mallory = await generateAgreementKey();
  // Mallory claims the paired device id but holds a different key: the pair secret differs.
  const fake = createDeviceChannel({ did: c.paired.desktopId, dev: c.paired.deviceId, privateKey: mallory.privateKey, peerPublic: c.paired.desktopAgree });
  const r = await fake.call('list', {}, c.send, uuid);
  assert.equal(r.status, 502);
  assert.equal(r.body.error.reason, 'rejected');
  assert.equal(c.desktop.sessionCount(), 0);

  await c.phone.call('state', {}, c.send, uuid);
  assert.equal(c.desktop.sessionCount(), 1);
  c.advance(31 * 60_000);
  c.ran.length = 0;
  const after = await c.phone.call('state', { k: 1 }, c.send, uuid); // a read: reopened once
  assert.equal(after.status, 200);
  assert.equal(c.ran.length, 1);
});

test('pairing: the hub cannot swap either ECDH key', async () => {
  const desk = await makeDesktop();
  const { qrText } = await desk.pairing.start();
  const qr = parsePairingQr(qrText, { now: desk.clock() });
  const phone = await PairingClient.begin(qr, { deviceName: 'Alice iPhone' });
  // The phone's key swapped in pair-init: the MAC (keyed by the QR secret) fails.
  const evil = await exportAgreementPublic((await generateAgreementKey()).publicKey);
  const r1 = await desk.hub.forward({ v: 1, to: qr.did, kind: 'pair-init', body: { ...phone.init, deviceAgree: evil } });
  assert.equal(r1.body.ok, false);
  assert.equal(r1.body.reason, 'bad-mac');

  // The desktop's key swapped in the challenge: its signature no longer verifies.
  const desk2 = await makeDesktop();
  const s2 = await desk2.pairing.start();
  const phone2 = await PairingClient.begin(parsePairingQr(s2.qrText, { now: desk2.clock() }), {});
  const r2 = await desk2.hub.forward({ v: 1, to: s2.qr.did, kind: 'pair-init', body: phone2.init });
  const ch = JSON.parse(r2.body.challenge.payload);
  const forged = { ...r2.body.challenge, payload: JSON.stringify({ ...ch, desktopAgree: evil }) };
  await assert.rejects(phone2.onChallenge(forged), /not signed by this desktop/);
});

test('envelope shape: closed keys, sizes, base64url; bad public keys refused', async () => {
  const good = { v: 1, dev: 'p1', sid: 'A'.repeat(22), seq: 1, salt: 'A'.repeat(43), iv: 'A'.repeat(16), ct: 'A'.repeat(40) };
  assert.equal(checkShape(good), good);
  for (const bad of [{ ...good, x: 1 }, { ...good, v: 2 }, { ...good, sid: '' }, { ...good, seq: 0 }, { ...good, iv: 'A'.repeat(15) }, { ...good, ct: 'A+' + 'A'.repeat(30) }, { ...good, dev: '' }]) {
    assert.throws(() => checkShape(bad), /malformed/);
  }
  await assert.rejects(importAgreementPublic('AAAA'), /bad-key|uncompressed/);
  const id = await createIdentity();
  assert.equal((await importAgreementPublic(id.agreePublicRaw)).type, 'public');
});
