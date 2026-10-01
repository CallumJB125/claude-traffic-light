// Migration runner for the hub DB (Node only: reads the .sql files).
// Works with node:sqlite's DatabaseSync (exec/prepare). Migration 1 is
// schema.sql; later ones are migrations/NNN_name.sql, applied in version order,
// each in its own transaction, recorded in schema_migrations. Never edit an
// applied migration: add a new file.
//
// Versions may have gaps (D50): parallel branches reserve numbers, so every
// shipped version not yet in schema_migrations is applied, even one lower than
// a version already applied (a reserved 007 that lands after 009).
//
// A file whose leading comments carry `-- migrate: foreign_keys=off` (table rebuilds,
// SQLite's 12-step procedure) runs with foreign keys off, which only works
// outside a transaction; a foreign_key_check before COMMIT rolls it back if the
// rebuild broke a reference.
//
// `-- migrate: rebuilds` (alone or with foreign_keys=off, e.g.
// `-- migrate: foreign_keys=off rebuilds`) marks a file that drops and
// recreates tables: a later version's triggers or indexes on those tables would
// be lost, so it is refused when any higher version is already applied.
//
// A rebuild drops the table's triggers with it, including ones an earlier
// migration put there for safety: one that rebuilds `connections` must
// re-create connection_id_not_pending and connections_pinned_fixed (022, D97),
// 023's connections_revoked_unlink and connections_identity_fixed (025, D98),
// and one that rebuilds integration_pending its triggers too.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// Directives: `-- migrate: foreign_keys=off rebuilds` (space or comma
// separated), anywhere in the file's leading comment block (blank lines and
// other comments may come first; a BOM is ignored). The first SQL line ends it.
export function directives(sql) {
  const out = new Set();
  for (const line of sql.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('--')) break;
    const m = /^--[ \t]*migrate:[ \t]*(.*)$/.exec(t);
    if (m) for (const d of m[1].trim().split(/[\s,]+/).filter(Boolean)) out.add(d);
  }
  return out;
}

export function loadMigrations(dir = join(HERE, 'migrations')) {
  const list = [{ version: 1, name: 'init', sql: readFileSync(join(HERE, 'schema.sql'), 'utf8') }];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      const m = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(f);
      if (!m) continue;
      const version = Number(m[1]);
      if (version <= 1) throw new Error(`migration ${f}: versions start at 002`);
      list.push({ version, name: m[2], sql: readFileSync(join(dir, f), 'utf8').replace(/^\uFEFF/, '') });
    }
  }
  for (let i = 1; i < list.length; i++) {
    if (list[i].version === list[i - 1].version) throw new Error(`two migrations with version ${list[i].version}`);
  }
  return list;
}

export function currentVersion(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get().v;
}

/**
 * Apply pending migrations. Returns the list of applied versions.
 * opts.wal: set journal_mode=WAL (skip for :memory:). opts.now: () => ISO string.
 */
export function migrate(db, { migrations = loadMigrations(), wal = false, now = () => new Date().toISOString() } = {}) {
  db.exec('PRAGMA foreign_keys = ON');
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  currentVersion(db);
  const have = new Map(db.prepare('SELECT version, name FROM schema_migrations').all().map((r) => [r.version, r.name]));
  // A version recorded under another name is a different migration (a branch's
  // reserved number reused on main): skipping the shipped one would leave its
  // tables missing and fail later, so stop before applying anything.
  for (const m of migrations) {
    if (have.has(m.version) && have.get(m.version) !== m.name) {
      const v = String(m.version).padStart(3, '0');
      throw new Error(`migration ${v} was applied as ${v}_${have.get(m.version)} but this hub ships ${v}_${m.name}; this database came from another branch and cannot be migrated in place`);
    }
  }
  const applied = [];
  for (const m of migrations) {
    if (have.has(m.version)) continue;
    const dir = directives(m.sql);
    const fkOff = dir.has('foreign_keys=off');
    const newest = Math.max(0, ...have.keys());
    if (dir.has('rebuilds') && newest > m.version) {
      throw new Error(`migration ${String(m.version).padStart(3, '0')}_${m.name} rebuilds tables and cannot be applied after version ${newest}; apply migrations in order`);
    }
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      if (fkOff) {
        const bad = db.prepare('PRAGMA foreign_key_check').all();
        if (bad.length) throw new Error(`foreign key check failed: ${bad.slice(0, 3).map((r) => `${r.table}→${r.parent}`).join(', ')}`);
      }
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${String(m.version).padStart(3, '0')}_${m.name} failed: ${e.message}`);
    } finally {
      if (fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
    applied.push(m.version);
  }
  return applied;
}

/**
 * Restore safety (design §5.3, §9.2): after ANY restore from backup, before
 * accepting connections: new hub_epoch, every card's fence + 1000, all live
 * leases become reconnecting (the hub then runs states.step(hub_boot) per card
 * as on every boot). One transaction.
 */
export function applyRestoreBump(db, newEpoch, now = new Date().toISOString(), bump = 1000) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE cards SET fence = fence + ?').run(bump);
    db.prepare('UPDATE leases SET fence = fence + ?').run(bump);
    const upsert = db.prepare('INSERT INTO hub_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    upsert.run('hub_epoch', newEpoch);
    upsert.run('restored_at', now);
    upsert.run('fence_bump_applied', String(bump));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
