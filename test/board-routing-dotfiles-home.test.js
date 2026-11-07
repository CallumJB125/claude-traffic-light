'use strict';
// Open decision 6: $HOME is itself a git checkout (a dotfiles repo with a remote). A session in a plain folder under it
// (~/notes) used to resolve the dotfiles remote, and a team that linked that remote got the card. A checkout whose top
// is $HOME is no repo: My board, no_repo. A real repo inside $HOME keeps its own remote.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { testTempDir } = require('./helpers/tmp');
const { repoFor, createWorkCapture } = require('../src/work-capture.js');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
function init(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

test('a folder under a dotfiles $HOME resolves no repo; $HOME itself neither; a nested real repo keeps its remote', async (t) => {
  const home = fs.realpathSync(testTempDir('dotfiles-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  init(home, 'https://github.com/someone/dotfiles.git');
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes);
  const app = init(path.join(home, 'dev', 'app'), 'https://github.com/org/app.git');
  assert.equal(await repoFor(notes, { home }), null);
  assert.equal(await repoFor(home, { home }), null);
  assert.equal(await repoFor(app, { home }), 'github.com/org/app');
  // The same folders when $HOME is somewhere else: the dotfiles checkout is an ordinary repo.
  assert.equal(await repoFor(notes, { home: path.join(home, 'elsewhere') }), 'github.com/someone/dotfiles');
});

test('a session in that folder gets a My board card (no_repo) even when a team links the dotfiles remote', async (t) => {
  const home = fs.realpathSync(testTempDir('dotfiles-cap-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  init(home, 'https://github.com/someone/dotfiles.git');
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes);
  const R = { hub: 'https://hub.example.test', user_id: 'u', team_id: 't', board_id: 'b', repo_id: 'r', canonical_url: 'github.com/someone/dotfiles', role: 'member' };
  const calls = [];
  const cap = createWorkCapture({ startEnabled: true, file: path.join(home, 'cap', 'capture.json'), host: 'mac', home, getRoutes: async () => ({ routes: [R], complete: true }),
    resolveRepo: (cwd) => repoFor(cwd, { home }), sendLocal: async (body) => { calls.push({ kind: 'local', body }); return { ok: true, card: { id: 'l' } }; },
    sendTeam: async (d, body) => { calls.push({ kind: 'team', body }); return { ok: true, card: { id: 't' } }; }, now: () => 100000 });
  t.after(() => cap.stop());
  await cap.observe([{ source: 'codex', sessionId: 's1', host: 'mac', cwd: notes, signal: 'tool-use', taskTitle: 'Tidy notes', updatedAt: new Date(100000).toISOString() }]);
  assert.deepEqual(calls.map((c) => c.kind), ['local']);
  assert.deepEqual(cap.snapshot().map((e) => e.why), ['no_repo']);
});
