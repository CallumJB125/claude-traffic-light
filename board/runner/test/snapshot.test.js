// Code snapshots (spike 7): private GIT_INDEX_FILE never touches the agent's
// index or HEAD, even raced against the agent's own `git add`; secret scan and
// size cap hold; a failed push is reported push_failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { snapshot, git, findGitleaks } from '../git.js';
import { makeRepo, tmpDir, rm } from './helpers.js';

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const gitAsync = (cwd, ...a) => new Promise((resolve, reject) => execFile('git', a, { cwd }, (e, so, se) => (e ? reject(Object.assign(e, { se })) : resolve(so))));

function worktree(root, repo) {
  const wt = path.join(root, 'wt');
  sh(repo.checkout, 'worktree', 'add', '-q', '-b', 'board/K-1-r1', wt, 'main');
  return wt;
}

test('snapshot race: 10 snapshots vs 100 agent git-adds → no errors, agent index intact, HEAD unchanged', async () => {
  const root = tmpDir();
  try {
    const repo = makeRepo(root);
    const wt = worktree(root, repo);
    const head = sh(wt, 'rev-parse', 'HEAD');
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(wt, `f${i}.txt`), `v${i}\n`);
    const agent = (async () => {
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(path.join(wt, `f${i % 20}.txt`), `v${i}\n`);
        await gitAsync(wt, 'add', `f${i % 20}.txt`);
      }
    })();
    const snaps = (async () => {
      const out = [];
      for (let i = 0; i < 10; i++) out.push(await snapshot({ wt, ref: 'refs/board/K-1/r1', message: `snap ${i}`, push: i % 3 === 0, gitleaks: null }));
      return out;
    })();
    const [, results] = await Promise.all([agent, snaps]);
    assert.ok(results.every((r) => ['pushed', 'local', 'unchanged'].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
    assert.equal(sh(wt, 'rev-parse', 'HEAD'), head, 'HEAD untouched');
    // The agent's index holds exactly what the agent staged.
    const staged = sh(wt, 'diff', '--cached', '--name-only').split('\n').sort();
    assert.deepEqual(staged, Array.from({ length: 20 }, (_, i) => `f${i}.txt`).sort());
    // The last snapshot has HEAD as first parent and the working tree content.
    const last = results.filter((r) => r.sha).at(-1);
    assert.equal(sh(wt, 'rev-parse', `${last.sha}^1`), head);
    assert.equal(sh(wt, 'show', `${last.sha}:f19.txt`), 'v99');
    assert.ok(!fs.readdirSync(wt).some((f) => f.startsWith('board-idx')));
  } finally { rm(root); }
});

test('a credential in a changed file holds the snapshot (regex fallback, and gitleaks when installed)', async () => {
  const root = tmpDir();
  try {
    const repo = makeRepo(root);
    const wt = worktree(root, repo);
    fs.writeFileSync(path.join(wt, 'config.js'), `export const token = 'ghp_${'a1B2c3D4e5'.repeat(4)}';\n`);
    const r = await snapshot({ wt, ref: 'refs/board/K-1/r1', message: 'x', gitleaks: null });
    assert.equal(r.status, 'held');
    assert.match(r.reason, /possible secret: github_token@config\.js/);
    assert.throws(() => sh(repo.bare, 'rev-parse', '--verify', 'refs/board/K-1/r1'));
    const gl = findGitleaks();
    if (gl) {
      const r2 = await snapshot({ wt, ref: 'refs/board/K-1/r1', message: 'x', gitleaks: gl });
      assert.equal(r2.status, 'held');
      assert.match(r2.reason, /possible secret/);
    }
  } finally { rm(root); }
});

test('size cap: a file over 5 MB is held', async () => {
  const root = tmpDir();
  try {
    const repo = makeRepo(root);
    const wt = worktree(root, repo);
    fs.writeFileSync(path.join(wt, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const r = await snapshot({ wt, ref: 'refs/board/K-1/r1', message: 'x', gitleaks: null });
    assert.equal(r.status, 'held');
    assert.match(r.reason, /over 5 MB: big\.bin/);
  } finally { rm(root); }
});

test('push to an unreachable remote → push_failed with the local commit kept', async () => {
  const root = tmpDir();
  try {
    const repo = makeRepo(root);
    const wt = worktree(root, repo);
    sh(repo.checkout, 'config', '--unset', `url.file://${repo.bare}.insteadOf`);
    sh(repo.checkout, 'config', `url.file://${root}/nowhere.git.insteadOf`, 'https://github.com/acme/app.git');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n');
    const r = await snapshot({ wt, ref: 'refs/board/K-1/r1', message: 'x', gitleaks: null });
    assert.equal(r.status, 'push_failed');
    assert.ok(r.sha);
    assert.equal((await git(wt, ['rev-parse', 'refs/board/K-1/r1'])).trim(), r.sha);
  } finally { rm(root); }
});
