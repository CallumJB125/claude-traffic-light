// Project-folder reads stay off the main thread and are bounded
// (src/bounded-io.js): a folder macOS holds behind a privacy prompt can't
// freeze the app or stall a poll.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const B = require('../src/bounded-io.js');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-io-')));
const sh = (cwd, ...args) => childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
function repo() {
  const dir = tmp();
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'one');
  return dir;
}

// Any synchronous fs call on a path under `root` is recorded (and fails, as a
// blocked read would never return): the code under test must make none.
function forbidSyncUnder(root) {
  const touched = [];
  const names = ['statSync', 'lstatSync', 'existsSync', 'readFileSync', 'readdirSync', 'realpathSync', 'openSync', 'accessSync', 'copyFileSync', 'opendirSync'];
  const saved = names.map((n) => [n, fs[n]]);
  for (const [n, orig] of saved) {
    fs[n] = function guarded(p, ...rest) {
      if (typeof p === 'string' && (p === root || p.startsWith(root + path.sep))) { touched.push(`${n} ${p}`); throw Object.assign(new Error('blocked'), { code: 'EPERM' }); }
      return orig.call(this, p, ...rest);
    };
  }
  return { touched, restore: () => { for (const [n, orig] of saved) fs[n] = orig; } };
}

test('withDeadline: the work settles it, or at the deadline the child is killed and the fallback returned', async () => {
  assert.equal(await B.withDeadline((done) => { setTimeout(() => done('ok'), 5); }, 1000, 'late'), 'ok');
  const child = new EventEmitter();
  const kills = [];
  child.kill = (sig) => kills.push(sig);
  const began = Date.now();
  assert.equal(await B.withDeadline(() => child, 40, 'late'), 'late');
  assert.ok(Date.now() - began < 1000);
  assert.deepEqual(kills, ['SIGKILL']);
  assert.equal(await B.withDeadline(() => { throw new Error('spawn failed'); }, 1000, 'fallback'), 'fallback');
  let calls = 0;
  assert.equal(await B.withDeadline((done) => { done(1); done(2); calls += 1; }, 1000, 0), 1);
  assert.equal(calls, 1);
});

test('isDirWithin: folders, files, missing and relative paths, and a stat that never answers', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'f'), '');
  assert.equal(await B.isDirWithin(dir), true);
  assert.equal(await B.isDirWithin(path.join(dir, 'f')), false);
  assert.equal(await B.isDirWithin(path.join(dir, 'nope')), false);
  assert.equal(await B.isDirWithin('relative/dir'), false);
  assert.equal(await B.isDirWithin(undefined), false);
  const began = Date.now();
  assert.equal(await B.isDirWithin(dir, 40, () => new Promise(() => {})), false);
  assert.ok(Date.now() - began < 1000);
});

test('session handover git facts: no synchronous touch of the session folder, same answers', async () => {
  const H = require('../src/session-handover.js');
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  const guard = forbidSyncUnder(dir);
  let g;
  try { g = await H.gitFacts(dir); } finally { guard.restore(); }
  assert.deepEqual(guard.touched, []);
  assert.equal(g.repo, true);
  assert.equal(g.branch, 'main');
  assert.deepEqual(g.status, ['?? b.txt']);
  assert.deepEqual(await H.gitFacts(path.join(dir, 'a.txt')), { repo: false });
  assert.deepEqual(await H.gitFacts(path.join(dir, 'missing')), { repo: false });
});

test('git signals: a session folder whose git never answers does not hold up the poll', async () => {
  const G = require('../src/github-signals.js');
  const runGh = async () => ({ notFound: true, stdout: '', stderr: '' });
  const p = G.create({ stateFile: null, runGh, git: () => new Promise(() => {}), folderMs: 40 });
  const began = Date.now();
  await p.tick({ sessions: [{ cwd: '/Users/someone/Desktop/project' }], config: {} });
  assert.ok(Date.now() - began < 2000);
  assert.equal(p.status().state, 'no-gh');
  assert.deepEqual(p.status().repos, []);
  assert.equal(await G.folderRepo('/x', async () => null), null);
});

test('work capture repo lookup: the origin is read through git -C, unchanged', async () => {
  const W = require('../src/work-capture.js');
  const dir = repo();
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git');
  const guard = forbidSyncUnder(dir);
  let r;
  try { r = await W.repoFor(dir); } finally { guard.restore(); }
  assert.deepEqual(guard.touched, []);
  assert.equal(r, 'github.com/acme/widget');
  assert.equal(await W.repoFor(path.join(dir, 'missing')), null);
});

test('checkpoint git: -C instead of a spawn cwd, no synchronous stat of the folder, and a git that never exits rejects', async () => {
  const CheckpointGit = require('../src/checkpoint-git.js');
  const dir = repo();
  const git = CheckpointGit.createGit();
  const guard = forbidSyncUnder(dir);
  let r;
  try { r = await git.repoOf(dir); } finally { guard.restore(); }
  assert.deepEqual(guard.touched, []);
  assert.equal(r.top, dir);
  assert.deepEqual(await git.repoOf(path.join(dir, 'missing')), { skip: 'not-git' });

  const orig = childProcess.execFile;
  const seen = [];
  childProcess.execFile = (bin, args, opts) => {
    seen.push({ args, opts });
    const child = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => {};
    return child;
  };
  try {
    await assert.rejects(git.run(dir, ['status'], { timeoutMs: 10 }), (e) => e.code === 'ETIMEDOUT');
  } finally { childProcess.execFile = orig; }
  assert.deepEqual(seen[0].args.slice(0, 2), ['-C', dir]);
  assert.equal(seen[0].opts.cwd, undefined);
});

test('checkpoint restore: removes and rewrites files without synchronous fs on the work tree', async () => {
  const CheckpointGit = require('../src/checkpoint-git.js');
  const dir = repo();
  const git = CheckpointGit.createGit();
  const r = await git.repoOf(dir);
  const base = await git.snapshot(r, { message: 'base' });
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  const now = await git.snapshot(r, { message: 'now' });
  const guard = forbidSyncUnder(dir);
  let out;
  try { out = await git.restoreTree(r, now, base); } finally { guard.restore(); }
  assert.deepEqual(guard.touched, []);
  assert.deepEqual(out, { written: 1, removed: 1 });
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.existsSync(path.join(dir, 'sub')), false);
});

test('worktree share and the session bridge ask git with -C', async () => {
  const W = require('../src/worktree-share.js');
  const dir = repo();
  const share = W.createWorktreeShare();
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  const guard = forbidSyncUnder(dir);
  let out;
  try { out = await share.refresh([{ sessionId: 's1', cwd: dir, updatedAt: at }, { sessionId: 's2', cwd: dir, updatedAt: at }]); } finally { guard.restore(); }
  assert.deepEqual(guard.touched, []);
  assert.deepEqual(out, [{ toplevel: dir, sessions: ['s1', 's2'], dirty: 1 }]);
  const { gitRoot } = require('../buddy-window/session-bridge.js');
  assert.equal(await gitRoot(dir), dir);
  assert.equal(await gitRoot(path.join(dir, 'missing')), null);
});

test('focus and tasks: the folder check is async and bounded', async () => {
  const Focus = require('../src/focus/index.js');
  const dir = tmp();
  const pending = Focus.isDir(dir);
  assert.ok(pending instanceof Promise);
  assert.equal(await pending, true);
  assert.equal(await Focus.isDir(path.join(dir, 'missing')), false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tasks-service.js'), 'utf8');
  assert.match(src, /isDirWithin: isDirDefault/);
  assert.doesNotMatch(src, /statSync/);
});
