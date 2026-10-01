import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { communicationRig } from './communication-helpers.js';
import { runHb } from './helpers.js';
import { ownershipPath } from '../ownership.js';

const declare = (p, paths, generation) => p.client.rpc(p.run, 'board_declare_plan', { paths,
  ...(generation ? { ownership_generation: generation } : {}) });
const read = (p) => p.client.rpc(p.run, 'board_check_overlap');

// Actual valid same-repository card/run ownership records; no agent process.
function peerRecord(h, a, board, paths) {
  assert.ok(paths.length <= 200 && paths.every((p) => ownershipPath(p) === p));
  const source = h.hub.run(a.run.run_id);
  const card = { ...h.hub.card(a.run.card_id), id: randomUUID(), board_id: board,
    key: 'WORK-' + randomUUID(), active_run_id: null };
  h.db.insert('cards', card);
  const dispatch = randomUUID();
  h.db.insert('dispatches', { request_id: dispatch, card_id: card.id, dispatched_by: source.dispatched_by,
    state: 'claimed', created_at: h.hub.iso() });
  const run = { ...source, id: randomUUID(), card_id: card.id, dispatch_request_id: dispatch };
  h.db.insert('runs', run);
  h.db.run('UPDATE cards SET active_run_id=? WHERE id=?', run.id, card.id);
  h.hub.ownership.register(run, card, { known: true });
  h.db.run('UPDATE task_ownership SET paths=?,intent_version=1 WHERE run_id=?', JSON.stringify(paths), run.id);
  return run.id;
}

for (const [shape, prefix, segmentBudget] of [
  ['long shared segment', 'a'.repeat(480), 100_000],
  ['maximum segment depth', 'a/'.repeat(242) + 'a', 5_000_000],
]) test(`maximum valid ownership source has finite comparison work: ${shape}`, async (t) => {
  const { h, A, sender: a, users } = await communicationRig(t);
  const own = Array.from({ length: 200 }, (_, i) => `${prefix}/own${i}`);
  assert.ok(own.every((p) => ownershipPath(p) === p));
  assert.equal((await declare(a, own)).ok, true);
  for (let i = 0; i < 49; i++) peerRecord(h, a, A.board,
    Array.from({ length: 200 }, (_, k) => `${prefix}/peer${i}-${k}`));
  const member = h.hub.member(A.viewer), cred = { kind: 'device', id: users.aviewer.device_id };
  // Count actual primitive work, not a fragile elapsed-time threshold. The old
  // all-pairs projection needs 3.92 million prefix checks for this valid input.
  let prefixChecks = 0, normalizations = 0, lookups = 0;
  const startsWith = String.prototype.startsWith, replace = String.prototype.replace, get = Map.prototype.get;
  const begin = performance.now(); let result;
  try {
    String.prototype.startsWith = function (...args) { prefixChecks++; return startsWith.apply(this, args); };
    String.prototype.replace = function (...args) { normalizations++; return replace.apply(this, args); };
    Map.prototype.get = function (...args) { lookups++; return get.apply(this, args); };
    result = await h.hub.ownership.staffRead(member, a.run.card_id, cred, { boardIds: [A.board] });
  } finally {
    String.prototype.startsWith = startsWith; String.prototype.replace = replace; Map.prototype.get = get;
  }
  t.diagnostic(`50 x 200 paths: prefix=${prefixChecks}, normalization=${normalizations}, map=${lookups}, ${(performance.now() - begin).toFixed(1)}ms`);
  assert.equal(result.ownership_intents.length, 50);
  assert.equal(result.ownership_truncated, false);
  assert.equal(result.ownership_overlaps.length, 0);
  assert.ok(result.ownership_intents.every((r) => r.paths.length === 20 && r.paths_truncated));
  assert.ok(prefixChecks < 50_000, 'prefix checks must not scale with own paths times peer paths');
  assert.ok(normalizations < 25_000, 'each source path is normalized once, not once per pair');
  assert.ok(lookups < segmentBudget, 'segment traversal must have a finite linear input budget');
});

test('staff, runner reads and declaration responses share a member quota before projection or writes', async (t) => {
  const x = await communicationRig(t), { h, sender: a, recipient: b } = x;
  const secondInstall = await h.signIn(a.user.email); assert.equal(secondInstall.status, 200);
  const anotherRun = await x.participant({ ...a.user, token: secondInstall.body.device_token,
    device_id: secondInstall.body.device_id });
  h.hub.limiter.limits.ownership_read_member = { capacity: 2, per_ms: 60_000 };
  let projections = 0;
  const snapshot = h.hub.ownership.snapshotFor.bind(h.hub.ownership);
  h.hub.ownership.snapshotFor = (...args) => { projections++; return snapshot(...args); };
  const d = await declare(a, ['src/quota.js']); assert.equal(d.ok, true);
  const member = h.hub.member(h.hub.run(a.run.run_id).on_behalf_of);
  const cred = { kind: 'device', id: a.user.device_id };
  await h.hub.ownership.staffRead(member, a.run.card_id, cred);
  assert.equal(projections, 2);
  const before = JSON.stringify({ record: h.db.get('SELECT * FROM task_ownership WHERE run_id=?', a.run.run_id),
    paths: h.hub.run(a.run.run_id).planned_paths, journal: h.db.all("SELECT * FROM journal WHERE kind='plan.declare'"),
    permissions: h.db.all('SELECT * FROM permission_requests WHERE run_id=?', a.run.run_id) });
  assert.equal((await read(a)).error?.code, 'RATE_LIMITED');
  assert.equal((await read(anotherRun)).error?.code, 'RATE_LIMITED', 'a second enrollment/run cannot reset the same member quota');
  assert.throws(() => h.hub.ownership.staffRead(member, a.run.card_id, cred), { code: 'RATE_LIMITED' });
  assert.equal((await declare(a, ['src/uncommitted.js'], d.result.ownership.generation)).error?.code, 'RATE_LIMITED');
  assert.equal(projections, 2, 'no expensive work once the member quota is exhausted');
  assert.equal(JSON.stringify({ record: h.db.get('SELECT * FROM task_ownership WHERE run_id=?', a.run.run_id),
    paths: h.hub.run(a.run.run_id).planned_paths, journal: h.db.all("SELECT * FROM journal WHERE kind='plan.declare'"),
    permissions: h.db.all('SELECT * FROM permission_requests WHERE run_id=?', a.run.run_id) }), before);
  assert.equal((await declare(b, ['src/other-member.js'])).ok, true, 'another member has a separate quota');
  await a.client.hb([runHb(a.run)]);
  h.clock.advance(30_000);
  assert.equal((await read(a)).ok, true, 'monotonic refill admits a read');
});

test('indexed overlap preserves literal and terminal wildcard segment semantics, order and truncation', async (t) => {
  const { h, sender: a, recipient: b } = await communicationRig(t);
  const expected = (own, peers) => own.filter((a) => peers.some((b) => {
    const left = a.replace(/\/\*\*$/, ''), right = b.replace(/\/\*\*$/, '');
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }));
  // Parent first/last must prune redundant descendants without losing sibling
  // matches. Keep own literals and /** distinct in their original order.
  const cases = [
    [['src/api', 'src/api/**', 'src/api/a.js', 'src/apix', 'src', 'lib/a.js', 'src/z'],
      ['src/api/deep/a.js', 'src/api/**', 'src/apix/child', 'lib/a.js/x']],
    [['src/api', 'src/api/**', 'src/api/a.js', 'src/apix', 'src', 'lib/a.js', 'src/z'],
      ['src/api/**', 'src/api/deep/a.js', 'src/apix/child', 'lib/a.js/x']],
    [['src/é', 'src/é/**', 'src/éx', 'Src/a', 'src/a', 'lib'], ['src/é/a', 'src/a', 'Lib/a']],
    [['src/a/b', 'src/a', 'src/ab', 'src'], ['src/a/b/c', 'src/a/d', 'src/abx/e']],
    [[], ['src/**']],
    [['src/**'], []],
    [Array.from({ length: 200 }, (_, i) => `src/a${i}`), ['src/**']],
  ];
  for (const [own, peers] of cases) {
    assert.ok([...own, ...peers].every((p) => ownershipPath(p) === p));
    // Intent changes use the actual declaration route and its generation,
    // rather than bypassing the validated source or fresh authority checks.
    const priorA = (await read(a)).result.ownership.generation;
    const priorB = (await read(b)).result.ownership.generation;
    assert.equal((await declare(a, own, priorA)).ok, true);
    assert.equal((await declare(b, peers, priorB)).ok, true);
    const result = (await read(a)).result.ownership_overlaps.find((p) => p.run_id === b.run.run_id);
    const paths = expected(own, peers);
    if (!paths.length) assert.equal(result, undefined);
    else { assert.deepEqual(result.paths, paths.slice(0, 20)); assert.equal(result.paths_truncated, paths.length > 20); }
  }
});
