const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/enter-allow.js');

test('C-G: a gesture deny acts only when exactly one request is waiting', () => {
  const a = { id: 'r1', kind: 'permission' };
  const b = { id: 'r2', kind: 'permission' };
  assert.deepEqual(E.gestureDenyTarget([a]), { req: a });
  assert.deepEqual(E.gestureDenyTarget([]), { req: null });
  assert.deepEqual(E.gestureDenyTarget(undefined), { req: null });
  const two = E.gestureDenyTarget([a, b]);
  assert.equal(two.req, undefined);
  assert.match(two.why, /2 waiting/);
});
