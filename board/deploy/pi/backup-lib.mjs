// Consistent SQLite snapshots paired with the immutable bytes they reference.
// The manifest is written last; incomplete bundles cannot be restored/pruned.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const FORMAT = 'plexiform-paired-backup-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const BUNDLE = /^board-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
const MAX_ARTIFACT = 8 * 1024 * 1024;
const fail = () => { throw new Error('paired backup is incomplete or contains invalid bytes'); };

function directory(dir, { create = false, privateMode = false } = {}) {
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (privateMode && (s.mode & 0o077))) fail();
}
function syncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function fileDigest(file, { target = null, expected = null, max = Infinity } = {}) {
  let src, out;
  try {
    src = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const s = fs.fstatSync(src);
    if (!s.isFile() || s.size > max || !Number.isSafeInteger(s.size) ||
        (expected && s.size !== expected.byte_length)) fail();
    if (target) out = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256'), chunk = Buffer.alloc(128 * 1024);
    let length = 0, n;
    while ((n = fs.readSync(src, chunk, 0, chunk.length, null))) {
      length += n; if (length > max || length > s.size) fail();
      hash.update(chunk.subarray(0, n));
      if (out !== undefined) { let off = 0; while (off < n) off += fs.writeSync(out, chunk, off, n - off); }
    }
    const sha256 = hash.digest('hex');
    if (length !== s.size || fs.fstatSync(src).size !== s.size || (expected && sha256 !== expected.sha256)) fail();
    if (out !== undefined) fs.fsyncSync(out);
    return { sha256, byte_length: length };
  } finally {
    if (src !== undefined) fs.closeSync(src);
    if (out !== undefined) fs.closeSync(out);
  }
}
function references(dbPath) {
  const conn = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = conn.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') fail();
    if (!conn.prepare("SELECT 1 x FROM sqlite_schema WHERE type = 'table' AND name = 'client_artifact_versions'").get()) return [];
    const rows = conn.prepare('SELECT id, sha256, byte_length FROM client_artifact_versions ORDER BY id').all();
    const ids = new Set();
    for (const r of rows) {
      if (!UUID.test(r.id) || !HASH.test(r.sha256) || !Number.isSafeInteger(r.byte_length) || r.byte_length < 1 || r.byte_length > MAX_ARTIFACT || ids.has(r.id)) fail();
      ids.add(r.id);
    }
    return rows.map((r) => ({ ...r, file: `client-artifacts/${r.id}.bin` }));
  } finally { conn.close(); }
}
function finish(destination, manifest) {
  syncDir(path.join(destination, 'client-artifacts')); syncDir(destination);
  const file = path.join(destination, 'manifest.json');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(manifest) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir(destination); syncDir(path.dirname(destination));
  return manifest;
}
function startDestination(destination) {
  directory(path.dirname(destination));
  fs.mkdirSync(destination, { mode: 0o700 }); // never overwrite an existing set
  fs.mkdirSync(path.join(destination, 'client-artifacts'), { mode: 0o700 });
}

export function snapshot({ dataDir, db = path.join(dataDir, 'board.db'), destination, createdAt = new Date().toISOString() }) {
  directory(dataDir);
  if (!fs.lstatSync(db).isFile() || fs.lstatSync(db).isSymbolicLink()) fail();
  startDestination(destination);
  try {
    const target = path.join(destination, 'board.db');
    const conn = new DatabaseSync(db, { readOnly: true });
    try { conn.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`); } finally { conn.close(); }
    fs.chmodSync(target, 0o600);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const artifacts = references(target), source = path.join(dataDir, 'client-artifacts');
    if (artifacts.length) directory(source);
    for (const a of artifacts) fileDigest(path.join(source, `${a.id}.bin`), {
      target: path.join(destination, a.file), expected: a, max: MAX_ARTIFACT,
    });
    return finish(destination, { format: FORMAT, created_at: createdAt,
      database: { file: 'board.db', ...fileDigest(target) }, artifacts });
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
}

export function validateBackup(bundle) {
  directory(bundle, { privateMode: true });
  const manifestFile = path.join(bundle, 'manifest.json');
  const fd = fs.openSync(manifestFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let manifest;
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > 64 * 1024 * 1024 || (s.mode & 0o077)) fail();
    manifest = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  if (manifest.format !== FORMAT || manifest.database?.file !== 'board.db' || !HASH.test(manifest.database.sha256) || !Number.isSafeInteger(manifest.database.byte_length) || !Array.isArray(manifest.artifacts)) fail();
  const db = path.join(bundle, 'board.db');
  fileDigest(db, { expected: manifest.database });
  const actual = references(db);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.artifacts)) fail();
  directory(path.join(bundle, 'client-artifacts'), { privateMode: true });
  for (const a of actual) fileDigest(path.join(bundle, a.file), { expected: a, max: MAX_ARTIFACT });
  return manifest;
}

// Prepare a verified fresh working copy. The caller stops the hub and
// replication before replacing live data, preserving the failed data first.
export function stageRestore({ bundle, destination }) {
  const manifest = validateBackup(bundle);
  startDestination(destination);
  try {
    fileDigest(path.join(bundle, 'board.db'), { target: path.join(destination, 'board.db'), expected: manifest.database });
    for (const a of manifest.artifacts) fileDigest(path.join(bundle, a.file), { target: path.join(destination, a.file), expected: a, max: MAX_ARTIFACT });
    return finish(destination, manifest);
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
}

export function createBackup({ dataDir, db = path.join(dataDir, 'board.db'), outDir = path.join(dataDir, 'backups'), keep = 14 }) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 365) throw new Error('BACKUP_KEEP must be an integer from 1 to 365');
  directory(outDir, { create: true, privateMode: true });
  const name = `board-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const partial = path.join(outDir, `.partial-${randomUUID()}`), bundle = path.join(outDir, name);
  const manifest = snapshot({ dataDir, db, destination: partial });
  try { fs.renameSync(partial, bundle); syncDir(outDir); }
  catch (error) { fs.rmSync(partial, { recursive: true, force: true }); throw error; }
  // Only complete verified bundles count toward retention; preserve corrupt
  // sets and legacy DB-only files for inspection rather than losing recovery.
  const complete = fs.readdirSync(outDir).filter((n) => BUNDLE.test(n)).sort().filter((n) => {
    try { validateBackup(path.join(outDir, n)); return true; } catch { return false; }
  });
  const old = complete.slice(0, Math.max(0, complete.length - keep));
  for (const n of old) fs.rmSync(path.join(outDir, n), { recursive: true });
  syncDir(outDir);
  return { bundle, artifact_count: manifest.artifacts.length, pruned: old.length };
}
