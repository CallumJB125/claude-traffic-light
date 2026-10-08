const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatusGate } = require('../src/status-gate.js');

test('first status always broadcasts, an identical one does not', () => {
  let t = 1000;
  const g = createStatusGate({ forceMs: 3500, now: () => t });
  const st = { look: { name: 'idle' }, sessions: [] };
  assert.equal(g.changed(st), true);
  g.mark(st);
  t += 300;
  assert.equal(g.changed({ look: { name: 'idle' }, sessions: [] }), false);
});

test('a changed status broadcasts', () => {
  let t = 1000;
  const g = createStatusGate({ now: () => t });
  g.mark({ look: { name: 'idle' } });
  t += 10;
  assert.equal(g.changed({ look: { name: 'busy' } }), true);
});

test('an unchanged status is still let through once forceMs has passed', () => {
  let t = 1000;
  const g = createStatusGate({ forceMs: 3500, now: () => t });
  const st = { a: 1 };
  g.mark(st);
  t += 3499;
  assert.equal(g.changed(st), false);
  t += 1;
  assert.equal(g.changed(st), true);
});

test('cameo photo payload is compared by rev, not by its data URL', () => {
  const g = createStatusGate({ now: () => 0 });
  g.mark({ look: { cameoPhoto: { rev: 1, src: 'data:aaa' } } });
  assert.equal(g.changed({ look: { cameoPhoto: { rev: 1, src: 'data:bbb' } } }), false);
  assert.equal(g.changed({ look: { cameoPhoto: { rev: 2, src: 'data:aaa' } } }), true);
});

test('reset forces the next broadcast', () => {
  const g = createStatusGate({ now: () => 0 });
  g.mark({ a: 1 });
  g.reset();
  assert.equal(g.changed({ a: 1 }), true);
});
