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
    { id: 'req-1', headline: 'Allow git push?', kind: 'permission', action: 'answer', options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }, { id: 'x'.repeat(101), label: 'too long id' }, { id: 'bad', label: 'L'.repeat(41) }, { id: 'noLabel' }, null] },
    { id: 'req-2', headline: 'Pick one', kind: 'question', options },
    { headline: 'No id', kind: 'question', options: [{ id: 'yes', label: 'Yes' }] },
    { id: 'req-4', headline: 'No options', kind: 'question' },
  ] } });
  assert.deepEqual(r.items[0].options, [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }]);
  assert.equal(r.items[0].requestId, 'req-1');
  assert.deepEqual(r.items[0].action, { kind: 'navigate', destination: 'waiting', label: 'Answer' });
  assert.equal(r.items[3].action.label, 'Open', 'not answerable here: Open, never Answer');
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

// B2: exactly one Burst card, only when Burst names a next step, loose ends are reported, or a limit is near.
test('inbox: one Burst card when statusView has an action, with that action as its one button; none when healthy', () => {
  const view = (over = {}) => ({ kind: 'on', headline: 'Claude Burst', detail: 'On, base-url mode, version 0.20.36. Route: primary.', chip: { tone: 'green', label: 'Primary' }, action: null, dimmed: false, ...over });
  assert.deepEqual(compose({ alerts: { burst: { view: view(), looseEnds: null } }, now }).items, [], 'healthy: nothing');
  assert.deepEqual(compose({ alerts: { burst: null }, now }).items, [], 'no Burst on this computer: nothing');
  const update = compose({ alerts: { burst: { view: view({ action: { kind: 'update', label: 'Update' }, detail: 'An update is ready.', attention: true }), looseEnds: null } }, now });
  assert.equal(update.items.length, 1);
  assert.deepEqual(update.items[0], { kind: 'burst', title: 'Claude Burst', meta: 'An update is ready.', ageMs: null, dimmed: false, action: { kind: 'burst', op: 'update', label: 'Update' }, key: 'burst:update' });
  assert.equal(update.label('burst'), 'Burst');
  // One missed poll (kind off, no attention flag) is never a card, even with an action; three misses (flagged) are, and win over loose ends.
  const blip = compose({ alerts: { burst: { view: view({ kind: 'off', headline: 'Burst is not responding', detail: 'Not responding: Burst is installed but its gateway did not answer just now.', chip: { tone: 'amber', label: 'Not responding' }, action: { kind: 'retry', label: 'Check again' } }), looseEnds: null } }, now });
  assert.deepEqual(blip.items, [], 'a single missed poll is not a card');
  const down = compose({ alerts: { burst: { view: view({ kind: 'off', headline: 'Burst is not responding', detail: 'Not responding: several checks in a row.', chip: { tone: 'amber', label: 'Not responding' }, action: { kind: 'enable', label: 'Turn on' }, attention: true }), looseEnds: { repos: 3, text: 'x' } } }, now });
  assert.equal(down.items.length, 1, 'never two Burst cards: the next step wins over loose ends');
  assert.equal(down.items[0].action.op, 'enable');
});

test('inbox: loose ends alone, or "Limit near" alone, give one Burst card whose button opens Usage & Burst; ordered with blockers', () => {
  const healthy = { kind: 'on', headline: 'Claude Burst', detail: 'On.', chip: { tone: 'green', label: 'Primary' }, action: null };
  const loose = compose({ alerts: { burst: { view: healthy, looseEnds: { repos: 2, uncommitted: 3, unpushed: 1, stashes: 0, text: '3 uncommitted files, 1 unpushed commit in 2 repositories.' } } }, now });
  assert.deepEqual(loose.items.map((i) => [i.title, i.meta, i.action]), [['Loose ends in 2 repositories', '3 uncommitted files, 1 unpushed commit in 2 repositories. Commit or push before closing those sessions.', { kind: 'navigate', destination: 'optimiser', label: 'Open Usage & Burst' }]]);
  const near = compose({ alerts: { burst: { view: { ...healthy, chip: { tone: 'amber', label: 'Limit near' } }, looseEnds: null } }, now });
  assert.equal(near.items[0].title, 'Claude is near its limit');
  assert.equal(near.items[0].action.destination, 'optimiser');
  assert.equal(near.items[0].key, 'burst:limit-near');
  assert.deepEqual(compose({ alerts: { burst: { view: healthy, looseEnds: { repos: 0 } } }, now }).items, [], 'zero repositories is not loose');
  const mixed = compose({
    needs: { items: [{ headline: 'Allow git push?', kind: 'permission' }] },
    alerts: { stuck: [{ handle: 's1', title: 'Stuck', meta: '', canOpen: true }], burst: { view: { ...healthy, kind: 'broken', action: { kind: 'repair', label: 'Repair' } } } },
    morning: { items: [{ title: 'Nightly', state: 'failed', summary: 'exit 1' }] },
    now,
  });
  assert.deepEqual(mixed.items.map((i) => i.kind), ['approval', 'blocker', 'burst', 'failed'], 'a Burst that needs a hand sits with the blockers, after approvals');
  // Malformed views never invent a card.
  for (const bad of [{ view: { kind: 'broken', action: { kind: 'x'.repeat(41), label: 'y' } } }, { view: { kind: 'broken', action: { kind: 'update' } } }, 'nope', { looseEnds: { repos: 'many' } }]) assert.deepEqual(compose({ alerts: { burst: bad }, now }).items, [], JSON.stringify(bad));
});

// Verifier fix 3: the Home card shows only for a state worth a hand. Each kind is tested.
test('inbox: Burst row only for broken, too_old, ca_untrusted, hosts_missing, console_down, gateway_stale, three misses, an update, loose ends or Limit near; never not_installed, off, checking, unsupported', () => {
  const { burstRow, ATTENTION_KINDS } = require('../src/attention-inbox.js');
  assert.deepEqual(ATTENTION_KINDS, ['broken', 'too_old', 'ca_untrusted', 'hosts_missing', 'console_down', 'gateway_stale']);
  const v = (kind, over = {}) => ({ kind, headline: `h ${kind}`, detail: 'd', chip: { tone: 'amber', label: 'x' }, action: { kind: 'repair', label: 'Repair' }, dimmed: false, ...over });
  for (const kind of ATTENTION_KINDS) {
    const r = burstRow({ view: v(kind), looseEnds: null });
    assert.ok(r, kind); assert.equal(r.title, `h ${kind}`); assert.deepEqual(r.action, { kind: 'burst', op: 'repair', label: 'Repair' });
  }
  // unreachable with misses >= 3 and an update arrive as kind off/on with the card's `attention` flag (src/home-alerts.js).
  assert.equal(burstRow({ view: v('off', { attention: true, action: { kind: 'enable', label: 'Turn on' } }) }).action.op, 'enable', 'three misses');
  assert.equal(burstRow({ view: v('on', { attention: true, action: { kind: 'update', label: 'Update' } }) }).action.op, 'update', 'update available');
  assert.equal(burstRow({ view: v('on', { action: null, chip: { tone: 'amber', label: 'Limit near' } }) }).key, 'burst:limit-near');
  assert.equal(burstRow({ view: v('on', { action: null, chip: { tone: 'green', label: 'Primary' } }), looseEnds: { repos: 1, text: 't' } }).key, 'burst:loose-ends');
  // Never: not installed, off on purpose, checking, unsupported, one missed poll (off with an action but no flag).
  for (const kind of ['not_installed', 'off', 'checking', 'unsupported']) assert.equal(burstRow({ view: v(kind, { action: { kind: 'install', label: 'Install' } }), looseEnds: null }), null, kind);
  for (const kind of ['not_installed', 'checking', 'unsupported']) assert.equal(burstRow({ view: v(kind, { chip: { tone: 'amber', label: 'Limit near' } }), looseEnds: { repos: 2, text: 't' } }), null, `${kind}: not even for loose ends or the chip`);
  assert.equal(burstRow({ view: v('on', { action: { kind: 'uninstall', label: 'Uninstall…' } }) }), null, 'healthy on: an action without the flag is not a card');
  assert.equal(burstRow({ view: v('on', { action: null, updateAvailable: false }) }), null);
});

// Verifier fix 7: the row carries `dimmed` from the card (stale last-known state) for the page to render as a class.
test('inbox: the Burst row mirrors the card\'s dimmed flag', () => {
  const { burstRow } = require('../src/attention-inbox.js');
  const stale = burstRow({ view: { kind: 'gateway_stale', headline: 'Burst is not responding', detail: 'd', chip: null, action: { kind: 'repair', label: 'Repair' }, dimmed: true } });
  assert.equal(stale.dimmed, true);
  assert.equal(burstRow({ view: { kind: 'broken', headline: 'h', detail: 'd', chip: null, action: { kind: 'repair', label: 'Repair' }, dimmed: false } }).dimmed, false);
  assert.equal(burstRow({ view: { kind: 'on', headline: 'h', detail: 'd', chip: null, action: null, dimmed: 'yes' }, looseEnds: { repos: 1, text: 't' } }).dimmed, false, 'only a real true');
});

test('a finished piece of work is "Check it", the word every view uses', () => {
  const { LABEL } = require('../src/attention-inbox.js');
  const W = require('../src/work-organise.js');
  assert.equal(LABEL.review, 'Check it');
  assert.equal(LABEL.review, W.BUCKETS.find((b) => b.id === 'check').label);
});
