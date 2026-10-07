// Terminal state comes from the stream `result` (never the Stop hook);
// comment/answer delivery (tool boundary vs idle stdin); handover_begin/park;
// T_claim → prep.failed; the Stop-hook reminder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree } from '../git.js';
import { snapshotRef } from '../../shared/fence.js';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, readFakeLog, fakeClock, advance, hookCall, OWNER } from './helpers.js';

async function withRunner(scenario, fn, extra = {}) {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario, ...extra });
  try { await fn({ hub, sup, root }); } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
}

test('error_max_budget_usd → run.failed{budget}', () => withRunner({ steps: [{ result: 'error_max_budget_usd' }] }, async ({ hub, sup }) => {
  const run = await claimRun(sup, hub, offerFor({ key: 'T-1' }));
  const f = await waitFor(() => hub.outs('run.failed')[0], { what: 'failed' });
  assert.equal(f.fail_kind, 'budget');
  await waitFor(() => run.ended, { what: 'ended' });
}));

test('usage limit (rate_limit_event rejected) → run.failed{limit} with resets_in_ms', () => withRunner({
  steps: [{ rate_limit: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600 } }, { result: 'error_during_execution', text: 'usage limit reached' }],
}, async ({ hub, sup }) => {
  await claimRun(sup, hub, offerFor({ key: 'T-2' }));
  const f = await waitFor(() => hub.outs('run.failed')[0], { what: 'failed' });
  assert.equal(f.fail_kind, 'limit');
  assert.ok(f.resets_in_ms > 3000 * 1000 && f.resets_in_ms <= 3600 * 1000);
}));

test('transient 429: three backoff retries via stdin, then failed{limit}', () => withRunner({
  steps: [{ result: 'error_during_execution', text: 'API Error: 429 rate_limit_error' }],
  on_input: { 'rate limited': [{ result: 'error_during_execution', text: 'API Error: 429' }] },
}, async ({ hub, sup }) => {
  const run = await claimRun(sup, hub, offerFor({ key: 'T-3' }));
  const f = await waitFor(() => hub.outs('run.failed')[0], { what: 'failed', timeout: 8000 });
  assert.equal(f.fail_kind, 'limit');
  assert.equal(readFakeLog(run.runDir).filter((e) => e.ev === 'turn' && /rate limited/.test(e.text)).length, 3);
}));

test('network error text → failed{network}; plain error → failed{error}', async () => {
  await withRunner({ steps: [{ result: 'error_during_execution', text: 'fetch failed: ECONNRESET' }], on_input: { 'network dropped': [{ result: 'error_during_execution', text: 'fetch failed: ECONNRESET' }] } }, async ({ hub, sup }) => {
    await claimRun(sup, hub, offerFor({ key: 'T-4' }));
    assert.equal((await waitFor(() => hub.outs('run.failed')[0], { what: 'failed' })).fail_kind, 'network');
  });
  await withRunner({ steps: [{ result: 'error_during_execution', text: 'something broke' }] }, async ({ hub, sup }) => {
    await claimRun(sup, hub, offerFor({ key: 'T-5' }));
    assert.equal((await waitFor(() => hub.outs('run.failed')[0], { what: 'failed' })).fail_kind, 'error');
  });
});

test('Stop hook without complete/ask/release gets a reminder, but is never terminal', () => withRunner({ steps: [{ stop_hook: 'all good' }, { result: 'success' }] }, async ({ hub, sup }) => {
  const run = await claimRun(sup, hub, offerFor({ key: 'T-6' }));
  const h = await waitFor(() => readFakeLog(run.runDir).find((e) => e.ev === 'hook' && e.event === 'Stop'), { what: 'stop hook' });
  assert.match(h.out.hookSpecificOutput.additionalContext, /board_complete/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(run.ended, false, 'idle, not ended');
  assert.equal(hub.outs('run.failed').length, 0);
}));

test('comments: idle → stdin + delivered{stdin}; mid-turn → PostToolUse context + delivered{post_tool_use}; answers deduped', () => withRunner({
  steps: [{ result: 'success' }],
  on_input: { 'comment by Sam': [{ tool: 'Bash', input: { command: 'sleep 1' }, ms: 400 }, { tool: 'Read', input: { file_path: 'README.md' } }] },
}, async ({ hub, sup }) => {
  const run = await claimRun(sup, hub, offerFor({ key: 'T-7' }));
  await waitFor(() => run.backend && !run.backend.turnActive, { what: 'idle' });
  hub.send({ type: 'comment.deliver', run_id: run.run_id, card_id: run.card_id, fence: run.fence, comments: [{ comment_id: 'c1', author_name: 'Sam', body: 'use the v2 API', created_age_ms: 5 }] });
  await waitFor(() => hub.outs('comment.delivered').some((m) => m.via === 'stdin'), { what: 'delivered via stdin' });
  await waitFor(() => readFakeLog(run.runDir).some((e) => e.ev === 'turn' && /use the v2 API/.test(e.text)), { what: 'agent got it' });
  // Mid-turn now (the Bash step): the next comment rides the PostToolUse hook.
  await waitFor(() => run.backend.turnActive && run.toolInFlight, { what: 'mid-turn' });
  hub.send({ type: 'comment.deliver', run_id: run.run_id, card_id: run.card_id, fence: run.fence, comments: [{ comment_id: 'c2', author_name: 'Kim', body: 'also update docs', created_age_ms: 5 }] });
  await waitFor(() => hub.outs('comment.delivered').some((m) => m.via === 'post_tool_use' && m.comment_ids.includes('c2')), { what: 'delivered at tool boundary' });
  await waitFor(() => readFakeLog(run.runDir).find((e) => e.ev === 'hook' && e.event === 'PostToolUse' && /also update docs/.test(JSON.stringify(e.out))), { what: 'PostToolUse context' });
  // An ask answer re-sent on reconnect is applied once.
  await waitFor(() => !run.backend.turnActive, { what: 'idle again' });
  const ans = { type: 'answer', run_id: run.run_id, card_id: run.card_id, fence: run.fence, ask_id: 'ask-9', answer: 'blue', answered_by: { member_id: OWNER, name: 'Owner' } };
  hub.send(ans);
  hub.send(ans);
  await waitFor(() => readFakeLog(run.runDir).some((e) => e.ev === 'turn' && /was answered[\s\S]*blue/.test(e.text)), { what: 'answer delivered' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(readFakeLog(run.runDir).filter((e) => e.ev === 'turn' && /blue/.test(e.text)).length, 1);
}));

test('handover_begin → agent asked for the handover → write → stop, snapshot, handover.complete', () => withRunner({
  steps: [{ result: 'success' }],
  on_input: { 'asked for a handover': [{ mcp: 'board_write_handover', args: { patch: { next: 'ship it', done: ['wrote parser'] } } }, { result: 'success' }] },
}, async ({ hub, sup }) => {
  const run = await claimRun(sup, hub, offerFor({ key: 'T-8' }));
  await waitFor(() => !run.backend.turnActive, { what: 'idle' });
  hub.send({ type: 'cmd', cmd_id: 'h1', run_id: run.run_id, card_id: run.card_id, fence: run.fence, cmd: 'handover_begin', wait_ms: 20000 });
  await waitFor(() => hub.outs('handover.complete').length, { what: 'handover.complete', timeout: 15000 });
  assert.equal(hub.outs('handover.write')[0].patch.next, 'ship it');
  assert.ok(hub.outs('snapshot').length >= 1);
  await waitFor(() => run.ended, { what: 'ended' });
  assert.equal(run.endReason, 'handed_over');
}));

test('park: the final handover goes through the salvage lane (fence already bumped)', () => withRunner({
  steps: [{ result: 'success' }],
  on_input: { 'asked for a handover': [{ mcp: 'board_write_handover', args: { patch: { questions: 'which DB?' } } }, { result: 'success' }] },
}, async ({ hub, sup }) => {
  const run = await claimRun(sup, hub, offerFor({ key: 'T-9' }));
  await waitFor(() => !run.backend.turnActive, { what: 'idle' });
  hub.send({ type: 'cmd', cmd_id: 'p1', run_id: run.run_id, card_id: run.card_id, fence: run.fence, cmd: 'park', wait_ms: 20000 });
  await waitFor(() => run.ended, { what: 'ended', timeout: 15000 });
  await waitFor(() => hub.of('salvage').some((s) => s.kind === 'handover' && s.payload.patch.questions === 'which DB?'), { what: 'salvage handover' });
  assert.equal(hub.outs('handover.write').length, 0);
  assert.equal(hub.outs('handover.complete').length, 0);
}));

test('no init/activity within T_claim → prep.failed and the CLI is stopped', async () => {
  const clock = fakeClock();
  await withRunner({ no_init: true }, async ({ hub, sup }) => {
    const run = await claimRun(sup, hub, offerFor({ key: 'T-10' }), { active: false });
    await advance(sup, clock, 121);
    const f = await waitFor(() => hub.outs('prep.failed')[0], { what: 'prep.failed' });
    assert.match(f.cause, /T_claim/);
    await waitFor(() => run.ended, { what: 'ended' });
  }, { clock });
});

test('no SessionStart within 30 s → degraded fact', async () => {
  const clock = fakeClock();
  await withRunner({ steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] }, async ({ hub, sup }) => {
    const run = await claimRun(sup, hub, offerFor({ key: 'T-11' }));
    run.sessionStartSeen = false;   // as if the hook never fired
    await advance(sup, clock, 31);
    run.flushFacts();
    await waitFor(() => hub.facts('degraded').length, { what: 'degraded' });
    const ok = await hookCall(run, 'start', { source: 'compact' });
    assert.match(ok.result.stdout.hookSpecificOutput.additionalContext, /handover/i);
  }, { clock });
});

test('worktree prep slower than T_claim: prep.failed once, the CLI is never spawned, nothing re-enters the ledger', async () => {
  const clock = fakeClock();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (a) => { await gate; return createWorktree(a); };
  await withRunner({ steps: [{ result: 'success' }] }, async ({ hub, sup, root }) => {
    hub.send(offerFor({ key: 'T-12' }));
    const run = await waitFor(() => [...sup.runs.values()].find((r) => r.key === 'T-12'), { what: 'run registered' });
    await advance(sup, clock, 121);
    await waitFor(() => run.ended, { what: 'ended by T_claim' });
    release();
    await waitFor(() => fs.existsSync(run.worktree), { what: 'worktree finally created' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(run.backend, null, 'no CLI for an ended run');
    assert.equal(hub.outs('prep.failed').length, 1);
    assert.equal(sup.runs.size, 0);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'home', 'ledger.json'), 'utf8')).runs), []);
  }, { clock, opts: { createWorktree: slow } });
});

test('an ended run leaves no worktree or run dir behind; its branch and snapshot ref stay', async () => {
  await withRunner({ steps: [{ tool: 'Write', input: { file_path: 'notes.txt', content: 'x\n' } }, { result: 'error_max_budget_usd' }] }, async ({ hub, sup }) => {
    const run = await claimRun(sup, hub, offerFor({ key: 'T-13' }));
    await waitFor(() => run.ended, { what: 'ended' });
    await waitFor(() => !fs.existsSync(run.worktree) && !fs.existsSync(run.runDir), { what: 'cleaned up' });
    const repo = sup.policy.repos[run.repo_id].local_path;
    assert.doesNotThrow(() => execFileSync('git', ['rev-parse', '--verify', run.branch], { cwd: repo, stdio: 'ignore' }));
    assert.doesNotThrow(() => execFileSync('git', ['rev-parse', '--verify', snapshotRef('T-13', run.fence)], { cwd: repo, stdio: 'ignore' }));
    assert.doesNotMatch(execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }), /T-13/);
  }, { opts: { keepRunFiles: false } });
});

test('board_complete then RUN_ENDED: ends normally, final snapshot on the outbox, no salvage, no "taken over"', () => withRunner({
  steps: [
    { tool: 'Write', input: { file_path: 'done.txt', content: 'ok\n' } },
    { mcp: 'board_complete', args: { summary: 'did it', evidence_ids: ['e1'] } },
    { tool: 'Bash', input: { command: 'sleep 1' }, ms: 1200 },
    { result: 'success' },
  ],
}, async ({ hub, sup }) => {
  hub.rpcReply = (f) => (f.method === 'board_complete' ? { ok: true, result: { state: 'in_review' } } : { ok: true, result: {} });
  const run = await claimRun(sup, hub, offerFor({ key: 'T-14' }));
  await waitFor(() => run.completed, { what: 'board_complete' });
  hub.endedRuns.add(run.run_id);
  sup.sendHbNow();
  await waitFor(() => run.fenced, { what: 'RUN_ENDED seen' });
  const pre = await hookCall(run, 'pre', { tool_name: 'Read', tool_input: { file_path: 'README.md' } });
  assert.match(pre.result.stdout.hookSpecificOutput.permissionDecisionReason, /ended/);
  assert.doesNotMatch(pre.result.stdout.hookSpecificOutput.permissionDecisionReason, /taken over/);
  await waitFor(() => run.ended, { what: 'ended', timeout: 8000 });
  assert.equal(run.endReason, 'completed');
  assert.equal(run.postFence, false);
  await waitFor(() => hub.outs('snapshot').some((m) => m.status === 'pushed'), { what: 'final snapshot via outbox' });
  assert.equal(hub.of('salvage').length, 0, 'a completed run never salvages');
}));

test('board_release{requeue} then FENCED: ends normally; the fence moved, so the final writes go as salvage without a takeover note', () => withRunner({
  steps: [
    { mcp: 'board_release', args: { reason: 'blocked on infra', requeue: true } },
    { tool: 'Write', input: { file_path: 'late.txt', content: 'late\n' } },
    { result: 'success' },
  ],
}, async ({ hub, sup }) => {
  hub.rpcReply = (f) => (f.method === 'board_release' ? { ok: true, result: { state: 'queued' } } : { ok: true, result: {} });
  const run = await claimRun(sup, hub, offerFor({ key: 'T-15' }));
  await waitFor(() => run.released, { what: 'released' });
  hub.fencedRuns.add(run.run_id);
  sup.sendHbNow();
  await waitFor(() => run.ended, { what: 'ended', timeout: 8000 });
  assert.equal(run.endReason, 'released');
  assert.equal(run.postFence, true);
  assert.equal(hub.of('salvage').filter((s) => s.kind === 'note' && /fenced/.test(s.payload.text)).length, 0);
}));

test('park: a FENCED heartbeat inside the handover window does not cut it short', () => withRunner({
  steps: [{ result: 'success' }],
  on_input: { 'asked for a handover': [{ tool: 'Bash', input: { command: 'sleep 1' }, ms: 1500 }, { mcp: 'board_write_handover', args: { patch: { next: 'finish the parser' } } }, { result: 'success' }] },
}, async ({ hub, sup }) => {
  const run = await claimRun(sup, hub, offerFor({ key: 'T-16' }));
  await waitFor(() => !run.backend.turnActive, { what: 'idle' });
  hub.send({ type: 'cmd', cmd_id: 'p2', run_id: run.run_id, card_id: run.card_id, fence: run.fence, cmd: 'park', wait_ms: 20000 });
  await waitFor(() => run.handover && run.backend.turnActive, { what: 'handover turn started' });
  hub.fencedRuns.add(run.run_id);
  sup.sendHbNow();
  hub.send({ type: 'fenced', run_id: run.run_id, card_id: run.card_id, held_fence: run.fence, current_fence: run.fence + 1 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(run.ended, false, 'still inside the park window');
  await waitFor(() => run.ended, { what: 'ended', timeout: 15000 });
  assert.equal(run.endReason, 'parked');
  assert.ok(hub.of('salvage').some((s) => s.kind === 'handover' && s.payload.patch.next === 'finish the parser'), 'the handover written after FENCED arrived');
}));
