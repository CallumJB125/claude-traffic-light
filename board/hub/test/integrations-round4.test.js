// Integrations security review, round 4 (callumbaker-70): migration 008 never
// silently drops another migration's triggers or indexes (H-1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrate, loadMigrations, currentVersion } from '../../shared/migrate.js';

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
