import test from 'node:test';
import assert from 'node:assert/strict';
import { Run } from '../run.js';
const fixture = () => {
  const notes = [], ledger = [], ended = [], out = [];
  const sup = { log: { warn() {}, info() {} }, clock: { mono: () => 10, wall: () => 10 }, opts: {},
    windowsQuarantinedRepos: new Set(), notifyLocal: x => notes.push(x), saveLedger: r => ledger.push(r),
    emitOut: (_r, x) => out.push(x), runEnded: r => ended.push(r) };
  const run = new Run(sup, { run_id: 'run', repo_id: 'repo', key: 'T-1', fence: 1, worktree: '/never-read', offer: {} });
  run.backend = { platform: 'win32', exited: true, stop: async () => false, confirmStopped: async () => false, endInput() {} };
  return { run, sup, notes, ledger, ended, out };
};
for (const action of ['fail', 'prepFailed', 'finish', 'command']) test(`Windows ${action} retains ownership and prevents handover without a stop receipt`, async () => {
  const f = fixture();
  if (action === 'command') await f.run.command({ cmd: 'stop' });
  else await f.run[action]('error', 'fixture');
  assert.equal(f.run.windowsStopUnconfirmed, true); assert.equal(f.run.ended, false); assert.equal(f.ended.length, 0);
  assert.equal(f.run.gateState().open, false); assert.ok(f.ledger.length); assert.ok(f.sup.windowsQuarantinedRepos.has('repo'));
  assert.match(f.notes.at(-1).reason, /quarantined/); assert.equal(await f.run.snapshotNow(), null);
});
test('a queued snapshot rechecks quarantine before touching the workspace', async () => {
  const f = fixture(); let release;
  f.run.snapshotChain = new Promise(r => { release = r; });
  const snapshot = f.run.snapshotNow(); f.run.windowsStopUnconfirmed = true; release();
  assert.equal(await snapshot, null); assert.equal(f.out.length, 0);
});
