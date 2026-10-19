// A deliberately separate path from whole-project restore. Only regular files
// captured by an exact turn may be reversed, and only while they still equal
// that turn's after-state. Independent external writers do not honour our lock:
// refuse observed busy work and recheck immediately before each filesystem effect.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const C = require('node:fs').constants;

const FILE = new Set(['100644', '100755']);
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const signature = e => e ? `${e.mode}:${e.oid}` : 'absent';
const safe = p => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !p.includes('\\') && !path.isAbsolute(p) && p.split('/').every(s => s && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
async function entries(git, top, commit) {
  const out = await git.run(top, ['ls-tree', '-r', '-z', commit]);
  const result = new Map();
  for (const line of out.split('\0').filter(Boolean)) {
    const m = /^(\d+) (\w+) ([a-f0-9]+)\t(.*)$/s.exec(line);
    if (!m || result.has(m[4])) throw new Error('Unsupported checkpoint tree');
    result.set(m[4], { mode: m[1], type: m[2], oid: m[3] });
  }
  return result;
}
async function fingerprint(top, p) {
  if (!safe(p)) return { unsafe: true };
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) {
    try { if (!(await fs.lstat(path.join(top, ...parts.slice(0, i)))).isDirectory()) return { unsafe: true }; }
    catch (e) { if (e.code === 'ENOENT') return { absent: true }; throw e; }
  }
  const file = path.join(top, p);
  let st; try { st = await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return { absent: true }; throw e; }
  if (!st.isFile() || st.nlink > 1 || (st.mode & 0o7000) || st.size > 50 * 1024 * 1024) return { unsafe: true };
  let fd;
  try {
    fd = await fs.open(file, C.O_RDONLY | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0));
    const opened = await fd.stat();
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) return { unsafe: true };
    const body = await fd.readFile(), end = await fd.stat(), named = await fs.lstat(file);
    if (!named.isFile() || named.dev !== st.dev || named.ino !== st.ino || end.size !== st.size || end.mtimeMs !== st.mtimeMs || end.ctimeMs !== st.ctimeMs) return { unsafe: true };
    return { hash: digest(body), executable: process.platform === 'win32' ? false : !!(st.mode & 0o111), mode: st.mode & 0o777, dev: st.dev, ino: st.ino, mtime: st.mtimeMs, ctime: st.ctimeMs };
  } catch (e) { if (['ELOOP', 'ENOENT', 'ENOTDIR'].includes(e.code)) return { unsafe: true }; throw e; }
  finally { await fd?.close(); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function identity(top) {
  const real = await fs.realpath(top), st = await fs.lstat(top);
  if (real !== top || !st.isDirectory()) throw new Error('Project identity changed');
  return { real, dev: st.dev, ino: st.ino };
}
async function formatSafe(git, repo) {
  let autocrlf = ''; try { autocrlf = (await git.run(repo.top, ['config', '--get', 'core.autocrlf'])).trim(); } catch { /* unset */ }
  if (autocrlf && autocrlf !== 'false') return false;
  const attr = (await git.run(repo.top, ['rev-parse', '--git-path', 'info/attributes'])).trim();
  try { if ((await fs.lstat(path.resolve(repo.top, attr))).size > 0) return false; }
  catch (e) { if (e.code !== 'ENOENT') return false; }
  return true;
}
function attributes(p, trees) {
  const parts = p.split('/');
  const candidates = ['.gitattributes', ...parts.slice(0, -1).map((_, i) => `${parts.slice(0, i + 1).join('/')}/.gitattributes`)];
  return candidates.some(a => trees.some(t => t.has(a)));
}

async function preview({ git, repo, before, after, current }) {
  const [old, end, live] = await Promise.all([before, after, current].map(c => entries(git, repo.top, c)));
  let autocrlf = ''; try { autocrlf = (await git.run(repo.top, ['config', '--get', 'core.autocrlf'])).trim(); } catch { /* unset */ }
  const changed = await git.diffFiles(repo.top, before, after), files = [], selected = [];
  for (const f of changed) {
    const a = old.get(f.path), b = end.get(f.path), c = live.get(f.path);
    let reason = null;
    if (!safe(f.path) || [a, b, c].some(e => e && (!FILE.has(e.mode) || e.type !== 'blob'))) reason = 'unsupported-path';
    else if ((a && !b) || (a && b && a.mode !== b.mode)) reason = 'metadata';
    else if (signature(b) !== signature(c)) reason = 'later-change';
    else if (attributes(f.path, [old, end, live]) || (autocrlf && autocrlf !== 'false')) reason = 'attributes';
    if (!reason && a) {
      const size = Number((await git.run(repo.top, ['cat-file', '-s', a.oid])).trim());
      if (!Number.isSafeInteger(size) || size > 50 * 1024 * 1024) reason = 'unsupported-path';
    }
    const raw = reason ? null : await fingerprint(repo.top, f.path);
    if (!reason && raw.unsafe) reason = 'unsupported-path';
    if (!reason && b) {
      const content = await git.run(repo.top, ['cat-file', 'blob', b.oid], { encoding: null });
      if (raw.absent || raw.hash !== digest(content) || (process.platform !== 'win32' && raw.executable !== (b.mode === '100755'))) reason = 'later-change';
    } else if (!reason && !raw.absent) reason = 'later-change';
    const item = { path: f.path, status: f.status, action: a ? 'restore' : 'remove', reason };
    files.push(item);
    if (!reason) selected.push({ ...item, before: a ?? null, expected: raw });
  }
  return { root: await identity(repo.top), before, after, current, files, selected };
}

async function unchanged({ git, repo, plan, current }) {
  if (!same(await identity(repo.top), plan.root)) return false;
  const trees = await Promise.all([current, plan.current].map(c => git.run(repo.top, ['rev-parse', `${c}^{tree}`])));
  if (trees[0] !== trees[1]) return false;
  for (const f of plan.selected) if (!same(await fingerprint(repo.top, f.path), f.expected)) return false;
  return true;
}

async function apply({ git, repo, plan, isBusy, current = () => true }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'plexiform-undo-'));
  let written = 0, removed = 0;
  try {
    // Prepare every blob before changing anything. Raw blobs are only eligible
    // without Git content transformations; see preview's conservative refusal.
    for (let i = 0; i < plan.selected.length; i++) {
      const f = plan.selected[i];
      if (f.before) await fs.writeFile(path.join(temp, String(i)), await git.run(repo.top, ['cat-file', 'blob', f.before.oid], { encoding: null }), { mode: 0o600 });
    }
    if (await isBusy() || !same(await identity(repo.top), plan.root)) return { ok: false, reason: 'busy', written, removed };
    for (const f of plan.selected) if (!same(await fingerprint(repo.top, f.path), f.expected)) return { ok: false, reason: 'stale', written, removed };
    for (let i = 0; i < plan.selected.length; i++) {
      const f = plan.selected[i];
      if (await isBusy() || !same(await identity(repo.top), plan.root) || !same(await fingerprint(repo.top, f.path), f.expected)) return { ok: false, reason: 'interrupted', written, removed };
      const file = path.join(repo.top, f.path);
      if (!current()) return { ok: false, reason: 'interrupted', written, removed };
      if (!f.before) { await fs.unlink(file); removed++; continue; }
      // Retain the existing inode, permissions, ACLs and xattrs. Git does not
      // record deleted-file metadata or full mode changes: preview keeps those
      // paths rather than reconstructing them with wider default permissions.
      let fd;
      try {
        fd = await fs.open(file, C.O_RDWR | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0));
        const st = await fd.stat();
        if (!st.isFile() || st.dev !== f.expected.dev || st.ino !== f.expected.ino || st.nlink !== 1 || (st.mode & 0o777) !== f.expected.mode || await isBusy() || !same(await fingerprint(repo.top, f.path), f.expected)) return { ok: false, reason: 'interrupted', written, removed };
        const body = await fs.readFile(path.join(temp, String(i)));
        if (await isBusy() || !same(await fingerprint(repo.top, f.path), f.expected)) return { ok: false, reason: 'interrupted', written, removed };
        if (!current()) return { ok: false, reason: 'interrupted', written, removed };
        await fd.writeFile(body); await fd.truncate(body.length); written++;
      } finally { await fd?.close(); }
    }
    return { ok: true, written, removed };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

module.exports = { preview, unchanged, apply, formatSafe };
