'use strict';
// Team file heat map (src/team-heatmap.js) and auto standup (src/team-standup.js):
// both pure, both from the activity records the desktop already reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const { heatmap } = require('../src/team-heatmap.js');
const { standup, toText } = require('../src/team-standup.js');

const NOW = Date.parse('2026-10-19T09:00:00Z');
const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const rec = (author, extra = {}) => ({ record_id: `i:claude:${author}-${extra.title || 't'}`, author, title: 'Task', status: 'ended', files: { edited: [], read: [] }, updated_at: iso(NOW - H), ...extra });

test('heat map: counts per folder and file, active sessions weigh double, two people on one file are flagged', () => {
  const h = heatmap([
    rec('Bob', { status: 'working', files: { edited: ['src/auth/login.js', 'src/auth/token.js'], read: ['README.md'] } }),
    rec('Carol', { files: { edited: ['src/auth/login.js'], read: [] } }),
    rec('Dan', { files: { edited: ['docs/a.md'], read: [] }, updated_at: iso(NOW - 3 * 24 * H) }),
  ], { window: '24h', now: NOW });
  assert.equal(h.total, 2, 'read files and files outside the window are left out');
  assert.deepEqual(h.files[0], { path: 'src/auth/login.js', count: 2, weight: 3, active: true, people: ['Bob', 'Carol'], shared: true });
  assert.deepEqual(h.shared, ['src/auth/login.js']);
  assert.equal(h.dirs.length, 1);
  assert.equal(h.dirs[0].path, 'src/auth');
  assert.equal(h.dirs[0].count, 3);
  assert.deepEqual(h.dirs[0].files.map((f) => f.name), ['login.js', 'token.js']);
  const week = heatmap([rec('Dan', { files: { edited: ['docs/a.md', 'top.md'], read: [] }, updated_at: iso(NOW - 3 * 24 * H) })], { window: '7d', now: NOW });
  assert.deepEqual(week.dirs.map((d) => d.path).sort(), ['.', 'docs']);
  assert.equal(heatmap(null).total, 0);
});

test('standup: yesterday, today and blocked per teammate in plain words', () => {
  const rows = standup([
    rec('Bob', { title: 'Session refresh', status: 'working', files: { edited: ['src/auth/login.js'], read: [] } }),
    rec('Bob', { title: 'Fix CI', status: 'ended', handover: true, updated_at: iso(NOW - 20 * H) }),
    rec('Carol', { title: 'Upgrade deps', status: 'waiting', files: { edited: ['src/auth/login.js'], read: [] } }),
    rec('Dan', { title: 'Flaky test', status: 'idle', handoff_requested: true }),
    rec('Eve', { title: 'Billing', status: 'paused_limit' }),
    rec('Old', { title: 'Ancient', status: 'ended', updated_at: iso(NOW - 5 * 24 * H) }),
  ], { now: NOW });
  const by = Object.fromEntries(rows.map((r) => [r.author, r]));
  assert.deepEqual(by.Bob.yesterday, ['Finished "Fix CI" and left a handover']);
  assert.deepEqual(by.Bob.today, ['Working on "Session refresh"']);
  assert.deepEqual(by.Bob.blocked, ['Editing src/auth/login.js alongside someone else']);
  assert.deepEqual(by.Carol.blocked, ['"Upgrade deps" is waiting for an answer', 'Editing src/auth/login.js alongside someone else']);
  assert.deepEqual(by.Dan.yesterday, ['Handed "Flaky test" to the team']);
  assert.deepEqual(by.Eve.blocked, ['"Billing" is paused at a usage limit']);
  assert.equal(by.Old, undefined, 'nothing recent, nothing to say');
  const text = toText(rows);
  assert.match(text, /^Bob\n {2}Yesterday: Finished "Fix CI" and left a handover\n {2}Today: Working on "Session refresh"\n {2}Blocked: Editing src\/auth\/login\.js alongside someone else/m);
  assert.match(text, /Dan\n {2}Yesterday: Handed "Flaky test" to the team\n {2}Today: nothing shared\n {2}Blocked: nothing/);
  assert.equal(toText([]), 'Standup: nothing shared by the team in the last two days.');
});

test('standup: hub collision events mark both people blocked', () => {
  const rows = standup([rec('A', { record_id: 'r1', status: 'working' }), rec('B', { record_id: 'r2', status: 'working' })], { collisions: [{ path: 'x.js', records: ['r1', 'r2'] }], now: NOW });
  assert.deepEqual(rows.map((r) => r.blocked), [['Editing x.js alongside someone else'], ['Editing x.js alongside someone else']]);
});
