// Applies a team setup's files to a folder the user chose. Two steps: plan()
// is a dry run that writes nothing and returns a diff plus a confirm token;
// apply() writes only when handed that token back, and records an undo
// manifest. Every write stays inside the chosen folder: absolute paths,
// "..", backslashes and symlinked components are rejected, not resolved.
const nodeFs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIMITS = { files: 64, fileBytes: 256 * 1024, totalBytes: 1024 * 1024, pathChars: 240 };
const UNDO_DIR = '.plexiform-undo';
const LCS_CELLS = 4e6;

class ApplyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new ApplyError(code, message); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function cleanRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > LIMITS.pathChars) fail('BAD_PATH', 'file path missing or too long');
  if (rel.includes('\0') || rel.includes('\\')) fail('BAD_PATH', `unsafe characters in path: ${rel}`);
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) fail('ABSOLUTE_PATH', `absolute path not allowed: ${rel}`);
  const parts = rel.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) fail('TRAVERSAL', `path escapes the folder or is not normal: ${rel}`);
  if (parts[0] === UNDO_DIR) fail('BAD_PATH', `${UNDO_DIR} is reserved`);
  return parts;
}

function lstat(p) {
  try { return nodeFs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function lineDiff(oldText, newText) {
  const a = oldText.split('\n'), b = newText.split('\n');
  if (a.length * b.length > LCS_CELLS) return [...a.map(l => `-${l}`), ...b.map(l => `+${l}`)].join('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join('\n');
}

function resolveFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) fail('BAD_FOLDER', 'target folder must be an absolute path');
  const st = lstat(folder);
  if (!st || !st.isDirectory()) fail('BAD_FOLDER', 'target folder must be an existing directory (not a symlink)');
  return nodeFs.realpathSync(folder);
}

function plan(setup, folder) {
  const root = resolveFolder(folder);
  const files = setup && setup.files;
  if (!Array.isArray(files) || !files.length) fail('BAD_SETUP', 'setup has no files');
  if (files.length > LIMITS.files) fail('TOO_LARGE', `more than ${LIMITS.files} files`);
  const seen = new Set();
  let total = 0;
  const entries = files.map((f) => {
    const parts = cleanRel(f && f.path);
    const rel = parts.join('/');
    if (seen.has(rel)) fail('BAD_PATH', `duplicate path: ${rel}`);
    seen.add(rel);
    if (typeof f.content !== 'string') fail('BAD_SETUP', `content must be text: ${rel}`);
    const content = Buffer.from(f.content, 'utf8');
    if (content.length > LIMITS.fileBytes) fail('TOO_LARGE', `file over ${LIMITS.fileBytes} bytes: ${rel}`);
    total += content.length;
    if (total > LIMITS.totalBytes) fail('TOO_LARGE', `setup over ${LIMITS.totalBytes} bytes`);
    let cur = root;
    let existing = null;
    parts.forEach((part, idx) => {
      cur = path.join(cur, part);
      const st = lstat(cur);
      if (!st) return;
      if (st.isSymbolicLink()) fail('SYMLINK', `symlink in path: ${rel}`);
      if (idx < parts.length - 1) { if (!st.isDirectory()) fail('BAD_PATH', `not a directory: ${part} in ${rel}`); }
      else if (!st.isFile()) fail('BAD_PATH', `target is not a regular file: ${rel}`);
      else existing = st;
    });
    const old = existing ? nodeFs.readFileSync(cur) : null;
    const same = old && old.equals(content);
    return {
      path: rel,
      action: !old ? 'create' : same ? 'unchanged' : 'update',
      bytes: content.length,
      sha256: sha(content),
      priorSha256: old ? sha(old) : null,
      diff: same ? '' : lineDiff(old ? old.toString('utf8') : '', f.content),
      content: f.content,
    };
  });
  const token = sha(JSON.stringify({ root, e: entries.map(e => [e.path, e.sha256, e.priorSha256]) }));
  return { folder: root, entries, token, changes: entries.filter(e => e.action !== 'unchanged').length };
}

function writeAtomic(target, buf) {
  const tmp = `${target}.plexiform-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    nodeFs.writeFileSync(tmp, buf, { flag: 'wx' });
    nodeFs.renameSync(tmp, target);
  } catch (e) {
    try { nodeFs.rmSync(tmp, { force: true }); } catch { /* already gone */ }
    throw e;
  }
}

function apply(setup, folder, confirm, { now = Date.now } = {}) {
  const p = plan(setup, folder);
  if (typeof confirm !== 'string' || confirm !== p.token) fail('NOT_CONFIRMED', 'confirmation token does not match the current plan; review the diff again');
  const root = p.folder;
  const id = `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const manifest = { v: 1, id, folder: root, files: [], dirs: [] };
  const write = (e) => {
    const target = path.join(root, ...e.path.split('/'));
    const rec = { path: e.path, existed: e.priorSha256 !== null, wroteSha256: e.sha256, prior: e.priorSha256 !== null ? nodeFs.readFileSync(target).toString('base64') : null };
    let dir = root;
    for (const part of e.path.split('/').slice(0, -1)) {
      dir = path.join(dir, part);
      if (!lstat(dir)) { nodeFs.mkdirSync(dir); manifest.dirs.push(path.relative(root, dir).split(path.sep).join('/')); }
    }
    writeAtomic(target, Buffer.from(e.content, 'utf8'));
    manifest.files.push(rec);
  };
  const saveManifest = () => {
    const dir = path.join(root, UNDO_DIR);
    if (!lstat(dir)) nodeFs.mkdirSync(dir);
    writeAtomic(path.join(dir, `${id}.json`), Buffer.from(JSON.stringify(manifest, null, 2)));
  };
  try {
    for (const e of p.entries) if (e.action !== 'unchanged') write(e);
  } catch (err) {
    saveManifest();
    undo(root, id);
    throw err;
  }
  saveManifest();
  return { id, written: manifest.files.map(f => f.path) };
}

function undo(folder, id) {
  const root = resolveFolder(folder);
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]+$/.test(id)) fail('BAD_ID', 'invalid undo id');
  const file = path.join(root, UNDO_DIR, `${id}.json`);
  const st = lstat(file);
  if (!st || !st.isFile()) fail('NO_UNDO', 'undo manifest not found');
  const manifest = JSON.parse(nodeFs.readFileSync(file, 'utf8'));
  const restored = [], skipped = [];
  for (const f of [...manifest.files].reverse()) {
    const parts = cleanRel(f.path);
    let cur = root, ok = true;
    for (const part of parts) {
      cur = path.join(cur, part);
      const s = lstat(cur);
      if (s && s.isSymbolicLink()) ok = false;
    }
    const s = lstat(cur);
    if (!ok || !s || !s.isFile() || sha(nodeFs.readFileSync(cur)) !== f.wroteSha256) { skipped.push(f.path); continue; }
    if (f.existed) writeAtomic(cur, Buffer.from(f.prior, 'base64'));
    else nodeFs.rmSync(cur);
    restored.push(f.path);
  }
  for (const d of [...manifest.dirs].reverse()) {
    const dir = path.join(root, ...cleanRel(d));
    const s = lstat(dir);
    if (s && s.isDirectory() && !nodeFs.readdirSync(dir).length) nodeFs.rmdirSync(dir);
  }
  nodeFs.rmSync(file);
  return { restored, skipped };
}

module.exports = { plan, apply, undo, ApplyError, LIMITS, UNDO_DIR };
