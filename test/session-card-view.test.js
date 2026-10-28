// The widget's per-session hover card (src/session-card-view.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/session-card-view.js');

const NOW = Date.parse('2026-10-19T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

test('the title is the project folder name, never the path; the folder line has home as ~ (QoL2)', () => {
  const c = V.sessionCard({ sessionId: 's1', cwd: '/Users/me/work/plexiform', signal: 'tool-use', tool: 'Bash' }, { now: NOW, home: '/Users/me' });
  assert.equal(c.title, 'plexiform');
  assert.equal(c.folder, '~/work/plexiform');
  assert.ok(!JSON.stringify(c).includes('/Users/me'));
  assert.equal(V.sessionCard({ cwd: '/' }, { now: NOW }).title, 'Other work');
});

test('a working session says its tool and how long it has run, in words', () => {
  const c = V.sessionCard({ sessionId: 's1', cwd: '/p/a', signal: 'tool-use', tool: 'Edit', startedAt: ago(75) }, { now: NOW });
  assert.equal(c.state, 'Edit · running for 1 h 15');
  assert.deepEqual(c.actions, ['open', 'finder', 'editor', 'pin']);
});

test('a waiting session says since when and offers Answer', () => {
  const c = V.sessionCard({ sessionId: 's1', cwd: '/p/a', signal: 'permission-ask', tool: 'Bash', updatedAt: ago(7) }, { now: NOW });
  assert.match(c.state, /^Needs you since 7 min/);
  assert.equal(c.waiting, true);
  assert.deepEqual(c.actions, ['open', 'answer', 'finder', 'editor', 'pin']);
  assert.equal(c.waitFor, '7m');
});

test('spend shows when known, with unpriced requests counted', () => {
  assert.equal(V.sessionCard({ sessionId: 's', signal: 'idle' }, { now: NOW, spend: { cost_usd: 1.234, unpriced: 0 } }).spend, '$1.23 this session');
  assert.equal(V.sessionCard({ sessionId: 's', signal: 'idle' }, { now: NOW, spend: { cost_usd: 140, unpriced: 2 } }).spend, '$140 this session (+2 unpriced)');
  assert.equal(V.sessionCard({ sessionId: 's', signal: 'idle' }, { now: NOW }).spend, '');
});

test('a teammate card carries initials and no local actions', () => {
  const c = V.sessionCard({ cwd: 'repo', signal: 'tool-use', tool: 'codex' }, { now: NOW, teammate: { name: 'Ann Lee' } });
  assert.deepEqual(c.teammate, { name: 'Ann Lee', initials: 'AL' });
  assert.deepEqual(c.actions, []);
  assert.equal(V.initials('zoe'), 'ZO');
  assert.equal(V.initials(''), '?');
});

test('pinned sessions offer Unpin; remote ones cannot be opened here', () => {
  assert.deepEqual(V.sessionCard({ sessionId: 's', signal: 'idle', pinned: true }, { now: NOW }).actions, ['open', 'unpin']);
  const r = V.sessionCard({ sessionId: 'remote:x', signal: 'permission-ask', remote: true, deviceName: 'Laptop' }, { now: NOW });
  assert.deepEqual(r.actions, ['pin']);
  assert.match(r.state, /on Laptop/);
});

test('control and bidi characters are stripped from untrusted text', () => {
  const c = V.sessionCard({ cwd: '/p/evil‮exe\u0007', signal: 'tool-use', tool: 'Ba\u0000sh' }, { now: NOW });
  assert.equal(c.title, 'evilexe');
  assert.match(c.state, /^Bash/);
});

test('words is coarse', () => {
  assert.equal(V.words(30000), 'under a minute');
  assert.equal(V.words(120 * 60000), '2 h');
  assert.equal(V.words(3 * 86400000), '3 days');
  assert.equal(V.words(-1), '');
});

test('the card carries the latest recap, stuck help, the deploy line and a paused-nudges action', () => {
  const c = V.sessionCard({ sessionId: 's1', cwd: '/p/shop', signal: 'stop' }, { now: NOW,
    explain: { recap: { headline: 'What your AI just did in shop', line: 'Changed 2 files.' }, help: [{ label: 'Ask what went wrong', handle: 'abc_DEF-1' }, { label: 'bad', handle: '<x>' }], why: 'A command failed in the last turn.' },
    deploy: { label: 'Vercel', name: 'shop', state: 'failed', summary: 'Build failed' }, nudgesPaused: true });
  assert.deepEqual(c.recap, { headline: 'What your AI just did in shop', line: 'Changed 2 files.' });
  assert.deepEqual(c.help, [{ label: 'Ask what went wrong', handle: 'abc_DEF-1' }]);
  assert.equal(c.helpWhy, 'A command failed in the last turn.');
  assert.equal(c.deploy, 'Vercel · shop: failed: Build failed');
  assert.ok(c.actions.includes('resume-nudges'));
  assert.equal(V.deployLine({ label: 'Netlify', name: 'x', state: 'live' }), 'Netlify · x: live');
  assert.equal(V.deployLine({ state: 'unknown' }), '');
  const mate = V.sessionCard({ sessionId: 's2', cwd: '/p' }, { now: NOW, teammate: { name: 'Ann' }, explain: { recap: { headline: 'h' } }, deploy: { state: 'live' }, nudgesPaused: true });
  assert.equal(mate.recap, null);
  assert.equal(mate.deploy, '');
  assert.ok(!mate.actions.includes('resume-nudges'));
});

test('state words are the bucket headings; a running tool says more than Working on it', () => {
  const state = (signal, extra = {}) => V.sessionCard({ sessionId: 's', signal, ...extra }, { now: NOW }).state;
  assert.equal(state('idle'), 'Idle');
  assert.equal(state('session-end'), 'Idle');
  assert.equal(state('stop'), 'Finished — check it');
  assert.equal(state('turn-failed'), 'Stuck or failed');
  assert.equal(state('prompt-submit'), 'Working on it');
  assert.equal(state('tool-use', { tool: 'Bash' }), 'Bash');
  assert.equal(V.sessionCard({ signal: 'stop' }, { now: NOW }).waiting, true, 'the widget still treats a stopped turn as your turn');
});
