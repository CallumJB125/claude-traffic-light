// Exit (g), runner half: a hub/tunnel outage shorter than G (edge answers
// 530 / error 1033) keeps the gate open and the agent working; it closes at
// G like any partition, and 530 never reopens it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GATE_G_MS } from '../../shared/liveness.js';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, fakeClock, advance, hookCall } from './helpers.js';

const pre = (run) => hookCall(run, 'pre', { tool_name: 'Read', tool_input: { file_path: `${run.worktree}/README.md` }, cwd: run.worktree });
const denied = (r) => r.result.stdout.hookSpecificOutput?.permissionDecision === 'deny';

test('530 for 3 min: gate stays open, tools proceed, outbox queues; hub back → replayed delayed and acked', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const clock = fakeClock();
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, clock, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-30' }));
    await advance(sup, clock, 16);
    await new Promise((r) => setTimeout(r, 50));
    const ackMono = run.ack.mono;

    hub.down = 530;          // Pi reboot / cloudflared down
    hub.dropAll();
    await waitFor(() => sup.originDown, { what: 'origin down' });
    await advance(sup, clock, 180);
    assert.ok(clock.mono() - ackMono < GATE_G_MS);
    assert.equal(run.gateOpen, true, 'short outage: gate open');
    const pr = await pre(run);
    assert.ok(!denied(pr), `agents keep working: ${JSON.stringify(pr)}`);
    // Work done offline goes to the outbox, marked offline.
    const e = run.emit({ kind: 'progress.append', text: 'offline progress' });
    assert.equal(e.offline, true);

    hub.down = null;         // hub back within G
    await waitFor(() => sup.connected, { what: 'reconnected' });
    await waitFor(() => hub.frames.some((f) => f.type === 'out' && f.msg.kind === 'progress.append'), { what: 'replay' });
    const replay = hub.frames.find((f) => f.type === 'out' && f.msg.kind === 'progress.append');
    assert.equal(replay.delayed, true, 'replayed entries are delayed');
    await waitFor(() => sup.outbox.acked === sup.outbox.head, { what: 'all acked' });
    assert.equal(run.gateOpen, true);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('530 longer than G: closes at G; a later 530 never reopens; only current:true does', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const clock = fakeClock();
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, clock, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-31' }));
    hub.down = 530;
    hub.dropAll();
    await waitFor(() => sup.originDown, { what: 'origin down' });
    await advance(sup, clock, Math.ceil(GATE_G_MS / 1000) + 1);
    assert.equal(run.gateOpen, false);
    assert.ok(denied(await pre(run)));
    await advance(sup, clock, 60);
    assert.equal(run.gateOpen, false, '530 does not reopen');
    // Hub returns but says the run is no longer current → stays closed and is fenced.
    hub.current = false;
    hub.down = null;
    await waitFor(() => sup.connected, { what: 'reconnected' });
    await waitFor(() => run.fenced, { what: 'fenced' });
    assert.equal(run.gateOpen, false);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
