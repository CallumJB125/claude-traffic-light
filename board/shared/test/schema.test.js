import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, loadMigrations, currentVersion, applyRestoreBump } from '../migrate.js';
import { step, toDb, STATES, DARK } from '../states.js';

const NOW = '2026-09-30T10:00:00.000Z';

function fresh() {
  const db = new DatabaseSync(':memory:');
  migrate(db, { now: () => NOW });
  db.exec(`
    INSERT INTO orgs (id, name, created_at) VALUES ('o1','Org','${NOW}');
    INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at)
      VALUES ('m1','o1',1,'callum','c@x.io','Callum','owner','${NOW}'), ('m2','o1',2,'james','j@x.io','James','member','${NOW}');
    INSERT INTO devices (id, member_id, name, kind, token_hash, created_at) VALUES ('d1','m1','MacBook','runner','h1','${NOW}');
    INSERT INTO repos (id, org_id, canonical_url, short_name) VALUES ('r1','o1','github.com/pistorventures/bondly','bondly');
    INSERT INTO boards (id, org_id, name, key_prefix) VALUES ('b1','o1','Team','BDL');
    INSERT INTO board_repos VALUES ('b1','r1');
  `);
  return db;
}

const insertCard = (db, id, cols = {}) => {
  const row = { id, board_id: 'b1', key: `BDL-${id}`, title: 't', repo_id: 'r1', created_by: 'm1', created_at: NOW, updated_at: NOW, ...cols };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO cards (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
};

test('migrate: applies 001 and the shipped migrations once, records them, is idempotent', () => {
  const db = new DatabaseSync(':memory:');
  const shipped = loadMigrations().map((m) => m.version);
  assert.deepEqual(migrate(db, { now: () => NOW }), shipped);
  assert.deepEqual(migrate(db), []);
  assert.equal(currentVersion(db), shipped.at(-1));
  assert.ok(db.prepare('PRAGMA table_info(devices)').all().some((c) => c.name === 'form_factor'), '002 device form factor');
  assert.ok(db.prepare('PRAGMA table_info(devices)').all().some((c) => c.name === 'outbox_id'), '004 outbox identity');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  for (const t of ['orgs', 'hub_meta', 'members', 'devices', 'repos', 'boards', 'board_repos', 'runner_repos', 'cards', 'card_assignees', 'dispatches', 'runs', 'leases', 'events', 'handovers', 'comments', 'evidence', 'asks', 'permission_requests', 'memories', 'path_locks', 'plan_steps', 'budgets', 'trust_policy', 'overlaps', 'audit', 'schema_migrations']) {
    assert.ok(tables.includes(t), t);
  }
});

test('migrate: later files apply in order in their own transaction; a failing one rolls back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-mig-'));
  try {
    writeFileSync(join(dir, '002_add_x.sql'), 'CREATE TABLE x (a INTEGER);');
    const db = new DatabaseSync(':memory:');
    assert.deepEqual(migrate(db, { migrations: loadMigrations(dir) }), [1, 2]);
    writeFileSync(join(dir, '003_bad.sql'), 'CREATE TABLE y (a INTEGER); CREATE TABLE x (a INTEGER);');
    assert.throws(() => migrate(db, { migrations: loadMigrations(dir) }), /003_bad failed/);
    assert.equal(currentVersion(db), 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='y'").get().n, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: gaps are allowed and a reserved lower version landing later is still applied (D50)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-mig-'));
  try {
    writeFileSync(join(dir, '002_a.sql'), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(dir, '005_c.sql'), 'CREATE TABLE c (x INTEGER);');
    const db = new DatabaseSync(':memory:');
    assert.deepEqual(migrate(db, { migrations: loadMigrations(dir) }), [1, 2, 5]);
    writeFileSync(join(dir, '003_b.sql'), 'CREATE TABLE b (x INTEGER);');
    assert.deepEqual(migrate(db, { migrations: loadMigrations(dir) }), [3]);
    assert.deepEqual(migrate(db, { migrations: loadMigrations(dir) }), []);
    writeFileSync(join(dir, '003_dup.sql'), 'SELECT 1;');
    assert.throws(() => loadMigrations(dir), /two migrations with version 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate: `-- migrate: foreign_keys=off` rebuilds a referenced table with ids intact; a broken reference rolls back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-mig-'));
  try {
    writeFileSync(join(dir, '002_base.sql'), `
      CREATE TABLE people (id TEXT PRIMARY KEY, login TEXT NOT NULL);
      CREATE TABLE posts (id TEXT PRIMARY KEY, author TEXT NOT NULL REFERENCES people);
      INSERT INTO people VALUES ('p1','a'), ('p2','b');
      INSERT INTO posts VALUES ('x1','p1'), ('x2','p2');`);
    const db = new DatabaseSync(':memory:');
    migrate(db, { migrations: loadMigrations(dir) });
    // Without the directive, DROP TABLE people fails (posts refer to it).
    writeFileSync(join(dir, '003_rebuild.sql'), `-- migrate: foreign_keys=off
      CREATE TABLE people_new (id TEXT PRIMARY KEY, login TEXT);
      INSERT INTO people_new SELECT id, login FROM people;
      DROP TABLE people;
      ALTER TABLE people_new RENAME TO people;`);
    assert.deepEqual(migrate(db, { migrations: loadMigrations(dir) }), [3]);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys back on');
    assert.deepEqual(db.prepare('SELECT p.id FROM posts x JOIN people p ON p.id = x.author ORDER BY p.id').all().map((r) => r.id), ['p1', 'p2']);
    assert.equal(db.prepare("SELECT * FROM pragma_table_info('people') WHERE name = 'login'").get().notnull, 0, 'NOT NULL dropped');
    writeFileSync(join(dir, '004_breaks.sql'), `-- migrate: foreign_keys=off
      DELETE FROM people WHERE id = 'p2';`);
    assert.throws(() => migrate(db, { migrations: loadMigrations(dir) }), /004_breaks failed: foreign key check failed: posts→people/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM people').get().n, 2, 'rolled back');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    // The directive counts only on the first line.
    writeFileSync(join(dir, '004_breaks.sql'), `SELECT 1;
      -- migrate: foreign_keys=off
      DELETE FROM people WHERE id = 'p2';`);
    assert.throws(() => migrate(db, { migrations: loadMigrations(dir) }), /FOREIGN KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fence is monotonic (trigger) and restore bumps +1000 with a new epoch', () => {
  const db = fresh();
  insertCard(db, 'c1', { fence: 3 });
  db.prepare("UPDATE cards SET fence = 4 WHERE id = 'c1'").run();
  assert.throws(() => db.prepare("UPDATE cards SET fence = 4 WHERE id = 'c1'").run(), /fence must strictly increase/);
  assert.throws(() => db.prepare("UPDATE cards SET fence = 2 WHERE id = 'c1'").run(), /fence must strictly increase/);
  applyRestoreBump(db, 'epoch-2', NOW);
  assert.equal(db.prepare("SELECT fence FROM cards WHERE id='c1'").get().fence, 1004);
  assert.equal(db.prepare("SELECT v FROM hub_meta WHERE k='hub_epoch'").get().v, 'epoch-2');
});

test('run_state / fail_kind / blocked_kind / resume_to CHECKs', () => {
  const db = fresh();
  assert.throws(() => insertCard(db, 'a', { run_state: 'todo' }), /CHECK/, "'todo' is stored as NULL");
  assert.throws(() => insertCard(db, 'b', { run_state: 'paused_offline', column_name: 'in_progress' }), /CHECK/, 'runner-local state never stored');
  assert.throws(() => insertCard(db, 'c', { run_state: 'failed', fail_kind: 'bogus', column_name: 'in_progress' }), /CHECK/);
  assert.throws(() => insertCard(db, 'd', { run_state: 'running', fail_kind: 'error', column_name: 'in_progress' }), /CHECK/);
  assert.throws(() => insertCard(db, 'e', { run_state: 'running', resume_to: 'quiet', column_name: 'in_progress' }), /CHECK/);
  assert.throws(() => insertCard(db, 'f', { run_state: 'running', column_name: 'todo' }), /CHECK/, 'column derives from run state');
  assert.throws(() => insertCard(db, 'g', { repo_id: null, run_state: 'queued' }), /CHECK/, 'no run without a repo');
  insertCard(db, 'h', { run_state: 'blocked', blocked_kind: 'decision', column_name: 'in_progress' });
  insertCard(db, 'i', { run_state: 'failed', fail_kind: 'released', column_name: 'in_progress' });
  insertCard(db, 'j', { run_state: 'suspended', resume_to: 'blocked', blocked_kind: 'permission', column_name: 'in_progress' });
  insertCard(db, 'k', { repo_id: null, column_name: 'in_progress' });
});

test('every state-machine output satisfies the cards CHECKs', () => {
  const db = fresh();
  const OK = new Proxy({ open_asks_remaining: 0, hub_uptime_ms: 3_600_000, tunnel_ok: true }, { get: (t, k) => (k in t ? t[k] : true) });
  const seedFor = (s) => ({
    run_state: s, fence: 1, blocked_kind: s === 'blocked' || s === 'parked' ? 'question' : null,
    fail_kind: s === 'failed' ? 'error' : null, resume_to: DARK.has(s) ? 'blocked' : null,
    pre_reconnect_state: s === 'reconnecting' ? 'running' : null, handover_target: s === 'handing_over' ? { kind: 'queue' } : null, handover_provenance: null,
  });
  const events = ['dispatch', 'cancel', 'claim', 'activity', 'prep_failed', 'hb_timeout', 'claim_timeout', 'quiet_timeout', 'block', 'answer', 'park_timeout',
    'host_suspending', 'hb', 'orphan_timeout', 'suspend_timeout', 'hub_boot', 'reconnect_timeout', 'run_failed', 'stop', 'release', 'retry', 'take_over',
    'hand_over', 'handover_complete', 'handover_timeout', 'redispatch', 'take_myself', 'complete', 'request_changes', 'pr_closed', 'pr_merged'];
  let n = 0;
  for (const s of STATES) {
    for (const type of events) {
      const r = step(seedFor(s), { type, fence: 1, expected_fence: 1, request_id: 'q', kind: 'permission', fail_kind: 'limit', requeue: type === 'release' && n % 2 === 0, target: { kind: 'queue' } }, OK);
      if (!r.ok) continue;
      const row = toDb(r.card);
      insertCard(db, `x${n++}`, {
        run_state: row.run_state, column_name: row.column_name, blocked_kind: row.blocked_kind, fail_kind: row.fail_kind,
        resume_to: row.resume_to, pre_reconnect_state: row.pre_reconnect_state, handover_target: row.handover_target,
        handover_provenance: row.handover_provenance, fence: row.fence,
      });
    }
  }
  assert.ok(n > 60, `exercised ${n} transitions`);
});

test('one active run per card; one lease per card; one pending dispatch per card', () => {
  const db = fresh();
  insertCard(db, 'c1', { fence: 1, run_state: 'claimed', column_name: 'in_progress' });
  const disp = db.prepare("INSERT INTO dispatches (request_id, card_id, dispatched_by, created_at, state) VALUES (?, 'c1', 'm1', ?, ?)");
  disp.run('q1', NOW, 'claimed');
  disp.run('q2', NOW, 'claimed');
  disp.run('q3', NOW, 'pending');
  assert.throws(() => disp.run('q4', NOW, 'pending'), /UNIQUE/);
  const run = db.prepare("INSERT INTO runs (id, card_id, fence, device_id, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, started_at) VALUES (?, 'c1', ?, 'd1', 'm1', 'm1', ?, 'claude_cli', 'r1', 'main', ?)");
  run.run('run1', 1, 'q1', NOW);
  assert.throws(() => run.run('run2', 2, 'q2', NOW), /UNIQUE/, 'second active run');
  db.prepare("UPDATE runs SET ended_at = ? WHERE id = 'run1'").run(NOW);
  run.run('run2', 2, 'q2', NOW);
  assert.throws(() => run.run('run3', 2, 'q3', NOW), /UNIQUE/, 'same (card, fence)');
  db.prepare("INSERT INTO leases (card_id, run_id, fence, hub_epoch) VALUES ('c1','run2',2,'e')").run();
  assert.throws(() => db.prepare("INSERT INTO leases (card_id, run_id, fence, hub_epoch) VALUES ('c1','run2',2,'e')").run(), /UNIQUE|PRIMARY/);
});

test('exit (l): permission answers — first wins by CAS; one open ask per card', () => {
  const db = fresh();
  insertCard(db, 'c1', { fence: 1, run_state: 'blocked', blocked_kind: 'permission', column_name: 'in_progress' });
  db.prepare("INSERT INTO dispatches (request_id, card_id, dispatched_by, created_at, state) VALUES ('q1','c1','m1',?, 'claimed')").run(NOW);
  db.prepare("INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, started_at) VALUES ('run1','c1',1,'m1','m1','q1','claude_cli','r1','main',?)").run(NOW);
  db.prepare("INSERT INTO permission_requests (id, run_id, card_id, tool, input_summary, state, approvers, created_at) VALUES ('p1','run1','c1','Bash','npm run migrate','open','[\"m1\",\"m2\"]',?)").run(NOW);
  const answer = db.prepare("UPDATE permission_requests SET state=?, answered_by=?, answered_at=? WHERE id=? AND state='open'");
  assert.equal(answer.run('allowed', 'm2', NOW, 'p1').changes, 1, 'James answers first');
  assert.equal(answer.run('denied', 'm1', NOW, 'p1').changes, 0, 'Callum sees ALREADY_ANSWERED');
  const ask = db.prepare("INSERT INTO asks (id, run_id, card_id, kind, text, state, created_at) VALUES (?, 'run1', 'c1', 'question', 'x', ?, ?)");
  ask.run('a1', 'open', NOW);
  assert.throws(() => ask.run('a2', 'open', NOW), /UNIQUE/);
  ask.run('a3', 'answered', NOW);
});

test('overlaps: run_a < run_b, unique per reason; memories body ≤ 1200', () => {
  const db = fresh();
  insertCard(db, 'c1');
  db.prepare("INSERT INTO dispatches (request_id, card_id, dispatched_by, created_at, state) VALUES ('q1','c1','m1',?, 'claimed'), ('q2','c1','m1',?, 'claimed')").run(NOW, NOW);
  const run = db.prepare("INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, started_at, ended_at) VALUES (?, 'c1', ?, 'm1','m1', ?, 'claude_cli','r1','main', ?, ?)");
  run.run('ra', 1, 'q1', NOW, NOW);
  run.run('rb', 2, 'q2', NOW, null);
  const ov = db.prepare("INSERT INTO overlaps (id, repo_id, run_a, run_b, level, reason, first_seen, last_seen) VALUES (?, 'r1', ?, ?, 'high', ?, ?, ?)");
  ov.run('o1', 'ra', 'rb', 'same_file', NOW, NOW);
  assert.throws(() => ov.run('o2', 'rb', 'ra', 'same_file', NOW, NOW), /CHECK/);
  assert.throws(() => ov.run('o3', 'ra', 'rb', 'same_file', NOW, NOW), /UNIQUE/);
  assert.throws(() => ov.run('o4', 'ra', 'rb', 'vibes', NOW, NOW), /CHECK/);
  const mem = db.prepare("INSERT INTO memories (id, org_id, repo_id, kind, body, author_run_id, created_at, updated_at) VALUES (?, 'o1', 'r1', 'handoff', ?, 'ra', ?, ?)");
  mem.run('m1', 'x'.repeat(1200), NOW, NOW);
  assert.throws(() => mem.run('m2', 'x'.repeat(1201), NOW, NOW), /CHECK/);
});

test('lessons are append-only: UPDATE, DELETE and INSERT OR REPLACE all abort', () => {
  const db = fresh();
  const ins = (verb, text) => db.prepare(`${verb} INTO lessons (id, org_id, repo_id, text, created_at) VALUES ('l1','o1','r1',?,?)`).run(text, NOW);
  ins('INSERT', 'run db:reset before the API tests');
  assert.throws(() => ins('INSERT OR REPLACE', 'rewritten lesson text here'), /append-only/);
  assert.throws(() => ins('REPLACE', 'rewritten lesson text here'), /append-only/);
  assert.throws(() => db.exec("UPDATE lessons SET text = 'rewritten lesson text here'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM lessons'), /append-only/);
  assert.equal(db.prepare('SELECT text FROM lessons').get().text, 'run db:reset before the API tests');
  db.prepare("INSERT INTO lessons (id, org_id, repo_id, text, created_at) VALUES ('l2','o1','r1','a second distinct lesson',?)").run(NOW);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lessons').get().n, 2, 'new ids still insert');
});
