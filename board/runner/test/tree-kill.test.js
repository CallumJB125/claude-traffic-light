// Stop recipe (spikes 5b–5e): interrupt → end stdin → SIGTERM → SIGKILL the
// CLI (pid + lstart still match) and every descendant process group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, readFakeLog, alive } from './helpers.js';
import { killTree, lstartOf, descendants, treeGroups } from '../procs.js';

test('stop cmd on a CLI that ignores SIGTERM kills it and its detached tool tree', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { ignore_term: true, ignore_eof: true, steps: [{ tool: 'Bash', input: { command: 'sleep 300' }, grandchild: true, ms: 120000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-10' }));
    const gc = await waitFor(() => readFakeLog(run.runDir).find((e) => e.ev === 'grandchild'), { what: 'grandchild' });
    const pid = run.backend.pid;
    // interrupt aborts the fake's tool wait; then it is idle and ignores SIGTERM
    hub.send({ type: 'cmd', cmd_id: 'c1', run_id: run.run_id, card_id: run.card_id, fence: run.fence, cmd: 'stop' });
    await waitFor(() => run.ended, { what: 'run ended', timeout: 15000 });
    await waitFor(() => !alive(pid) && !alive(gc.pid), { what: 'tree dead', timeout: 5000 });
    const log = readFakeLog(run.runDir);
    assert.ok(log.some((e) => e.ev === 'stdin' && e.msg.type === 'control_request'), 'interrupt sent first');
    assert.ok(log.some((e) => e.ev === 'eof'), 'then end of stdin');
    assert.ok(log.some((e) => e.ev === 'signal' && e.sig === 'SIGTERM'), 'then SIGTERM (ignored, so SIGKILL + group kill)');
    assert.equal(run.endReason, 'stopped');
    assert.equal(hub.outs('run.failed').length, 0, 'a hub-ordered stop is not a failure');
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('killTree refuses a pid whose lstart does not match (pid reuse)', async () => {
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  await waitFor(() => lstartOf(child.pid), { what: 'lstart' });
  const r = killTree(child.pid, 'Thu Jan  1 00:00:00 1970');
  assert.deepEqual(r, { groups: [], pids: [] });
  assert.ok(alive(child.pid));
  killTree(child.pid, lstartOf(child.pid));
  await waitFor(() => !alive(child.pid), { what: 'killed' });
});

test('descendants/treeGroups find a detached grandchild group', async () => {
  const parent = spawn('/bin/sh', ['-c', `'${process.execPath}' -e "require('child_process').spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'}).unref(); setTimeout(()=>{},30000)"`], { detached: true, stdio: 'ignore' });
  await waitFor(() => descendants(parent.pid).some((d) => d.pgid !== parent.pid), { what: 'grandchild group' });
  const { groups } = treeGroups(parent.pid);
  assert.ok(groups.length >= 2);
  const kids = descendants(parent.pid).map((d) => d.pid);
  killTree(parent.pid, lstartOf(parent.pid));
  await waitFor(() => !alive(parent.pid) && kids.every((k) => !alive(k)), { what: 'all dead' });
});
