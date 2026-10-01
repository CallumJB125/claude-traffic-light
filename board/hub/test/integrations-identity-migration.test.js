// Migration 023 (D98): external_identities.connection_id with its triggers.
// The backfill never deletes a row: what it can't attribute to exactly one
// active connection aborts the migration instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrate, loadMigrations, currentVersion } from '../../shared/migrate.js';
import { openDb } from '../db.js';

const NOW = '2026-09-30T10:00:00.000Z';
const upTo = (v) => loadMigrations().filter((m) => m.version <= v);

function populated() {
  const db = new DatabaseSync(':memory:');
  migrate(db, { migrations: upTo(22) });
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const ids = { orgA: randomUUID(), orgB: randomUUID(), alice: randomUUID(), bob: randomUUID(), ben: randomUUID(), connA: randomUUID(), connB: randomUUID(), revoked: randomUUID(), board: randomUUID() };
  run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?), (?, ?, ?)', ids.orgA, 'A', NOW, ids.orgB, 'B', NOW);
  let gh = 1;
  for (const [id, org, login, role] of [[ids.alice, ids.orgA, 'alice', 'owner'], [ids.bob, ids.orgA, 'bob', 'member'], [ids.ben, ids.orgB, 'ben', 'owner']]) {
    run('INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, org, gh++, login, `${login}@x.test`, login, role, NOW);
  }
  run("INSERT INTO boards (id, org_id, name, key_prefix, settings) VALUES (?, ?, 'B', 'BB', '{}')", ids.board, ids.orgA);
  run("INSERT INTO connections (id, org_id, provider, external_id, created_by, created_at) VALUES (?, ?, 'slack', 'T1', ?, ?)", ids.connA, ids.orgA, ids.alice, NOW);
  run("INSERT INTO connections (id, org_id, provider, external_id, created_by, created_at) VALUES (?, ?, 'slack', 'T2', ?, ?)", ids.connB, ids.orgB, ids.ben, NOW);
  run("INSERT INTO connections (id, org_id, provider, external_id, status, created_by, created_at) VALUES (?, ?, 'slack', 'T9', 'revoked', ?, ?)", ids.revoked, ids.orgA, ids.alice, NOW);
  run("INSERT INTO connection_secrets (connection_id, kind, key_id, nonce, ciphertext, created_at) VALUES (?, 'bot_token', 'k', x'00', x'00', ?)", ids.connA, NOW);
  run("INSERT INTO external_links (card_id, connection_id, kind, external_id, created_at) SELECT NULL, NULL, 'x', 'x', ? WHERE 0", NOW);
  const ident = (subject, member, ws) => run("INSERT INTO external_identities (provider, workspace_id, subject, member_id, verified_via, linked_at) VALUES ('slack', ?, ?, ?, 'oauth_link', ?)", ws, subject, member, NOW);
  ident('U1', ids.alice, 'T1');
  ident('U2', ids.bob, 'T1');
  ident('U3', ids.ben, 'T2');
  return { db, ids, ident, run };
}

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'").all().map((r) => r.name);
const counts = (db) => Object.fromEntries(tables(db).map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));

test('023 on a populated DB: every identity row is kept and attributed to its one active connection; no row of any table is deleted', () => {
  const { db, ids } = populated();
  const before = counts(db);
  migrate(db, { migrations: loadMigrations() });
  assert.ok(currentVersion(db) >= 23);
  const after = counts(db);
  for (const [t, n] of Object.entries(before)) assert.equal(after[t], n, `${t} lost rows`);
  const rows = db.prepare('SELECT subject, member_id, connection_id FROM external_identities ORDER BY subject').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { subject: 'U1', member_id: ids.alice, connection_id: ids.connA },
    { subject: 'U2', member_id: ids.bob, connection_id: ids.connA },
    { subject: 'U3', member_id: ids.ben, connection_id: ids.connB },
  ]);
  db.close();
});

test('023 aborts, changing nothing, rather than delete a row it can\'t attribute (no active connection, a revoked one, another org\'s, a removed member)', () => {
  const cases = [
    ['no connection for the workspace', (x) => x.ident('U9', x.ids.bob, 'T404')],
    ['only a revoked connection', (x) => x.ident('U9', x.ids.bob, 'T9')],
    ['the workspace is another org\'s', (x) => x.ident('U9', x.ids.ben, 'T1')],
    ['the member was removed', (x) => x.run('UPDATE members SET removed_at = ? WHERE id = ?', NOW, x.ids.bob)],
  ];
  for (const [name, spoil] of cases) {
    const x = populated();
    spoil(x);
    const before = counts(x.db);
    const schema = x.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all().map((r) => r.sql);
    assert.throws(() => migrate(x.db, { migrations: loadMigrations() }), /023_identity_links failed: .*cannot be attributed/, name);
    assert.equal(currentVersion(x.db), 22, name);
    assert.deepEqual(counts(x.db), before, name);
    assert.deepEqual(x.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all().map((r) => r.sql), schema, `${name}: no column or trigger left behind`);
    x.db.close();
  }
});

test('after every migration the 023 triggers exist (a later rebuild of connections, members or external_identities must re-create them)', () => {
  const db = openDb(':memory:');
  const names = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger'").map((r) => r.name));
  for (const t of ['external_identities_ins', 'external_identities_no_update', 'members_removed_unlink', 'connections_revoked_unlink']) {
    assert.ok(names.has(t), `trigger ${t} is missing`);
  }
});

test('023 triggers: an insert needs an active connection of the same provider and workspace in the live member\'s org; updates abort; removal, a team move and a revoke delete the links', () => {
  const db = openDb(':memory:');
  const run = (sql, ...a) => db.run(sql, ...a);
  const orgA = randomUUID();
  const orgB = randomUUID();
  run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?), (?, ?, ?)', orgA, 'A', NOW, orgB, 'B', NOW);
  const member = (org, role = 'member') => {
    const id = randomUUID();
    run('INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, org, -Math.floor(Math.random() * 1e9), `m${id.slice(0, 6)}`, `${id}@x.test`, 'm', role, NOW);
    return id;
  };
  const a1 = member(orgA, 'owner');
  const a2 = member(orgA);
  const a3 = member(orgA);
  const b1 = member(orgB, 'owner');
  const conn = (org, ws, by, status = 'active') => {
    const id = randomUUID();
    run('INSERT INTO connections (id, org_id, provider, external_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, org, 'slack', ws, status, by, NOW);
    return id;
  };
  const cA = conn(orgA, 'T1', a1);
  const cB = conn(orgB, 'T2', b1);
  const cR = conn(orgA, 'T3', a1, 'revoked');
  const ins = (subject, memberId, ws, connectionId, provider = 'slack') => run("INSERT INTO external_identities (provider, workspace_id, subject, member_id, connection_id, verified_via, linked_at) VALUES (?, ?, ?, ?, ?, 'oauth_link', ?)", provider, ws, subject, memberId, connectionId, NOW);
  for (const [name, args] of [
    ['NULL connection_id', ['U1', a1, 'T1', null]],
    ['another org\'s member', ['U1', b1, 'T1', cA]],
    ['another org\'s connection', ['U1', a1, 'T2', cB]],
    ['a revoked connection', ['U1', a1, 'T3', cR]],
    ['workspace ≠ external_id', ['U1', a1, 'T2', cA]],
    ['provider ≠ the connection\'s', ['U1', a1, 'T1', cA, 'github']],
    ['an unknown connection', ['U1', a1, 'T1', randomUUID()]],
  ]) assert.throws(() => ins(...args), /cross-team reference|FOREIGN KEY/, name);
  run('UPDATE members SET removed_at = ? WHERE id = ?', NOW, a3);
  assert.throws(() => ins('U3', a3, 'T1', cA), /cross-team reference/, 'a removed member');
  ins('U1', a1, 'T1', cA);
  ins('U2', a2, 'T1', cA);
  ins('U4', b1, 'T2', cB);
  for (const sql of ["UPDATE external_identities SET subject = 'U9'", `UPDATE external_identities SET member_id = '${a2}'`, `UPDATE external_identities SET connection_id = '${cB}'`, "UPDATE external_identities SET linked_at = 'x'"]) {
    assert.throws(() => run(`${sql} WHERE subject = 'U1'`), /never changed/, sql);
  }
  // 008's UNIQUEs still hold: one subject and one member per workspace.
  assert.throws(() => ins('U1', a3, 'T1', cA), /UNIQUE|cross-team/);
  assert.throws(() => ins('U8', a1, 'T1', cA), /UNIQUE/);
  const subjects = () => db.all('SELECT subject FROM external_identities ORDER BY subject').map((r) => r.subject);
  run('UPDATE members SET removed_at = ? WHERE id = ?', NOW, a2);
  assert.deepEqual(subjects(), ['U1', 'U4']);
  run('UPDATE members SET org_id = ? WHERE id = ?', orgB, a1);
  assert.deepEqual(subjects(), ['U4']);
  run("UPDATE connections SET status = 'revoked', revoked_at = ? WHERE id = ?", NOW, cB);
  assert.deepEqual(subjects(), []);
});
