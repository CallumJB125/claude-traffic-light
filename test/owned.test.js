// Buddy-owned sessions (hooks/owned.js): an env var only counts against a
// record Buddy wrote at launch; one claim per launch; the claim window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../hooks/owned.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-owned-'));

test('a launch record is 0600 in a 0700 dir and yields BUDDY_OWNED', () => {
  const root = tmp();
  const { launchId, env, record } = O.recordLaunch(root, { launcher: 'board', cwd: '/wt', tmux: { pane: '%3', socket: '/tmp/s' } });
  assert.match(launchId, O.LAUNCH_ID_RE);
  assert.deepEqual(env, { BUDDY_OWNED: launchId });
  assert.deepEqual(record.tmux, { pane: '%3', socket: '/tmp/s', serverPid: null });
  assert.equal(fs.statSync(O.dirOf(root)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(O.dirOf(root), `${launchId}.json`)).mode & 0o777, 0o600);
  assert.throws(() => O.recordLaunch(root, { cwd: 'relative' }));
});

test('claim: first session wins; same process (/clear) or same session (resume) keep it', () => {
  const root = tmp();
  const { launchId } = O.recordLaunch(root, { cwd: '/wt' });
  assert.equal(O.checkOwned(root, launchId, { sessionId: 's1', claudePid: 100, cwd: '/wt/sub' }).owned, true);
  assert.equal(O.checkOwned(root, launchId, { sessionId: 's2', claudePid: 100, cwd: '/wt' }).owned, true, '/clear: new session id, same process');
  assert.equal(O.checkOwned(root, launchId, { sessionId: 's1', claudePid: 200, cwd: '/wt' }).owned, true, 'resume: same session id');
  assert.deepEqual(O.checkOwned(root, launchId, { sessionId: 's3', claudePid: 300, cwd: '/wt' }), { owned: false, reason: 'claimed by another session' });
});

test('refused: bad ids, unknown ids, other folders, expired windows, tampered records', () => {
  const root = tmp();
  const now = Date.now();
  const { launchId } = O.recordLaunch(root, { cwd: '/wt', now });
  const q = { sessionId: 's', claudePid: 1, cwd: '/wt' };
  assert.equal(O.checkOwned(root, '../x', q).owned, false);
  assert.equal(O.checkOwned(root, 'y'.repeat(24), q).reason, 'no launch record');
  assert.equal(O.checkOwned(root, launchId, { ...q, cwd: '/wtx' }).reason, 'cwd outside the launch folder');
  assert.equal(O.checkOwned(root, launchId, { ...q, now: now + O.CLAIM_WINDOW_MS + 1 }).reason, 'launch record expired');
  const file = path.join(O.dirOf(root), `${launchId}.json`);
  fs.chmodSync(file, 0o666);
  assert.equal(O.checkOwned(root, launchId, q).reason, 'no launch record', 'a world-writable record is not trusted');
});

test('unclaimed launches are listed until claimed or expired', () => {
  const root = tmp();
  const now = Date.now();
  const a = O.recordLaunch(root, { cwd: '/a', tmux: { pane: '%1' }, now });
  const b = O.recordLaunch(root, { cwd: '/b', now });
  assert.deepEqual(O.unclaimedLaunches(root, { now }).map((r) => r.launchId).sort(), [a.launchId, b.launchId].sort());
  O.checkOwned(root, a.launchId, { sessionId: 's', cwd: '/a', now });
  assert.deepEqual(O.unclaimedLaunches(root, { now }).map((r) => r.launchId), [b.launchId]);
  assert.deepEqual(O.unclaimedLaunches(root, { now: now + O.CLAIM_WINDOW_MS + 1 }), []);
});
