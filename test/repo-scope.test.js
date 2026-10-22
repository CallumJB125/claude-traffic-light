'use strict';
// hooks/repo-scope.js: the one "never" rule the agent bus, main's awareness
// roster and the awareness hook share (plan-agent-awareness §3.2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const Scope = require('../hooks/repo-scope.js');
const { testTempDir } = require('./helpers/tmp');

const git = (dir, args) => new Promise((resolve, reject) => execFile('git', ['-C', dir, ...args], { encoding: 'utf8' }, (e, out) => (e ? reject(e) : resolve(out))));
const realpath = (p) => fs.promises.realpath(p);
const gitInit = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: dir });
  return fs.realpathSync(dir);
};

function world(t) {
  const dir = fs.realpathSync(testTempDir('pf-repo-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  return { dir, home };
}
const verdict = async (top, opts) => (await Scope.neverReason(top, { git, realpath, ...opts })) || Scope.protectedReason(top, opts.home);

test('normalizeRemoteUrl and DENY_READ are the board\'s, value for value', async () => {
  const { normalizeRemoteUrl } = await import('../board/shared/scope.js');
  const { DENY_READ } = await import('../board/runner/launch.js');
  assert.deepEqual([...Scope.DENY_READ], [...DENY_READ]);
  const urls = ['git@github.com:PistorVentures/bondly.git', 'ssh://git@github.com:22/PistorVentures/bondly', 'https://user:tok@GitHub.com/PistorVentures/Bondly/', 'https://gitlab.com/a/b/c.git',
    'ssh://host:owner/repo', 'file:///tmp/x', '/tmp/repo', 'C:\\repo', 'github.com/acme/app', '', null, 'git://example.org/A/B', 'ftp://x/y/z', 'host:a/../b', 'h:only'];
  for (const u of urls) assert.equal(Scope.normalizeRemoteUrl(u), normalizeRemoteUrl(u), String(u));
});

test('never: a root, $HOME or a folder holding it, the data folder, a deny path, a protected folder', async (t) => {
  const { dir, home } = world(t);
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  const opts = { home, dataDirs: [data], exclude: [] };
  assert.equal(await verdict('/', opts), 'ROOT');
  assert.equal(await verdict(home, opts), 'HOME');
  assert.equal(await verdict(dir, opts), 'HOME', 'a folder holding $HOME');
  assert.equal(await verdict(path.join(data, 'x'), opts), 'DATA');
  assert.equal(await verdict(path.join(home, '.ssh'), opts), 'DENY');
  assert.equal(await verdict(path.join(home, '.claude', 'projects'), opts), 'DENY');
  assert.equal(await verdict(path.join(home, '.config', 'tool'), opts), 'PROTECTED');
  assert.equal(await verdict(path.join(home, 'Library', 'App'), opts), 'PROTECTED');
  assert.equal(await verdict(path.join(home, 'code', 'app'), opts), null);
  assert.equal(await Scope.neverReason(null, opts), 'UNRESOLVED');
  assert.equal(Scope.protectedReason(path.join(home, 'code'), home), null);
});

test('exclude: a folder, everything under it, a linked worktree outside it, and a canonical remote', async (t) => {
  const { dir, home } = world(t);
  const repo = gitInit(path.join(dir, 'work', 'app'));
  const wt = path.join(dir, 'elsewhere', 'app-wt');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt', wt], { cwd: repo });
  const other = gitInit(path.join(dir, 'more', 'other'));
  const base = { home, dataDirs: [] };
  assert.equal(await verdict(repo, { ...base, exclude: [repo] }), 'EXCLUDED');
  assert.equal(await verdict(repo, { ...base, exclude: [path.join(dir, 'work')] }), 'EXCLUDED', 'a parent folder');
  assert.equal(await verdict(fs.realpathSync(wt), { ...base, exclude: [repo] }), 'EXCLUDED', 'a linked worktree outside the folder');
  assert.equal(await verdict(other, { ...base, exclude: [repo] }), null);
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/App.git'], { cwd: other });
  assert.equal(await verdict(other, { ...base, exclude: ['https://github.com/acme/app'] }), 'EXCLUDED', 'by canonical remote');
  assert.equal(await verdict(other, { ...base, exclude: ['github.com/acme/other'] }), null);
});

test('git that cannot answer never makes a folder allowed by itself: a caller sees the failure', async (t) => {
  const { dir, home } = world(t);
  const repo = gitInit(path.join(dir, 'app'));
  let failed = false;
  const broken = () => { failed = true; return Promise.reject(Object.assign(new Error('timeout'), { killed: true })); };
  await Scope.neverReason(repo, { home, exclude: ['github.com/acme/app'], git: broken, realpath });
  assert.equal(failed, true, 'the resolver asked git, so the caller can treat the failure as unresolved');
});

test('parity with busRepoAllowed: the bus refuses exactly what the resolver says never to (automatic mode, session folders)', async (t) => {
  const { startBus } = await import('../board/tasks-engine/test/bus-helpers.js');
  const b = await startBus({ wait: true }, { policy: () => ({}) });
  t.after(() => b.cleanup());
  const home = fs.realpathSync(b.engine.env.HOME);
  const root = fs.realpathSync(b.h.dir);
  const top = fs.realpathSync(b.h.repo.checkout);
  const remote = gitInit(path.join(root, 'remote-app'));
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/parity.git'], { cwd: remote });
  const wt = path.join(root, 'parity-wt');
  b.h.repo.git('worktree', 'add', '-q', '-b', 'parity', wt);
  const linked = fs.realpathSync(wt);
  const inData = gitInit(path.join(b.h.dataDir, 'inside'));
  const cases = [
    { top, exclude: [] },
    { top, exclude: [top] },
    { top, exclude: [root] },
    { top: linked, exclude: [top] },
    { top: linked, exclude: [] },
    { top: remote, exclude: ['github.com/acme/parity'] },
    { top: remote, exclude: ['github.com/acme/elsewhere'] },
    { top: inData, exclude: [] },
  ];
  for (const c of cases) {
    await b.bus('busSetContext', { exclude: c.exclude, repos: [], scope: 'auto', folders: [c.top] });
    const bus = await b.engine.busRepoAllowed(c.top);
    const reason = await verdict(c.top, { home, dataDirs: [b.h.dataDir], exclude: c.exclude });
    assert.equal(bus, reason === null, `${path.relative(root, c.top) || c.top} exclude=${JSON.stringify(c.exclude)}: bus ${bus}, resolver ${reason}`);
  }
});
