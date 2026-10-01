// The client against the mock: every event, push frame and result is
// validated against schema.json while the demo scripts run end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMock, assertValid, waitFor, byScript } from './helpers.js';

async function withDemo(fn) {
  const m = await startMock();
  const events = [];
  const pushes = [];
  // Capture raw push frames too (not just what the client hands the handler).
  m.client.sock.prependListener('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      try { const f = JSON.parse(line); if (f.push) pushes.push(f); } catch { /* partial line; the client reassembles */ }
    }
  });
  await m.client.subscribe('*', { fromSeq: 1 }, (e) => events.push(e));
  try { await fn({ ...m, events, pushes }); } finally { await m.close(); }
  return { events, pushes };
}

test('demo A: queued → running (transcript/tool/diff) → approval → running → ready to review with evidence → merged', async () => {
  await withDemo(async ({ client, srv, events }) => {
    const a = byScript(srv, 'work-approval');
    const seen = () => events.filter((e) => e.taskId === a.id && e.type === 'state').map((e) => e.state);
    const req = await waitFor(() => events.find((e) => e.taskId === a.id && e.type === 'approval' && e.phase === 'requested'), { label: 'approval request' });
    const detail = await client.getTask(a.id);
    assertValid('GetTaskResult', detail);
    assert.equal(detail.state, 'blocked');
    assert.equal(detail.blockedKind, 'permission');
    assert.deepEqual(detail.actions, ['approve', 'deny', 'pause', 'takeover', 'stop']);
    assert.match(detail.reason, /^approval waiting · `npm install/);
    assert.equal(detail.openApprovals[0].approvalId, req.approvalId);

    const r = await client.act(a.id, 'approve', { approvalId: req.approvalId, scope: 'once' });
    assertValid('ActResult', r);
    await waitFor(async () => (await client.getTask(a.id)).state === 'in_review', { label: 'A in_review' });
    for (const s of ['queued', 'claimed', 'running', 'blocked', 'in_review']) assert.ok(seen().includes(s), `A passed through ${s}`);
    for (const t of ['transcript', 'tool', 'diff', 'cost', 'handover', 'claims']) assert.ok(events.some((e) => e.taskId === a.id && e.type === t), `A emitted ${t}`);

    const done = await client.getTask(a.id);
    assert.equal(done.evidence.tests, 'pass');
    assert.equal(done.label, 'Ready to review');
    assert.match(done.reason, /tests ✓ · 3 files \+101 −8 · \$0\.42/);
    assert.deepEqual(done.actions, ['merge', 'openPr', 'message', 'discard']);
    assert.equal(done.green, false);

    const merged = await client.act(a.id, 'merge', {});
    assert.equal(merged.task.state, 'done');
    assert.equal(merged.task.outcome, 'merged');
    assert.equal(merged.task.reason, 'merged into main');
  });
});

test('demo B: usage limit → handing over → paused with wait-for-reset / continue-with-Codex choices → switch to Codex → review', async () => {
  await withDemo(async ({ client, srv, events }) => {
    const b = byScript(srv, 'limit');
    const ask = await waitFor(() => events.find((e) => e.taskId === b.id && e.type === 'ask' && e.kind === 'limit' && e.phase === 'asked'), { label: 'limit ask' });
    assert.deepEqual(ask.choices.map((c) => [c.id, c.action]), [['wait_reset', 'resume'], ['switch_ai', 'switchAi']]);
    await waitFor(async () => (await client.getTask(b.id)).state === 'parked', { label: 'B parked' });
    const d = await client.getTask(b.id);
    assert.equal(d.parkReason, 'limit');
    assert.equal(d.label, 'Paused');
    assert.match(d.reason, /^usage limit on your Claude account · resets in 2h [45]m$/);
    assert.ok(d.actions.includes('switchAi') && d.actions.includes('resume'));
    assert.equal(d.handover.provenance, 'checkpoint_complete');
    const states = events.filter((e) => e.taskId === b.id && e.type === 'state').map((e) => e.state);
    assert.ok(states.includes('handing_over'), 'checkpoint before pausing');

    const choice = ask.choices.find((c) => c.id === 'switch_ai');
    const r = await client.act(b.id, choice.action, choice.payload);
    assert.equal(r.task.ai.id, 'codex');
    assert.match(r.task.ai.reason, /Switched by you from claude/);
    await waitFor(async () => (await client.getTask(b.id)).state === 'in_review', { label: 'B in_review on codex' });
    assert.ok(events.some((e) => e.taskId === b.id && e.type === 'ask' && e.phase === 'answered' && e.answer === 'switch_ai'));
  });
});

test('demo B alt: wait for reset resumes the same AI', async () => {
  await withDemo(async ({ client, srv }) => {
    const b = byScript(srv, 'limit');
    await waitFor(async () => (await client.getTask(b.id)).state === 'parked', { label: 'B parked' });
    const r = await client.act(b.id, 'resume', { when: 'reset' });
    assert.match(r.task.reason, /resumes then$/);
    await waitFor(async () => (await client.getTask(b.id)).state === 'in_review', { label: 'B in_review after reset' });
    assert.equal((await client.getTask(b.id)).ai.id, 'claude');
  });
});

test('demo C: orphaned, never green; take over returns the resume command', async () => {
  await withDemo(async ({ client, srv, events }) => {
    const c = byScript(srv, 'orphan');
    await waitFor(async () => (await client.getTask(c.id)).state === 'orphaned', { label: 'C orphaned' });
    const states = events.filter((e) => e.taskId === c.id && e.type === 'state');
    assert.ok(states.some((e) => e.state === 'unresponsive'));
    assert.ok(states.filter((e) => e.state !== 'running').every((e) => e.green === false));
    assert.ok(!client.isGreen(c.id));
    const d = await client.getTask(c.id);
    assert.deepEqual(d.actions, ['takeover', 'retry', 'discard', 'stop']);
    assert.equal(d.live.child_alive, false);
    const r = await client.act(c.id, 'takeover', { mode: 'tab' });
    assertValid('ActResult', r);
    assert.equal(r.task.state, 'handed_over');
    assert.deepEqual(r.takeover.argv.slice(0, 3), ['claude', '--resume', d.sessionId]);
    assert.equal(r.takeover.cwd, d.worktree);
    const back = await client.act(c.id, 'handback', { note: 'fixed the fixture path by hand' });
    assert.equal(back.task.state !== 'handed_over', true);
    await waitFor(async () => (await client.getTask(c.id)).state === 'in_review', { label: 'C in_review after handback' });
  });
});

test('every event, push frame and read result matches the schema', async () => {
  const { events, pushes } = await withDemo(async ({ client, srv, events }) => {
    const a = byScript(srv, 'work-approval');
    const req = await waitFor(() => events.find((e) => e.taskId === a.id && e.type === 'approval' && e.phase === 'requested'), { label: 'approval' });
    await client.act(a.id, 'deny', { approvalId: req.approvalId, message: 'no new deps' });
    await waitFor(() => [...srv.tasks.values()].filter((t) => ['in_review', 'parked', 'orphaned'].includes(t.state)).length === 5, { label: 'all demo tasks settle', timeoutMs: 15000 });
    await new Promise((r) => setTimeout(r, 250));   // at least one hb push
    assertValid('ListTasksResult', await client.listTasks());
    for (const t of srv.tasks.values()) {
      assertValid('GetTaskResult', await client.getTask(t.id), `getTask ${t.script}`);
      assertValid('ListMessagesResult', await client.listMessages(t.id));
    }
    assertValid('DetectAIsResult', await client.detectAIs());
    assertValid('GetLimitsResult', await client.getLimits());
    assertValid('GetLimitsResult', await client.setLimits({ maxParallel: 3, perAi: { codex: 1 } }));
    assertValid('GetClaimsResult', await client.getClaims('/Users/demo/Development/acme-web'));
  });
  assert.ok(events.length > 60, `saw ${events.length} events`);
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'events arrive in seq order');
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seqs');
  for (const e of events) assertValid('Event', e, `event ${e.type}#${e.seq}`);
  const types = new Set(events.map((e) => e.type));
  for (const t of ['state', 'transcript', 'tool', 'diff', 'approval', 'ask', 'cost', 'handover', 'claims', 'overlap', 'message', 'message-state']) assert.ok(types.has(t), `mock emits ${t}`);
  assert.ok(pushes.some((p) => p.push === 'hb'));
  for (const p of pushes) assertValid('Push', p, `push ${p.push}`);
});

test('state events carry the supervisor-computed green, and only running can be green', async () => {
  await withDemo(async ({ srv, events, client }) => {
    await waitFor(() => events.some((e) => e.type === 'state' && e.green), { label: 'a green state' });
    for (const e of events.filter((x) => x.type === 'state')) {
      if (e.green) assert.equal(e.state, 'running');
      if (e.live) assert.equal(e.live.green, e.green);
    }
    const running = [...srv.tasks.values()].find((t) => t.state === 'running');
    if (running) assert.equal(typeof client.isGreen(running.id), 'boolean');
  });
});
