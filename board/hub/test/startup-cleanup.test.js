import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { Db, openDb } from '../db.js';
import { silentLogger } from '../log.js';
import { fakeClock, fakeGitHub, testConfig } from './helpers.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-startup-close-'));
  const config = testConfig({ dataDir: dir, dbPath: join(dir, 'board.db'), auth: 'local', localSecret: 's'.repeat(64) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { config, options: { clock: fakeClock(), log: silentLogger, github: fakeGitHub(), timers: false } };
}
function closed(raw) { assert.throws(() => raw.prepare('SELECT 1'), /not open|closed/i); }
function release(raw) { try { raw?.close(); } catch { /* An already closed fixture owns no handle. */ } }

test('refused missing local owner closes the acquired database and preserves stored data', t => {
  const f = fixture(t), seed = openDb(f.config.dbPath); seed.setMeta('local_member', 'missing-synthetic-owner'); seed.setMeta('kept', 'synthetic retained value'); seed.close();
  const meta = Db.prototype.meta; let raw;
  Db.prototype.meta = function (...args) { raw = this.raw; return meta.apply(this, args); };
  try {
    assert.throws(() => createApp(f.config, f.options), /local owner missing or removed/);
    assert.ok(raw); closed(raw);
    const inspect = openDb(f.config.dbPath);
    try { assert.equal(inspect.meta('kept'), 'synthetic retained value'); assert.equal(inspect.meta('local_member'), 'missing-synthetic-owner'); assert.equal(inspect.get('SELECT count(*) n FROM members').n, 0); }
    finally { inspect.close(); }
  } finally { Db.prototype.meta = meta; release(raw); }
});

test('post-open migration refusal closes SQLite without changing malformed existing metadata', t => {
  const f = fixture(t), seed = new DatabaseSync(f.config.dbPath); seed.exec("CREATE TABLE schema_migrations (unrecognized TEXT); INSERT INTO schema_migrations VALUES ('kept')"); seed.close();
  const exec = DatabaseSync.prototype.exec; let raw;
  DatabaseSync.prototype.exec = function (...args) { raw = this; return exec.apply(this, args); };
  try { assert.throws(() => openDb(f.config.dbPath), /version/); assert.ok(raw); closed(raw); }
  finally { DatabaseSync.prototype.exec = exec; release(raw); }
  const inspect = new DatabaseSync(f.config.dbPath);
  try { assert.equal(inspect.prepare('SELECT unrecognized FROM schema_migrations').get().unrecognized, 'kept'); }
  finally { inspect.close(); }
});

test('existing local-mode refusal retains its original error and closes exactly once', t => {
  const f = fixture(t), seed = openDb(f.config.dbPath); seed.setMeta('local_member', 'synthetic-local-marker'); seed.close();
  const close = Db.prototype.close; let calls = 0, raw;
  Db.prototype.close = function () { calls++; raw = this.raw; return close.call(this); };
  try { assert.throws(() => createApp({ ...f.config, auth: 'dev' }, f.options), /belongs to the desktop app/); assert.equal(calls, 1); closed(raw); }
  finally { Db.prototype.close = close; release(raw); }
});

test('successful construction keeps the real database available until normal app shutdown', async t => {
  const f = fixture(t), app = createApp(f.config, f.options); const raw = app.db.raw;
  try { assert.equal(app.db.meta('local_member'), app.hub.localMemberId); assert.ok(raw.prepare('SELECT 1').get()); await app.listen(0, '127.0.0.1'); }
  finally { await app.close({ graceMs: 100 }); }
  closed(raw);
});
