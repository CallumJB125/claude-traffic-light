// Exit (e): hb.ack current:false → fenced: pre denies ("taken over"), the CLI
// is stopped, the worktree is snapshotted to refs/board/<KEY>/r<n>-salvage
// (pushed) and salvage frames (snapshot, handover, note) reach the hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, fakeClock, advance, hookCall, alive } from './helpers.js';

test('revived zombie is fenced, stopped and salvaged', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const clock = fakeClock();
  const sup = await startRunner({
    hub, home: path.join(root, 'home'), repo, clock,
    scenario: { steps: [
      { tool: 'Write', input: { file_path: 'wip.txt', content: 'half done\n' } },
      { mcp: 'board_write_handover', args: { patch: { hypothesis: 'the cache key is wrong', next: 'fix key()' } } },
      { tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 },
    ] },
  });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-70', fence: 2 }));
    await waitFor(() => run.narrative, { what: 'handover written' });
    const pid = run.backend.pid;
    hub.fencedRuns.add(run.run_id);            // the card was taken over while we were away
    await advance(sup, clock, 16);
    await waitFor(() => run.fenced, { what: 'fenced' });
    const r = await hookCall(run, 'pre', { tool_name: 'Read', tool_input: { file_path: 'wip.txt' }, cwd: run.worktree }).catch(() => null);
    if (r) assert.match(r.result.stdout.hookSpecificOutput.permissionDecisionReason, /taken over/);
    await waitFor(() => run.ended, { what: 'run ended', timeout: 15000 });
    assert.ok(!alive(pid), 'CLI stopped');
    assert.equal(run.localState, 'fenced');
    await waitFor(() => hub.of('salvage').some((s) => s.kind === 'note'), { what: 'salvage frames received' });
    const salv = hub.of('salvage');
    const snap = salv.find((s) => s.kind === 'snapshot' && s.payload.ref.endsWith('-salvage'));
    assert.ok(snap, `salvage snapshot frame: ${JSON.stringify(salv)}`);
    assert.equal(snap.payload.ref, 'refs/board/APP-70/r3-salvage');
    assert.equal(snap.payload.status, 'pushed');
    assert.equal(snap.fence, 3);
    assert.ok(salv.find((s) => s.kind === 'handover' && s.payload.patch.hypothesis === 'the cache key is wrong'));
    assert.ok(salv.find((s) => s.kind === 'note'));
    const sha = execFileSync('git', ['--git-dir', repo.bare, 'rev-parse', 'refs/board/APP-70/r3-salvage'], { encoding: 'utf8' }).trim();
    assert.equal(sha, snap.payload.sha);
    const content = execFileSync('git', ['--git-dir', repo.bare, 'show', `${sha}:wip.txt`], { encoding: 'utf8' });
    assert.equal(content, 'half done\n');
    assert.equal(hub.outs('run.failed').length, 0);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('an rpc answered FENCED fences the run too; a `fenced` frame does as well', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  hub.rpcReply = () => ({ ok: false, error: { code: 'FENCED', message: 'stale fence' } });
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-71' }));
    await assert.rejects(run.tool('board_get_card', {}), (e) => e.code === 'FENCED');
    await waitFor(() => run.fenced && run.ended, { what: 'fenced and ended', timeout: 15000 });
    const run2 = await claimRun(sup, hub, offerFor({ key: 'APP-72' }));
    hub.send({ type: 'fenced', run_id: run2.run_id, card_id: run2.card_id, held_fence: run2.fence, current_fence: run2.fence + 1 });
    await waitFor(() => run2.fenced && run2.ended, { what: 'second fenced', timeout: 15000 });
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
