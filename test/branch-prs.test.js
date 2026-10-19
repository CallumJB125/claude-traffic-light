// Open PRs by branch (src/branch-prs.js) from the pages the GitHub poll already
// fetched, the poller's prFor(cwd), and My board's capture report carrying it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BranchPrs = require('../src/branch-prs.js');
const G = require('../src/github-signals.js');
const { createWorkCapture, prBody } = require('../src/work-capture.js');

const FIX = path.join(__dirname, 'fixtures', 'github');
const NOW = Date.parse('2026-09-30T12:00:00Z');
const URL = (n) => `https://github.com/acme/widget/pull/${n}`;
const pull = (n, ref, extra = {}) => ({ number: n, html_url: URL(n), head: { ref, sha: 'abc', repo: { full_name: 'acme/widget' } }, base: { repo: { full_name: 'acme/widget' } }, requested_reviewers: [], ...extra });
const run = (workflow, status, conclusion, extra = {}) => ({ workflow_id: workflow, name: `wf-${workflow}`, head_branch: 'feat/x', head_sha: 'abc', status, conclusion, updated_at: '2026-09-30T11:00:00Z', ...extra });

test('checks: running beats failing beats passing; only the PR head, newest run per workflow, no deploys', () => {
  const pr = pull(1, 'feat/x');
  const deploy = (n) => /deploy/.test(n);
  assert.equal(BranchPrs.checksFor(pr, [], deploy), null, 'no runs: unknown');
  assert.equal(BranchPrs.checksFor(pr, [run(1, 'completed', 'success')], deploy), 'passing');
  assert.equal(BranchPrs.checksFor(pr, [run(1, 'completed', 'success'), run(2, 'completed', 'failure')], deploy), 'failing');
  assert.equal(BranchPrs.checksFor(pr, [run(1, 'completed', 'failure'), run(2, 'in_progress', null)], deploy), 'pending');
  assert.equal(BranchPrs.checksFor(pr, [run(1, 'completed', 'failure', { updated_at: '2026-09-30T10:00:00Z' }), run(1, 'completed', 'success')], deploy), 'passing', 'a re-run that passed replaces the failure');
  assert.equal(BranchPrs.checksFor(pr, [run(1, 'completed', 'failure', { head_sha: 'old' })], deploy), null, 'an older head does not count');
  assert.equal(BranchPrs.checksFor(pr, [run(1, 'completed', 'failure', { head_branch: 'main' })], deploy), null);
  assert.equal(BranchPrs.checksFor(pr, [run(1, 'completed', 'failure', { name: 'deploy prod' })], deploy), null);
  assert.equal(BranchPrs.checksFor(pr, [run(1, 'completed', 'skipped')], deploy), 'none');
});

test('review: each reviewer\'s newest verdict; changes requested beats approved; else requested or none', () => {
  const rv = (login, state) => ({ user: { login }, state });
  const pr = pull(1, 'feat/x');
  assert.equal(BranchPrs.reviewFor(pr, []), 'none');
  assert.equal(BranchPrs.reviewFor({ ...pr, requested_reviewers: [{ login: 'a' }] }, []), 'requested');
  assert.equal(BranchPrs.reviewFor({ ...pr, requested_teams: [{ slug: 't' }] }, undefined), 'requested');
  assert.equal(BranchPrs.reviewFor(pr, [rv('a', 'APPROVED')]), 'approved');
  assert.equal(BranchPrs.reviewFor(pr, [rv('a', 'APPROVED'), rv('b', 'CHANGES_REQUESTED')]), 'changes_requested');
  assert.equal(BranchPrs.reviewFor(pr, [rv('b', 'CHANGES_REQUESTED'), rv('b', 'APPROVED')]), 'approved', 'b changed their mind');
  assert.equal(BranchPrs.reviewFor(pr, [rv('b', 'CHANGES_REQUESTED'), rv('b', 'COMMENTED')]), 'changes_requested', 'a comment is not a verdict');
});

test('index: by head branch; drafts, forks and junk handled', () => {
  const out = BranchPrs.index({ pulls: [pull(3, 'feat/x', { draft: true }), pull(4, 'fork/x', { head: { ref: 'fork/x', sha: 's', repo: { full_name: 'stranger/widget' } } }),
    pull(5, 'bad', { html_url: 'https://evil.example/acme/widget/pull/5' }), { number: 'x' }, null, pull(6, 'feat/y', { requested_reviewers: [{ login: 'me' }] })] });
  assert.deepEqual(out, {
    'feat/x': { number: 3, url: URL(3), state: 'draft', checks: null, review: 'none' },
    'feat/y': { number: 6, url: URL(6), state: 'open', checks: null, review: 'requested' },
  });
});

test('the poller answers prFor(cwd) from its last poll, with no GitHub call of its own', async () => {
  const raw = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
  const files = { user: 'user.200.txt', 'repos/acme/widget/actions/runs': 'runs.200.txt', 'repos/acme/widget/pulls': 'pulls.200.txt', 'repos/acme/widget/pulls/8/reviews': 'reviews-8.200.txt' };
  const calls = [];
  const runGh = async (args) => { const p = args[args.length - 1]; calls.push(p); return { notFound: false, stdout: raw(files[p] ?? files[p.split('?')[0]]), stderr: '' }; };
  const git = async (cwd, args) => (cwd !== '/work/widget' ? null : args[0] === 'remote' ? 'origin\tgit@github.com:acme/widget.git (fetch)' : 'feat/x');
  const p = G.create({ stateFile: null, runGh, git, now: () => NOW });
  assert.equal(p.prFor('/work/widget'), null, 'nothing known before a poll');
  await p.tick({ sessions: [{ cwd: '/work/widget', signal: 'tool-use' }], config: {} });
  const n = calls.length;
  // The fixture's runs are on another head sha than PR #8, so its checks are unknown.
  assert.deepEqual(p.prFor('/work/widget'), { number: 8, url: URL(8), state: 'open', checks: null, review: 'changes_requested' });
  assert.equal(p.prFor('/elsewhere'), null);
  assert.equal(p.prFor(null), null);
  assert.equal(calls.length, n);
});

test('capture: the open PR goes to My board only, cleared with null; a team hub never gets it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-pr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const R = { hub: 'https://hub.example.test', user_id: 'u', team_id: 't', board_id: 'b', repo_id: 'r', canonical_url: 'github.com/org/app', role: 'member' };
  const calls = [];
  let time = 100000, pr = { number: 8, url: URL(8), state: 'open', checks: 'failing', review: 'requested', extra: 'dropped' };
  const make = (file, repo) => createWorkCapture({ startEnabled: true, file: path.join(dir, file), host: 'mac', now: () => time, resolveRepo: async () => repo,
    getRoutes: async () => ({ routes: [R], complete: true }), prFor: () => pr,
    sendLocal: async (body) => { calls.push(['local', body]); return { ok: true, card: { id: 'c1' } }; },
    sendTeam: async (_d, body) => { calls.push(['team', body]); return { ok: true, card: { id: 'c2' } }; } });
  const ev = (extra = {}) => ({ source: 'codex', sessionId: 's1', host: 'mac', cwd: '/working/app', signal: 'tool-use', updatedAt: new Date(time).toISOString(), ...extra });
  const local = make('local.json', null);
  t.after(() => local.stop());
  await local.observe([ev()]);
  assert.deepEqual(calls.at(-1), ['local', calls.at(-1)[1]]);
  assert.deepEqual(calls.at(-1)[1].pr, { number: 8, url: URL(8), state: 'open', checks: 'failing', review: 'requested' });
  pr = null; time += 1000;
  await local.observe([ev({ updatedAt: new Date(time).toISOString() })]);
  assert.equal(calls.at(-1)[1].pr, null, 'no open PR any more clears it');
  const team = make('team.json', R.canonical_url);
  t.after(() => team.stop());
  pr = { number: 8, url: URL(8), state: 'open' };
  await team.observe([ev({ sessionId: 's2' })]);
  assert.equal(calls.at(-1)[0], 'team');
  assert.ok(!Object.hasOwn(calls.at(-1)[1], 'pr'), 'a team card never carries it');
});

test('prBody: only an open or draft github.com PR with allowlisted facts', () => {
  assert.deepEqual(prBody({ number: 1, url: URL(1), state: 'draft', checks: 'weird', review: 'approved' }), { number: 1, url: URL(1), state: 'draft', checks: null, review: 'approved' });
  assert.equal(prBody({ number: 1, url: URL(1), state: 'merged' }), null);
  assert.equal(prBody({ number: 1, url: 'https://example.com/x', state: 'open' }), null);
  assert.equal(prBody({ number: 0, url: URL(1), state: 'open' }), null);
  assert.equal(prBody(null), null);
});
