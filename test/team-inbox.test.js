'use strict';
// Team depth lane B: hub inbox rows folded into Home's Inbox and the badge
// (plan acceptance B4) and the notification throttle (B5).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTeamInbox, notifyPolicy, notification, splitKey, NOTIFY_EVERY_MS } = require('../src/team-inbox.js');

const NOW = Date.UTC(2026, 9, 19, 12);
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const HUB = 'https://hub.example:8443';
const hubItems = [
  { id: 'i1', org_id: 'o', kind: 'mention', ref: { card_id: 'c1', by: 'm-ana', by_name: 'Ana', title: 'Fix login' }, created_at: iso(5), read_at: null },
  { id: 'i2', org_id: 'o', kind: 'handoff_request', ref: { card_id: 'c2', by_name: 'Ben', title: 'Retries', handoff_id: 'h1' }, created_at: iso(2), read_at: null },
  { id: 'i3', org_id: 'o', kind: 'moment', ref: { moment_id: 'm1', by_name: 'Cy', label: 'Checkout live', team: 'Core' }, created_at: iso(40), read_at: null },
  { id: 'i0', org_id: 'o', kind: 'reply', ref: { by_name: 'Ana' }, created_at: iso(90), read_at: iso(80) },
];
const local = [{ kind: 'approval', title: 'Allow git push?', key: 'needs:0' }, { kind: 'blocker', title: 'Stuck', key: 'stuck:1' }];

test('B4: three unread hub rows plus two local rows → unread 3, badge total 5; a row seen twice stays one row', () => {
  const inbox = createTeamInbox({ now: () => NOW });
  const fresh = inbox.ingest(HUB, hubItems);
  assert.deepEqual(fresh.map((r) => r.id), ['i1', 'i2', 'i3'], 'read rows are not fresh');
  assert.equal(inbox.unread(), 3);
  assert.deepEqual(inbox.ingest(HUB, [hubItems[0], hubItems[1]]), [], 'repeated inbox.id is not fresh again');
  assert.equal(inbox.unread(), 3);
  assert.equal(inbox.size(), 4);
  const m = inbox.merge(local);
  assert.equal(m.unread, 3);
  assert.equal(m.total, 5);
  assert.deepEqual(m.items.map((i) => i.kind), ['approval', 'blocker', 'handoff', 'mention', 'moment'], 'local first, then team rows newest first');
  const row = m.items[3];
  assert.equal(row.title, 'Ana mentioned you: Fix login');
  assert.deepEqual(row.action, { kind: 'navigate', destination: 'overview', label: 'Open' });
  assert.deepEqual(row.read, { kind: 'inbox-read', ids: [`${HUB}:i1`] });
  assert.equal(row.key, `team:${HUB}:i1`);
  assert.equal(m.items[2].action.destination, 'sessions', 'hand-offs open the Sessions page');
  assert.equal(m.items[4].meta, 'Core');
  assert.equal(m.items[3].ageMs, 5 * 60_000);
  const other = createTeamInbox();
  other.ingest('https://other.example', [hubItems[0]]);
  other.ingest(HUB, [hubItems[0]]);
  assert.equal(other.unread(), 2, 'the same id on two hubs is two rows');
});

test('markRead marks locally, drops the badge and groups ids per hub for the POST; unknown keys are ignored', () => {
  const inbox = createTeamInbox({ now: () => NOW });
  inbox.ingest(HUB, hubItems);
  inbox.ingest('https://b.example', [{ id: 'i1', kind: 'reply', ref: {}, created_at: iso(1) }]);
  assert.equal(inbox.unread(), 4);
  const groups = inbox.markRead([`${HUB}:i1`, `${HUB}:i3`, 'https://b.example:i1', `${HUB}:nope`, 42]);
  assert.deepEqual(groups, [{ origin: HUB, ids: ['i1', 'i3'] }, { origin: 'https://b.example', ids: ['i1'] }]);
  assert.equal(inbox.unread(), 1);
  assert.deepEqual(inbox.ingest(HUB, [hubItems[0]]), [], 'a re-poll of a row read here keeps it read');
  assert.equal(inbox.unread(), 1);
  assert.deepEqual(splitKey(`${HUB}:i1`), { origin: HUB, id: 'i1' });
  assert.equal(splitKey('nocolon'), null);
});

test('B5: two mentions 10 s apart on one hub raise one notification; a hand-off request on another hub raises its own; replies and moments never do', () => {
  const inbox = createTeamInbox({ now: () => NOW });
  const a = inbox.ingest(HUB, [hubItems[0]]);
  assert.deepEqual(inbox.toNotify(a, NOW), [{ title: 'A teammate mentioned you', body: 'Ana mentioned you: Fix login', silent: true }]);
  const b = inbox.ingest(HUB, [{ ...hubItems[0], id: 'i9', created_at: iso(0) }]);
  assert.deepEqual(inbox.toNotify(b, NOW + 10_000), [], 'throttled within 30 s');
  const c = inbox.ingest('https://other.example', [hubItems[1]]);
  assert.equal(inbox.toNotify(c, NOW + 10_000).length, 1, 'the throttle is per hub');
  assert.equal(inbox.toNotify(c, NOW + 10_000)[0]?.title, undefined, 'already notified for this hub within 30 s');
  const d = inbox.ingest(HUB, [{ ...hubItems[0], id: 'i10', created_at: iso(0) }]);
  assert.equal(inbox.toNotify(d, NOW + NOTIFY_EVERY_MS).length, 1, 'after 30 s the next mention notifies');
  const quiet = inbox.ingest(HUB, [hubItems[2], { ...hubItems[3], id: 'i11', read_at: null }]);
  assert.deepEqual(inbox.toNotify(quiet, NOW + 120_000), []);
  assert.equal(notifyPolicy({ kind: 'mention' }, null, NOW), true);
  assert.equal(notifyPolicy({ kind: 'mention', read_at: iso(1) }, null, NOW), false);
  assert.equal(notifyPolicy({ kind: 'handoff_request' }, NOW - 29_000, NOW), false);
  assert.equal(notifyPolicy({ kind: 'handoff_request' }, NOW - 30_000, NOW), true);
  assert.equal(notifyPolicy({ kind: 'input_answered' }, null, NOW), false);
  assert.equal(notification({ kind: 'handoff_request', ref: { by_name: 'Ben' } }).title, 'A card was handed to you');
});

test('ingest validates: no origin, unknown kinds, missing ids and non-arrays are ignored; the store is capped', () => {
  const inbox = createTeamInbox({ now: () => NOW });
  assert.deepEqual(inbox.ingest('', hubItems), []);
  assert.deepEqual(inbox.ingest(HUB, 'nope'), []);
  assert.deepEqual(inbox.ingest(HUB, [{ id: 'x', kind: 'spam' }, { kind: 'mention' }, null]), []);
  assert.equal(inbox.unread(), 0);
  inbox.ingest(HUB, Array.from({ length: 250 }, (_, i) => ({ id: `r${i}`, kind: 'reply', ref: {}, created_at: iso(i) })));
  assert.equal(inbox.size(), 200);
  assert.deepEqual(inbox.merge().items.length, 200);
  assert.equal(inbox.merge().total, 200);
});
