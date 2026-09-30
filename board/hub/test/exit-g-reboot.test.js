// Exit (g): a Pi reboot < 4 min orphans nothing. Reopen the same DB with a new
// hub_epoch: live cards show reconnecting, the runner's first HB of the new
// epoch recovers them; a runner that stays away goes unresponsive after TTL
// of uptime but is never orphaned inside the boot grace. Restore from backup
// bumps every fence by 1000, so old leases come back FENCED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TTL_MS } from '../../shared/liveness.js';
import { startHub, fakeClock, runHb, runMsg } from './helpers.js';

test('exit (g): hub restart → reconnecting → first HB of the new epoch recovers; nothing orphaned after +3 min', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-reboot-'));
  try {
    let h = await startHub({ dataDir });
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r1 = await h.runner(dev);
    const run = await h.startRun(alice, r1);
    const run2 = await h.startRun(alice, r1);
    await r1.rpc(run2, 'board_ask_human', { kind: 'question', text: 'which bank?' });
    assert.equal(h.card(run2.card_id).run_state, 'blocked');
    const epoch1 = h.hub.epoch;
    const closed = r1.closed();
    await h.close();                                  // Pi reboots
    assert.equal(await closed, 4000, 'runners told the hub is shutting down');

    h = await startHub({ dataDir, clock: fakeClock(50_000) });
    try {
      assert.notEqual(h.hub.epoch, epoch1);
      assert.equal(h.card(run.card_id).run_state, 'reconnecting');
      assert.equal(h.card(run.card_id).pre_reconnect_state, 'running');
      assert.equal(h.card(run2.card_id).run_state, 'reconnecting');
      assert.equal(h.card(run2.card_id).resume_to, 'blocked');

      // Runner stays away 3 min: unresponsive after TTL of uptime, never orphaned.
      await h.run(3 * 60_000);
      assert.equal(h.card(run.card_id).run_state, 'unresponsive');
      assert.equal(h.card(run2.card_id).run_state, 'unresponsive');

      const r2 = await h.runner(dev, { runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'running' }, { run_id: run2.run_id, card_id: run2.card_id, fence: run2.fence, local_state: 'running' }] });
      assert.equal(r2.welcome.hub_epoch, h.hub.epoch);
      assert.equal(r2.all('fenced').length, 0);
      const ack = await r2.hb([runHb(run), runHb(run2)]);
      assert.deepEqual(ack.runs.map((x) => x.current), [true, true]);
      assert.equal(ack.hub_epoch, h.hub.epoch);
      assert.equal(h.card(run.card_id).run_state, 'quiet', 'recovers grey; green needs fresh activity');
      assert.equal(h.card(run2.card_id).run_state, 'blocked', 'Needs you survives the restart');
      await r2.out({ kind: 'activity', ...runMsg(run), source: 'assistant' });
      assert.equal(h.card(run.card_id).run_state, 'running');
      for (let t = 0; t < 10 * 60_000; t += 15_000) {
        await h.tick(15_000);
        await r2.hb([runHb(run, { last_activity_age_ms: 1000 }), runHb(run2)]);
      }
      assert.equal(h.db.get("SELECT count(*) AS n FROM cards WHERE run_state = 'orphaned'").n, 0);
    } finally {
      await h.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('exit (g): a runner that reconnects inside the window never sees unresponsive', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-reboot-'));
  try {
    let h = await startHub({ dataDir });
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const run = await h.startRun(alice, await h.runner(dev));
    await h.close();
    h = await startHub({ dataDir, clock: fakeClock(9_000_000) });
    try {
      await h.run(TTL_MS - 5000);
      assert.equal(h.card(run.card_id).run_state, 'reconnecting');
      const r = await h.runner(dev, { runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'running' }] });
      await r.hb([runHb(run)]);
      assert.equal(h.card(run.card_id).run_state, 'quiet');
    } finally {
      await h.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('exit (g): restore from backup bumps fences by 1000 with a new epoch; old leases are FENCED', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-restore-'));
  try {
    let h = await startHub({ dataDir });
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const run = await h.startRun(alice, await h.runner(dev));
    await h.close();
    writeFileSync(join(dataDir, 'board.db.restored'), '');   // marker left by the restore script
    h = await startHub({ dataDir, clock: fakeClock(7_000_000) });
    try {
      const c = h.card(run.card_id);
      assert.equal(c.fence, run.fence + 1000);
      assert.equal(c.run_state, 'reconnecting');
      assert.equal(h.db.meta('fence_bump_applied'), '1000');
      assert.equal(h.db.meta('hub_epoch'), h.hub.epoch);
      const r = await h.runner(dev, { runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'running' }] });
      const fenced = await r.next('fenced', (m) => m.run_id === run.run_id);
      assert.equal(fenced.current_fence, run.fence + 1000);
      const ack = await r.hb([runHb(run)]);
      assert.deepEqual([ack.runs[0].current, ack.runs[0].reason], [false, 'FENCED']);
    } finally {
      await h.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
