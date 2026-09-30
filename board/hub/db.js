// SQLite via node:sqlite (no native deps). WAL + synchronous=NORMAL +
// busy_timeout: the layout Litestream expects (one file, the hub never
// truncates the WAL itself). node:sqlite binds only null/number/bigint/
// string/Uint8Array, so every call goes through bind().

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from '../shared/migrate.js';

const bind = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export class HubError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.code = code;
    this.extra = extra;
  }
}

export function openDb(path, { now } = {}) {
  const memory = path === ':memory:';
  if (!memory) mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA busy_timeout = 5000');
  migrate(raw, { wal: !memory, now });
  if (!memory) raw.exec('PRAGMA synchronous = NORMAL');
  return new Db(raw);
}

export class Db {
  constructor(raw) {
    this.raw = raw;
    this.cache = new Map();
    this.depth = 0;
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  get(sql, ...args) { return this.stmt(sql).get(...args.map(bind)) ?? null; }
  all(sql, ...args) { return this.stmt(sql).all(...args.map(bind)); }
  run(sql, ...args) { return this.stmt(sql).run(...args.map(bind)); }
  exec(sql) { this.raw.exec(sql); }

  // Nested calls become savepoints; the outermost is BEGIN IMMEDIATE.
  tx(fn) {
    const sp = `sp${this.depth}`;
    this.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.depth--;
      this.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  insert(table, row) {
    const keys = Object.keys(row);
    return this.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
  }

  meta(k) { return this.get('SELECT v FROM hub_meta WHERE k = ?', k)?.v ?? null; }
  setMeta(k, v) { this.run('INSERT INTO hub_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v)); }

  close() { this.raw.close(); }
}

export const json = (v, d = null) => {
  if (v == null) return d;
  try { return JSON.parse(v); } catch { return d; }
};
