// W3-C encrypted sync: the hub (sync.js, sync-store.js, migration 062) driven by
// the real desktop client (src/sync/client.js) over loopback HTTP to an
// in-process hub. The object store is in memory and the S3/R2 adapter gets a
// fake SDK: no request leaves this machine. Acceptance: two devices converge;
// hub DB, logs and stored objects hold no plaintext; quota is enforced; lapse
// -> read-only -> deletion with email notices; the recovery code restores on
// a new device; revocation rotates the key and the revoked device can't read
// anything new.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { startAccounts, dumpDb } from './accounts-helpers.js';
import { ROOMY } from './tenancy/fixture.js';
import { createLogger } from '../log.js';
import { memoryStore, R2SyncStore, r2Config, storeFrom } from '../sync-store.js';
import { SYNC_PLANS, READ_ONLY_DAYS } from '../sync.js';

const require = createRequire(import.meta.url);
const { createSyncClient, memoryStore: localStore } = require('../../../src/sync/client.js');
const Keys = require('../../../src/sync/keys.js');
const Ent = require('../../../src/entitlements.js');

const DAY = 86_400_000;
// Plaintext that must never reach the hub, its logs or the object store.
const SECRET_TITLE = 'PLAINTEXT-MARKER fix the payroll export';
const SECRET_DOC = 'PLAINTEXT-HANDOVER Next: wire the invoice CSV into the client portal';
const SECRET_REPO = 'PLAINTEXT-REPO-acme-ledger';
const API_KEY = 'sk-ant-api03-' + 'Q'.repeat(80);

async function setup() {
  const store = memoryStore();
  const lines = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  // One person signs in from several computers: lift the per-address sign-in limits too.
  const roomy = { ...ROOMY, ...Object.fromEntries(['auth_start_email', 'auth_start_email_hour', 'auth_start_email_all', 'auth_verify_email'].map((k) => [k, { capacity: 10_000, per_ms: 60_000 }])) };
  const h = await startAccounts({ config: { syncStore: store, rateLimits: roomy }, log });
  // One desktop sign-in; waits for its own code mail (sends are queued), so repeated sign-ins never reuse an old code.
  const device = async (email) => {
    const before = h.mailer.sent.length;
    const s = await h.start(email);
    assert.equal(s.status, 200, s.text);
    for (let i = 0; i < 200 && h.mailer.sent.length === before; i++) await new Promise((r) => setImmediate(r));
    const code = /code: (\d{6})/.exec(h.mailer.sent.at(-1).text)[1];
    const r = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: s.body.flow_id, code, device_name: 'MacBook-Pro', platform: 'darwin-arm64', form_factor: 'laptop' } });
    assert.equal(r.status, 200, r.text);
    return { userId: r.body.user.id, token: r.body.device_token, deviceId: r.body.device_id, email };
  };
  const plus = (userId, { status = 'active', end = Math.floor(h.hub.wallMs() / 1000) + 30 * 86_400 } = {}) => {
    h.db.run('DELETE FROM entitlements WHERE subject_type = ? AND subject_id = ?', 'user', userId);
    h.db.insert('entitlements', { id: randomUUID(), subject_type: 'user', subject_id: userId, plan: 'plus', interval: 'month', seats: 1, status,
      cancel_at_period_end: 0, current_period_end: end, paid_through: end, state_at: 0, provider: 'stripe', created_at: h.hub.iso(), updated_at: h.hub.iso() });
  };
  const client = (dev, ls = localStore()) => ({
    dev, ls,
    c: createSyncClient({ identity: () => ({ origin: h.base, userId: dev.userId, token: () => dev.token }), fetch: (...a) => fetch(...a), store: ls, deviceName: 'Mac' }),
  });
  const api = (dev, method, path, body) => h.call(method, path, { token: dev.token, body });
  return { h, store, lines, device, plus, client, api };
}

function noPlaintext(fx, extra = []) {
  const haystacks = [
    ['hub database', dumpDb(fx.h.db)],
    ['hub log', fx.lines.join('\n')],
    ['object store', [...fx.store.objects.values()].map((b) => Buffer.from(b).toString('latin1')).join('\n')],
    ['mail', JSON.stringify(fx.h.mailer.sent)],
  ];
  for (const [where, text] of haystacks) {
    for (const needle of [SECRET_TITLE, SECRET_DOC, SECRET_REPO, API_KEY, 'PLAINTEXT-', ...extra]) {
      assert.ok(!text.includes(needle), `${where} contains plaintext: ${needle.slice(0, 30)}`);
    }
  }
}

test('two devices converge (LWW per doc under a Lamport clock), and the hub, its logs and the object store hold no plaintext', async () => {
  const fx = await setup();
  try {
    const a = fx.client(await fx.device('me@sync.test'));
    const b = fx.client(await fx.device('me@sync.test'));
    fx.plus(a.dev.userId);

    const first = await a.c.enable();
    assert.equal(first.ok, true);
    assert.match(first.recoveryCode, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    const waiting = await b.c.enable();
    assert.deepEqual([waiting.ok, waiting.waiting], [false, 'approval']);
    // The approving device compares fingerprints: the one the hub lists is b's own.
    const st = await a.c.state();
    const listed = st.devices.find((d) => d.device_id === b.dev.deviceId);
    assert.equal(Keys.fingerprint(listed.agree_pub), waiting.fingerprint);
    assert.equal((await a.c.approve(b.dev.deviceId)).ok, true);
    assert.equal((await b.c.enable()).ok, true, 'b adopts its wrap');

    // Each device writes docs; both edit `memory:claude:s1` concurrently.
    const putA = (lg) => {
      lg.put('memory:claude:s1', 'memory', { tool: 'claude', sid: 's1', title: SECRET_TITLE, repo: SECRET_REPO, started: 1, cwd: '/Users/me/private' });
      lg.put('handover:k1', 'handover', { key: 'k1', title: 'Handover', text: `${SECRET_DOC}\nANTHROPIC_API_KEY=${API_KEY}`, updatedAt: 5 });
      lg.put('checkpoint:s1', 'checkpoint', { sid: 's1', repo: SECRET_REPO, source: 'claude', updatedAt: 9 });
    };
    const putB = (lg) => { lg.put('memory:claude:s1', 'memory', { tool: 'claude', sid: 's1', title: `${SECRET_TITLE} (b)`, started: 1 }); lg.put('memory:codex:s2', 'memory', { tool: 'codex', sid: 's2', title: 'PLAINTEXT-B second' }); };
    const ra = await a.c.syncNow({ collect: putA });
    const rb = await b.c.syncNow({ collect: putB });
    assert.equal(ra.pushed.uploaded, 1);
    // b had its own s1 at the same Lamport time: a's s1 applies only if a's device id wins the tie.
    assert.equal(rb.pulled.applied, 2 + (a.dev.deviceId > b.dev.deviceId ? 1 : 0));
    await a.c.syncNow();
    await b.c.syncNow();
    const da = a.c.log(a.dev.deviceId).lg.docs();
    const db = b.c.log(b.dev.deviceId).lg.docs();
    assert.deepEqual(da, db, 'both devices hold the same docs');
    assert.deepEqual(Object.keys(da).sort(), ['checkpoint:s1', 'handover:k1', 'memory:claude:s1', 'memory:codex:s2']);
    // Same Lamport time (1 each): the larger device id wins the tie, on both devices.
    const winner = a.dev.deviceId > b.dev.deviceId ? SECRET_TITLE : `${SECRET_TITLE} (b)`;
    assert.equal(da['memory:claude:s1'].data.title, winner);
    // Only allowlisted fields, secrets redacted before sealing.
    assert.equal(da['memory:claude:s1'].data.cwd, undefined);
    assert.ok(!da['handover:k1'].data.text.includes(API_KEY));
    assert.match(da['handover:k1'].data.text, /<redacted:/);

    // The hub saw only ciphertext: DB rows, log lines, stored objects, mail.
    assert.equal(fx.store.objects.size, 2);
    noPlaintext(fx, ['/Users/me/private']);
    const row = fx.h.db.get('SELECT * FROM sync_blobs ORDER BY id LIMIT 1');
    assert.deepEqual(Object.keys(row).sort(), ['created_at', 'device_id', 'epoch', 'id', 'object_key', 'seq', 'sha256', 'size', 'user_id']);
    assert.match(row.object_key, new RegExp(`^sync/${a.dev.userId}/${a.dev.deviceId}/[0-9a-f-]{36}$`));
    const cursor = fx.h.db.get('SELECT cursor FROM sync_devices WHERE device_id = ?', b.dev.deviceId).cursor;
    assert.equal(cursor, fx.h.db.get('SELECT MAX(id) AS m FROM sync_blobs').m, 'per-device cursor recorded');

    // Another user sees none of it.
    const other = await fx.device('other@sync.test');
    fx.plus(other.userId);
    assert.equal((await fx.api(other, 'GET', `/api/sync/blobs/${row.id}`)).status, 403, 'not in a sync set');
    await fx.client(other).c.enable();
    assert.equal((await fx.api(other, 'GET', `/api/sync/blobs/${row.id}`)).status, 404);
    assert.deepEqual((await fx.api(other, 'GET', '/api/sync/blobs?after=0')).body.blobs, []);
  } finally { await fx.h.close(); }
});

test('quota: device count and bytes are enforced from the plan limits; tickets are bound to their size, hash and device', async () => {
  const fx = await setup();
  try {
    const a = fx.client(await fx.device('q@sync.test'));
    assert.equal((await fx.api(a.dev, 'POST', '/api/sync/devices', { agree_pub: Keys.createDeviceKey().pub })).status, 402, 'no plan, no sync');
    fx.plus(a.dev.userId);
    await a.c.enable();
    const others = [];
    for (let i = 0; i < 3; i++) others.push(await fx.device('q@sync.test'));
    assert.equal((await fx.client(others[0]).c.enable()).waiting, 'approval');
    assert.equal((await fx.client(others[1]).c.enable()).waiting, 'approval');
    const fourth = await fx.api(others[2], 'POST', '/api/sync/devices', { agree_pub: Keys.createDeviceKey().pub, name: 'x' });
    assert.equal(fourth.status, 403);
    assert.deepEqual([fourth.body.error.code, fourth.body.error.resource, fourth.body.error.limit], ['QUOTA_EXCEEDED', 'sync.devices', SYNC_PLANS.plus.devices]);

    // Bytes: one byte short of the 5 GiB limit.
    fx.h.db.run('UPDATE sync_accounts SET bytes_used = ? WHERE user_id = ?', SYNC_PLANS.plus.bytes - 10, a.dev.userId);
    await assert.rejects(a.c.syncNow({ collect: (lg) => lg.put('memory:x:1', 'memory', { tool: 'x', sid: '1', title: 'over quota' }) }), (e) => e.code === 'QUOTA_EXCEEDED' && e.extra.resource === 'sync.bytes');
    assert.equal(fx.store.objects.size, 0, 'nothing stored over quota');
    assert.equal(a.c.local().pending, 1, 'the op waits locally');
    fx.h.db.run('UPDATE sync_accounts SET bytes_used = 0 WHERE user_id = ?', a.dev.userId);
    assert.equal((await a.c.syncNow()).pushed.uploaded, 1);
    const used = fx.h.db.get('SELECT bytes_used FROM sync_accounts WHERE user_id = ?', a.dev.userId).bytes_used;
    assert.equal(used, fx.h.db.get('SELECT size FROM sync_blobs').size);

    // Ticket tampering.
    const data = Buffer.from('opaque ciphertext stand-in');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(data).digest('hex');
    const t = (await fx.api(a.dev, 'POST', '/api/sync/uploads', { size: data.length, sha256, epoch: 1 })).body;
    assert.equal((await fx.api(a.dev, 'PUT', '/api/sync/blobs', { ...t, size: t.size + 1, data: data.toString('base64url') })).status, 403, 'size changed');
    assert.equal((await fx.api(a.dev, 'PUT', '/api/sync/blobs', { ...t, path: t.path.replace(/.$/, '0'), data: data.toString('base64url') })).status, 403, 'path changed');
    assert.equal((await fx.api(a.dev, 'PUT', '/api/sync/blobs', { ...t, data: Buffer.from('other bytes of the same.. ').toString('base64url') })).status, 400, 'hash mismatch');
    assert.equal((await fx.api(others[0], 'PUT', '/api/sync/blobs', { ...t, data: data.toString('base64url') })).status, 403, 'another device (no key yet)');
    fx.h.clock.advance(11 * 60_000);
    assert.equal((await fx.api(a.dev, 'PUT', '/api/sync/blobs', { ...t, data: data.toString('base64url') })).status, 403, 'expired');
    assert.equal((await fx.api(a.dev, 'POST', '/api/sync/uploads', { size: 600 * 1024, sha256, epoch: 1 })).status, 400, 'blob too large');
    assert.equal((await fx.api(a.dev, 'POST', '/api/sync/uploads', { size: 10, sha256, epoch: 2 })).status, 409, 'stale epoch');
  } finally { await fx.h.close(); }
});

test('lapse: read-only for 30 days with an email notice, renewal restores, then deletion of every object and row with a second notice', async () => {
  const fx = await setup();
  try {
    const a = fx.client(await fx.device('lapse@sync.test'));
    const b = fx.client(await fx.device('lapse@sync.test'));
    fx.plus(a.dev.userId);
    await a.c.enable();
    await b.c.enable();
    await a.c.approve(b.dev.deviceId);
    await a.c.syncNow({ collect: (lg) => lg.put('memory:c:1', 'memory', { tool: 'c', sid: '1', title: SECRET_TITLE }) });
    assert.equal(fx.store.objects.size, 1);

    // The plan ends.
    fx.h.db.run('DELETE FROM entitlements');
    assert.deepEqual(await fx.h.hub.sync.sweep(), { lapsed: 1, noticed: 1, purged: 0 });
    const notice = fx.h.mailer.sent.at(-1);
    assert.equal(notice.to, 'lapse@sync.test');
    assert.match(notice.subject, /read-only/);
    const until = new Date(fx.h.hub.wallMs() + READ_ONLY_DAYS * DAY).toISOString().slice(0, 10);
    assert.ok(notice.text.includes(until), 'the notice names the deletion date');
    assert.deepEqual(await fx.h.hub.sync.sweep(), { lapsed: 0, noticed: 0, purged: 0 }, 'one notice only');

    const st = await b.c.state();
    assert.equal(st.mode, 'read_only');
    // Read-only: download works, upload is refused.
    const r = await b.c.syncNow({ collect: (lg) => lg.put('memory:c:2', 'memory', { tool: 'c', sid: '2', title: 'x' }) });
    assert.equal(r.mode, 'read_only');
    assert.equal(r.pulled.applied, 1);
    assert.equal(r.pushed.uploaded, 0);
    assert.equal((await fx.api(a.dev, 'POST', '/api/sync/uploads', { size: 10, sha256: 'a'.repeat(64), epoch: 1 })).status, 402, 'no uploads while read-only');

    // Renewing inside the 30 days restores it.
    fx.h.clock.advance(10 * DAY);
    fx.plus(a.dev.userId);
    assert.equal((await a.c.state()).mode, 'active');
    assert.equal(fx.h.db.get('SELECT lapsed_at FROM sync_accounts').lapsed_at, null);

    // Lapse again and let 30 days pass: everything goes.
    fx.h.db.run('DELETE FROM entitlements');
    await fx.h.hub.sync.sweep();
    fx.h.clock.advance(READ_ONLY_DAYS * DAY - 1000);
    assert.equal((await fx.h.hub.sync.sweep()).purged, 0, 'not a moment early');
    fx.h.clock.advance(2000);
    assert.equal((await b.c.state()).mode, 'gone');
    assert.equal((await fx.api(b.dev, 'GET', '/api/sync/blobs?after=0')).status, 402);
    assert.deepEqual(await fx.h.hub.sync.sweep(), { lapsed: 0, noticed: 0, purged: 1 });
    assert.equal(fx.store.objects.size, 0);
    for (const t of ['sync_accounts', 'sync_devices', 'sync_blobs']) assert.equal(fx.h.db.get(`SELECT COUNT(*) AS n FROM ${t}`).n, 0, t);
    assert.match(fx.h.mailer.sent.at(-1).subject, /deleted/);
    noPlaintext(fx);
  } finally { await fx.h.close(); }
});

test('recovery code restores on a new device; a wrong code does not', async () => {
  const fx = await setup();
  try {
    const a = fx.client(await fx.device('rec@sync.test'));
    fx.plus(a.dev.userId);
    const { recoveryCode } = await a.c.enable();
    await a.c.syncNow({ collect: (lg) => lg.put('handover:h', 'handover', { key: 'h', text: SECRET_DOC }) });

    // A new computer (laptop lost): fresh sign-in, fresh local state.
    const n = fx.client(await fx.device('rec@sync.test'));
    await assert.rejects(n.c.recover(Keys.newRecoveryCode()), (e) => e.code === 'bad-code');
    await assert.rejects(n.c.recover('not a code'), (e) => e.code === 'bad-code');
    assert.equal((await n.c.recover(recoveryCode.toLowerCase().replace(/-/g, ' '))).ok, true, 'case and separators are forgiven');
    const r = await n.c.syncNow();
    assert.equal(r.pulled.applied, 1);
    assert.equal(n.c.log(n.dev.deviceId).lg.docs()['handover:h'].data.text, SECRET_DOC);
    // The restored device is trusted by the keyring, so a's next approve/rotate keeps it.
    const ring = n.ls.load('keyring');
    assert.ok(ring.devices[n.dev.deviceId]);
    await a.c.syncNow();
    assert.equal(a.ls.load('keyring').rev, ring.rev, 'a adopted the new revision');
    noPlaintext(fx, [recoveryCode, recoveryCode.replace(/-/g, '')]);
  } finally { await fx.h.close(); }
});

test('revocation rotates the content key: the revoked device is refused and cannot decrypt anything new; the others still can', async () => {
  const fx = await setup();
  try {
    const a = fx.client(await fx.device('rev@sync.test'));
    const b = fx.client(await fx.device('rev@sync.test'));
    const c = fx.client(await fx.device('rev@sync.test'));
    fx.plus(a.dev.userId);
    const { recoveryCode } = await a.c.enable();
    for (const x of [b, c]) { await x.c.enable(); await a.c.approve(x.dev.deviceId); await x.c.enable(); }
    await a.c.syncNow({ collect: (lg) => lg.put('memory:c:old', 'memory', { tool: 'c', sid: 'old', title: 'before' }) });
    await b.c.syncNow();
    const bRing = b.ls.load('keyring');
    assert.equal(bRing.current, 1);

    assert.equal((await a.c.revoke(b.dev.deviceId)).epoch, 2);
    assert.equal(fx.h.db.get('SELECT epoch FROM sync_accounts').epoch, 2);
    // b is refused by the hub.
    await assert.rejects(b.c.syncNow(), (e) => e.code === 'revoked' || e.extra?.reason === 'revoked');
    assert.equal((await fx.api(b.dev, 'GET', '/api/sync/blobs?after=0')).status, 403);
    assert.equal((await b.c.state()).your_wrap, undefined, 'no wrap for a revoked device');

    // New ops are sealed under epoch 2; even given the raw object, b's keyring can't open it.
    await a.c.syncNow({ collect: (lg) => lg.put('memory:c:new', 'memory', { tool: 'c', sid: 'new', title: SECRET_TITLE }) });
    const blob = fx.h.db.get('SELECT * FROM sync_blobs ORDER BY id DESC LIMIT 1');
    assert.equal(blob.epoch, 2);
    const raw = fx.store.objects.get(blob.object_key);
    assert.throws(() => Keys.openBlob(bRing, { uid: a.dev.userId, deviceId: blob.device_id }, raw), (e) => e.code === 'no-key');
    // And b can't forge its way back: old-epoch uploads are refused for everyone.
    assert.equal((await fx.api(a.dev, 'POST', '/api/sync/uploads', { size: 10, sha256: 'b'.repeat(64), epoch: 1 })).status, 409);

    // c (still trusted) got the new key and reads both old and new data.
    const r = await c.c.syncNow();
    assert.equal(r.pulled.applied, 2);
    assert.equal(c.ls.load('keyring').current, 2);
    assert.ok(c.ls.load('keyring').keys[1], 'old keys are kept so old ops stay readable');
    assert.equal(c.ls.load('keyring').devices[b.dev.deviceId], undefined);
    // The recovery code still works after rotation (rewrapped to the recovery key).
    const n = fx.client(await fx.device('rev@sync.test'));
    await n.c.recover(recoveryCode);
    assert.equal(n.ls.load('keyring').current, 2);
  } finally { await fx.h.close(); }
});

test('account deletion purges sync at the next sweep without a notice; hub state without a store is disabled', async () => {
  const fx = await setup();
  try {
    const a = fx.client(await fx.device('del@sync.test'));
    fx.plus(a.dev.userId);
    await a.c.enable();
    await a.c.syncNow({ collect: (lg) => lg.put('memory:c:1', 'memory', { tool: 'c', sid: '1', title: 't' }) });
    const mails = fx.h.mailer.sent.length;
    fx.h.hub.sync.forgetUser(a.dev.userId);
    assert.equal((await fx.h.hub.sync.sweep()).purged, 1);
    assert.equal(fx.store.objects.size, 0);
    assert.equal(fx.h.mailer.sent.length, mails, 'no notice for a deleted account');
  } finally { await fx.h.close(); }
  const off = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    const r = await off.signIn('x@sync.test');
    const got = await off.call('GET', '/api/sync/state', { token: r.body.device_token });
    assert.deepEqual([got.status, got.body.error.code], [404, 'METHOD_DISABLED']);
    assert.equal(off.hub.sync.enabled, false);
    assert.deepEqual(await off.hub.sync.sweep(), { lapsed: 0, noticed: 0, purged: 0 });
  } finally { await off.close(); }
});

test('the hub sync limits are the desktop plan limits (src/entitlements.js)', () => {
  for (const plan of ['plus', 'team']) {
    assert.equal(SYNC_PLANS[plan].bytes, Ent.LIMITS[plan]['sync.bytes']);
    assert.equal(SYNC_PLANS[plan].devices, Ent.LIMITS[plan].devices);
  }
  assert.equal(Ent.FEATURES.sync, 'plus');
});

test('R2 store: config pinned to r2.cloudflarestorage.com; put/get/delete through the S3 API (fake SDK, no network)', async () => {
  const good = { endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, bucket: 'plexiform-sync', accessKeyId: 'AKIAFIXTURE', secretAccessKey: 'fixture-secret' };
  assert.equal(r2Config(good).endpoint, good.endpoint);
  for (const endpoint of ['http://x.r2.cloudflarestorage.com', 'https://s3.amazonaws.com', `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/path`, 'https://user:pw@x.r2.cloudflarestorage.com']) {
    assert.throws(() => r2Config({ ...good, endpoint }), /CONFIG|endpoint/);
  }
  assert.throws(() => r2Config({ ...good, bucket: 'Bad_Bucket' }));
  assert.throws(() => r2Config({ ...good, secretAccessKey: '' }));

  const sent = [];
  const objects = new Map();
  class Cmd { constructor(input) { this.input = input; } }
  const sdk = {
    S3Client: class { constructor(cfg) { this.cfg = cfg; sent.push({ client: cfg }); } async send(cmd) {
      sent.push({ cmd: cmd.constructor.name, input: cmd.input });
      if (cmd instanceof sdk.PutObjectCommand) { if (objects.has(cmd.input.Key)) throw Object.assign(new Error('exists'), { $metadata: { httpStatusCode: 412 } }); objects.set(cmd.input.Key, Buffer.from(cmd.input.Body)); return {}; }
      if (cmd instanceof sdk.GetObjectCommand) { const b = objects.get(cmd.input.Key); if (!b) throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }); return { Body: { transformToByteArray: async () => new Uint8Array(b) } }; }
      if (cmd instanceof sdk.DeleteObjectCommand) { objects.delete(cmd.input.Key); return {}; }
      throw new Error('unknown');
    } },
    PutObjectCommand: class PutObjectCommand extends Cmd {}, GetObjectCommand: class GetObjectCommand extends Cmd {}, DeleteObjectCommand: class DeleteObjectCommand extends Cmd {},
  };
  const s = new R2SyncStore(good, { sdk });
  const key = `sync/u1/d1/${randomUUID()}`;
  await s.put(key, Buffer.from('ciphertext'));
  await assert.rejects(s.put(key, Buffer.from('again')), (e) => e.code === 'EXISTS');
  assert.equal(Buffer.from(await s.get(key)).toString(), 'ciphertext');
  await s.delete(key);
  await s.delete(key);
  await assert.rejects(s.get(key), (e) => e.code === 'MISSING');
  await assert.rejects(s.put('../escape', Buffer.from('x')), (e) => e.code === 'BAD_KEY');
  const put = sent.find((x) => x.cmd === 'PutObjectCommand').input;
  assert.deepEqual([put.Bucket, put.IfNoneMatch, put.ContentType, put.CacheControl], ['plexiform-sync', '*', 'application/octet-stream', 'no-store']);
  const cfg = sent[0].client;
  assert.deepEqual([cfg.endpoint, cfg.region, cfg.maxAttempts, cfg.forcePathStyle], [good.endpoint, 'auto', 1, true]);
  assert.equal(storeFrom(null), null);
  assert.equal(storeFrom({ kind: 'memory' }).kind, 'memory');
  assert.ok(storeFrom({ kind: 'r2', ...good }) instanceof R2SyncStore);
});
