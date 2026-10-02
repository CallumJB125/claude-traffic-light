'use strict';
// Session directory model (src/session-directory.js): dedupe, team privacy,
// freshness/replay, provenance, capability reasons and human edit precedence.
const test = require('node:test'), assert = require('node:assert/strict');
const { createSessionDirectory, freshness, taskOf, CAPABILITIES } = require('../src/session-directory');
const { createFakeTeamHub } = require('../src/team-hub-fake');

const T0 = 1_800_000_000_000;
const SESSION = '10000000-0000-4000-8000-000000000001';
const caps = (message) => ({ open: { enabled: false, label: 'Open', reason: 'No card.' }, message: { enabled: message, label: 'Message', reason: message ? '' : 'A current owned runner with messaging is required.' } });
const work = (over = {}) => ({ id: 'w-1', handle: null, label: 'Session', provider: { id: 'codex', label: 'Codex', kind: 'integrated' }, device: { label: 'This device', local: true }, board: { label: 'Unassigned', kind: 'unknown' }, project: 'plexiform-owned-AbC123', status: 'Working', freshness: 'recent', age_ms: 2000, task: { status: 'unknown', title: 'Task not reported', key: null }, children: [], capabilities: caps(false), ...over });
const owned = (over = {}) => ({ state: { session: SESSION, generation: 1, provider: { id: 'codex', label: 'Codex' }, ownership: 'plexiform-owned', status: 'ready', activeTurn: null, capabilities: { steer: true, interrupt: true }, deliveries: [{ text: 'private message' }], board: 'local', ...over }, leaf: 'plexiform-owned-AbC123' });
const TEAM = { key: 'a'.repeat(32), name: 'Dev team', id: 'team-1' };
const VIEWER = { id: 'u-me', name: 'Me' };
const hubEntry = (over = {}) => ({ ref: 'r-1', team: { id: 'team-1', name: 'Dev team' }, owner: { id: 'u-bob', name: 'Bob' }, share: { explicit: true, scope: 'interact', expiresAt: null, revoked: false }, provider: { id: 'claude', label: 'Claude Code' }, device: { label: 'Bob’s Windows PC' }, card: { key: 'DEV-1', title: 'Fix login', edited_by: 'automation' }, task_title: 'automated title', state: 'working', observed_at: T0 - 1000, online: true, capabilities: { steer: false, interrupt: true }, children: [], ...over });

test('freshness: recent, stale after the window, unknown for missing or future times', () => {
  assert.deepEqual(freshness(T0 - 1000, T0), { freshness: 'recent', ageMs: 1000 });
  assert.equal(freshness(T0 - 91_000, T0).freshness, 'stale');
  assert.equal(freshness(null, T0).freshness, 'unknown');
  assert.equal(freshness(T0 + 5000, T0).freshness, 'unknown', 'a future-dated report is not fresh');
});

test('human card edits beat board titles, which beat automated reports', () => {
  assert.deepEqual(taskOf({ human: 'Human title', card: 'Card', reported: 'Auto' }), { title: 'Human title', source: 'human' });
  assert.deepEqual(taskOf({ card: 'Card', reported: 'Auto' }), { title: 'Card', source: 'board' });
  assert.deepEqual(taskOf({ reported: 'Auto' }), { title: 'Auto', source: 'reported' });
  assert.deepEqual(taskOf({}), { title: 'Task not reported', source: 'unknown' });
  const d = createSessionDirectory({ now: () => T0 });
  const { entries } = d.team({ team: TEAM, viewer: VIEWER, member: true, hubEntries: [hubEntry({ card: { key: 'DEV-1', title: 'Renamed by Ana', edited_by: 'human' }, task_title: 'agent says something else' })] });
  assert.deepEqual(entries[0].task, { title: 'Renamed by Ana', source: 'human' });
});

test('mine: an owned session and its own hook report are one entry; a shared owned session is counted once with a team badge', () => {
  const d = createSessionDirectory({ now: () => T0 });
  const shares = [{ session: SESSION, scope: 'watch', teamKey: TEAM.key, teamName: 'Dev team' }];
  const child = { id: 'c-1', label: 'Agent', status: 'Working', freshness: 'recent', age_ms: 1000, task: { status: 'tracked', title: 'Child work', key: null }, capabilities: caps(false) };
  const other = work({ id: 'w-2', project: 'elsewhere', provider: { id: 'gemini', label: 'Gemini', kind: 'integrated' } });
  const entries = d.mine({ work: [work({ children: [child] }), other], owned: [owned()], shares });
  assert.equal(entries.length, 2, 'owned + unrelated observed session; the twin report folded in');
  const e = entries.find((x) => x.kind === 'owned');
  assert.deepEqual(e.provenance, ['owned', 'observed']);
  assert.equal(e.children.length, 1); assert.equal(e.children[0].parent, e.id);
  assert.equal(e.scope, 'team'); assert.deepEqual(e.teams, [{ key: TEAM.key, name: 'Dev team' }]);
  assert.equal(e.capabilities.remoteControl.available, false, 'watch-only share does not grant control');
  const counts = d.counts(entries);
  assert.equal(counts.sessions, 2); assert.equal(counts.team, 1); assert.equal(counts.children, 1);
  // The same owned session in the team view is the same entry, not a second census row.
  const team = d.team({ team: TEAM, viewer: VIEWER, member: true, personal: entries, hubEntries: [] });
  assert.deepEqual(team.entries.map((x) => x.id), [e.id]);
  assert.equal(JSON.stringify(entries).includes('private message'), false, 'owned deliveries never enter the directory');
  assert.equal(JSON.stringify(entries).includes(SESSION), true, 'only Plexiform\'s own session id is the interaction ref');
});

test('capability reasons: hooks alone never claim inbound control; unmanaged Codex says why', () => {
  const d = createSessionDirectory({ now: () => T0 });
  const [codex, gemini] = d.mine({ work: [work({ project: 'p' }), work({ id: 'w-2', project: 'q', provider: { id: 'gemini', label: 'Gemini', kind: 'integrated' } })] });
  for (const e of [codex, gemini]) {
    assert.equal(e.capabilities.discovery.available, true); assert.equal(e.capabilities.telemetry.available, true);
    for (const k of ['receive', 'reply', 'resume', 'steer', 'interrupt', 'remoteControl']) { assert.equal(e.capabilities[k].available, false, k); assert.ok(e.capabilities[k].reason.length > 10, k); }
    assert.equal(e.interact, null);
  }
  assert.match(codex.capabilities.receive.reason, /Codex, which has no supported way/);
  assert.match(gemini.capabilities.receive.reason, /hooks report activity only/);
  assert.deepEqual(Object.keys(codex.capabilities), CAPABILITIES);
  const [o] = d.mine({ owned: [owned({ status: 'working', capabilities: { steer: false, interrupt: true } })] });
  assert.equal(o.capabilities.receive.available, true); assert.equal(o.capabilities.steer.available, false); assert.match(o.capabilities.steer.reason, /does not offer steering/);
  assert.match(o.capabilities.remoteControl.reason, /Not shared/);
  const [ended] = d.mine({ owned: [owned({ status: 'ended' })] });
  assert.equal(ended.capabilities.receive.available, false); assert.match(ended.capabilities.receive.reason, /ended/);
});

test('team privacy: only explicit, live shares for this team from current co-members survive main-side', () => {
  const d = createSessionDirectory({ now: () => T0 });
  const hostile = [
    hubEntry({ ref: 'ok' }),
    hubEntry({ ref: 'other-team', team: { id: 'team-2', name: 'Other' } }),
    hubEntry({ ref: 'implicit', share: { explicit: false, scope: 'interact' } }),
    hubEntry({ ref: 'no-share', share: undefined }),
    hubEntry({ ref: 'revoked', share: { explicit: true, scope: 'interact', revoked: true } }),
    hubEntry({ ref: 'expired', share: { explicit: true, scope: 'watch', expiresAt: T0 - 1 } }),
    hubEntry({ ref: 'bad-scope', share: { explicit: true, scope: 'admin' } }),
    hubEntry({ ref: 'mine', owner: { id: 'u-me', name: 'Me' } }),
    hubEntry({ ref: 'leaky', cwd: '/Users/bob/secret-project', thread_id: 'thr_123', token: 'sk-live', device: { label: 'Bob’s PC', path: '/Users/bob' } }),
  ];
  const { entries, refs } = d.team({ team: TEAM, viewer: VIEWER, member: true, hubEntries: hostile });
  assert.equal(entries.length, 2);
  const json = JSON.stringify(entries);
  for (const leak of ['secret-project', 'thr_123', 'sk-live', '/Users/bob', 'other-team', 'u-bob']) assert.equal(json.includes(leak), false, leak);
  assert.equal(refs.size, 2);
  // Not a current member: nothing of anyone else's, whatever the hub returns.
  assert.equal(d.team({ team: TEAM, viewer: VIEWER, member: false, hubEntries: hostile }).entries.length, 0);
});

test('team freshness: replay cannot refresh observedAt; children keep their own time; self-reports stay separate', () => {
  let now = T0;
  const d = createSessionDirectory({ now: () => now });
  const read = (over) => d.team({ team: TEAM, viewer: VIEWER, member: true, hubEntries: [hubEntry(over)] }).entries[0];
  let e = read({ observed_at: T0 - 1000, children: [{ ref: 'k', name: 'Sub', state: 'working', observed_at: T0 - 200_000 }], self_reported: { state: 'working', at: T0 - 10 } });
  assert.equal(e.freshness, 'recent'); assert.equal(e.children[0].freshness, 'stale', 'parent activity does not refresh a child');
  assert.deepEqual(e.selfReported, { state: 'Working', at: T0 - 10 }); assert.deepEqual(e.provenance, ['shared', 'self-reported']);
  now = T0 + 200_000;
  e = read({ observed_at: T0 - 5000 }); // an older event replayed
  assert.equal(e.observedAt, T0 - 1000); assert.equal(e.freshness, 'stale');
  e = read({ observed_at: now + 60_000 }); // future-dated
  assert.equal(e.observedAt, T0 - 1000); assert.equal(e.freshness, 'stale');
  assert.equal(e.capabilities.receive.available, false); assert.match(e.capabilities.receive.reason, /offline or this report is stale/);
});

test('team capability reasons: watch-only, offline, ended, provider limits', () => {
  const d = createSessionDirectory({ now: () => T0 });
  const one = (over) => d.team({ team: TEAM, viewer: VIEWER, member: true, hubEntries: [hubEntry(over)] }).entries[0];
  const watch = one({ share: { explicit: true, scope: 'watch' } });
  assert.equal(watch.interact, null); assert.match(watch.capabilities.receive.reason, /Bob shared this session with your team to watch only/);
  assert.match(one({ online: false }).capabilities.receive.reason, /offline/);
  assert.match(one({ state: 'ended' }).capabilities.receive.reason, /ended/);
  const live = one({});
  assert.equal(live.capabilities.receive.available, true); assert.equal(live.capabilities.interrupt.available, true);
  assert.equal(live.capabilities.steer.available, false); assert.match(live.capabilities.steer.reason, /does not offer steering/);
  assert.equal(live.capabilities.remoteControl.available, false); assert.equal(live.capabilities.resume.available, false);
  assert.equal(one({ state: 'input' }).input, true);
});

test('fake team hub filters like a real hub: membership, explicit share, revocation', async () => {
  const hub = createFakeTeamHub({ viewer: 'u-me', users: { 'u-me': 'Me', 'u-bob': 'Bob', 'u-eve': 'Eve' },
    teams: [{ id: 't1', name: 'One', members: ['u-me', 'u-bob'] }, { id: 't2', name: 'Two', members: ['u-eve', 'u-bob'] }],
    sessions: [{ ref: 'a', owner: 'u-bob', state: 'working', shares: [{ team: 't1', scope: 'interact' }] }, { ref: 'b', owner: 'u-bob', state: 'working', shares: [] }, { ref: 'c', owner: 'u-eve', state: 'working', shares: [{ team: 't2', scope: 'watch' }] }] });
  const me = hub.viewer();
  assert.deepEqual((await hub.teams(me)).map((t) => t.id), ['t1']);
  assert.deepEqual((await hub.sessions(me, 't1')).map((s) => s.ref), ['a']);
  assert.deepEqual(await hub.sessions(me, 't2'), [], 'not a member of t2');
  assert.equal((await hub.send(me, 't2', 'c', 'hi')).ok, false);
  hub.revoke('a', 't1');
  assert.deepEqual(await hub.sessions(me, 't1'), []);
  assert.equal((await hub.send(me, 't1', 'a', 'hi')).ok, false);
});

test('mine: an attached codex-daemon session is labelled as started outside Plexiform and never carries a team badge', () => {
  const d = createSessionDirectory({ now: () => T0 });
  const shares = [{ session: SESSION, scope: 'interact', teamKey: TEAM.key, teamName: 'Dev team' }];
  const [e] = d.mine({ owned: [{ ...owned({ provider: { id: 'codex-daemon', label: 'Codex CLI' }, ownership: 'existing-unmanaged' }), leaf: null }], shares });
  assert.equal(e.board.label, 'Started outside Plexiform');
  assert.equal(e.scope, 'personal'); assert.deepEqual(e.teams, []);
  assert.equal(e.capabilities.remoteControl.available, false);
  assert.match(e.capabilities.remoteControl.reason, /never shared/);
});
