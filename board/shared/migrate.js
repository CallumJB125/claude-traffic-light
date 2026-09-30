// Migration runner for the hub DB (Node only: reads the .sql files).
// Works with node:sqlite's DatabaseSync (exec/prepare). Migration 1 is
// schema.sql; later ones are migrations/NNN_name.sql, applied in order, each
// in its own transaction, recorded in schema_migrations. Never edit an
// applied migration: add a new file.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadMigrations(dir = join(HERE, 'migrations')) {
  const list = [{ version: 1, name: 'init', sql: readFileSync(join(HERE, 'schema.sql'), 'utf8') }];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      const m = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(f);
      if (!m) continue;
      const version = Number(m[1]);
      if (version <= 1) throw new Error(`migration ${f}: versions start at 002`);
      list.push({ version, name: m[2], sql: readFileSync(join(dir, f), 'utf8') });
    }
  }
  for (let i = 1; i < list.length; i++) {
    if (list[i].version !== list[i - 1].version + 1) throw new Error(`migration gap before ${list[i].version}`);
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
  const have = currentVersion(db);
  const applied = [];
  for (const m of migrations) {
    if (m.version <= have) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${String(m.version).padStart(3, '0')}_${m.name} failed: ${e.message}`);
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
