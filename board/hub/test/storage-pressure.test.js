import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, lstatSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { openDb } from '../db.js';
import { StorageWatch, dbFileSize, parseStorageMax, STORAGE_CHECK_MS } from '../storage-watch.js';
import { loadConfig } from '../config.js';
import { fakeClock, runMsg, startHub } from './helpers.js';
import { startAccounts } from './accounts-helpers.js';
import { tenancy } from './tenancy/fixture.js';
import { communicationRig, taskMessage } from './communication-helpers.js';
import { fakeClients, fakeProviders, s256 } from './fake-oauth.js';

const MiB = 1024 * 1024;
function pressure(h) {
  let bytes = 0;
  h.hub.storage = new StorageWatch(h.hub, { maxMb: 1, size: () => bytes });
  return value => { bytes = value; h.clock.advance(STORAGE_CHECK_MS); return h.hub.storage.check(); };
}
const rows = db => JSON.stringify(['users', 'user_devices', 'orgs', 'boards', 'members', 'cards', 'comments', 'journal', 'task_message_threads', 'task_messages'].map(t => [t, db.get(`SELECT COUNT(*) n FROM ${t}`).n]));

test('optional fixed-text config bounds and disabled watcher perform no sampling', () => {
  for (const v of ['-1', '0', '1.5', 'NaN', 'Infinity', 'secret-value', String(Number.MAX_SAFE_INTEGER)]) {
    assert.throws(() => parseStorageMax(v), e => e.message === 'DB_SIZE_MAX_MB must be a positive safe whole number of MiB');
  }
  assert.equal(loadConfig({ BOARD_AUTH: 'dev' }).dbSizeMaxMb, null);
  assert.equal(loadConfig({ BOARD_AUTH: 'dev', DB_SIZE_MAX_MB: '3' }).dbSizeMaxMb, 3);
  const w = new StorageWatch({ config: {}, mono: () => 0 }, { size: () => { throw new Error('disabled sampled'); } });
  assert.equal(w.enabled, false); assert.equal(w.check(), false);
});

test('actual temporary SQLite WAL counts, while missing/type/linked DB samples refuse', t => {
  const dir = mkdtempSync(join(tmpdir(), 'plexiform-pressure-'));
  const path = join(dir, 'board.db'), db = openDb(path); t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const before = dbFileSize(path);
  db.raw.exec('CREATE TABLE pressure_fixture (bytes BLOB); INSERT INTO pressure_fixture VALUES (zeroblob(2097152));');
  assert.ok(lstatSync(`${path}-wal`).size > 2 * MiB); assert.ok(dbFileSize(path) > before + 2 * MiB);
  const clock = fakeClock(), log = { warn() {} };
  const w = new StorageWatch({ config: { dbPath: path }, mono: clock.mono, log }, { maxMb: 1 }); assert.equal(w.paused, true);
  assert.throws(() => dbFileSize(join(dir, 'missing')), /storage sample unavailable/);
  const directory = join(dir, 'directory'); mkdirSync(directory); assert.throws(() => dbFileSize(directory), /storage sample unavailable/);
  const link = join(dir, 'link'); symlinkSync(path, link); assert.throws(() => dbFileSize(link), /storage sample unavailable/);
  assert.equal(dbFileSize(':memory:'), 0);
});

test('actual app startup pauses a populated disk database and the real reaper resumes after compaction', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plexiform-pressure-boot-')), path = join(dataDir, 'board.db');
  const initial = openDb(path);
  initial.raw.exec('CREATE TABLE pressure_fixture (bytes BLOB); INSERT INTO pressure_fixture VALUES (zeroblob(4194304));'); initial.close();
  let h;
  t.after(async () => { if (h) await h.close(); rmSync(dataDir, { recursive: true, force: true }); });
  h = await startHub({ dataDir, config: { dbSizeMaxMb: 2 } }); assert.equal(h.hub.storage.paused, true);
  const cookie = await h.login('alice'), create = () => h.api(cookie, 'POST', `/api/boards/${h.ids.board}/cards`, { request_id: randomUUID(), title: 'Disk pressure admission' });
  assert.equal((await create()).body.error.resource, 'storage');
  h.db.raw.exec('DELETE FROM pressure_fixture; PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  assert.ok(dbFileSize(path) < 2 * MiB * .9);
  await h.tick(STORAGE_CHECK_MS); assert.equal(h.hub.storage.paused, false); assert.equal((await create()).status, 200);
});

test('hysteresis, unknown size and monotonic rollback keep cached admission truthful without logging errors', () => {
  let now = 100, bytes = MiB, reads = 0; const logs = [];
  const w = new StorageWatch({ config: {}, mono: () => now, log: { warn: (...a) => logs.push(a) } }, { maxMb: 1, size: () => { reads++; if (bytes === null) throw new Error('/private/secret.db'); return bytes; } });
  assert.equal(w.check(), false); assert.equal(reads, 1);
  bytes = MiB + 1; now += STORAGE_CHECK_MS; assert.equal(w.check(), true);
  bytes = Math.floor(.95 * MiB); now += STORAGE_CHECK_MS; assert.equal(w.check(), true);
  bytes = Math.floor(.89 * MiB); now += STORAGE_CHECK_MS; assert.equal(w.check(), false);
  bytes = null; now += STORAGE_CHECK_MS; assert.equal(w.check(), true);
  bytes = Math.floor(.95 * MiB); now += STORAGE_CHECK_MS; assert.equal(w.check(), true);
  bytes = 0; now -= 1; assert.equal(w.check(), false, 'rollback forces resample');
  assert.ok(!JSON.stringify(logs).includes('private'));
  assert.deepEqual(logs.map(row => row[1].status), ['paused', 'available', 'unknown', 'paused', 'available']);
});

test('paused new email starts stay silent with a real flow cookie; existing login and step-up remain usable', async t => {
  const h = await startAccounts(); t.after(() => h.close());
  const prior = await h.signIn('alice@dev.local'); assert.equal(prior.status, 200);
  const change = pressure(h); change(2 * MiB); const sent = h.mailer.sent.length;
  const start = await h.start('fresh@pressure.test', { client: 'web' }); assert.equal(start.status, 200);
  assert.deepEqual(Object.keys(start.body).sort(), ['expires_in', 'flow_id']); assert.ok(start.cookies.some(c => c.startsWith('__Host-buddy_flow=')));
  assert.equal(h.mailer.sent.length, sent); assert.ok(h.db.get('SELECT code_hash FROM login_flows WHERE id=?', start.body.flow_id).code_hash.startsWith('dud:'));
  const existing = await h.signIn('alice@dev.local'); assert.equal(existing.status, 200, existing.text);
  assert.ok(await h.stepUp(existing.body.device_token, 'alice@dev.local'));
});

test('a real code issued before pause rolls back new account and can be retried after recovery', async t => {
  const h = await startAccounts(); t.after(() => h.close()); const change = pressure(h);
  const s = await h.start('pending@pressure.test'), code = h.codeFor('pending@pressure.test'); assert.equal(s.status, 200);
  const before = rows(h.db); change(2 * MiB);
  const verify = () => h.call('POST', '/api/auth/email/verify', { body: { flow_id: s.body.flow_id, code, form_factor: 'laptop' } });
  const refused = await verify(); assert.equal(refused.status, 503); assert.equal(refused.body.error.code, 'SIGNUP_PAUSED'); assert.equal(rows(h.db), before);
  assert.equal(h.db.get('SELECT consumed_at FROM login_flows WHERE id=?', s.body.flow_id).consumed_at, null);
  change(0); const accepted = await verify(); assert.equal(accepted.status, 200, accepted.text);
});

test('fake-provider new OAuth signup refuses while the same existing provider identity still signs in', async t => {
  const clock = fakeClock(), clients = fakeClients(), provider = fakeProviders({ clock, clients });
  const h = await startAccounts({ clock, config: clients, fetchImpl: provider.fetch }); t.after(() => h.close());
  async function oauth(who) {
    const verifier = randomBytes(32).toString('base64url');
    const s = await h.call('POST', '/api/auth/oauth/start', { body: { provider: 'github', code_challenge: s256(verifier), redirect_uri: 'http://127.0.0.1:53682/callback', client: 'buddy_desktop' } }); assert.equal(s.status, 200, s.text);
    const a = provider.authorize(s.body.url, who);
    return h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: s.body.flow_id, code: a.code, state: a.state, code_verifier: verifier } });
  }
  const who = { id: 1231, login: 'fixture', emails: [{ email: 'known@pressure.test', primary: true, verified: true }] };
  assert.equal((await oauth(who)).status, 200); const change = pressure(h); change(2 * MiB); const before = rows(h.db);
  const refused = await oauth({ ...who, id: 1232, emails: [{ email: 'new@pressure.test', primary: true, verified: true }] });
  assert.equal(refused.status, 503, refused.text); assert.equal(refused.body.error.code, 'SIGNUP_PAUSED'); assert.equal(rows(h.db), before);
  assert.equal((await oauth(who)).status, 200);
});

test('team/setup/card/comment admission is atomic, current replay and existing edits/read stay usable', async t => {
  const f = await tenancy(); t.after(() => f.h.close()); const change = pressure(f.h);
  const path = `/api/boards/${f.A.board}/cards`, body = { request_id: randomUUID(), title: 'Accepted before pressure' };
  const first = await f.as(f.users.ua, 'POST', path, body); assert.equal(first.status, 200);
  change(2 * MiB); const before = rows(f.db), key = f.h.hub.board(f.A.board).next_key, other = f.snapshotB();
  for (const [u, route, payload] of [
    [f.users.ua, '/api/teams', { name: 'Paused team' }],
    [f.users.n, '/api/account/setup', {}],
    [f.users.ua, path, { request_id: randomUUID(), title: 'Paused new card' }],
    [f.users.ua, `/api/cards/${f.A.card}/comments`, { request_id: randomUUID(), body: 'Paused comment' }],
  ]) { const r = await f.as(u, 'POST', route, payload); assert.equal(r.status, 403, r.text); assert.equal(r.body.error.resource, 'storage'); assert.equal(rows(f.db), before); }
  assert.equal(f.h.hub.board(f.A.board).next_key, key); assert.equal(f.snapshotB(), other);
  const replay = await f.as(f.users.ua, 'POST', path, body); assert.equal(replay.status, 200); assert.equal(replay.body.card.id, first.body.card.id);
  const card = f.h.hub.card(f.A.card);
  const edit = await f.as(f.users.ua, 'PATCH', `/api/cards/${card.id}`, { request_id: randomUUID(), version: card.version, title: 'Existing work stays editable' }); assert.equal(edit.status, 200, edit.text);
  assert.equal((await f.as(f.users.ua, 'GET', `/api/cards/${card.id}`)).status, 200);
});

test('queued central creation resamples before insert; nonaccounts mode also refuses new rows', async t => {
  const f = await tenancy(); t.after(() => f.h.close()); const change = pressure(f.h);
  let release, entered; const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const held = f.h.hub.withBoard(f.A.board, async () => { entered(); await gate; }); await ready;
  const before = rows(f.db), key = f.h.hub.board(f.A.board).next_key;
  const creation = f.h.app.api.createCard(f.h.hub.member(f.A.owner), f.A.board, { title: 'Queued admission', request_id: randomUUID() }, { cred: { kind: 'device', id: f.users.ua.device_id } });
  change(2 * MiB); release(); await held; await assert.rejects(creation, e => e.code === 'QUOTA_EXCEEDED' && e.extra.resource === 'storage');
  assert.equal(rows(f.db), before); assert.equal(f.h.hub.board(f.A.board).next_key, key);
  const h = await startHub(); t.after(() => h.close()); pressure(h)(2 * MiB); const cookie = await h.login('alice');
  const refused = await h.api(cookie, 'POST', `/api/boards/${h.ids.board}/cards`, { title: 'Dev storage pressure', request_id: randomUUID() }); assert.equal(refused.status, 403); assert.equal(refused.body.error.resource, 'storage');
});

test('the same HTTP request recovers from storage refusal and concurrent retries add exactly one row', async t => {
  const f = await tenancy(); t.after(() => f.h.close()); const change = pressure(f.h);
  for (const kind of ['card', 'comment']) {
    const marker = `Recovered ${kind} ${randomUUID()}`;
    const route = kind === 'card' ? `/api/boards/${f.A.board}/cards` : `/api/cards/${f.A.card}/comments`;
    const body = { request_id: randomUUID(), ...(kind === 'card' ? { title: marker } : { body: marker }) };
    change(2 * MiB); const before = rows(f.db), key = f.h.hub.board(f.A.board).next_key;
    const denied = await f.as(f.users.ua, 'POST', route, body);
    assert.equal(denied.status, 403, denied.text); assert.equal(denied.body.error.resource, 'storage');
    assert.equal(rows(f.db), before); assert.equal(f.h.hub.board(f.A.board).next_key, key);
    change(0);
    const [accepted, replay] = await Promise.all([f.as(f.users.ua, 'POST', route, body), f.as(f.users.ua, 'POST', route, body)]);
    assert.equal(accepted.status, 200, accepted.text); assert.equal(replay.status, 200, replay.text); assert.deepEqual(replay.body, accepted.body);
    assert.equal(f.db.get(kind === 'card' ? 'SELECT COUNT(*) n FROM cards WHERE title=?' : 'SELECT COUNT(*) n FROM comments WHERE body=?', marker).n, 1);
    assert.equal(f.h.hub.board(f.A.board).next_key, key + (kind === 'card' ? 1 : 0));
    const after = rows(f.db);
    const altered = await f.as(f.users.ua, 'POST', route, { ...body, ...(kind === 'card' ? { title: 'Different request' } : { body: 'Different request' }) });
    assert.equal(altered.status, 409); assert.equal(rows(f.db), after);
  }
});

test('storage recovery does not permit a queued retry after its current membership is removed', async t => {
  const f = await tenancy(); t.after(() => f.h.close()); const change = pressure(f.h);
  const route = `/api/boards/${f.A.board}/cards`, body = { request_id: randomUUID(), title: 'Current authority on recovered retry' };
  change(2 * MiB); assert.equal((await f.as(f.users.amember, 'POST', route, body)).body.error.resource, 'storage'); change(0);
  const original = f.h.hub.withBoard.bind(f.h.hub); let release, entered, enqueued;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; }), queued = new Promise(r => { enqueued = r; });
  const held = original(f.A.board, async () => { entered(); await gate; }); await ready;
  f.h.hub.withBoard = (id, fn) => { if (id === f.A.board) enqueued(); return original(id, fn); };
  let timer, retry;
  try {
    retry = f.as(f.users.amember, 'POST', route, body);
    await Promise.race([queued, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('retry did not enter the board queue')), 2000); })]);
    const before = rows(f.db), key = f.h.hub.board(f.A.board).next_key;
    f.db.run('UPDATE members SET removed_at=? WHERE id=?', f.h.hub.iso(), f.A.member);
    release(); await held; const refused = await retry;
    assert.equal(refused.status, 403, refused.text); assert.equal(refused.body.error.code, 'FORBIDDEN');
    assert.equal(rows(f.db), before); assert.equal(f.h.hub.board(f.A.board).next_key, key);
  } finally { clearTimeout(timer); release(); f.h.hub.withBoard = original; await held; if (retry) await retry; }
});

test('new coordination comments refuse without partial threads but observed running outcomes remain recordable', async t => {
  const f = await communicationRig(t); pressure(f.h)(2 * MiB); const before = rows(f.db);
  const refused = await f.sender.client.rpc(f.sender.run, 'board_send_message', taskMessage(f.recipient)); assert.equal(refused.ok, false); assert.equal(refused.error.code, 'QUOTA_EXCEEDED'); assert.equal(rows(f.db), before);
  await f.sender.client.out({ ...runMsg(f.sender.run), kind: 'comment.create', text: 'Actual observed result while pressure is paused' });
  assert.equal(f.db.get('SELECT COUNT(*) n FROM comments WHERE author_run_id=? AND body=?', f.sender.run.run_id, 'Actual observed result while pressure is paused').n, 1);
});

test('health shows only a direct-local paused boolean and omits it for every proxy header', async t => {
  const h = await startAccounts({ config: { ...fakeClients(), publicUrl: 'https://pressure.test', trustCfIp: true, accountsDev: false } }); t.after(() => h.close()); pressure(h)(2 * MiB);
  const local = await h.call('GET', '/api/health'); assert.deepEqual(local.body.storage, { paused: true });
  for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-ray', 'cf-connecting-ip', 'x-real-ip', 'true-client-ip', 'via', 'cdn-loop']) {
    const publicHealth = await h.call('GET', '/api/health', { headers: { [name]: 'fixture' } }); assert.equal(publicHealth.status, 200); assert.ok(!Object.hasOwn(publicHealth.body, 'storage'), name);
  }
  assert.ok(!local.text.includes('max_mb') && !local.text.includes('size_mb'));
});
