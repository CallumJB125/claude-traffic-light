// Gate close escalation + same-machine resume: a CLI that doesn't end its turn
// on interrupt is SIGKILLed after the grace; when a current ack reopens the
// gate the session continues with --resume <session_id> and the SAME isolation
// flags (spike 5a).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GATE_G_MS } from '../../shared/liveness.js';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, readFakeLog, fakeClock, advance, alive } from './helpers.js';

test('gate close → interrupt ignored → SIGKILL tree; reopen → --resume with the same profile', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const clock = fakeClock();
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, clock, scenario: { ignore_interrupt: true, steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, grandchild: true, ms: 600000 }], resume_steps: [{ result: 'success' }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'R-1' }));
    const gc = await waitFor(() => readFakeLog(run.runDir).find((e) => e.ev === 'grandchild'), { what: 'grandchild' });
    const firstPid = run.backend.pid;
    sup.tick();
    hub.down = 'reset';
    hub.dropAll();
    await waitFor(() => !sup.connected, { what: 'offline' });
    await advance(sup, clock, Math.ceil(GATE_G_MS / 1000) + 1);
    assert.equal(run.gateOpen, false);
    await waitFor(() => !alive(firstPid) && !alive(gc.pid), { what: 'killed after grace', timeout: 5000 });
    assert.equal(run.ended, false, 'paused, not ended');
    assert.equal(hub.outs('run.failed').length, 0, JSON.stringify(hub.outs('run.failed')));
    hub.down = null;
    await waitFor(() => run.gateOpen, { what: 'reopened' });
    await waitFor(() => run.backend.pid !== firstPid && run.backend.alive(), { what: 'resumed' });
    const starts = await waitFor(() => { const s = readFakeLog(run.runDir).filter((e) => e.ev === 'start'); return s.length === 2 && s; }, { what: 'second start logged' });
    const [a, b] = starts.map((s) => s.argv);
    assert.equal(b[b.indexOf('--resume') + 1], run.sessionId);
    assert.ok(!b.includes('--session-id'));
    const strip = (v) => v.filter((x, i) => !['--resume', '--session-id'].includes(x) && !['--resume', '--session-id'].includes(v[i - 1]));
    assert.deepEqual(strip(b), strip(a), 'identical isolation flags');
    assert.equal(starts[1].resume, true);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
