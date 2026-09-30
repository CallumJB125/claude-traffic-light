// Exit (b): kill -9 the CLI → run.failed reaches the hub in < 1 s, the tool
// tree that outlived it is reaped, and the final snapshot follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, readFakeLog, alive, fakeClock } from './helpers.js';

test('kill -9 of the CLI → run.failed{error} within 1 s; grandchild tool tree killed', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const clock = fakeClock();
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, clock, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 300' }, grandchild: true, ms: 60000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-9' }));
    const gc = await waitFor(() => readFakeLog(run.runDir).find((e) => e.ev === 'grandchild'), { what: 'grandchild' });
    await waitFor(() => run.toolInFlight, { what: 'tool in flight' });
    sup.tick();   // the tick records the tool tree while claude is alive
    assert.ok(alive(gc.pid));
    const t0 = Date.now();
    process.kill(run.backend.pid, 'SIGKILL');
    await waitFor(() => hub.outs('run.failed').length, { what: 'run.failed', timeout: 1000 });
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `run.failed after ${ms} ms`);
    const f = hub.outs('run.failed')[0];
    assert.equal(f.fail_kind, 'error');
    assert.match(f.reason, /claude exited/);
    await waitFor(() => !alive(gc.pid), { what: 'grandchild reaped', timeout: 3000 });
    await waitFor(() => run.ended, { what: 'run ended' });
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
