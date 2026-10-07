'use strict';

// WP3: "2 sessions share this working tree", from real local git repositories.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorktreeShare } = require('../src/worktree-share.js');

const NOW = Date.parse('2026-10-07T10:00:00Z');
const at = (ms) => new Date(NOW - ms).toISOString();
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-share-')));
  const main = path.join(dir, 'main');
  fs.mkdirSync(path.join(main, 'sub'), { recursive: true });
  git(main, 'init', '-q');
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return { dir, main };
}
const row = (sessionId, cwd, extra = {}) => ({ sessionId, cwd, updatedAt: at(1000), signal: 'tool-use', ...extra });

test('two live sessions in one toplevel with uncommitted files -> shared; separate worktrees -> not', async () => {
  const { dir, main } = repo();
  try {
    const ws = createWorktreeShare({ now: () => NOW });
    const both = [row('s1', main), row('s2', path.join(main, 'sub'), { source: 'codex' })];
    assert.deepEqual(await ws.refresh(both), [], 'clean tree: nothing to warn about');
    fs.writeFileSync(path.join(main, 'a.txt'), 'x');
    fs.writeFileSync(path.join(main, 'sub', 'b.txt'), 'y');
    assert.deepEqual(await ws.refresh(both), [{ toplevel: main, sessions: ['s1', 's2'], dirty: 2 }]);

    const other = path.join(dir, 'card-1');
    git(main, 'worktree', 'add', '-q', '-b', 'card-1', other);
    fs.writeFileSync(path.join(other, 'c.txt'), 'z');
    assert.deepEqual(await ws.refresh([row('s1', main), row('s3', other)]), [], 'each worktree is its own toplevel');

    assert.deepEqual(await ws.refresh([row('s1', main), row('s2', main, { signal: 'session-end' })]), [], 'an ended session is not live');
    assert.deepEqual(await ws.refresh([row('s1', main), row('s2', main, { updatedAt: at(3 * 3600_000) })]), [], 'a long-silent session is not live');
    assert.deepEqual(await ws.refresh([row('s1', main), row('remote:s2', main)]), [], 'remote sessions do not count');
    assert.deepEqual(await ws.refresh([row('s1', path.join(dir, 'not-a-repo')), row('s2', 'relative/path')]), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shared() answers from the cache at once and refreshes in the background, at most once per ttl', async () => {
  const calls = [];
  const fake = async (args, cwd) => { calls.push(args[0] === '--no-optional-locks' ? 'status' : 'top'); return args[0] === 'rev-parse' ? '/repo\n' : ' M a.js\n?? b.js\n'; };
  let t = NOW;
  const ws = createWorktreeShare({ now: () => t, git: fake, ttlMs: 1000 });
  const rows = [row('s1', '/repo/a'), row('s2', '/repo/b')];
  assert.deepEqual(ws.shared(rows), []);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ws.shared(rows), [{ toplevel: '/repo', sessions: ['s1', 's2'], dirty: 2 }]);
  const n = calls.length;
  ws.shared(rows);
  assert.equal(calls.length, n, 'cached within the ttl');
  t += 1001;
  ws.shared(rows);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((c) => c === 'status').length, 2, 'refreshed after the ttl; toplevels stay cached');
  assert.equal(calls.filter((c) => c === 'top').length, 2);
});
