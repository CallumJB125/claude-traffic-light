'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/handoff-packet.js');

const input = { from: 'claude', to: 'codex', goal: 'Ship the wombat importer', files: ['src/a.js', 'src/a.js', 'src/b.js'], summary: 'Parser done; tests missing.', branch: 'claude/wombat' };
const opts = { home: '/Users/jane' };

test('build keeps the fields, dedupes files and validates', () => {
  const p = P.build(input, opts);
  assert.deepEqual(p.files, ['src/a.js', 'src/b.js']);
  assert.equal(p.to, 'codex');
  assert.deepEqual(P.validate(p), { ok: true, errors: [] });
});

test('build scrubs secrets and home paths from every free-text field', () => {
  const p = P.build({ ...input, goal: 'use api_key=sk-abcdefghijklmnopqrstuvwx', summary: 'see /Users/jane/secret-proj/x.js', files: ['/Users/jane/secret-proj/x.js'] }, opts);
  const all = JSON.stringify(p);
  assert.ok(!all.includes('sk-abcdefghijklmnop'));
  assert.ok(!all.includes('/Users/jane'));
  assert.deepEqual(p.files, ['~/secret-proj/x.js']);
});

test('build bounds sizes and ignores bad input', () => {
  const p = P.build({ ...input, goal: 'g'.repeat(5000), files: Array.from({ length: 200 }, (_, i) => `f${i}`) }, opts);
  assert.ok(p.goal.length <= P.LIMITS.goal);
  assert.equal(p.files.length, P.LIMITS.files);
  assert.equal(P.build(null).to, null);
  assert.equal(P.build({ to: 'Bad Tool!' }).to, null);
});

test('validate rejects missing goal, no target, same tool, wrong shape', () => {
  assert.equal(P.validate(P.build({ ...input, goal: '' }, opts)).ok, false);
  assert.equal(P.validate(P.build({ ...input, to: '' }, opts)).ok, false);
  assert.equal(P.validate(P.build({ ...input, to: 'claude' }, opts)).ok, false);
  assert.equal(P.validate(null).ok, false);
  assert.equal(P.validate({ ...P.build(input, opts), files: [3] }).ok, false);
});

test('release needs a confirmation bound to this exact packet', () => {
  const p = P.build(input, opts);
  assert.throws(() => P.release(p), /Confirm/);
  assert.throws(() => P.release(p, { confirmed: true }), /Confirm/);
  assert.throws(() => P.release(p, { confirmed: 'yes', digest: P.digest(p) }), /Confirm/);
  const c = P.confirmation(p);
  const text = P.release(p, c);
  assert.match(text, /Ship the wombat importer/);
  assert.match(text, /- src\/a\.js/);
  assert.throws(() => P.release({ ...p, goal: 'something else' }, c), /Confirm/);
});

test('release refuses an invalid packet even when confirmed', () => {
  const p = P.build({ ...input, goal: '' }, opts);
  assert.throws(() => P.release(p, P.confirmation(p)), /goal/i);
});
