// Integrations security review, round 4 (callumbaker-70): migration 008 never
// silently drops another migration's triggers or indexes (H-1); webhook
// failure buckets per (connection, IP) that never refuse a verified delivery (M-1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { defineConnector } from '../integrations/connector.js';
import { migrate, loadMigrations, currentVersion } from '../../shared/migrate.js';
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
