'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createTeamCoordinator } = require('../src/team-coordinator');
const { createTeamSessionControls } = require('../src/team-session-controls');
const TEAM = 'a'.repeat(32), ids = ['b'.repeat(40), 'c'.repeat(40)];
const tick = () => new Promise(r => setImmediate(r));
function fixture() {
  let time = 1_000_000, visible = true, focused = true, revoked = false, scope = 'interact', held = null, resolveHeld = null, inspectHeld = null;
  const states = ids.map(() => ({ generation: 1, activeTurn: null, status: 'ready', capabilities: { newTurn: true, steer: true }, deliveries: [] }));
  const calls = [], requested = [];
  const entries = ids.map((id, i) => ({ id, kind: 'shared', scope: 'team', teams: [{ key: TEAM }], owner: { name: ['Bob', 'Cara'][i] }, provider: { id: ['codex', 'claude'][i], label: ['Codex', 'Claude Code'][i] }, device: { label: 'Other device' }, task: { title: `Task ${i + 1}` }, state: 'Idle', freshness: 'recent', observedAt: time, interact: { kind: 'team', ref: id }, capabilities: { receive: { available: true, reason: '' } }, messageContract: 'live' }));
  const hub = {
    async proposals(_v, _t, ref, op, input) { requested.push({ ref, op }); return { ok: true, proposal: { ...input, status: 'pending' } }; },
    async inspect(_v, _t, ref) { if (inspectHeld) await inspectHeld(); if (revoked) return { ok: false, status: 'forbidden' }; return { ok: true, state: structuredClone(states[ids.indexOf(ref)]) }; },
    async act(_v, _t, ref, command, _request, fresh) {
      if (held) await held();
      if (!fresh() || revoked) return { ok: false, status: 'stale' };
      const i = ids.indexOf(ref), d = { id: crypto.randomUUID(), state: 'acknowledged', text: command.text, response: '' };
      calls.push({ ref, ...command }); states[i].deliveries.push(d); states[i].status = 'working'; states[i].activeTurn = crypto.randomUUID();
      return { ok: true, status: 'acknowledged', delivery: { ...d } };
    },
  };
  const controls = createTeamSessionControls({ now: () => time, current: () => visible, actionCurrent: () => focused,
    resolve: async id => { if (resolveHeld) await resolveHeld(); return revoked ? { ok: false, status: 'stale' } : { hub, viewer: { id: 'operator' }, team: 'private-team', ref: id, scope, isCurrent: () => !revoked }; } });
  const directory = { schema: 1, view: 'team', status: 'complete', observed_at: time, team: { key: TEAM, name: 'Dev' }, entries };
  let inventoryHook = null;
  const coordinator = createTeamCoordinator({ now: () => time, current: () => visible, actionCurrent: () => focused, inspect: controls.inspect, action: controls.action,
    resolve: async entry => revoked ? null : { hub, viewer: { id: 'operator' }, team: 'private-team', ref: entry.id, scope, isCurrent: () => !revoked },
    inventory: async () => { if (inventoryHook) await inventoryHook(); return structuredClone({ ...directory, entries: revoked ? [] : entries }); } });
  const request = { team: TEAM, title: 'Review and compare', assignments: ids.map((id, i) => ({ id, name: ['Implementation review', 'Test review'][i], text: [`Review parser behavior`, 'Review test coverage'][i] })) };
  return { coordinator, controls, states, entries, directory, calls, requested, request,
    propose: () => coordinator.propose(structuredClone(request)),
    confirm: p => coordinator.confirm({ proposal: p.proposal, grants: p.assignments.filter(a => a.status === 'review').map(a => ({ assignment: a.assignment, operation: 'send' })) }),
    advance: ms => time += ms, blur: () => focused = false, hide: () => visible = false, revoke: () => revoked = true,
    watch: () => { scope = 'watch'; entries[0].interact = null; entries[0].capabilities.receive = { available: false, reason: 'Shared to watch only.' }; },
    hold: fn => held = fn, onInventory: fn => inventoryHook = fn, holdResolve: fn => resolveHeld = fn, holdInspect: fn => inspectHeld = fn,
  };
}
test('fresh shared named assignments are inert until individually granted; exact receipts correlate replies', async () => {
  const x = fixture(), plan = await x.propose();
  assert.equal(plan.status, 'review'); assert.equal(x.calls.length, 0);
  assert.equal(JSON.stringify(plan).includes('private-team'), false);
  assert.equal(plan.assignments[0].selection, undefined);
  const sent = await x.confirm(plan);
  assert.equal(sent.assignments.every(a => a.status === 'sent'), true);
  assert.deepEqual(x.calls.map(c => c.text), x.request.assignments.map(a => a.text));
  assert.ok(sent.assignments.every(a => a.grant.operation === 'send' && a.grant.state === 'used'));
  x.states[0].deliveries[0].response = 'Parser result'; x.states[0].deliveries[0].state = 'completed';
  x.states[1].deliveries.push({ id: crypto.randomUUID(), state: 'completed', text: 'Unrelated request', response: 'PRIVATE unrelated output' });
  const result = await x.coordinator.results({ proposal: plan.proposal });
  assert.equal(result.assignments[0].response, 'Parser result'); assert.equal(result.assignments[0].receipt.state, 'completed');
  assert.equal(result.assignments[1].response, ''); assert.equal(JSON.stringify(result).includes('PRIVATE unrelated output'), false);
  assert.equal((await x.confirm(plan)).status, 'stale'); assert.equal(x.calls.length, 2);
});
test('one selected grant sends exactly that assignment and confers no interrupt or later-turn authority', async () => {
  const x = fixture(), p = await x.propose();
  const bad = await x.coordinator.confirm({ proposal: p.proposal, grants: [{ assignment: p.assignments[0].assignment, operation: 'interrupt' }] });
  assert.equal(bad.status, 'invalid'); assert.equal(x.calls.length, 0);
  const r = await x.coordinator.confirm({ proposal: p.proposal, grants: [{ assignment: p.assignments[1].assignment, operation: 'send' }] });
  assert.equal(x.calls.length, 1); assert.equal(x.calls[0].ref, ids[1]); assert.equal(r.assignments[0].status, 'not-selected');
});
test('watch-only, task inbox, stale, unsupported and busy targets are blocked with no implicit steer or queue', async () => {
  for (const change of ['watch', 'inbox', 'stale', 'busy', 'unsupported']) {
    const x = fixture();
    if (change === 'watch') x.watch();
    if (change === 'inbox') x.entries[0].messageContract = 'task-inbox';
    if (change === 'stale') x.entries[0].observedAt -= 90_001;
    if (change === 'busy') { x.states[0].status = 'working'; x.states[0].activeTurn = crypto.randomUUID(); }
    if (change === 'unsupported') x.states[0].capabilities.newTurn = false;
    const p = await x.propose(); assert.equal(p.assignments[0].status, 'blocked', change);
    assert.equal((await x.coordinator.confirm({ proposal: p.proposal, grants: [{ assignment: p.assignments[0].assignment, operation: 'send' }] })).status, 'invalid');
    assert.equal(x.calls.length, 0);
  }
});
for (const mutation of ['expired', 'blur', 'hide', 'revoked', 'retargeted', 'generation', 'busy']) test(`${mutation} between review and grant never dispatches a changed target`, async () => {
  const x = fixture(), p = await x.propose();
  if (mutation === 'expired') x.advance(30_001);
  if (mutation === 'blur') x.blur();
  if (mutation === 'hide') x.hide();
  if (mutation === 'revoked') x.revoke();
  if (mutation === 'retargeted') x.entries[0].owner.name = 'Another owner';
  if (mutation === 'generation') x.states[0].generation++;
  if (mutation === 'busy') { x.states[0].status = 'working'; x.states[0].activeTurn = crypto.randomUUID(); }
  await x.coordinator.confirm({ proposal: p.proposal, grants: [{ assignment: p.assignments[0].assignment, operation: 'send' }] });
  assert.equal(x.calls.length, 0);
});
test('duplicate click consumes all grants before awaiting fresh inventory', async () => {
  const x = fixture(), p = await x.propose(); let release;
  x.onInventory(() => new Promise(r => release = r));
  const pending = x.confirm(p); await tick();
  assert.equal((await x.confirm(p)).status, 'stale'); release();
  await pending; assert.equal(x.calls.length, 2);
});
test('uncertain provider outcome is retained and never automatically retried', async () => {
  const x = fixture(), p = await x.propose(); let attempts = 0;
  x.hold(() => { attempts++; throw Error('network lost'); });
  const r = await x.confirm(p); assert.equal(r.assignments.every(a => a.status === 'unconfirmed'), true);
  await x.coordinator.results({ proposal: p.proposal }); await x.confirm(p);
  assert.equal(attempts, 2); assert.equal(x.calls.length, 0);
});
test('revocation after dispatch withholds prior target and response; correlated history eviction never borrows another response', async () => {
  const x = fixture(), p = await x.propose(); await x.confirm(p);
  x.states[0].deliveries[0].response = 'Prior authorized output';
  assert.equal((await x.coordinator.results({ proposal: p.proposal })).assignments[0].response, 'Prior authorized output');
  x.states[0].deliveries = [{ id: crypto.randomUUID(), response: 'Unrelated output', state: 'completed' }];
  assert.equal((await x.coordinator.results({ proposal: p.proposal })).assignments[0].response, '');
  x.revoke(); const r = await x.coordinator.results({ proposal: p.proposal });
  assert.equal(r.assignments[0].target, null); assert.equal(r.assignments[0].text, ''); assert.equal(r.assignments[0].response, '');
});
test('cancel and invalidation retire reviews, including in-flight inspection', async () => {
  const x = fixture(), p = await x.propose();
  assert.equal(x.coordinator.cancel({ proposal: p.proposal }).status, 'cancelled'); assert.equal((await x.confirm(p)).status, 'stale');
  let release; x.onInventory(() => new Promise(r => release = r));
  const pending = x.propose(); await tick(); x.coordinator.invalidate(); release();
  assert.equal((await pending).status, 'stale'); assert.equal(x.calls.length, 0);
});
test('inventory is fresh and closed, refusing partial data and injected target authority', async () => {
  const x = fixture();
  assert.equal((await x.coordinator.inventory({ team: TEAM })).entries.length, 2);
  x.directory.status = 'partial'; assert.equal((await x.coordinator.inventory({ team: TEAM })).status, 'unavailable');
  x.directory.status = 'complete'; x.directory.observed_at += 1; assert.equal((await x.coordinator.inventory({ team: TEAM })).status, 'unavailable');
  for (const input of [{ ...x.request, actor: 'owner' }, { ...x.request, assignments: [x.request.assignments[0], x.request.assignments[0]] }, { ...x.request, assignments: [{ ...x.request.assignments[0], text: '😀'.repeat(3000) }] }]) assert.equal((await x.coordinator.propose(input)).status, 'invalid');
});
test('first empty-route adoption retries only the inert inventory read', async () => {
  const x = fixture(); let reads = 0;
  x.onInventory(() => { reads++; if (reads === 1) x.coordinator.invalidate(); });
  const r = await x.coordinator.inventory({ team: null });
  assert.equal(r.ok, true); assert.equal(reads, 2); assert.equal(x.calls.length, 0);
});
for (const boundary of ['Resolve', 'Inspect', 'Act']) test(`30-second assignment grant expiring during ${boundary} cannot borrow the controls' 45-second review`, async () => {
  const x = fixture(), p = await x.propose(); let release;
  const hold = boundary === 'Act' ? 'hold' : `hold${boundary}`;
  x[hold](() => new Promise(r => release = r));
  const pending = x.coordinator.confirm({ proposal: p.proposal, grants: [{ assignment: p.assignments[0].assignment, operation: 'send' }] });
  await tick(); assert.equal(typeof release, 'function'); x.advance(31_000); release();
  const r = await pending; assert.notEqual(r.assignments[0].status, 'sent'); assert.equal(x.calls.length, 0);
});
test('ordinary reviewed controls retain their documented 45-second lifetime without a narrower caller grant', async () => {
  const x = fixture(), inspected = await x.controls.inspect({ id: ids[0] }); x.advance(31_000);
  const r = await x.controls.action({ selection: inspected.selection, operation: 'send', text: 'Ordinary explicit send' });
  assert.equal(r.ok, true); assert.equal(x.calls.length, 1);
});

test('asking an owner to approve a message is refused with the watch-only reason when the share became watch-only, and sent to the hub when it is interact', async () => {
  const ok = fixture(), p = await ok.propose();
  const sent = await ok.coordinator.requestOwner({ proposal: p.proposal });
  assert.equal(sent.assignments[0].status, 'awaiting-owner', sent.assignments[0].reason); assert.deepEqual(ok.requested.map(r => r.op), ['request', 'request']);
  const x = fixture(), q = await x.propose();
  x.watch();
  const r = await x.coordinator.requestOwner({ proposal: q.proposal });
  assert.equal(r.assignments[0].status, 'refused');
  assert.equal(r.assignments[0].reason, 'Shared with you to watch only. The owner can choose Allow sending.');
  assert.deepEqual(x.requested, [], 'nothing was asked of a watch-only session');
});
