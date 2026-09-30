// Integrations core: D40 (every notify is a journal row), the journal bus
// (cursors, order, retry, restart), and the vault (D41).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db.js';
import { createBus, DEAD_AFTER } from '../bus.js';
import { createVault, loadKey, keyIdOf } from '../vault.js';
import { startHub, runMsg, settle } from './helpers.js';

// ── D40 ──────────────────────────────────────────────────────────────────

test('D40: a notify effect (run.failed) writes card.notify in the same transaction, with the recipients', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    await runner.out({ kind: 'run.failed', ...runMsg(run), fail_kind: 'error', reason: 'CLI exited' });
    const rows = h.db.all("SELECT seq, payload FROM journal WHERE card_id = ? AND kind = 'card.notify'", run.card_id).map((r) => ({ seq: r.seq, ...JSON.parse(r.payload) }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rule, 'failed');
    assert.deepEqual(rows[0].to, [h.ids.alice]);
    // Same transaction as the transition that caused it: adjacent to its card.transition row.
    const t = h.db.get("SELECT seq FROM journal WHERE card_id = ? AND kind = 'card.transition' ORDER BY seq DESC LIMIT 1", run.card_id);
    assert.ok(Math.abs(t.seq - rows[0].seq) <= 3, `card.notify ${rows[0].seq} next to transition ${t.seq}`);
  } finally {
    await h.close();
  }
});

// ── bus ──────────────────────────────────────────────────────────────────

function journalDb() {
  const db = openDb(':memory:');
  let n = 0;
  const add = (kind = 'card.update', payload = {}) => {
    n += 1;
    db.run("INSERT INTO journal (board_id, card_id, run_id, at_hub, hub_epoch, actor_kind, actor_id, kind, payload) VALUES (NULL, NULL, NULL, ?, 'e', 'system', NULL, ?, ?)", new Date(1_000_000 + n).toISOString(), kind, JSON.stringify(payload));
  };
  return { db, add };
}

const manualTimers = () => {
  const q = [];
  return { setTimeout: (fn, ms) => { const t = { fn, ms }; q.push(t); return t; }, clearTimeout: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); }, q };
};

test('bus: a new consumer starts at the head (no replay of history), then gets every later row in order', async () => {
  const { db, add } = journalDb();
  add('card.create', { n: 0 });
  const bus = createBus({ db, timers: manualTimers() });
  const got = [];
  bus.subscribe('slack', (r) => { got.push(r.payload.n); });
  await bus.settle();
  assert.deepEqual(got, []);
  for (let i = 1; i <= 450; i += 1) add('card.update', { n: i });
  bus.poke();
  await bus.settle();
  assert.equal(got.length, 450);
  assert.deepEqual(got.slice(0, 3), [1, 2, 3]);
  assert.equal(got.at(-1), 450);
  assert.equal(bus.health()[0].backlog, 0);
});

test('bus: kinds filter skips rows but still advances the cursor', async () => {
  const { db, add } = journalDb();
  const bus = createBus({ db, timers: manualTimers() });
  const got = [];
  bus.subscribe('notifier', (r) => { got.push(r.kind); }, { kinds: ['card.notify'] });
  add('card.update'); add('card.notify', { rule: 'failed' }); add('comment.create');
  bus.poke();
  await bus.settle();
  assert.deepEqual(got, ['card.notify']);
  assert.equal(bus.health()[0].backlog, 0);
});

test('bus: a failing row blocks only its consumer, retries with backoff, and is not skipped', async () => {
  const { db, add } = journalDb();
  const timers = manualTimers();
  const bus = createBus({ db, timers });
  let fail = 2;
  const a = [];
  const b = [];
  bus.subscribe('flaky', (r) => { if (r.payload.n === 2 && fail > 0) { fail -= 1; throw new Error('slack 500'); } a.push(r.payload.n); });
  bus.subscribe('steady', (r) => { b.push(r.payload.n); });
  await bus.settle();
  add('x', { n: 1 }); add('x', { n: 2 }); add('x', { n: 3 });
  bus.poke();
  await bus.settle();
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1, 2, 3]);
  const h = bus.health().find((x) => x.consumer === 'flaky');
  assert.equal(h.failures, 1);
  assert.match(h.last_error.message, /slack 500/);
  assert.equal(h.backlog, 2);
  // Backoff timers: first 1 s, then 2 s.
  assert.equal(timers.q.at(-1).ms, 1000);
  timers.q.pop().fn();
  await bus.settle();
  assert.deepEqual(a, [1]);
  assert.equal(timers.q.at(-1).ms, 2000);
  timers.q.pop().fn();
  await bus.settle();
  assert.deepEqual(a, [1, 2, 3]);
  assert.equal(bus.health().find((x) => x.consumer === 'flaky').failures, 0);
});

test('bus: a restart resumes at the stored cursor (at-least-once, nothing lost)', async () => {
  const { db, add } = journalDb();
  const bus1 = createBus({ db, timers: manualTimers() });
  const first = [];
  bus1.subscribe('c', (r) => { first.push(r.payload.n); });
  await bus1.settle();
  add('x', { n: 1 }); add('x', { n: 2 });
  bus1.poke();
  await bus1.settle();
  bus1.stop();
  add('x', { n: 3 }); add('x', { n: 4 });
  const bus2 = createBus({ db, timers: manualTimers() });
  const second = [];
  bus2.subscribe('c', (r) => { second.push(r.payload.n); });
  await bus2.settle();
  assert.deepEqual(first, [1, 2]);
  assert.deepEqual(second, [3, 4]);
});

test('bus: the journal is never updated (append-only stays true with consumers running)', async () => {
  const { db, add } = journalDb();
  const bus = createBus({ db, timers: manualTimers() });
  bus.subscribe('c', () => {});
  add('x');
  bus.poke();
  await bus.settle();
  assert.throws(() => db.run("UPDATE journal SET kind = 'y'"), /append-only|abort|ABORT/i);
});

test('bus: the hub pokes consumers after commit (end to end through a real hub)', async () => {
  const h = await startHub();
  try {
    const bus = createBus({ db: h.db, timers: manualTimers() });
    h.hub.on('journal', () => bus.poke());
    const kinds = [];
    bus.subscribe('probe', (r) => { kinds.push(r.kind); });
    await bus.settle();
    const alice = await h.login('alice');
    await h.createCard(alice, { title: 'from the bus' });
    await settle();
    await bus.settle();
    assert.ok(kinds.includes('card.create'), kinds.join(','));
  } finally {
    await h.close();
  }
});

// ── vault ────────────────────────────────────────────────────────────────

test('vault: seal/open round trip; ciphertext is bound to its row (connection, kind) and key', () => {
  const key = randomBytes(32);
  const v = createVault(key);
  const sealed = v.seal('conn-1', 'bot_token', 'xoxb-secret-token');
  assert.equal(sealed.key_id, keyIdOf(key));
  assert.ok(!Buffer.from(sealed.ciphertext).toString('utf8').includes('xoxb'));
  assert.equal(v.open('conn-1', 'bot_token', sealed), 'xoxb-secret-token');
  assert.throws(() => v.open('conn-2', 'bot_token', sealed), /auth|unable|Unsupported/i);
  assert.throws(() => v.open('conn-1', 'signing_secret', sealed), /auth|unable|Unsupported/i);
  const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
  tampered.ciphertext[0] ^= 1;
  assert.throws(() => v.open('conn-1', 'bot_token', tampered), /auth|unable|Unsupported/i);
  const other = createVault(randomBytes(32));
  assert.throws(() => other.open('conn-1', 'bot_token', sealed), /different key/);
  // Two seals of the same value never repeat (fresh nonce).
  assert.notDeepEqual(v.seal('c', 'k', 'x').ciphertext, v.seal('c', 'k', 'x').ciphertext);
});

test('vault: without a key nothing can be sealed (connections are refused)', () => {
  const v = createVault(null);
  assert.equal(v.available, false);
  assert.throws(() => v.seal('c', 'k', 'x'), (e) => e.code === 'POLICY_DENIED');
});

test('loadKey: env hex/base64, keyfile outside the data dir only, 0600 only, 32 bytes only', () => {
  const hex = randomBytes(32).toString('hex');
  const env = { BOARD_ENC_KEY: hex };
  assert.equal(loadKey({ env, hasParentPort: false }).toString('hex'), hex);
  assert.equal(env.BOARD_ENC_KEY, undefined, 'the key is removed from env once read');
  assert.throws(() => loadKey({ env: { BOARD_ENC_KEY: hex }, hasParentPort: true }), /parentPort/);
  const b64 = randomBytes(32).toString('base64');
  assert.equal(loadKey({ env: { BOARD_ENC_KEY: b64 }, hasParentPort: false }).toString('base64'), b64);
  assert.throws(() => loadKey({ env: { BOARD_ENC_KEY: 'short' }, hasParentPort: false }), /32 bytes/);
  assert.equal(loadKey({ env: {}, hasParentPort: false }), null);
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  const data = join(dir, 'data');
  const inside = join(data, 'enc.key');
  assert.throws(() => loadKey({ env: { BOARD_ENC_KEY_FILE: inside }, dataDir: data, hasParentPort: false }), /outside BOARD_DATA_DIR/);
  // `..` and symlinks can't get a keyfile into the data dir either.
  mkdirSync(data, { recursive: true });
  const sneaky = join(dir, 'x', '..', 'data', 'k');
  writeFileSync(join(data, 'k'), randomBytes(32).toString('hex'), { mode: 0o600 });
  assert.throws(() => loadKey({ env: { BOARD_ENC_KEY_FILE: sneaky }, dataDir: data, hasParentPort: false }), /outside BOARD_DATA_DIR/);
  symlinkSync(join(data, 'k'), join(dir, 'link.key'));
  assert.throws(() => loadKey({ env: { BOARD_ENC_KEY_FILE: join(dir, 'link.key') }, dataDir: data, hasParentPort: false }), /outside BOARD_DATA_DIR/);
  symlinkSync(data, join(dir, 'datalink'));
  assert.throws(() => loadKey({ env: { BOARD_ENC_KEY_FILE: join(dir, 'link.key') }, dataDir: join(dir, 'datalink'), hasParentPort: false }), /outside BOARD_DATA_DIR/);
  const f = join(dir, 'enc.key');
  writeFileSync(f, hex);
  chmodSync(f, 0o644);
  assert.throws(() => loadKey({ env: { BOARD_ENC_KEY_FILE: f }, dataDir: data, hasParentPort: false }), /chmod 600/);
  chmodSync(f, 0o600);
  assert.equal(loadKey({ env: { BOARD_ENC_KEY_FILE: f }, dataDir: data, hasParentPort: false }).toString('hex'), hex);
});

test('migration 007: tables exist; identities are unique per workspace subject and per member', () => {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  db.run("INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', ?)", now);
  db.run("INSERT INTO connections (id, org_id, provider, external_id, created_at) VALUES ('c', 'o', 'slack', 'T1', ?)", now);
  assert.throws(() => db.run("INSERT INTO connections (id, org_id, provider, external_id, created_at) VALUES ('c2', 'o', 'slack', 'T1', ?)", now), /UNIQUE/);
  assert.throws(() => db.run("INSERT INTO connections (id, org_id, provider, external_id, status, created_at) VALUES ('c3', 'o', 'slack', 'T2', 'bogus', ?)", now), /CHECK/);
  for (const t of ['connection_secrets', 'external_identities', 'external_links', 'routes', 'inbound_dedupe', 'bus_cursors']) {
    assert.ok(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", t), t);
  }
});

test('bus: a poison row is dead-lettered after DEAD_AFTER tries on the same seq, and the consumer carries on', async () => {
  const { db, add } = journalDb();
  const timers = manualTimers();
  const bus = createBus({ db, timers });
  const got = [];
  bus.subscribe('c', (r) => { if (r.payload.n === 2) throw new Error('always broken'); got.push(r.payload.n); });
  await bus.settle();
  add('x', { n: 1 }); add('x', { n: 2 }); add('x', { n: 3 });
  bus.poke();
  await bus.settle();
  for (let i = 1; i < DEAD_AFTER; i += 1) { timers.q.pop().fn(); await bus.settle(); }
  assert.deepEqual(got, [1, 3]);
  const h = bus.health()[0];
  assert.equal(h.dead_letters, 1);
  assert.equal(h.backlog, 0);
  const dl = db.get('SELECT * FROM bus_dead_letters');
  assert.equal(dl.consumer, 'c');
  assert.match(dl.error, /always broken/);
});
