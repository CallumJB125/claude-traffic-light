// The git that per-turn checkpoints use, and nothing else. Every call runs one
// fixed binary with fixed options: no hooks, no fsmonitor, no attributes file,
// no transport (protocol.allow=never, no ssh), no automatic gc, no system or
// global config. A repo whose own config defines filters or includes is
// refused, so taking or restoring a checkpoint never runs code from the repo.
//
// A checkpoint is a commit object made from a temporary index (GIT_INDEX_FILE),
// so the user's index, HEAD and branches are never touched; refs live under
// refs/plexiform/cp/ and nothing here fetches, pushes or clones.
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { withDeadline, GRACE_MS } = require('./bounded-io');

const REF_ROOT = 'refs/plexiform/cp/';
const DEV_NULL = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SAFE_GIT = Object.freeze([
  '-c', `core.hooksPath=${DEV_NULL}`, '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${DEV_NULL}`,
  '-c', 'protocol.allow=never', '-c', 'core.sshCommand=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
  '-c', 'core.quotePath=false', '-c', 'advice.addEmbeddedRepo=false',
]);
const IDENTITY = { GIT_AUTHOR_NAME: 'Plexiform', GIT_AUTHOR_EMAIL: 'checkpoints@plexiform.invalid', GIT_COMMITTER_NAME: 'Plexiform', GIT_COMMITTER_EMAIL: 'checkpoints@plexiform.invalid' };
const UNSAFE_CONFIG = /^(?:filter|include|includeif)\./i;

function findGit({ env = process.env, platform = process.platform, exists = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } } } = {}) {
  if (platform === 'win32') {
    for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
      const p = path.join(dir, 'git.exe');
      if (path.isAbsolute(p) && exists(p)) return p;
    }
    return null;
  }
  return ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'].find(exists) ?? null;
}

/**
 * → {run, repoOf, snapshot, updateRef, deleteRef, listRefs, readCommit, diffFiles, diffText, restoreTree}
 * run(cwd, args, {index, global, input, timeoutMs, maxBuffer}) → stdout; rejects with err.stderr set.
 */
function createGit({ bin = findGit(), env = process.env, tmpdir = os.tmpdir() } = {}) {
  const base = { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C', ...IDENTITY };
  for (const k of ['HOME', 'PATH', 'TMPDIR', 'SYSTEMROOT', 'USERPROFILE']) if (env[k]) base[k] = env[k];

  function run(cwd, args, { index = null, global = false, input = null, timeoutMs = 60000, maxBuffer = 64 << 20 } = {}) {
    if (!bin) return Promise.reject(Object.assign(new Error('git not found'), { code: 'NOGIT', stderr: '' }));
    const childEnv = { ...base, ...(global ? {} : { GIT_CONFIG_GLOBAL: DEV_NULL }), ...(index ? { GIT_INDEX_FILE: index } : {}) };
    // -C, not a spawn cwd, and a deadline: see src/bounded-io.js.
    const stuck = Object.assign(new Error('git did not finish'), { code: 'ETIMEDOUT', stderr: '' });
    return withDeadline((done) => {
      try {
        const child = childProcess.execFile(bin, ['-C', cwd, ...SAFE_GIT, ...args], { env: childEnv, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => { // privacy-flow: checkpoint-git
          if (err) { err.stderr = stderr; done({ err }); } else done({ stdout });
        });
        if (input != null) child.stdin.end(input); else child.stdin.end();
        return child;
      } catch (err) { done({ err }); return null; }
    }, timeoutMs + GRACE_MS, { err: stuck }).then((r) => (r.err ? Promise.reject(r.err) : r.stdout));
  }

  // The user's global ignore file still applies, though the rest of their global config does not.
  async function excludesFile(top) {
    let p = null;
    try { p = (await run(top, ['config', '--type=path', '--get', 'core.excludesFile'], { global: true, timeoutMs: 5000 })).trim(); } catch { /* unset */ }
    if (!p) p = path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'git', 'ignore');
    return path.isAbsolute(p) && fs.existsSync(p) ? p : null;
  }

  /** The repo holding cwd → {top, gitDir}, or {skip: 'not-git'|'filters'|'no-git'}. */
  async function repoOf(cwd) {
    if (!bin) return { skip: 'no-git' };
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { skip: 'not-git' };
    let out;
    try { out = await run(cwd, ['rev-parse', '--is-bare-repository', '--show-toplevel', '--absolute-git-dir'], { timeoutMs: 5000 }); } catch { return { skip: 'not-git' }; }
    const [bare, top, gitDir] = out.split('\n');
    if (bare !== 'false' || !top || !gitDir) return { skip: 'not-git' };
    let local = '';
    // Global and system config are off, so this lists the repo's own (and worktree) config.
    try { local = await run(top, ['config', '--name-only', '--list'], { timeoutMs: 5000 }); } catch { /* no local config */ }
    if (local.split('\n').some((k) => UNSAFE_CONFIG.test(k))) return { skip: 'filters' };
    return { top, gitDir };
  }

  async function withTempIndex(fn) {
    const dir = fs.mkdtempSync(path.join(tmpdir, 'plexiform-cp-'));
    try { return await fn(path.join(dir, 'index')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  /** Commits the working tree as it is (tracked + untracked, not ignored) without touching the user's index. → commit sha. */
  async function snapshot({ top, gitDir }, { parent = null, message }) {
    const excl = await excludesFile(top);
    const extra = excl ? ['-c', `core.excludesFile=${excl}`] : [];
    return withTempIndex(async (index) => {
      // Start from the user's index for its stat cache, falling back to HEAD when it can't be used as-is.
      try { await fsp.copyFile(path.join(gitDir, 'index'), index); } catch { /* none yet */ }
      try { await run(top, [...extra, 'add', '-A', '--', '.'], { index }); } catch {
        fs.rmSync(index, { force: true });
        try { await run(top, ['read-tree', 'HEAD'], { index }); } catch { /* unborn branch */ }
        await run(top, [...extra, 'add', '-A', '--', '.'], { index });
      }
      const tree = (await run(top, ['write-tree'], { index })).trim();
      return (await run(top, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], { input: message })).trim();
    });
  }

  const updateRef = (top, ref, sha) => run(top, ['update-ref', '--no-deref', ref, sha]);
  const deleteRef = (top, ref) => run(top, ['update-ref', '--no-deref', '-d', ref]);

  /** → [{ref, sha, parent, at (ms), subject}] under prefix. */
  async function listRefs(top, prefix = REF_ROOT) {
    const out = await run(top, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(parent)%00%(committerdate:unix)%00%(subject)', prefix]);
    return out.split('\n').filter(Boolean).map((line) => {
      const [ref, sha, parent, at, subject] = line.split('\0');
      return { ref, sha, parent: parent.split(' ')[0] || null, at: Number(at) * 1000, subject };
    });
  }

  /** → [{path, status, add, del}] between two commits (a: before, b: after), renames off. */
  async function diffFiles(top, a, b) {
    const [stat, names] = await Promise.all([
      run(top, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', a, b]),
      run(top, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', a, b]),
    ]);
    const counts = new Map();
    const s = stat.split('\0');
    for (let i = 0; i + 1 < s.length; i++) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(s[i]);
      if (m) counts.set(m[3], { add: m[1] === '-' ? null : Number(m[1]), del: m[2] === '-' ? null : Number(m[2]) });
    }
    const n = names.split('\0');
    const files = [];
    for (let i = 0; i + 1 < n.length; i += 2) files.push({ path: n[i + 1], status: n[i][0], ...(counts.get(n[i + 1]) ?? { add: null, del: null }) });
    return files;
  }

  /** The patch between two commits, optionally for one path. No external diff or textconv drivers. */
  const diffText = (top, a, b, file = null, maxBuffer = 4 << 20) =>
    run(top, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', a, b, ...(file ? ['--', `:(literal)${file}`] : [])], { maxBuffer });

  /**
   * Makes the working tree match `target`, given that it currently matches `current`
   * (a snapshot taken just now). Paths in neither (ignored files) are left alone; the
   * user's index and HEAD are not touched. → {written, removed}.
   */
  async function restoreTree({ top }, current, target) {
    const out = await run(top, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', current, target]);
    const n = out.split('\0');
    const remove = [], write = [];
    for (let i = 0; i + 1 < n.length; i += 2) {
      const st = n[i][0], p = n[i + 1];
      if (st === 'D' || st === 'T') remove.push(p);
      if (st !== 'D') write.push(p);
    }
    const root = await fsp.realpath(top);
    for (const p of remove) {
      const abs = path.join(root, p);
      if (!inside(root, abs) || p.split('/').includes('.git')) continue;
      try { const dir = await fsp.realpath(path.dirname(abs)); if (dir !== root && !inside(root, dir)) continue; } catch { continue; }
      try { const st = await fsp.lstat(abs); if (!st.isDirectory()) await fsp.unlink(abs); } catch { continue; }
      for (let d = path.dirname(abs); d !== root && inside(root, d); d = path.dirname(d)) { try { await fsp.rmdir(d); } catch { break; } }
    }
    if (write.length) {
      await withTempIndex(async (index) => {
        await run(top, ['read-tree', target], { index });
        await run(top, ['checkout-index', '-f', '-z', '--stdin'], { index, input: write.join('\0') + '\0' });
      });
    }
    return { written: write.length, removed: remove.length };
  }

  return { run, repoOf, snapshot, updateRef, deleteRef, listRefs, diffFiles, diffText, restoreTree, bin };
}

const inside = (root, p) => { const rel = path.relative(root, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

module.exports = { createGit, findGit, SAFE_GIT, REF_ROOT };
