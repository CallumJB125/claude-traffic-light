// Sleep detection (spike 8): tick-gap detector + injected powerMonitor.
// Short wake → pre waits for a hub round trip, then proceeds (rule 5).
// Long sleep (≥ G) → gate closed + interrupt until a current:true ack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { GATE_G_MS } from '../../shared/liveness.js';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, readFakeLog, fakeClock, advance, hookCall } from './helpers.js';

const pre = (run) => hookCall(run, 'pre', { tool_name: 'Glob', tool_input: { pattern: 'src/**' }, cwd: run.worktree }, { timeoutMs: 30000 });
const denied = (r) => r.result.stdout.hookSpecificOutput?.permissionDecision === 'deny';

test('tick gap of 8 s → wake recorded, hb carries slept_ms, pre waits for the round trip then proceeds', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const clock = fakeClock();
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, clock, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-40' }));
    await advance(sup, clock, 3);
    const hbBefore = hub.of('hb').length;
    clock.advance(8000);           // the event loop was frozen for 8 s
    sup.tick();
    assert.ok(run.wake, 'wake recorded');
    assert.ok(run.wake.slept_ms >= 6000 && run.wake.slept_ms <= 8000, `slept ${run.wake.slept_ms}`);
    await waitFor(() => hub.of('hb').length > hbBefore, { what: 'immediate hb after wake' });
    const hb = hub.of('hb').at(-1);
    assert.ok(hb.slept_ms >= 6000);
    await waitFor(() => !run.wake, { what: 'wake cleared by current ack' });
    const t0 = Date.now();
    assert.ok(!denied(await pre(run)));
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(run.gateOpen, true);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('short wake while the hub is silent: pre holds for the round trip (await_ack), then proceeds', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const clock = fakeClock();
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, clock, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-41' }));
    hub.holdHb = true;
    run.onWake(10000);
    assert.equal(run.gateState().reason, 'await_ack');
    let answered = false;
    const p = pre(run).then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(answered, false, 'pre is held while no ack has confirmed the fence');
    hub.releaseHb();
    const r = await p;
    assert.ok(!denied(r));
    assert.equal(run.wake, null);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('long sleep (≥ G) → gate closes + interrupt; reopens only on a current ack', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const clock = fakeClock();
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, clock, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-42' }));
    const saved = hub.frames.length;
    hub.down = 'reset';
    hub.dropAll();
    await waitFor(() => !sup.connected, { what: 'offline' });
    clock.advance(GATE_G_MS + 60000);
    sup.tick();
    assert.equal(run.gateOpen, false);
    assert.ok(['long_sleep', 'ack_stale'].includes(run.gateReason));
    assert.ok(denied(await pre(run)));
    await waitFor(() => readFakeLog(run.runDir).some((e) => e.ev === 'stdin' && e.msg.type === 'control_request'), { what: 'interrupt' });
    hub.down = null;
    await waitFor(() => sup.connected, { what: 'reconnected' });
    await waitFor(() => run.gateOpen, { what: 'reopened by current ack' });
    assert.ok(hub.frames.length > saved);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('powerMonitor suspend → host.suspending; resume after 10 min → gate closed until ack', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const clock = fakeClock();
  const pm = new EventEmitter();
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, clock, powerMonitor: pm, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-43' }));
    pm.emit('suspend');
    await waitFor(() => hub.of('host.suspending').length, { what: 'host.suspending' });
    assert.deepEqual(hub.of('host.suspending')[0].runs.map((r) => r.run_id), [run.run_id]);
    hub.down = 'reset';
    hub.dropAll();
    await waitFor(() => !sup.connected, { what: 'offline' });
    clock.advance(10 * 60 * 1000);
    pm.emit('resume');
    assert.ok(run.wake && run.wake.slept_ms >= 10 * 60 * 1000);
    sup.tick();
    assert.equal(run.gateOpen, false);
    hub.down = null;
    await waitFor(() => run.gateOpen, { what: 'reopened' });
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
