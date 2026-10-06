const test = require('node:test');
const assert = require('node:assert/strict');
const { spendMinGap, HIDDEN_GAP_MS } = require('../src/spend-poll.js');

test('a visible window keeps the requested gap', () => {
  assert.equal(spendMinGap({ minGap: 3000, anyVisible: true }), 3000);
  assert.equal(spendMinGap({ minGap: 14000, anyVisible: true }), 14000);
});

test('nothing visible stretches the gap to a minute', () => {
  assert.equal(spendMinGap({ minGap: 3000, anyVisible: false }), HIDDEN_GAP_MS);
  assert.equal(spendMinGap({ minGap: 14000, anyVisible: false }), 60000);
});

test('a gap already longer than a minute is left alone', () => {
  assert.equal(spendMinGap({ minGap: 120000, anyVisible: false }), 120000);
});
