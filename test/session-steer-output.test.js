'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInteractionHub } = require('../src/session-interaction');
const ACTOR = 'steer-output-test';
async function rig() {
  const ee = new EventEmitter(), calls = [];
  const adapter = { label: 'Synthetic', capabilities: { newTurn: true, steer: true, interrupt: true }, alive: () => true,
    open: async () => ({ target: 'private-target' }), async send(req) { calls.push(req); return { turnId: req.expectedTurnId ?? 'private-turn', mode: req.expectedTurnId ? 'steer' : 'new-turn' }; },
    on: fn => { ee.on('event', fn); return () => ee.off('event', fn); } };
  const hub = createInteractionHub({ adapters: { synthetic: adapter }, boardCurrent: () => true });
  const s = (await hub.launch({ provider: 'synthetic' }, ACTOR)).state, base = { session: s.session, generation: s.generation };
  const state = () => hub.state({ session: s.session }, ACTOR);
  const emit = e => ee.emit('event', { target: 'private-target', turnId: 'private-turn', ...e });
  await hub.send({ ...base, text: 'Initial request' }, ACTOR);
  return { hub, adapter, calls, base, state, emit, steer: text => hub.send({ ...base, text, expectedTurn: state().activeTurn }, ACTOR) };
}
test('steer receipt excludes prior output, waits for its own echo, and shows only later turn output', async () => {
  const r = await rig();
  try {
    const prior = 'Earlier list: 1 2 3 4 5. ';
    r.emit({ kind: 'delta', text: prior });
    const sent = await r.steer('Stop the list');
    assert.equal(sent.delivery.response, ''); assert.equal(sent.delivery.state, 'acknowledged', 'earlier output cannot make a new steer responding');
    assert.equal(sent.delivery.recorded, false, 'ack does not invent a literal echo');
    r.emit({ kind: 'input-recorded', clientId: r.calls[1].clientId, text: 'Stop the list' });
    assert.equal(r.state().deliveries[1].state, 'recorded');
    r.emit({ kind: 'delta', target: 'another-target', text: 'wrong target' });
    r.emit({ kind: 'delta', turnId: 'another-turn', text: 'wrong turn' });
    assert.equal(r.state().deliveries[1].response, '');
    r.emit({ kind: 'delta', text: 'Stopped. ' });
    assert.equal(r.state().deliveries[1].response, 'Stopped. ');
    r.emit({ kind: 'message', text: `${prior}Stopped. ` });
    assert.equal(r.state().deliveries[1].response, 'Stopped. ');
    assert.equal(r.state().deliveries[0].response, `${prior}Stopped. `, 'new-turn response retains its original contract');
    r.emit({ kind: 'turn-completed', status: 'completed' });
    assert.equal(r.state().deliveries[1].state, 'completed');
  } finally { r.hub.stopAll(); }
});
test('steer output survives an earlier response cap and a shorter final provider message', async () => {
  const r = await rig();
  try {
    const prior = 'Earlier '.repeat(3000);
    r.emit({ kind: 'delta', text: prior });
    assert.equal(r.state().deliveries[0].response.length, 16000);
    await r.steer('Only return the marker');
    r.emit({ kind: 'delta', text: 'MARKER' });
    assert.equal(r.state().deliveries[1].response, 'MARKER', 'a full old response does not consume the new steer output budget');
    r.emit({ kind: 'message', text: `${prior}MARKER` });
    assert.equal(r.state().deliveries[1].response, 'MARKER', 'full final aggregate strips all prior output, including its truncated tail');
    r.emit({ kind: 'message', text: 'MARKER' });
    assert.equal(r.state().deliveries[1].response, 'MARKER', 'a final item replacing the aggregate must not be sliced away');
  } finally { r.hub.stopAll(); }
});
test('steer dispatch baseline precedes an asynchronous acknowledgement and mismatched turn acknowledgement refuses', async () => {
  const r = await rig();
  try {
    r.emit({ kind: 'delta', text: 'BEFORE' });
    r.adapter.send = async req => { r.calls.push(req); r.emit({ kind: 'delta', text: 'AFTER' }); await new Promise(resolve => setImmediate(resolve)); return { turnId: req.expectedTurnId, mode: 'steer' }; };
    const sent = await r.steer('Correction');
    assert.equal(sent.delivery.response, 'AFTER');
    r.adapter.send = async () => ({ turnId: 'wrong-native-turn', mode: 'steer' });
    const refused = await r.steer('Another correction');
    assert.equal(refused.ok, false); assert.equal(refused.status, 'stale');
    assert.equal(r.state().deliveries.at(-1).state, 'refused');
    assert.equal(r.state().deliveries.at(-1).response, '');
  } finally { r.hub.stopAll(); }
});
