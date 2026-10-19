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
