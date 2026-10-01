// Git plumbing for runs: scope inputs, per-run worktree, fact reads, and the
// code snapshot (spike 7: private GIT_INDEX_FILE, never touches the agent's
// index or HEAD).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { branchName } from '../shared/fence.js';
import { CREDENTIAL_PATTERNS } from '../shared/scope.js';

export const FILE_CAP = 5 * 1024 * 1024;
export const TOTAL_CAP = 25 * 1024 * 1024;

export function git(cwd, args, { env, input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { // privacy-flow: runner-local
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, timeout: timeoutMs, maxBuffer: 64 << 20, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; err.stdout = stdout; reject(err); } else resolve(stdout);
    });
    if (input != null) child.stdin.end(input);
  });
}

const tryGit = (cwd, args, opts) => git(cwd, args, opts).then((s) => s.trim(), () => null);

/** {cwd, toplevel, remote_url} for scope.scopeOf (null fields ⇒ deny). */
export async function sessionOf(cwd) {
  const toplevel = await tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return { cwd, toplevel: null, remote_url: null };
  // The configured URL, not `remote get-url` (which expands insteadOf): identity
  // is the name the member configured, whatever local transport rewrite applies.
  const remote = await tryGit(cwd, ['config', '--get', 'remote.origin.url']);
  const real = fs.realpathSync(toplevel);
  return { cwd: fs.realpathSync(cwd), toplevel: real, remote_url: remote };
}

/**
 * Create the run worktree at `wt` on board/<KEY>-r<fence> from the base ref,
 * or from seed.from_snapshot (fetching refs/board/<KEY>/* explicitly, spike 7).
 */
export async function createWorktree({ localPath, wt, key, fence, baseRef, fromSnapshot }) {
  const branch = branchName(key, fence);
  fs.mkdirSync(path.dirname(wt), { recursive: true, mode: 0o700 });
  let start;
  if (fromSnapshot) {
    await git(localPath, ['fetch', '--quiet', 'origin', `+refs/board/${key}/*:refs/board/${key}/*`]);
    start = fromSnapshot.sha || fromSnapshot.ref;
  } else {
    const ref = baseRef || 'HEAD';
    const fetched = await tryGit(localPath, ['fetch', '--quiet', 'origin', ref]);
    start = fetched !== null ? 'FETCH_HEAD' : ref;
    start = (await tryGit(localPath, ['rev-parse', '--verify', `${start}^{commit}`])) ?? (await git(localPath, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  }
  await git(localPath, ['worktree', 'add', '--quiet', '-b', branch, wt, start]);
  return { branch, base_sha: (await git(wt, ['rev-parse', 'HEAD'])).trim(), worktree: fs.realpathSync(wt) };
}

// Resolve once during preparation. Resumes retain this exact grant; they may
// never widen it to another branch or the complete shared metadata directory.
export async function runGitAccess(wt, branch) {
  const gitRef = `refs/heads/${branch}`;
  await git(wt, ['check-ref-format', gitRef]);
  const actual = (await git(wt, ['symbolic-ref', 'HEAD'])).trim();
  if (actual !== gitRef) throw new Error('run branch does not match its worktree');
  const gitDir = fs.realpathSync((await git(wt, ['rev-parse', '--absolute-git-dir'])).trim());
  const common = (await git(wt, ['rev-parse', '--git-common-dir'])).trim();
  const commonGitDir = fs.realpathSync(path.resolve(wt, common));
  if (!fs.statSync(gitDir).isDirectory() || !fs.statSync(commonGitDir).isDirectory()) throw new Error('run git metadata unavailable');
  return Object.freeze({ gitDir, commonGitDir, gitRef });
}

export async function gitFacts(wt) {
  const branch = await tryGit(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await tryGit(wt, ['rev-parse', 'HEAD']);
  let ahead = null;
  let behind = null;
  const counts = await tryGit(wt, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (counts) { const [b, a] = counts.split(/\s+/).map(Number); ahead = a; behind = b; }
  return { branch, head_sha: head, commits_ahead: ahead, commits_behind: behind };
}

// Secret scan of the changed files: gitleaks when installed, else the shared
// credential patterns. Returns null (clean) or a short reason.
async function secretScan(wt, files, { gitleaks }) {
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'board-scan-'));
  try {
    for (const f of files) {
      const src = path.join(wt, f);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
      const dst = path.join(tmpd, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    if (gitleaks) {
      const report = `${tmpd}.report.json`;
      const code = await new Promise((resolve) => {
        execFile(gitleaks, ['dir', tmpd, '--no-banner', '--redact', '-r', report], { timeout: 60000 }, (err) => resolve(err ? (err.code ?? 1) : 0)); // privacy-flow: runner-local
      });
      if (code === 0) { fs.rmSync(report, { force: true }); return null; }
      let hits = [];
      try { hits = JSON.parse(fs.readFileSync(report, 'utf8')); } catch { /* unreadable */ }
      fs.rmSync(report, { force: true });
      if (!hits.length) return 'gitleaks failed';
      return `possible secret: ${hits.map((h) => `${h.RuleID}@${path.relative(tmpd, h.File)}`).slice(0, 5).join(', ')}`;
    }
    for (const f of files) {
      const p = path.join(tmpd, f);
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const [kind, re] of CREDENTIAL_PATTERNS) if (re.test(text)) return `possible secret: ${kind}@${f}`;
    }
    return null;
  } finally {
    fs.rmSync(tmpd, { recursive: true, force: true });
  }
}

export function findGitleaks() {
  for (const p of ['/opt/homebrew/bin/gitleaks', '/usr/local/bin/gitleaks', '/usr/bin/gitleaks']) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * Snapshot the worktree to `ref` via a private index. push:false keeps it
 * local (gate close). Returns {status:'pushed'|'push_failed'|'held'|'local'|'unchanged', sha, ref, reason}.
 */
export async function snapshot({ wt, ref, message, push = true, gitleaks = findGitleaks() }) {
  const idx = path.join(os.tmpdir(), `board-idx-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    await git(wt, ['read-tree', 'HEAD'], { env });
    await git(wt, ['add', '-A'], { env });
    const changed = (await git(wt, ['diff', '--cached', '--name-only', '-z', 'HEAD'], { env })).split('\0').filter(Boolean);
    let total = 0;
    for (const f of changed) {
      let size = 0;
      try { size = fs.statSync(path.join(wt, f)).size; } catch { continue; }
      if (size > FILE_CAP) return { status: 'held', sha: null, ref, reason: `file over 5 MB: ${f}` };
      total += size;
    }
    if (total > TOTAL_CAP) return { status: 'held', sha: null, ref, reason: 'snapshot over 25 MB' };
    const hit = await secretScan(wt, changed, { gitleaks });
    if (hit) return { status: 'held', sha: null, ref, reason: hit };
    const tree = (await git(wt, ['write-tree'], { env })).trim();
    const head = (await git(wt, ['rev-parse', 'HEAD'])).trim();
    const prev = await tryGit(wt, ['rev-parse', '-q', '--verify', ref]);
    if (prev) {
      const prevTree = await tryGit(wt, ['rev-parse', `${prev}^{tree}`]);
      const prevParent = await tryGit(wt, ['rev-parse', `${prev}^1`]);
      if (prevTree === tree && prevParent === head) return push ? pushRef(wt, prev, ref, 'unchanged') : { status: 'unchanged', sha: prev, ref, reason: null };
    }
    const parents = ['-p', head, ...(prev ? ['-p', prev] : [])];
    const sha = (await git(wt, ['commit-tree', tree, ...parents, '-m', message])).trim();
    await git(wt, ['update-ref', ref, sha]);
    if (!push) return { status: 'local', sha, ref, reason: null };
    return pushRef(wt, sha, ref, 'pushed');
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

export async function pushRef(wt, sha, ref, okStatus = 'pushed') {
  try {
    await git(wt, ['push', '--quiet', 'origin', `${sha}:${ref}`], { timeoutMs: 60000 });
    return { status: okStatus === 'unchanged' ? 'pushed' : okStatus, sha, ref, reason: null };
  } catch (e) {
    return { status: 'push_failed', sha, ref, reason: String(e.stderr || e.message).split('\n').filter(Boolean)[0]?.slice(0, 200) ?? 'push failed' };
  }
}
