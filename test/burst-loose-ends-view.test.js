'use strict';

// B3 (pure): the loose-ends view model from Burst's raw /api/loose-ends answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const LE = require('../src/burst-loose-ends-view.js');
const FIXTURE = require('./fixtures/burst-0.20.36.json');

const AT = 1_792_401_162; // the fixture's report.at (unix seconds)
const H = 3600;
// The shape claude-burst internal/looseends writes (Report → Repo); the fixture's own run had nothing loose (repos: null).
const raw = (repos, extra = {}) => ({ report: { at: AT, scanned: 4, repos }, stale: { commits: 0, files: 0, stashes: 0 }, stale_hours: 24, within_days: 30, ...extra });
const repo = (root, over = {}) => ({ root, branch: 'main', upstream: 'origin/main', uncommitted: [], unpushed: [], stashes: [], ...over });

test('fixture: the real v0.20.36 answer with nothing loose gives an empty map, not null', () => {
  const v = LE.looseEndsView(FIXTURE['/api/loose-ends']);
  assert.ok(v);
  assert.equal(v.byRepo.size, 0);
  assert.deepEqual(v.totals, { repos: 0, uncommitted: 0, unpushed: 0, stashes: 0 });
  assert.equal(v.scanned, 4);
  assert.equal(v.staleHours, 24);
  assert.equal(v.at, AT * 1000);
  assert.equal(LE.summaryText(v), '');
});

test('repos keyed by root with counts; ahead beats the newest-few unpushed list; empty repos are left out', () => {
  const v = LE.looseEndsView(raw([
    repo('/Users/me/app/', { uncommitted: [{ path: '/Users/me/app/a.js', status: ' M', mtime: AT - H }, { path: '/Users/me/app/b.js', status: '??', mtime: AT - 2 * H }], unpushed: [{ hash: 'abc', when: AT - H, subject: 'x' }], ahead: 3, stashes: [{ ref: 'stash@{0}', when: AT - H, subject: 'wip' }] }),
    repo('/Users/me/docs', { stashes: [{ ref: 'stash@{0}', when: AT - 30 * H, subject: 'old' }] }),
    repo('/Users/me/clean'),
    { root: '', uncommitted: [{ path: 'x' }] },
    null,
  ]));
  assert.deepEqual([...v.byRepo.keys()], ['/Users/me/app', '/Users/me/docs']);
  const app = v.byRepo.get('/Users/me/app');
  assert.equal(app.uncommitted, 2);
  assert.equal(app.unpushed, 3, 'ahead counts every unpushed commit');
  assert.equal(app.stashes, 1);
  assert.equal(app.stale, false);
  assert.equal(app.branch, 'main');
  assert.equal(v.byRepo.get('/Users/me/docs').stale, true, 'a 30 h old stash is past the 24 h stale line');
  assert.deepEqual(v.totals, { repos: 2, uncommitted: 2, unpushed: 3, stashes: 2 });
  assert.equal(LE.summaryText(v), '2 uncommitted files, 3 unpushed commits, 2 stashes in 2 repositories.');
});

test('badgeText: "n uncommitted · n unpushed · n stashes", zero parts dropped, singular stash', () => {
  assert.equal(LE.badgeText({ uncommitted: 2, unpushed: 1, stashes: 1 }), '2 uncommitted · 1 unpushed · 1 stash');
  assert.equal(LE.badgeText({ uncommitted: 0, unpushed: 4, stashes: 2 }), '4 unpushed · 2 stashes');
  assert.equal(LE.badgeText({ uncommitted: 0, unpushed: 0, stashes: 0 }), '');
  assert.equal(LE.badgeText(null), '');
});

test('forPath: a session cwd matches the longest repository root that contains it, never a sibling with a shared prefix', () => {
  const v = LE.looseEndsView(raw([repo('/Users/me/app', { uncommitted: [{ path: 'a', mtime: AT }] }), repo('/Users/me/app/packages/web', { stashes: [{ when: AT }] }), repo('/Users/me/apple', { uncommitted: [{ path: 'b', mtime: AT }] })]));
  assert.equal(LE.forPath(v, '/Users/me/app/src').root, '/Users/me/app');
  assert.equal(LE.forPath(v, '/Users/me/app/packages/web/src/').root, '/Users/me/app/packages/web');
  assert.equal(LE.forPath(v, '/Users/me/app').root, '/Users/me/app');
  assert.equal(LE.forPath(v, '/Users/me/applesauce'), null);
  assert.equal(LE.forPath(v, ''), null);
  assert.equal(LE.forPath(null, '/Users/me/app'), null);
});

test('anything that is not a report is null, so callers hide the section instead of showing zeros', () => {
  for (const bad of [null, undefined, 'x', 12, [], {}, { report: null }, { report: 'nope' }]) assert.equal(LE.looseEndsView(bad), null);
  const v = LE.looseEndsView({ report: { repos: [repo('/r', { uncommitted: [{ path: 'a' }] })] } }, { now: () => 5_000 });
  assert.equal(v.at, 5_000, 'no report time: now');
  assert.equal(v.staleHours, LE.DEFAULT_STALE_HOURS);
  assert.equal(v.byRepo.get('/r').stale, false, 'a file with no mtime is never called stale');
});

// Verifier fix 1: BurstIpc.looseEndsView() feeds the client's normalized answer (counts per repo, `path`
// not `root`) into this view; it used to expect only the raw report and answered null, so the Overview
// badges and the Home loose-ends line never showed.
test('the client normalizer\'s shape (counts, path) is accepted as well as the raw report', () => {
  const { normalizeLooseEnds } = require('../src/burst-client.js');
  const withRepos = { ...FIXTURE['/api/loose-ends'], report: { ...FIXTURE['/api/loose-ends'].report, repos: [
    repo('/Users/me/app', { uncommitted: [{ path: '/Users/me/app/a.js', mtime: AT - H }], unpushed: [{ hash: 'x', when: AT - H }], ahead: 2, stashes: [{ ref: 'stash@{0}', when: AT, subject: 'wip' }] }),
    repo('/Users/me/clean'),
  ] } };
  const n = normalizeLooseEnds(withRepos);
  assert.equal(n.kind, 'ok');
  const v = LE.looseEndsView(n, { now: () => AT * 1000 });
  assert.ok(v, 'normalized shape is a report too');
  assert.deepEqual([...v.byRepo.keys()], ['/Users/me/app']);
  assert.deepEqual(v.byRepo.get('/Users/me/app'), { uncommitted: 1, unpushed: 2, stashes: 1, branch: 'main', noRemote: false, stale: false });
  assert.deepEqual(v.totals, { repos: 1, uncommitted: 1, unpushed: 2, stashes: 1 });
  assert.equal(v.staleHours, 24);
  assert.equal(v.scanned, 4);
  assert.equal(LE.badgeText(v.byRepo.get('/Users/me/app')), '1 uncommitted · 2 unpushed · 1 stash');
  // Same counts either way in.
  const r = LE.looseEndsView(withRepos).byRepo.get('/Users/me/app'), c = v.byRepo.get('/Users/me/app');
  assert.deepEqual([r.uncommitted, r.unpushed, r.stashes], [c.uncommitted, c.unpushed, c.stashes]);
  assert.equal(LE.looseEndsView({ kind: 'unsupported' }), null);
});

test('BurstIpc.looseEndsView(): client normalizer → view, byRepo has the repo with its counts', async () => {
  const Ipc = require('../src/burst-ipc.js');
  const { normalizeLooseEnds } = require('../src/burst-client.js');
  const raw = { ...FIXTURE['/api/loose-ends'], report: { ...FIXTURE['/api/loose-ends'].report, repos: [repo('/Users/me/app', { uncommitted: [{ path: '/Users/me/app/a.js', mtime: AT }], ahead: 1 })] } };
  const detect = { kind: 'present', installed: true, pid: 1, upgrade: null, capabilities: { looseEnds: true }, state: { version: '0.20.36', mode: 'base-url', active: true, route: 'PRIMARY', rejected: [], primaryFailures: 0, compaction: { pauseless: null, sessions: [], active: false }, contextFill: [] } };
  const client = { detect: async () => detect, adminUrl: () => 'http://127.0.0.1:7788', looseEnds: async () => normalizeLooseEnds(raw), requests: async () => [] };
  const api = Ipc.register({ utilityHandle: () => {}, settingsOnly: () => true, isMac: true, client, dialog: {}, shell: {}, scriptDir: '/x', log: () => {} });
  await api.refresh(true);
  assert.equal(api.looseEndsView(), null, 'first call warms the cache in the background');
  await new Promise((r) => setTimeout(r, 10));
  const v = api.looseEndsView();
  assert.ok(v && v.byRepo instanceof Map, 'a view, not null');
  assert.deepEqual([...v.byRepo.entries()].map(([k, c]) => [k, c.uncommitted, c.unpushed, c.stashes]), [['/Users/me/app', 1, 1, 0]]);
  assert.equal(v.totals.repos, 1);
});

test('normalized repos carry `oldest` (seconds) so the stale badge works on the client shape', () => {
  const { looseEndsView } = require('../src/burst-loose-ends-view.js');
  const now = 1_800_000_000_000; // ms
  const old = { kind: 'ok', staleHours: 24, repos: [{ path: '/r/old', uncommitted: 2, unpushed: 0, stashes: 0, oldest: now / 1000 - 48 * 3600 }, { path: '/r/new', uncommitted: 1, unpushed: 0, stashes: 0, oldest: now / 1000 - 3600 }, { path: '/r/none', uncommitted: 1, unpushed: 0, stashes: 0, oldest: null }] };
  const v = looseEndsView(old, { now: () => now });
  assert.equal(v.byRepo.get('/r/old').stale, true);
  assert.equal(v.byRepo.get('/r/new').stale, false);
  assert.equal(v.byRepo.get('/r/none').stale, false);
});
