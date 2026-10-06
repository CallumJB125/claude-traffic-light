const { test } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/quiet.js');

// Local-time instants (the module reads local clock parts): 2026-10-05 is a Monday.
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime();
const MON = 5, TUE = 6, FRI = 9, SAT = 10;
const night = { enabled: true, start: '22:00', end: '07:00', days: [1, 2, 3, 4, 5] };

test('snooze ends: 15 min, 1 h, and 08:00 tomorrow', () => {
  const now = at(MON, 21, 30);
  assert.equal(Q.snoozeEnd('15m', now), now + 15 * 60000);
  assert.equal(Q.snoozeEnd('1h', now), now + 3600000);
  assert.equal(Q.snoozeEnd('tomorrow', now), at(TUE, 8));
  assert.equal(Q.snoozeEnd('tomorrow', at(MON, 1)), at(TUE, 8));
  assert.equal(Q.snoozeEnd('nope', now), null);
});

test('an active snooze holds pings and expires on the clock', () => {
  const cfg = { snoozeUntil: at(MON, 12, 15) };
  assert.equal(Q.reason(cfg, { now: at(MON, 12, 0) }), 'snooze');
  assert.equal(Q.reason(cfg, { now: at(MON, 12, 15) }), null);
  assert.equal(Q.reason({ snoozeUntil: 0 }, { now: at(MON, 12) }), null);
  assert.equal(Q.snoozeLabel(at(MON, 12, 15), at(MON, 12, 0)), 'Snoozed for 15 more min');
  assert.equal(Q.snoozeLabel(at(TUE, 8), at(MON, 12, 0)), 'Snoozed until 08:00');
  assert.equal(Q.snoozeLabel(at(MON, 11), at(MON, 12)), null);
});

test('quiet hours wrap midnight and follow the day the night starts on', () => {
  assert.equal(Q.inQuietHours(night, at(MON, 23)), true);
  assert.equal(Q.inQuietHours(night, at(TUE, 6, 59)), true);
  assert.equal(Q.inQuietHours(night, at(TUE, 7)), false);
  assert.equal(Q.inQuietHours(night, at(MON, 21, 59)), false);
  // Friday night runs into Saturday morning; Saturday night does not start one.
  assert.equal(Q.inQuietHours(night, at(SAT, 3)), true);
  assert.equal(Q.inQuietHours(night, at(SAT, 23)), false);
  assert.equal(Q.inQuietHours(night, at(SAT + 1, 3)), false);
});

test('a same-day window and the off switches', () => {
  const lunch = { enabled: true, start: '12:00', end: '13:00', days: [1] };
  assert.equal(Q.inQuietHours(lunch, at(MON, 12, 30)), true);
  assert.equal(Q.inQuietHours(lunch, at(TUE, 12, 30)), false);
  assert.equal(Q.inQuietHours({ ...lunch, enabled: false }, at(MON, 12, 30)), false);
  assert.equal(Q.inQuietHours({ ...lunch, end: '12:00' }, at(MON, 12, 30)), false);
  assert.equal(Q.inQuietHours({ enabled: true, start: 'x', end: '25:00' }, at(MON, 23)), true, 'bad times fall back to 22:00-07:00');
  assert.equal(Q.inQuietHours(null, at(MON, 23)), false);
});

test('project mute matches a folder path prefix or a folder name', () => {
  const list = ['/Users/me/work/api', 'plexiform'];
  assert.equal(Q.projectMuted(list, '/Users/me/work/api'), true);
  assert.equal(Q.projectMuted(list, '/Users/me/work/api/src'), true);
  assert.equal(Q.projectMuted(list, '/Users/me/work/api-v2'), false);
  assert.equal(Q.projectMuted(list, '/Users/me/dev/plexiform-f1'), false);
  assert.equal(Q.projectMuted(list, '/Users/me/dev/plexiform'), true);
  assert.equal(Q.projectMuted(list, null), false);
  assert.equal(Q.projectMuted(undefined, '/x'), false);
});

test('reason orders project, snooze, quiet hours; and only cwd-less pings ignore mutes', () => {
  const cfg = { mutedProjects: ['api'], snoozeUntil: at(MON, 23, 30), quietHours: night };
  const now = at(MON, 23);
  assert.equal(Q.reason(cfg, { now, cwd: '/w/api' }), 'project');
  assert.equal(Q.reason(cfg, { now, cwd: '/w/web' }), 'snooze');
  assert.equal(Q.reason(cfg, { now }), 'snooze');
  assert.equal(Q.reason({ ...cfg, snoozeUntil: 0 }, { now, cwd: '/w/web' }), 'quiet-hours');
  assert.equal(Q.reason({}, { now, cwd: '/w/web' }), null);
});

test('allMuted: the alert sound is held only when every live session is muted', () => {
  const cfg = { mutedProjects: ['api'] };
  assert.equal(Q.allMuted(cfg, [{ cwd: '/w/api' }, { cwd: '/w/api/x' }]), true);
  assert.equal(Q.allMuted(cfg, [{ cwd: '/w/api' }, { cwd: '/w/web' }]), false);
  assert.equal(Q.allMuted(cfg, []), false);
});

test('only a held needs-input ask earns the silent badge', () => {
  assert.equal(Q.badgeFor('quiet-hours', 'permission-ask'), true);
  assert.equal(Q.badgeFor('snooze', 'permission-ask'), true);
  assert.equal(Q.badgeFor('quiet-hours', 'turn-failed'), false);
  assert.equal(Q.badgeFor(null, 'permission-ask'), false);
});
