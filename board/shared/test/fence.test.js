import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFence, compareFence, isCurrent, bump, restoreBump, formatFence, parseFence, branchName, snapshotRef, salvageRef, RESTORE_BUMP } from '../fence.js';

test('makeFence validates and freezes', () => {
  const f = makeFence(3, 'e1');
  assert.deepEqual(f, { n: 3, epoch: 'e1' });
  assert.ok(Object.isFrozen(f));
  assert.throws(() => makeFence(-1, 'e'));
  assert.throws(() => makeFence(1.5, 'e'));
  assert.throws(() => makeFence(1, ''));
});

test('only n decides currency; epoch is informational', () => {
  assert.equal(isCurrent(makeFence(3, 'old'), makeFence(3, 'new')), true);
  assert.equal(isCurrent(makeFence(2, 'e'), makeFence(3, 'e')), false);
  assert.equal(isCurrent(null, makeFence(3, 'e')), false);
  assert.ok(compareFence(makeFence(2, 'z'), makeFence(3, 'a')) < 0);
  assert.equal(compareFence(makeFence(3, 'z'), makeFence(3, 'a')), 0);
});

test('bump is +1 and strictly increasing; restore bump is +1000 with a new epoch', () => {
  const f = makeFence(7, 'e1');
  assert.deepEqual(bump(f), { n: 8, epoch: 'e1' });
  assert.deepEqual(bump(f, 'e2'), { n: 8, epoch: 'e2' });
  const r = restoreBump(f, 'e9');
  assert.deepEqual(r, { n: 7 + RESTORE_BUMP, epoch: 'e9' });
  // A zombie holding any fence issued before the backup can never be current again.
  for (let held = 0; held < 7 + 999; held++) assert.equal(isCurrent(makeFence(held, 'e1'), r), false);
});

test('wire form round-trips', () => {
  const f = makeFence(42, '2026-09-30T10:00:00Z-abc');
  assert.deepEqual(parseFence(formatFence(f)), f);
  assert.throws(() => parseFence('x@y'));
});

test('git names derive from the fence', () => {
  assert.equal(branchName('BDL-142', 3), 'board/BDL-142-r3');
  assert.equal(snapshotRef('BDL-142', 3), 'refs/board/BDL-142/r3');
  assert.equal(salvageRef('BDL-142', 3), 'refs/board/BDL-142/r3-salvage');
});
