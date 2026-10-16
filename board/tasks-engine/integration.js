// Reviewed local integration. Preview writes only unreachable Git objects and a
// private temporary index; it never stashes, resets or edits either checkout.
// Apply requires the same source and a clean, unchanged destination. Git's
// fast-forward checkout additionally refuses overlapping concurrent edits and
// ignored-file collisions. Independent writers do not participate in our lock.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const TTL = 5 * 60_000, MAX_REVIEWS = 100, MAX_FILES = 500, MAX_PATCH = 256 * 1024;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DEV_NULL = process.platform === 'win32' ? 'NUL' : '/dev/null';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message = 'The integration review changed. Review the task again.') => Object.assign(new Error(message), { code: 'CONFLICT' });
const unsafe = () => Object.assign(new Error('This repository needs manual integration.'), { code: 'POLICY_DENIED' });
const taskBinding = t => [t.id, t.state, t.stateSince, t.sessionId, t.repo?.root, t.worktree, t.branch, t.gitRef, t.gitDir, t.baseSha, t.worktreeCreated, t.workInPlace,
  t.source, digest(t.sourceMeta ?? null), t.ai?.id, t.ai?.model, t.permissionLevel, t.planFirst, t.planApproved, t.cost?.usd, t.cost?.budgetUsd,
  digest(t.spec ?? null), digest(t.checkpoint ?? null), digest(t.handover ?? null)];
const permittedPath = p => p && !path.isAbsolute(p) && !/[\\:\u0000-\u001f\u007f]/.test(p)
  && !p.split('/').some(s => !s || s === '.' || s === '..' || /^\.git$/i.test(s));
const privatePath = p => p.split('/').some(s => /^(?:\.env(?:\..*)?|\.ssh|\.aws|credentials|secrets?|id_[a-z0-9]+)$/i.test(s)) || /\.(?:pem|p12|pfx|key)$/i.test(p);

export function createTaskIntegration({ bin, env = process.env, dataDir, now = Date.now, readCoordination }) {
  const reviews = new Map(), queues = new Map();
  const baseEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: DEV_NULL, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' };
  for (const k of ['HOME', 'PATH', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT']) if (env[k]) baseEnv[k] = env[k];
  const options = ['--no-pager', '-c', `core.hooksPath=${DEV_NULL}`, '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${DEV_NULL}`,
    '-c', 'protocol.allow=never', '-c', 'core.sshCommand=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    '-c', 'commit.gpgsign=false', '-c', 'merge.verifySignatures=false', '-c', 'merge.autoStash=false', '-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true',
    '-c', 'user.name=Plexiform', '-c', 'user.email=integration@plexiform.invalid'];
  function git(cwd, args, { index, input, maxBuffer = 8 << 20 } = {}) {
    if (!bin) return Promise.reject(unsafe());
    return new Promise((resolve, reject) => {
      const child = execFile(bin, ['-C', cwd, ...options, ...args], { env: { ...baseEnv, ...(index ? { GIT_INDEX_FILE: index } : {}) }, timeout: 30_000,
        killSignal: 'SIGKILL', maxBuffer, encoding: 'utf8', windowsHide: true }, (error, stdout) => { // privacy-flow: runner-local
        if (error) { error.stdout = stdout; reject(error); } else resolve(stdout);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  const checked = async (p, current) => { const out = await p; if (!current()) throw invalid(); return out; };
  async function serial(key, fn) {
    const before = queues.get(key) ?? Promise.resolve(); let release;
    const latch = new Promise(r => release = r), tail = before.catch(() => {}).then(() => latch); queues.set(key, tail);
    try { await before.catch(() => {}); return await fn(); } finally { release(); if (queues.get(key) === tail) queues.delete(key); }
  }
  function eligible(t) {
    if (t.state !== 'in_review' || t.workInPlace || !t.worktreeCreated || !t.repo?.root || !t.gitDir || !t.gitRef || !OID.test(t.baseSha ?? '')) throw unsafe();
  }
  // The engine supplies the same observed claims used by getClaims, plus its
  // existing packet versions. No renderer/CLI field becomes coordination
  // authority. Synchronous reads allow a last check immediately before spawn.
  function coordination(t) {
    const c = readCoordination?.(t);
    if (!c || c.taskId !== t.id || c.repoRoot !== t.repo?.root || typeof c.epoch !== 'string'
      || !Number.isSafeInteger(c.decisionVersion) || c.decisionVersion < 0 || !Array.isArray(c.claims) || c.claims.length > 500
      || c.claims.some(p => !p || typeof p.taskId !== 'string' || p.taskId.length > 256 || typeof p.state !== 'string'
        || !Array.isArray(p.paths) || p.paths.length > MAX_FILES || p.paths.some(v => typeof v !== 'string' || v.length > 1024))) throw unsafe();
    return structuredClone(c);
  }
  const pathKey = p => p.normalize('NFC').toLowerCase().replace(/\/$/, '');
  function coordinationView(c, changed) {
    const paths = changed.map(f => [f.path, pathKey(f.path)]);
    return { scope: 'local-tasks', decisionVersion: c.decisionVersion, observedClaims: c.claims.length, advisory: true,
      conflicts: c.claims.flatMap(p => {
        const unknown = p.workInPlace || p.paths.length === 0 || p.pathsTruncated || p.paths.some(v => !permittedPath(v));
        const overlaps = paths.filter(([, key]) => p.paths.some(v => { const peer = pathKey(v); return key === peer || key.startsWith(`${peer}/`) || peer.startsWith(`${key}/`); })).map(([v]) => v);
        return unknown || overlaps.length ? [{ taskId: p.taskId, state: p.state, paths: overlaps.slice(0, 20), reason: p.workInPlace ? 'destination-active' : unknown ? 'paths-unconfirmed' : 'overlap' }] : [];
      }) };
  }
  async function repo(root, current) {
    const real = await checked(fs.realpath(root), current);
    if (real !== root) throw invalid();
    const config = await checked(git(real, ['config', '--no-includes', '--name-only', '--list']), current);
    // Includes and custom merge/filter drivers can execute repository-defined
    // commands during add/merge. Reject them instead of trusting their names.
    if (config.split('\n').some(k => /^(?:filter|include|includeif)\.|^merge\..*\.driver$|^core\.(?:worktree|sparsecheckout|alternaterefscommand)$/i.test(k))) throw unsafe();
    const lines = (await checked(git(real, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']), current)).trimEnd().split('\n');
    if (lines[0] !== real || lines.length !== 3) throw unsafe();
    const gitDir = await checked(fs.realpath(path.resolve(real, lines[1])), current), common = await checked(fs.realpath(path.resolve(real, lines[2])), current);
    const flags = await checked(git(real, ['ls-files', '-v', '-z']), current);
    if (flags.split('\0').filter(Boolean).some(s => !s.startsWith('H '))) throw unsafe();
    const head = (await checked(git(real, ['rev-parse', '--verify', 'HEAD']), current)).trim();
    const branch = (await checked(git(real, ['symbolic-ref', '--quiet', 'HEAD']), current)).trim();
    if (!OID.test(head) || !branch.startsWith('refs/heads/')) throw unsafe();
    const status = await checked(git(real, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']), current);
    const stat = await checked(fs.stat(gitDir), current);
    const configHash = digest(await checked(git(real, ['config', '--no-includes', '--list']), current));
    const indexFile = path.join(gitDir, 'index'), indexStat = await checked(fs.lstat(indexFile), current);
    if (!indexStat.isFile() || indexStat.isSymbolicLink()) throw unsafe();
    const indexHash = crypto.createHash('sha256').update(await checked(fs.readFile(indexFile), current)).digest('hex');
    return { root: real, gitDir, common, head, branch, status, identity: [stat.dev, stat.ino], configHash, indexHash };
  }
  async function snapshot(source, current) {
    const untracked = (await checked(git(source.root, ['ls-files', '--others', '--exclude-standard', '-z']), current)).split('\0').filter(Boolean);
    if (untracked.length > MAX_FILES || untracked.some(p => !permittedPath(p) || privatePath(p))) throw unsafe();
    const changed = new Set([...untracked, ...(await checked(git(source.root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--']), current)).split('\0').filter(Boolean)]);
    if (changed.size > MAX_FILES) throw unsafe();
    let bytes = 0;
    for (const p of changed) {
      if (!permittedPath(p)) throw unsafe();
      let stat; try { stat = await checked(fs.lstat(path.join(source.root, p)), current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.size > (8 << 20) || (bytes += stat.size) > (32 << 20)) throw unsafe();
    }
    const parent = path.join(dataDir, 'integration');
    await checked(fs.mkdir(parent, { recursive: true, mode: 0o700 }), current);
    const dir = await checked(fs.mkdtemp(path.join(parent, 'review-')), current), index = path.join(dir, 'index');
    try {
      await checked(fs.copyFile(path.join(source.gitDir, 'index'), index), current);
      await checked(fs.chmod(index, 0o600), current);
      await checked(git(source.root, ['add', '-A', '--', '.'], { index }), current);
      return (await checked(git(source.root, ['write-tree'], { index }), current)).trim();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  async function files(root, a, b, current) {
    const raw = (await checked(git(root, ['diff', '--no-ext-diff', '--no-textconv', '--raw', '--no-abbrev', '--no-renames', '-z', a, b, '--']), current)).split('\0');
    const out = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMD])$/.exec(raw[i]), p = raw[i + 1];
      if (!m || !permittedPath(p) || ![m[1], m[2]].every(mode => ['000000', '100644', '100755'].includes(mode))) throw unsafe();
      out.push({ path: p, status: m[3] });
    }
    if (out.length > MAX_FILES) throw unsafe();
    return out;
  }
  async function capture(t, current) {
    eligible(t);
    const context = coordination(t), binding = taskBinding(t);
    const source = await repo(t.worktree, current), destination = await repo(t.repo.root, current);
    if (source.root === destination.root || source.common !== destination.common || source.gitDir !== t.gitDir || source.branch !== t.gitRef) throw invalid();
    const tree = await snapshot(source, current);
    if (digest(context) !== digest(coordination(t)) || digest(binding) !== digest(taskBinding(t))) throw invalid();
    return { source, destination, tree, task: binding, coordination: context };
  }
  // Reuse the same restricted Git snapshot for an explicit provider handover.
  // Only isolated, engine-created worktrees have sufficient recorded identity.
  async function inspectSource(t, current = () => true) {
    if (t.workInPlace || !t.worktreeCreated || !t.repo?.root || !t.gitDir || !t.gitRef || !OID.test(t.baseSha ?? '')) throw unsafe();
    const binding = taskBinding(t), context = coordination(t), source = await repo(t.worktree, current);
    if (source.gitDir !== t.gitDir || source.branch !== t.gitRef) throw invalid();
    const tree = await snapshot(source, current), changed = await files(source.root, t.baseSha, tree, current);
    if (changed.some(f => privatePath(f.path))) throw unsafe();
    const patch = await checked(git(source.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', t.baseSha, tree, '--'], { maxBuffer: MAX_PATCH + 1 }), current);
    const numstat = await checked(git(source.root, ['diff', '--numstat', '--no-ext-diff', '--no-textconv', '--no-renames', t.baseSha, tree, '--']), current);
    if (Buffer.byteLength(patch) > MAX_PATCH || numstat.split('\n').some(s => s.startsWith('-\t-\t'))) throw unsafe();
    const fresh = await repo(t.worktree, current);
    if (digest(fresh) !== digest(source) || digest(binding) !== digest(taskBinding(t)) || digest(context) !== digest(coordination(t))) throw invalid();
    return { source, tree, task: binding, coordination: context, files: changed, patch };
  }
  async function preview(t, current = () => true) {
    return serial(t.repo?.root, async () => {
      const c = await capture(t, current), changed = await files(c.source.root, t.baseSha, c.tree, current);
      const context = coordinationView(c.coordination, changed);
      const blocked = (status, reason, entries = changed) => ({ status, canApply: false, reason, branch: c.destination.branch.slice(11), files: entries, patch: '', expiresAt: null, coordination: context });
      if (c.destination.status) return blocked('dirty', 'Save or commit your checkout changes before integrating. Your files were left unchanged.');
      if (!changed.length) return blocked('unchanged', 'This task has no changes to integrate.');
      if (context.conflicts.length) return blocked('ownership', 'Other local tasks may still change these paths. Resolve their ownership or wait for them to finish, then review again.');
      const snapshotCommit = (await checked(git(c.source.root, ['commit-tree', c.tree, '-p', c.source.head], { input: 'Plexiform reviewed task snapshot\n' }), current)).trim();
      let merged;
      try { merged = await checked(git(c.destination.root, ['merge-tree', '--write-tree', '--name-only', '--merge-base', t.baseSha, c.destination.head, snapshotCommit]), current); }
      catch (error) {
        if (error.code === 1 && OID.test(error.stdout?.split('\n')[0] ?? '')) return blocked('conflict', 'The task conflicts with your branch. Resolve it in the task worktree and review again.');
        if (error.code === 'CONFLICT') throw error;
        throw unsafe();
      }
      const tree = merged.split('\n')[0]; if (!OID.test(tree)) throw unsafe();
      const resultFiles = await files(c.destination.root, c.destination.head, tree, current);
      if (!resultFiles.length) return blocked('unchanged', 'Your branch already contains these changes.', []);
      const patch = await checked(git(c.destination.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', c.destination.head, tree, '--'], { maxBuffer: MAX_PATCH + 1 }), current);
      const numstat = await checked(git(c.destination.root, ['diff', '--numstat', '--no-ext-diff', '--no-textconv', '--no-renames', c.destination.head, tree, '--']), current);
      if (Buffer.byteLength(patch) > MAX_PATCH || numstat.split('\n').some(s => s.startsWith('-\t-\t'))) throw unsafe();
      const commit = (await checked(git(c.destination.root, ['commit-tree', tree, '-p', c.destination.head, '-p', snapshotCommit], { input: 'Integrate reviewed Plexiform task\n' }), current)).trim();
      // Reject changes during the preview itself. A later source content edit
      // is detected by the second private-index tree at confirmation.
      const freshSource = await repo(t.worktree, current), freshDestination = await repo(t.repo.root, current);
      if (digest(freshSource) !== digest(c.source) || digest(freshDestination) !== digest(c.destination)
        || digest(c.coordination) !== digest(coordination(t)) || digest(c.task) !== digest(taskBinding(t))) throw invalid();
      const id = crypto.randomUUID(), expiresAt = now() + TTL;
      const review = { status: 'review', canApply: true, reason: 'Creates a local merge commit on this branch. Nothing is pushed. The task worktree is kept.', branch: c.destination.branch.slice(11), files: resultFiles, patch, expiresAt, coordination: context };
      const hash = digest({ c, commit, review });
      for (const [key, value] of reviews) if (value.expiresAt <= now()) reviews.delete(key);
      while (reviews.size >= MAX_REVIEWS) reviews.delete(reviews.keys().next().value);
      reviews.set(id, { c, commit, hash, expiresAt });
      return { ...review, id, hash };
    });
  }
  async function apply(t, id, hash, current = () => true) {
    const r = reviews.get(id); reviews.delete(id);
    if (!r || r.hash !== hash || r.expiresAt <= now() || digest(r.c.task) !== digest(taskBinding(t))) throw invalid();
    return serial(t.repo.root, async () => {
      const fresh = () => current() && now() < r.expiresAt && digest(r.c.task) === digest(taskBinding(t)) && digest(r.c.coordination) === digest(coordination(t));
      const c = await capture(t, fresh);
      if (digest(c) !== digest(r.c)) throw invalid();
      if (!fresh()) throw invalid();
      let mergeError = null;
      try { await checked(git(c.destination.root, ['merge', '--ff-only', '--no-edit', '--no-stat', '--no-overwrite-ignore', '--no-autostash', '--no-verify-signatures', r.commit]), fresh); }
      catch (error) { mergeError = error; }
      // Receipt is observed even after focus/expiry changes: a completed Git
      // effect cannot be turned into an invitation to retry it.
      const head = (await git(c.destination.root, ['rev-parse', '--verify', 'HEAD'])).trim();
      const branch = (await git(c.destination.root, ['symbolic-ref', '--quiet', 'HEAD'])).trim();
      if (head === r.commit && branch === c.destination.branch) return { status: 'merged', commit: r.commit, branch: branch.slice(11) };
      if (mergeError && head === c.destination.head && branch === c.destination.branch) throw invalid('Git refused the integration. Your task worktree is kept; review your checkout before trying again.');
      throw Object.assign(invalid('Integration outcome is unconfirmed. Inspect your branch before reviewing another integration.'), { details: { outcome: 'unconfirmed' } });
    });
  }
  return { preview, apply, inspectSource, clear() { reviews.clear(); } };
}
