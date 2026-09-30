// Exit (a), runner half: offer → claim → worktree + fake claude → first
// `activity` well inside 60 s; hello/welcome/advertise/hb; facts via hooks;
// board tools over IPC; board_complete ends the run after the turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, readFakeLog, REPO_ID, OWNER } from './helpers.js';

test('self-dispatched offer is claimed and spawned; activity < 60 s; complete ends the run', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  hub.rpcReply = (f) => (f.method === 'board_complete' ? { ok: true, result: { state: 'in_review' } } : { ok: true, result: { card: { key: 'APP-1' } } });
  const sup = await startRunner({
    hub, home: path.join(root, 'home'), repo,
    scenario: {
      steps: [
        { tool: 'Write', input: { file_path: 'src/a.js', content: 'export const a = 1;\n' } },
        { tool: 'Bash', input: { command: 'npm test' }, output: 'tests 3\npass 3' },
        { tool: 'TodoWrite', input: { todos: [{ content: 'write a', status: 'completed' }, { content: 'test', status: 'in_progress' }] } },
        { tool: 'TaskCreate', input: { subject: 'write b', description: 'b.js' }, response: { task: { id: '7', subject: 'write b' } } },
        { tool: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' }, response: { success: true } },
        { mcp: 'board_update_status', args: { summary: 'writing a.js' } },
        { mcp: 'board_complete', args: { summary: 'done', evidence_ids: ['e1'] } },
        { result: 'success', cost: 0.02 },
      ],
    },
  });
  try {
    const hello = hub.of('hello')[0];
    assert.equal(hello.protocol, 1);
    assert.equal(hello.device_id, 'dev-1');
    assert.equal(hub.lastAuth, 'Bearer bdt_testtoken');
    assert.deepEqual(hub.of('advertise')[0].repos.map((r) => r.repo_id), [REPO_ID]);
    assert.ok(hub.of('hb').length >= 1, 'first hb right after welcome');

    fs.mkdirSync(path.join(repo.checkout, 'src'), { recursive: true });
    const t0 = Date.now();
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-1', fence: 4 }));
    const claim = hub.of('claim')[0];
    assert.equal(claim.expected_fence, 4);
    assert.equal(run.fence, 5);
    assert.equal(run.branch, 'board/APP-1-r5');
    await waitFor(() => hub.outs('activity').length, { what: 'first activity' });
    assert.ok(Date.now() - t0 < 60000);
    assert.equal(hub.outs('activity')[0].source, 'init');

    // Worktree on the run branch, CLI cwd = worktree.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: run.worktree, encoding: 'utf8' }).trim();
    assert.equal(branch, 'board/APP-1-r5');
    const start = readFakeLog(run.runDir).find((e) => e.ev === 'start');
    assert.equal(fs.realpathSync(start.cwd), run.worktree);

    // The run ends after the turn that called board_complete.
    await waitFor(() => !sup.runs.has(run.run_id), { what: 'run ended', timeout: 15000 });
    assert.equal(run.endReason, 'completed');
    await waitFor(() => sup.outbox.acked === sup.outbox.head, { what: 'outbox drained' });
    assert.ok(!hub.outs('run.failed').length, 'a completed run is not failed');

    const facts = hub.facts();
    assert.ok(facts.some((f) => f.kind === 'file' && f.path === 'src/a.js' && f.op === 'write'), 'file fact is repo-relative');
    assert.ok(facts.some((f) => f.kind === 'command' && f.cmd === 'npm test' && f.exit === 0), 'test command fact');
    assert.ok(facts.some((f) => f.kind === 'plan' && f.items[1]?.status === 'doing'), 'TodoWrite mirror');
    assert.ok(facts.some((f) => f.kind === 'plan' && f.items.length === 1 && f.items[0].text === 'write b' && f.items[0].status === 'doing'), 'TaskCreate/TaskUpdate mirror');
    assert.ok(facts.some((f) => f.kind === 'cost' && f.cost_usd === 0.02));
    assert.ok(facts.some((f) => f.kind === 'session'));
    assert.equal(hub.outs('status.update')[0].summary, 'writing a.js');
    const rpc = hub.of('rpc').find((f) => f.method === 'board_complete');
    assert.equal(rpc.run_token, run.run_token);
    assert.equal(rpc.repo_id, REPO_ID);
    // Final snapshot pushed to refs/board/APP-1/r5.
    const snap = hub.outs('snapshot').at(-1);
    assert.equal(snap.status, 'pushed');
    assert.equal(snap.ref, 'refs/board/APP-1/r5');
    assert.ok(execFileSync('git', ['--git-dir', repo.bare, 'rev-parse', 'refs/board/APP-1/r5'], { encoding: 'utf8' }).trim());
    // Outbox seqs are strictly increasing and all acked.
    const seqs = hub.of('out').map((f) => f.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(sup.outbox.acked, sup.outbox.head);
    // Hook SessionStart got the team context.
    const ss = readFakeLog(run.runDir).find((e) => e.ev === 'hook' && e.event === 'SessionStart');
    assert.match(ss.out.hookSpecificOutput.additionalContext, /Team context/);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('teammate dispatch: headless confirm denies → decline; auto-accept claims', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { steps: [{ result: 'success' }] } });
  try {
    hub.send(offerFor({ key: 'APP-2', by: 'm-mate' }));
    await waitFor(() => hub.of('decline').length, { what: 'decline' });
    assert.equal(hub.of('claim').length, 0);
    assert.equal(hub.of('decline')[0].card_id, 'card-APP-2');

    sup.policy.accept_from = { [REPO_ID]: ['m-mate'] };
    fs.writeFileSync(path.join(sup.l.home, 'policy.json'), JSON.stringify(sup.policy));
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-3', by: 'm-mate' }));
    assert.ok(run);
    assert.equal(hub.of('claim').length, 1);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('teammate dispatch with a confirm callback that accepts is claimed; never_auto label is declined', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const asked = [];
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { steps: [{ result: 'success' }] }, confirm: async (o) => { asked.push(o); return true; } });
  try {
    await claimRun(sup, hub, offerFor({ key: 'APP-4', by: 'm-mate' }));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].key, 'APP-4');
    assert.equal(asked[0].dispatched_by.member_id, 'm-mate');
    hub.send(offerFor({ key: 'APP-5', by: OWNER, labels: ['never_auto'] }));
    await waitFor(() => hub.of('decline').some((d) => d.card_id === 'card-APP-5'), { what: 'never_auto decline' });
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
