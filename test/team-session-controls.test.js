'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createTeamSessionControls } = require('../src/team-session-controls');
const ID = 'a'.repeat(40), turn = crypto.randomUUID();
const tick = () => new Promise(r => setImmediate(r));
function fixture() {
  let time = 1000, visible = true, focused = true, scope = 'interact', viewer = 'me', ref = 'private-share';
  const state = { generation: 1, activeTurn: null, status: 'ready', capabilities: { newTurn: true, steer: true, interrupt: true }, deliveries: [] };
  const calls = [];
  let waitResolve = null, waitInspect = null, waitAct = null;
  const hub = {
    async inspect() { if (waitInspect) await waitInspect(); return { ok: true, state: structuredClone(state) }; },
    async act(v, t, r, command, id, fresh) {
      if (waitAct) await waitAct();
      if (!fresh()) return { ok: false, status: 'stale' };
      calls.push({ v, t, r, command, id });
      return { ok: true, status: command.operation === 'interrupt' ? 'interrupt-requested' : 'acknowledged', delivery: { id: crypto.randomUUID(), state: 'acknowledged' } };
    },
  };
  const service = createTeamSessionControls({ now: () => time, current: () => visible, actionCurrent: () => focused, resolve: async () => {
    if (waitResolve) await waitResolve();
    return { hub, viewer: { id: viewer }, team: 'team', ref, scope };
  } });
  return { service, hub, state, calls,
    inspect: () => service.inspect({ id: ID }),
    send: (selection, text = 'Please check the selected task') => service.action({ selection, operation: 'send', text }),
    busy() { state.activeTurn = turn; state.status = 'working'; },
    advance: () => time += 45_001, blur: () => focused = false, hide: () => visible = false,
    watch: () => scope = 'watch', account: () => viewer = 'different-account', retarget: () => ref = 'different-share',
    holdResolve: fn => waitResolve = fn, holdInspect: fn => waitInspect = fn, holdAct: fn => waitAct = fn,
  };
}
test('reviewed shared session sends once and preserves actual provider acknowledgement', async () => {
  const x = fixture(), read = await x.inspect();
  assert.equal(read.capabilities.send.available, true);
  assert.equal(read.capabilities.steer.available, false);
  const result = await x.send(read.selection);
  assert.equal(result.status, 'acknowledged');
  assert.equal(result.delivery.state, 'acknowledged');
  assert.equal((await x.send(read.selection)).status, 'stale');
  assert.equal(x.calls.length, 1);
  assert.deepEqual(x.calls[0].command, { operation: 'send', generation: 1, turn: null, text: 'Please check the selected task' });
  assert.match(x.calls[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(read).includes('private-share'), false);
});
test('busy supported turn permits explicit steer and independent interrupt, never ordinary send', async () => {
  const x = fixture(); x.busy();
  let read = await x.inspect();
  assert.equal(read.capabilities.send.available, false);
  assert.equal(read.capabilities.steer.available, true);
  assert.equal((await x.send(read.selection)).ok, false);
  read = await x.inspect();
  assert.equal((await x.service.action({ selection: read.selection, operation: 'steer', text: 'Use the updated decision' })).status, 'acknowledged');
  assert.equal(x.calls[0].command.turn, turn);
  read = await x.inspect();
  assert.equal((await x.service.action({ selection: read.selection, operation: 'interrupt', text: '' })).status, 'interrupt-requested');
  assert.equal(x.calls[1].command.turn, turn);
});
test('busy provider without steering explains the limit and dispatches nothing', async () => {
  const x = fixture(); x.busy(); x.state.capabilities.steer = false;
  const read = await x.inspect();
  assert.match(read.capabilities.steer.reason, /does not support steering/);
  assert.equal((await x.service.action({ selection: read.selection, operation: 'steer', text: 'Change direction' })).ok, false);
  assert.equal(x.calls.length, 0);
});
for (const mutation of ['advance', 'blur', 'hide', 'watch', 'account', 'retarget']) test(`${mutation} after review refuses before provider dispatch`, async () => {
  const x = fixture(), read = await x.inspect(); x[mutation]();
  assert.equal((await x.send(read.selection)).ok, false);
  assert.equal(x.calls.length, 0);
});
for (const mutation of ['generation', 'turn']) test(`changed ${mutation} never retargets the reviewed action`, async () => {
  const x = fixture(), read = await x.inspect();
  if (mutation === 'generation') x.state.generation++; else x.busy();
  assert.equal((await x.send(read.selection)).status, 'stale');
  assert.equal(x.calls.length, 0);
});
test('watch read is available but every mutating capability remains unavailable', async () => {
  const x = fixture(); x.watch(); x.busy(); const read = await x.inspect();
  assert.equal(read.ok, true);
  assert.ok(Object.values(read.capabilities).every(c => c.available === false));
  assert.equal((await x.service.action({ selection: read.selection, operation: 'interrupt', text: '' })).ok, false);
  assert.equal(x.calls.length, 0);
});
test('concurrent clicks consume the review token before the first asynchronous check', async () => {
  const x = fixture(), read = await x.inspect(); let release;
  x.holdResolve(() => new Promise(r => release = r));
  const first = x.send(read.selection); await tick();
  assert.equal((await x.send(read.selection)).status, 'stale'); release();
  assert.equal((await first).ok, true); assert.equal(x.calls.length, 1);
});
test('separate reviews cannot dispatch concurrent actions on the same session, even after view invalidation', async () => {
  const x = fixture(), firstRead = await x.inspect(), secondRead = await x.inspect(); let release;
  x.holdAct(() => new Promise(r => release = r));
  const pending = x.send(firstRead.selection); await tick();
  assert.equal((await x.send(secondRead.selection)).status, 'busy');
  x.service.invalidate();
  const thirdRead = await x.inspect();
  assert.equal((await x.send(thirdRead.selection)).status, 'busy');
  release(); assert.equal((await pending).ok, false); assert.equal(x.calls.length, 0);
});
for (const boundary of ['Resolve', 'Inspect', 'Act']) test(`losing focus during ${boundary} sends no provider work`, async () => {
  const x = fixture(), read = await x.inspect(); let release;
  x[`hold${boundary}`](() => new Promise(r => release = r));
  const pending = x.send(read.selection); await tick(); x.blur(); release();
  assert.equal((await pending).ok, false); assert.equal(x.calls.length, 0);
});
test('invalidate during read withholds private state and retires all reviews', async () => {
  const x = fixture(), read = await x.inspect(); let release;
  x.holdInspect(() => new Promise(r => release = r));
  const pending = x.inspect(); await tick(); x.service.invalidate(); release();
  assert.equal((await pending).state, undefined);
  assert.equal((await x.send(read.selection)).status, 'stale');
});
test('account or route authority retired during an exact read withholds its response', async () => {
  let valid = true, release;
  const state = { generation: 1, activeTurn: null, status: 'ready', capabilities: { newTurn: true }, deliveries: [{ text: 'private response' }] };
  const target = { viewer: { id: 'viewer' }, team: 'team', ref: 'share', scope: 'interact', isCurrent: () => valid,
    hub: { inspect: () => new Promise(r => release = () => r({ ok: true, state })) } };
  const service = createTeamSessionControls({ resolve: async () => target });
  const pending = service.inspect({ id: ID }); await tick(); valid = false; release();
  const result = await pending; assert.equal(result.status, 'stale'); assert.equal(JSON.stringify(result).includes('private response'), false);
});
test('uncertain dispatch is not retried and does not turn into a queued receipt', async () => {
  const x = fixture(), read = await x.inspect(); let attempts = 0;
  x.hub.act = async () => { attempts++; throw new Error('lost connection'); };
  const result = await x.send(read.selection);
  assert.equal(result.status, 'unconfirmed'); assert.match(result.error, /may have acted/);
  assert.equal((await x.send(read.selection)).status, 'stale'); assert.equal(attempts, 1);
});
test('closed action shape rejects injected routing, malformed text and unsupported operations', async () => {
  const x = fixture(), read = await x.inspect();
  for (const change of [{ operation: 'close' }, { text: '\0x' }, { text: '😀'.repeat(3000) }, { ref: 'another' }, { generation: 2 }]) {
    const result = await x.service.action({ selection: read.selection, operation: 'send', text: 'hi', ...change });
    assert.equal(result.status, 'invalid');
  }
  assert.equal(x.calls.length, 0);
});
