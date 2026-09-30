// Integrations security review, round 4 (callumbaker-70): migration 008 never
// silently drops another migration's triggers or indexes (H-1); webhook
// failure buckets per (connection, IP) that never refuse a verified delivery (M-1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { defineConnector } from '../integrations/connector.js';
import { migrate, loadMigrations, currentVersion } from '../../shared/migrate.js';
import { replay } from '../../shared/journal.js';
import { dashboardMetrics } from '../../web/js/metrics.js';
import { startHub } from './helpers.js';

// ── H-1 ───────────────────────────────────────────────────────────────────

const at007 = () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, { migrations: loadMigrations().filter((m) => m.version <= 7) });
  return db;
};
const schemaOf = (db, tables = ['comments', 'journal']) => db.prepare(
  `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN (${tables.map(() => '?').join(',')}) ORDER BY type, name`,
).all(...tables).map((r) => ({ ...r }));

test('H-1: 008 starts with the `-- migrate: rebuilds` directive, which the runner reads as a comment', () => {
  const m = loadMigrations().find((x) => x.version === 8);
  assert.equal(m.sql.split('\n')[0], '-- migrate: rebuilds');
  assert.match(readFileSync(new URL('../../shared/migrations/008_integrations.sql', import.meta.url), 'utf8'), /^-- migrate: rebuilds\n/);
});

test('H-1: 008 keeps every trigger and index journal and comments had at 007 (only the two table definitions change)', () => {
  const db = at007();
  const before = schemaOf(db);
  migrate(db, { migrations: loadMigrations().filter((m) => m.version <= 8) });
  const after = schemaOf(db);
  const noTable = (rows) => rows.filter((r) => r.type !== 'table');
  assert.deepEqual(noTable(after), noTable(before));
  assert.deepEqual(after.filter((r) => r.type === 'table').map((r) => r.name), ['comments', 'journal']);
  db.close();
});

test('H-1: 008 aborts, changing nothing, rather than drop a trigger or index it does not recreate (e.g. xteam_comments_ins/upd)', () => {
  for (const extra of [
    `CREATE TRIGGER xteam_comments_ins BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT, 'cross-team') WHERE 0; END;
     CREATE TRIGGER xteam_comments_upd BEFORE UPDATE ON comments BEGIN SELECT RAISE(ABORT, 'cross-team') WHERE 0; END;`,
    'CREATE INDEX comments_by_card_later ON comments (card_id, created_at);',
    'CREATE INDEX journal_by_kind_later ON journal (kind);',
  ]) {
    const db = at007();
    db.exec(extra);
    const before = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all().map((r) => ({ ...r }));
    assert.throws(() => migrate(db, { migrations: loadMigrations().filter((m) => m.version <= 8) }), /008_integrations failed: 008 rebuilds journal and comments and would drop triggers or indexes/);
    assert.equal(currentVersion(db), 7);
    assert.deepEqual(db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all().map((r) => ({ ...r })), before);
    db.close();
  }
});

// ── M-1 ───────────────────────────────────────────────────────────────────

async function hubWith(opts = {}) {
  const h = await startHub(opts);
  h.hub.setVaultKey(randomBytes(32));
  return h;
}

const probe = (id, over = {}) => defineConnector({
  id, name: `Probe ${id}`, scopes: [], secrets: [], hosts: ['api.probe.example'],
  connect: { kind: 'token', verifyToken: async () => ({ external_id: 'w1' }) },
  verify: ({ headers }) => (headers['x-ok'] === '1' ? { ok: true, dedupe_key: headers['x-id'] } : { ok: false, reason: 'nope' }),
  handleWebhook: async () => {},
  actions: { 'card.create': { default: 'auto' } },
  ...over,
});

test('M-1: bad posts from an IP to connection A never block that IP’s verified deliveries to A or B', async () => {
  const h = await hubWith();
  try {
    const reg = h.app.integrations;
    reg.register(probe('pa'));
    reg.register(probe('pb'));
    const a = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'pa', external_id: 'w1' });
    const b = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'pb', external_id: 'w1' });
    h.hub.limiter.limits.webhook_fail_ip = { capacity: 2, per_ms: 60_000 };
    const post = (conn, headers) => fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers, body: JSON.stringify({ id: randomUUID() }) });
    assert.equal((await post(a, { 'x-id': 'x' })).status, 401);
    assert.equal((await post(a, { 'x-id': 'x' })).status, 401);
    assert.equal((await post(a, { 'x-id': 'x' })).status, 429, 'failures past the budget are refused');
    assert.equal((await post(a, { 'x-ok': '1', 'x-id': 'good-a' })).status, 200, 'a verified delivery to A still runs');
    assert.equal((await post(b, { 'x-ok': '1', 'x-id': 'good-b' })).status, 200, 'and to B');
    assert.equal((await post(b, { 'x-id': 'x' })).status, 401, 'B has its own failure budget');
  } finally { await h.close(); }
});

test('M-1: a flooding (connection, IP) pair gets one body read at a time; another connection is unaffected', async () => {
  const h = await hubWith();
  try {
    const reg = h.app.integrations;
    reg.register(probe('fa'));
    reg.register(probe('fb'));
    const a = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'fa', external_id: 'w1' });
    const b = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'fb', external_id: 'w1' });
    h.hub.limiter.limits.webhook_fail_ip = { capacity: 1, per_ms: 60_000 };
    assert.equal((await fetch(`${h.base}/integrations/${a.id}/webhook`, { method: 'POST', body: '{}' })).status, 401);
    const open = (conn) => {
      const u = new URL(`${h.base}/integrations/${conn.id}/webhook`);
      const out = { status: null };
      out.req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-length': String(5_000_000) } }, (res) => { res.resume(); out.status = res.statusCode; });
      out.req.on('error', () => {});
      out.req.write('{"partial":');
      return out;
    };
    const held = open(a);
    await new Promise((r) => setTimeout(r, 100));
    const flood = Array.from({ length: 5 }, () => open(a));
    const other = open(b);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(flood.map((f) => f.status), [429, 429, 429, 429, 429], 'refused before their bodies are read');
    assert.equal(held.status, null, 'the one read in flight goes on');
    assert.equal(other.status, null, 'another connection is read as usual');
    for (const x of [held, other, ...flood]) x.req.destroy();
  } finally { await h.close(); }
});

// ── M-2 ───────────────────────────────────────────────────────────────────

test('M-2: an integration’s card.create journals hashes and ids, never the title, body or acceptance; replay and the Dashboard still work', async () => {
  const h = await hubWith();
  try {
    const reg = h.app.integrations;
    reg.register(probe('tracker2'));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'tracker2', external_id: 'w1' });
    const ctx = reg.ctxFor(conn.id);
    const secret = 'Customer ACME-4471 cannot log in';
    const { card } = (await ctx.act('card.create', { external_ref: 'ISS-9' }, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, {
      request_id: randomUUID(), title: secret, body: `${secret}: full report`, acceptance: `${secret} fixed`,
    }))).result;
    const row = h.db.get("SELECT actor_kind, actor_id, payload FROM journal WHERE kind = 'card.create' AND card_id = ?", card.id);
    assert.equal(row.actor_kind, 'integration');
    assert.equal(row.actor_id, conn.id);
    assert.ok(!row.payload.includes('ACME'), 'no external text in the journal');
    const p = JSON.parse(row.payload);
    for (const f of ['title', 'body', 'acceptance']) {
      assert.equal(f in p, false, `${f} is not journaled`);
      assert.match(p[`${f}_sha256`], /^[0-9a-f]{16}$/);
    }
    assert.equal(p.title_sha256, createHash('sha256').update(secret).digest('hex').slice(0, 16));
    assert.equal(p.connection_id, conn.id);
    assert.equal(p.external_ref, 'ISS-9');
    assert.equal(p.key, card.key);
    // Replay rebuilds the card (its title lives in `cards`), the Dashboard shows the live title.
    const rows = h.db.all('SELECT * FROM journal ORDER BY seq');
    const r = replay(rows).get(card.id);
    assert.equal(r.key, card.key);
    assert.equal(r.title, null);
    assert.deepEqual(JSON.parse(r.labels), ['via:tracker2']);
    // The Dashboard reads the title from the snapshot's card; a card no longer
    // on the board shows its key (the title is null, rendered 'Removed card').
    const t0 = Date.now() - 3 * 3_600_000;
    const hist = [
      { seq: 1, card_id: card.id, at_hub: t0, kind: 'card.create', payload: p },
      { seq: 2, card_id: card.id, at_hub: t0 + 1000, kind: 'card.update', payload: { fields: { column_name: ['todo', 'in_progress'] } } },
      { seq: 3, card_id: card.id, at_hub: t0 + 2000, kind: 'card.update', payload: { fields: { column_name: ['in_progress', 'done'] } } },
    ];
    const onBoard = dashboardMetrics({ rows: hist, cards: [{ id: card.id, key: card.key, title: card.title }], now: Date.now() });
    assert.deepEqual(onBoard.cycle.items.map((i) => [i.key, i.title, i.on_board]), [[card.key, secret, true]]);
    const gone = dashboardMetrics({ rows: hist, cards: [], now: Date.now() });
    assert.deepEqual(gone.cycle.items.map((i) => [i.key, i.title, i.on_board]), [[card.key, null, false]]);
    // A person's own card keeps its text in the journal.
    const alice = await h.login('alice');
    const mine = await h.api(alice, 'POST', `/api/boards/${h.ids.board}/cards`, { request_id: randomUUID(), title: 'Mine', body: 'b' });
    assert.equal(JSON.parse(h.db.get("SELECT payload FROM journal WHERE kind = 'card.create' AND card_id = ?", mine.body.card.id).payload).title, 'Mine');
  } finally { await h.close(); }
});

// ── M-3 ───────────────────────────────────────────────────────────────────

test('M-3: an integration spends its own integration_conn bucket, never the member’s mutate_member', async () => {
  const h = await hubWith({ config: { rateLimits: { mutate_member: { capacity: 3, per_ms: 60_000 }, integration_conn: { capacity: 5, per_ms: 60_000 } } } });
  try {
    const reg = h.app.integrations;
    reg.register(probe('flood'));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'flood', external_id: 'w1' });
    const ctx = reg.ctxFor(conn.id);
    const create = () => ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: randomUUID(), title: 'From outside' }));
    for (let i = 0; i < 5; i += 1) await create();
    await assert.rejects(create(), (e) => e.code === 'RATE_LIMITED');
    const alice = await h.login('alice');
    for (let i = 0; i < 3; i += 1) {
      const r = await h.api(alice, 'POST', `/api/boards/${h.ids.board}/cards`, { request_id: randomUUID(), title: `Mine ${i}` });
      assert.equal(r.status, 200, 'the admin’s own browser is untouched by the flood');
    }
  } finally { await h.close(); }
});

test('M-3: at most 20 cards an hour per connection: the 21st is RATE_LIMITED and its act() is audited failed', async () => {
  const h = await hubWith();
  try {
    const reg = h.app.integrations;
    reg.register(probe('cap'));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'cap', external_id: 'w1' });
    const ctx = reg.ctxFor(conn.id);
    const create = (n) => ctx.act('card.create', { external_ref: `I-${n}` }, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: `issue-${n}`, title: `Issue ${n}` }));
    for (let i = 1; i <= 20; i += 1) assert.equal((await create(i)).decision, 'auto');
    await assert.rejects(create(21), (e) => e.code === 'RATE_LIMITED' && /retry in \d+ s/.test(e.message));
    assert.deepEqual({ ...h.db.get("SELECT decision, error FROM integration_audit WHERE external_ref = 'I-21'") }, { decision: 'failed', error: 'rate_limited' });
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM cards WHERE title LIKE 'Issue %'").n, 20);
    // Comments are not cards: they are still allowed (integration_conn only).
    const cardId = h.db.get("SELECT id FROM cards WHERE title = 'Issue 1'").id;
    await ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).comment(cardId, { request_id: randomUUID(), body: 'still here' }));
  } finally { await h.close(); }
});
