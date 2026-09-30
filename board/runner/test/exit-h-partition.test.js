// Exit (h): a partitioned runner blocks tools and interrupts the CLI at G,
// before the hub could orphan it (G < T_orphan); an ack 30 min old plus an
// origin-down edge never reopens the gate; only a current:true ack does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GATE_G_MS, T_ORPHAN_MS } from '../../shared/liveness.js';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, readFakeLog, fakeClock, advance, hookCall } from './helpers.js';

const pre = (run) => hookCall(run, 'pre', { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: run.worktree });
const denied = (r) => r.result.stdout.hookSpecificOutput?.permissionDecision === 'deny';

test('partition: pre denies + interrupt at G < T_orphan; stale ack + 530 stays closed; current ack reopens', async () => {
  assert.ok(GATE_G_MS < T_ORPHAN_MS);
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const clock = fakeClock();
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, clock, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-20' }));
    await waitFor(() => run.toolInFlight, { what: 'tool running' });
    await advance(sup, clock, 16);                                 // one HB round trip
    await waitFor(() => hub.of('hb').some((h) => h.runs.length), { what: 'hb with run' });
    await new Promise((r) => setTimeout(r, 50));
    const ackMono = run.ack.mono;
    assert.ok(ackMono > clock.mono() - 16000, 'fresh fence-confirming ack');

    hub.down = 'reset';                                            // partition: the edge is unreachable
    hub.dropAll();
    await waitFor(() => !sup.connected, { what: 'disconnected' });

    const toG = GATE_G_MS - (clock.mono() - ackMono);
    await advance(sup, clock, Math.floor(toG / 1000) - 2);
    assert.equal(run.gateOpen, true, 'still open just before G');
    assert.ok(!denied(await pre(run)));
    const interruptsBefore = readFakeLog(run.runDir).filter((e) => e.ev === 'stdin' && e.msg.type === 'control_request').length;

    await advance(sup, clock, 3);
    assert.equal(run.gateOpen, false, 'closed at G');
    const age = clock.mono() - ackMono;
    assert.ok(age >= GATE_G_MS && age < T_ORPHAN_MS, `closed at ack age ${age}`);
    assert.equal(run.localState, 'paused_offline');
    const r = await pre(run);
    assert.ok(denied(r));
    assert.match(r.result.stdout.hookSpecificOutput.permissionDecisionReason, /gate is closed/);
    await waitFor(() => readFakeLog(run.runDir).filter((e) => e.ev === 'stdin' && e.msg.type === 'control_request').length > interruptsBefore, { what: 'interrupt sent' });
    assert.equal(hub.outs('run.failed').length, 0, 'an interrupted turn at gate close is not a failure');

    // 30 minutes later the edge answers 530 / 1033 (origin down): still closed.
    hub.down = 530;
    await advance(sup, clock, 26 * 60, 1000);
    await waitFor(() => sup.originDown, { what: 'origin down seen' });
    assert.equal(run.gateOpen, false);
    assert.ok(denied(await pre(run)));

    // Hub back: welcome → hb → current:true ack reopens, and the agent is told to continue.
    hub.down = null;
    await waitFor(() => sup.connected, { what: 'reconnected' });
    await waitFor(() => run.gateOpen, { what: 'gate reopened' });
    assert.equal(run.localState, 'running');
    assert.ok(!denied(await pre(run)));
    await waitFor(() => readFakeLog(run.runDir).some((e) => e.ev === 'turn' && /connection restored/.test(e.text)), { what: 'continue message' });
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
