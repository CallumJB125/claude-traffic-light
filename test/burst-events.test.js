const test = require('node:test');
const assert = require('node:assert/strict');
const { createBurstEvents, gate, COOLDOWN_MS } = require('../src/burst-events.js');

const on = (o) => ({ kind: 'on', route: 'PRIMARY', chip: { tone: 'green', label: 'Primary' }, ...o });
const near = on({ chip: { tone: 'amber', label: 'Limit near' } });
const sec = on({ route: 'SECONDARY', chip: { tone: 'amber', label: 'Secondary' } });
const off = { kind: 'off', chip: { tone: 'grey', label: 'Burst off' } };
const kinds = (e) => e.map((x) => x.kind);

test('first poll is a baseline and raises nothing', () => {
  const t = createBurstEvents();
  assert.deepEqual(t.observe(near, 0), []);
  assert.deepEqual(t.observe(near, 1), []);
});

test('limit near, then failover, each fire once on their edge', () => {
  const t = createBurstEvents();
  t.observe(on(), 0);
  assert.deepEqual(kinds(t.observe(near, 1)), ['limit-near']);
  assert.deepEqual(t.observe(near, 2), [], 'steady state is silent');
  assert.deepEqual(kinds(t.observe(sec, 3)), ['failover']);
  assert.deepEqual(t.observe(sec, 4), []);
  assert.deepEqual(t.observe(near, 5), [], 'secondary easing back to near is not a new warning');
});

test('jumping straight to secondary raises failover only, not limit-near too', () => {
  const t = createBurstEvents();
  t.observe(on(), 0);
  assert.deepEqual(kinds(t.observe(sec, 1)), ['failover']);
});

test('bypass fires when Burst leaves the path; unsupported and empty views are ignored', () => {
  const t = createBurstEvents();
  t.observe(on(), 0);
  assert.deepEqual(t.observe(null, 1), []);
  assert.deepEqual(t.observe({ kind: 'unsupported' }, 2), []);
  assert.deepEqual(kinds(t.observe(off, 3)), ['bypass']);
  assert.deepEqual(t.observe(off, 4), []);
  assert.deepEqual(t.observe(on(), 5), []);
});

test('a flapping limit re-alerts only after the cooldown', () => {
  const t = createBurstEvents();
  t.observe(on(), 0);
  assert.equal(t.observe(near, 1).length, 1);
  t.observe(on(), 2);
  assert.equal(t.observe(near, 3).length, 0, 'inside the cooldown');
  t.observe(on(), 4);
  assert.equal(t.observe(near, COOLDOWN_MS + 5).length, 1);
});

test('quiet hours, snooze and project mute hold events through src/quiet.js', () => {
  const ev = [{ kind: 'failover', key: 'burst:failover' }];
  const now = new Date(2026, 9, 7, 23, 30).getTime();
  assert.deepEqual(gate(ev, {}, now), { send: ev, held: [], why: null });
  const quiet = { quietHours: { enabled: true, start: '22:00', end: '07:00' } };
  assert.deepEqual(gate(ev, quiet, now), { send: [], held: ev, why: 'quiet-hours' });
  assert.equal(gate(ev, { snoozeUntil: now + 1000 }, now).why, 'snooze');
  assert.equal(gate(ev, { snoozeUntil: now - 1 }, now).why, null);
});
