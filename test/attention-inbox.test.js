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
