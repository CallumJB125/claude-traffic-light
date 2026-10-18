const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresence, validViewers, TTL_MS } = require('../src/session-presence.js');

test('presence: viewers appear on a beat, newest first, and vanish 60 s after their last beat', () => {
  let t = 1000; const p = createPresence({ now: () => t });
  assert.equal(p.beat('s1', { name: 'Ana Lopez', initials: 'AL' }), true);
  t += 10_000; p.beat('s1', { name: 'Ben Kim', initials: 'BK' });
  assert.deepEqual(p.viewers('s1').map(v => v.name), ['Ben Kim', 'Ana Lopez']);
  t += TTL_MS - 5000;
  assert.deepEqual(p.viewers('s1').map(v => v.name), ['Ben Kim']);
  t += TTL_MS;
  assert.deepEqual(p.viewers('s1'), []);
});

test('presence: a session not marked shared never records viewers; leave removes one', () => {
  const p = createPresence({ shared: k => k === 'shared-1' });
  assert.equal(p.beat('private-1', { name: 'Ana' }), false);
  assert.deepEqual(p.viewers('private-1'), []);
  p.beat('shared-1', { name: 'Ana' }); p.leave('shared-1', 'Ana');
  assert.deepEqual(p.viewers('shared-1'), []);
  assert.equal(validViewers([{ name: 'Ana', initials: 'A' }]), true);
  assert.equal(validViewers([{ name: '', initials: 'A' }]), false);
});
