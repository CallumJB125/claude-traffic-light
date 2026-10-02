import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, snapshot, stageRestore, validateBackup } from '../pi/backup-lib.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function rig(t, { legacy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-backup-'));
  let conn;
  t.after(() => { conn?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
  const db = path.join(dataDir, 'board.db'); conn = new DatabaseSync(db);
  conn.exec('PRAGMA journal_mode=WAL; CREATE TABLE state(value TEXT); INSERT INTO state VALUES (\'before\')');
  if (!legacy) conn.exec('CREATE TABLE client_artifact_versions(id TEXT PRIMARY KEY, sha256 TEXT, byte_length INTEGER); CREATE TABLE decisions(artifact_id TEXT, sha256 TEXT, decision TEXT)');
  const add = (text = 'Exact approved deliverable') => {
    const bytes = Buffer.from(text), id = randomUUID();
    fs.mkdirSync(path.join(dataDir, 'client-artifacts'), { mode: 0o700, recursive: true });
    const file = path.join(dataDir, 'client-artifacts', `${id}.bin`);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    conn.prepare('INSERT INTO client_artifact_versions VALUES (?, ?, ?)').run(id, digest(bytes), bytes.length);
    return { id, bytes, file, sha256: digest(bytes), byte_length: bytes.length };
  };
  return { root, dataDir, db, conn, add };
}

test('live WAL backup restores the exact referenced bytes and approval without copying orphan uploads', (t) => {
  const r = rig(t), a = r.add();
  r.conn.prepare('INSERT INTO decisions VALUES (?, ?, ?)').run(a.id, a.sha256, 'approve');
  fs.writeFileSync(path.join(r.dataDir, 'client-artifacts', `${randomUUID()}.bin`), 'not committed');
  const { bundle, artifact_count } = createBackup({ dataDir: r.dataDir });
  assert.equal(artifact_count, 1); assert.equal(validateBackup(bundle).artifacts[0].id, a.id);
  assert.equal(fs.statSync(bundle).mode & 0o777, 0o700);
  for (const f of ['board.db', 'manifest.json', `client-artifacts/${a.id}.bin`]) assert.equal(fs.statSync(path.join(bundle, f)).mode & 0o777, 0o600);
  r.add('A later version'); r.conn.exec("UPDATE state SET value='after'");
  const destination = path.join(r.root, 'restored'); stageRestore({ bundle, destination });
  assert.equal(fs.readdirSync(path.join(destination, 'client-artifacts')).length, 1);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'client-artifacts', `${a.id}.bin`)), a.bytes);
  const restored = new DatabaseSync(path.join(destination, 'board.db'), { readOnly: true });
  try {
    assert.equal(restored.prepare('SELECT value FROM state').get().value, 'before');
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM client_artifact_versions').get().n, 1);
    const approval = restored.prepare('SELECT * FROM decisions').get();
    assert.equal(approval.sha256, digest(fs.readFileSync(path.join(destination, 'client-artifacts', `${approval.artifact_id}.bin`))));
    assert.equal(approval.decision, 'approve');
  } finally { restored.close(); }
  assert.equal(validateBackup(bundle).artifacts.length, 1, 'working restores preserve the original backup');
  assert.throws(() => stageRestore({ bundle, destination }), /EEXIST/);
});

test('missing, changed and symlink source bytes cannot publish a database-only success', (t) => {
  for (const kind of ['missing', 'changed', 'symlink']) {
    const r = rig(t), a = r.add();
    if (kind === 'changed') fs.writeFileSync(a.file, 'different');
    else { fs.unlinkSync(a.file); if (kind === 'symlink') { const f = path.join(r.root, 'foreign'); fs.writeFileSync(f, a.bytes); fs.symlinkSync(f, a.file); } }
    assert.throws(() => createBackup({ dataDir: r.dataDir }));
    assert.deepEqual(fs.readdirSync(path.join(r.dataDir, 'backups')), []);
  }
});

test('backup refuses a symlink artifact directory and untrusted metadata paths or lengths', (t) => {
  const r = rig(t), a = r.add(), dir = path.join(r.dataDir, 'client-artifacts');
  fs.renameSync(dir, path.join(r.root, 'foreign')); fs.symlinkSync(path.join(r.root, 'foreign'), dir);
  assert.throws(() => createBackup({ dataDir: r.dataDir }));
  fs.unlinkSync(dir); fs.renameSync(path.join(r.root, 'foreign'), dir);
  for (const [id, len] of [['../foreign', a.byte_length], [a.id, 8 * 1024 * 1024 + 1]]) {
    r.conn.prepare('UPDATE client_artifact_versions SET id = ?, byte_length = ?').run(id, len);
    assert.throws(() => createBackup({ dataDir: r.dataDir }), /incomplete/);
  }
});

test('corrupt backup bytes or a forged manifest cannot prepare a restore', (t) => {
  for (const kind of ['database', 'artifact', 'manifest', 'symlink']) {
    const r = rig(t), a = r.add(), { bundle } = createBackup({ dataDir: r.dataDir });
    if (kind === 'database') fs.appendFileSync(path.join(bundle, 'board.db'), 'changed');
    if (kind === 'artifact') fs.writeFileSync(path.join(bundle, 'client-artifacts', `${a.id}.bin`), 'changed');
    if (kind === 'manifest') { const f = path.join(bundle, 'manifest.json'), m = JSON.parse(fs.readFileSync(f)); m.artifacts[0].file = '../foreign'; fs.writeFileSync(f, JSON.stringify(m)); }
    if (kind === 'symlink') { const f = path.join(bundle, 'client-artifacts', `${a.id}.bin`); fs.unlinkSync(f); fs.symlinkSync(a.file, f); }
    const destination = path.join(r.root, 'restored');
    assert.throws(() => stageRestore({ bundle, destination }));
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readFileSync(a.file), a.bytes);
  }
});

test('retention removes complete bundles together and preserves legacy or incomplete recovery data', async (t) => {
  const r = rig(t); r.add();
  const first = createBackup({ dataDir: r.dataDir, keep: 2 }), out = path.dirname(first.bundle);
  const legacy = path.join(out, 'board-old.db'); fs.writeFileSync(legacy, 'legacy');
  const incomplete = path.join(out, '.partial-preserved'); fs.mkdirSync(incomplete, { mode: 0o700 });
  await new Promise((resolve) => setTimeout(resolve, 3));
  const second = createBackup({ dataDir: r.dataDir, keep: 2 });
  await new Promise((resolve) => setTimeout(resolve, 3));
  const third = createBackup({ dataDir: r.dataDir, keep: 2 });
  assert.equal(third.pruned, 1); assert.equal(fs.existsSync(first.bundle), false);
  assert.equal(validateBackup(second.bundle).artifacts.length, 1); assert.equal(validateBackup(third.bundle).artifacts.length, 1);
  assert.equal(fs.existsSync(legacy), true); assert.equal(fs.existsSync(incomplete), true);
  for (const keep of [0, -1, NaN, 1.5, 366]) assert.throws(() => createBackup({ dataDir: r.dataDir, keep }), /BACKUP_KEEP/);
});

test('the nightly executable and snapshot modes also support pre-artifact databases', (t) => {
  const r = rig(t, { legacy: true });
  const cli = fileURLToPath(new URL('../pi/backup.mjs', import.meta.url));
  const call = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { env: { ...process.env, BOARD_DATA_DIR: r.dataDir, BOARD_DB: r.db, BACKUP_KEEP: '14' }, encoding: 'utf8' }));
  const result = call(); assert.equal(result.artifact_count, 0); assert.equal(call('--verify', result.bundle).verified, true);
  const exact = path.join(r.root, 'cutover-snapshot'); assert.equal(call('--snapshot', exact).artifact_count, 0);
  assert.equal(call('--stage-restore', exact, path.join(r.root, 'prepared')).artifact_count, 0);
  assert.equal(validateBackup(exact).artifacts.length, 0);
});

test('retention always preserves the returned bundle across clock rollback and equal timestamps', (t) => {
  const r = rig(t); r.add();
  const ActualDate = Date;
  let now = '2099-01-01T00:00:00.000Z';
  t.mock.method(globalThis, 'Date', function (...args) { return new ActualDate(...(args.length ? args : [now])); });
  const previous = createBackup({ dataDir: r.dataDir, keep: 1 });
  now = '2000-01-01T00:00:00.000Z';
  const rollback = createBackup({ dataDir: r.dataDir, keep: 1 });
  assert.equal(rollback.pruned, 1); assert.equal(fs.existsSync(previous.bundle), false);
  assert.equal(validateBackup(rollback.bundle).artifacts.length, 1);
  // Put a valid older invocation last in the same-timestamp sort order.
  const high = rollback.bundle.replace(/[0-9a-f]{8}$/, 'ffffffff'); fs.renameSync(rollback.bundle, high);
  const equal = createBackup({ dataDir: r.dataDir, keep: 1 });
  assert.equal(equal.pruned, 1); assert.equal(fs.existsSync(high), false);
  assert.equal(validateBackup(equal.bundle).artifacts.length, 1);
});
