const test = require('node:test');
const assert = require('node:assert/strict');
const { compose, MAX } = require('../src/attention-inbox.js');

const now = Date.UTC(2026, 9, 18, 12);
const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();

test('inbox: five kinds merge, ordered by severity then age, each with one action', () => {
  const r = compose({
    needs: { items: [{ headline: 'Allow git push?', kind: 'permission', project: 'app', age: '2 min', late: false }] },
    alerts: { stuck: [{ handle: 's1', title: 'Stuck: app silent for 12 min', meta: 'Codex', canOpen: true }], limits: [], mail: [] },
    morning: { items: [{ title: 'Nightly tests', state: 'failed', summary: 'exit 1' }] },
    teamToday: { changes: { items: [{ kind: 'handoff', text: 'Ana handed "Fix login" to the team', repo: 'app', team: 'Core', at: iso(30) }, { kind: 'review', text: 'Ben\'s "Retries" is ready for review', repo: 'app', team: 'Core', at: iso(5) }] }, people: { items: [] } },
    now,
  });
  assert.deepEqual(r.items.map(i => i.kind), ['approval', 'blocker', 'failed', 'handoff', 'review']);
  assert.equal(r.items[0].action.destination, 'waiting');
  assert.deepEqual(r.items[1].action, { kind: 'alert', alert: 'stuck', op: 'open', handle: 's1', label: 'Open session' });
  assert.equal(r.total, 5);
  assert.equal(r.label('handoff'), 'Handoff');
});

test('inbox: older rows of the same severity come first; followed-session events and waiting teammates appear as questions', () => {
  const r = compose({
    teamToday: { changes: { items: [] }, people: { items: [{ author: 'Ana', title: 'Fix login', status: 'Waiting', repo: 'app', branch: 'fix', updated_at: iso(3) }] } },
    follow: [{ key: 'k', transition: 'attention', at: now - 40 * 60_000, title: 'Retries', owner: 'Ben' }, { key: 'k2', transition: 'finished', at: now - 60_000, title: 'Docs', owner: 'Cy' }],
    now,
  });
  assert.deepEqual(r.items.map(i => i.title), ['Ben\'s "Retries" needs input', 'Ana\'s "Fix login" is waiting', 'Cy\'s "Docs" finished']);
  assert.equal(r.items[0].action.destination, 'overview');
});

test('inbox: nothing is invented when parts are missing, and the list is capped', () => {
  assert.deepEqual(compose({}).items, []);
  const many = compose({ needs: { items: Array.from({ length: 50 }, (_, i) => ({ headline: `Q${i}`, kind: 'question', project: 'p' })) } });
  assert.equal(many.items.length, MAX);
  assert.equal(many.total, 50);
});

test('inbox: quick decision options and the request id pass through, validated and capped at four; the Answer fallback stays', () => {
  const options = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
  const r = compose({ needs: { items: [
    { id: 'req-1', headline: 'Allow git push?', kind: 'permission', options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }, { id: 'x'.repeat(101), label: 'too long id' }, { id: 'bad', label: 'L'.repeat(41) }, { id: 'noLabel' }, null] },
    { id: 'req-2', headline: 'Pick one', kind: 'question', options },
    { headline: 'No id', kind: 'question', options: [{ id: 'yes', label: 'Yes' }] },
    { id: 'req-4', headline: 'No options', kind: 'question' },
  ] } });
  assert.deepEqual(r.items[0].options, [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }]);
  assert.equal(r.items[0].requestId, 'req-1');
  assert.deepEqual(r.items[0].action, { kind: 'navigate', destination: 'waiting', label: 'Answer' });
  assert.equal(r.items[1].options.length, 4);
  assert.deepEqual(r.items[2].options, [], 'no request id: nothing to answer');
  assert.deepEqual(r.items[3].options, []);
});

test('inbox: hub inbox rows (mention, reply, moment, handoff) merge with their Open and Mark read actions; malformed rows are dropped', () => {
  const team = [
    { kind: 'mention', title: 'Ana mentioned you: Fix login', meta: 'Core', ageMs: 5 * 60_000, action: { kind: 'navigate', destination: 'overview', label: 'Open' }, read: { kind: 'inbox-read', ids: ['https://hub:i1'] }, key: 'team:https://hub:i1' },
    { kind: 'handoff', title: 'Ben handed you a card: Retries', meta: 'Core', ageMs: 60_000, action: { kind: 'navigate', destination: 'sessions', label: 'Open' }, read: { kind: 'inbox-read', ids: ['https://hub:i2'] }, key: 'team:https://hub:i2' },
    { kind: 'moment', title: 'Cy marked a moment', meta: '', ageMs: 40 * 60_000, action: { kind: 'navigate', destination: 'elsewhere' }, read: { kind: 'inbox-read', ids: ['https://hub:i3'] }, key: 'team:https://hub:i3' },
    { kind: 'reply', title: 'Ana replied to you', ageMs: null, action: {}, read: { kind: 'inbox-read', ids: ['https://hub:i4'] }, key: 'team:https://hub:i4' },
    { kind: 'spam', title: 'x', read: { kind: 'inbox-read', ids: ['k'] }, key: 'team:x' },
    { kind: 'mention', title: 'no key', read: { kind: 'inbox-read', ids: ['k'] } },
    { kind: 'mention', title: 'no read ids', key: 'team:y' },
    null,
  ];
  const r = compose({ needs: { items: [{ headline: 'Allow git push?', kind: 'permission' }] }, team, now });
  assert.deepEqual(r.items.map(i => i.kind), ['approval', 'mention', 'handoff', 'reply', 'moment'], 'same severity: older first');
  assert.deepEqual(r.items[1].action, { kind: 'navigate', destination: 'overview', label: 'Open' });
  assert.deepEqual(r.items[1].read, { kind: 'inbox-read', ids: ['https://hub:i1'] });
  assert.equal(r.items[2].action.destination, 'sessions');
  assert.equal(r.items[4].action.destination, 'overview', 'an unknown destination falls back to Overview');
  assert.equal(r.items[3].ageMs, null);
  assert.equal(r.total, 5);
  assert.deepEqual([r.label('mention'), r.label('reply'), r.label('moment')], ['Mention', 'Reply', 'Moment']);
});
