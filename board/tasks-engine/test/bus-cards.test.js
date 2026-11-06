// G8: a hand-off run lands on a board. The engine reports it to main's automatic cards (onWork) as soon as the run
// exists, with the asker's board (a route key main put on the hand-off) when there is one. The hand-off's title is
// an AI's, so it is a My board title only (title null, localTitle set), like an untitled task of the person's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.js';
import { startBus, rid } from './bus-helpers.js';

const KEY = 'b'.repeat(64);
const ORIGIN = { key: 'claude|sess-cards-1', handle: 'claude-app-a1e0' };

test('G8: a hand-off run gets a card row at once; the asker\'s board rides along; no brief, no team title', async () => {
  const seen = [];
  const b = await startBus({ delayMs: 3000, text: 'Done.' }, { engineOpts: { onWork: (rows) => seen.push(rows) } });
  try {
    const plain = await b.handoff({ request_id: rid('card'), title: 'Fix the parser', brief: 'SECRET BRIEF' });
    const task = await waitFor(() => b.taskOf(plain.handoff_id), { label: 'task' });
    const row = (await waitFor(() => seen.findLast((r) => r.some((x) => x.taskId === task.id)), { label: 'work row' })).find((x) => x.taskId === task.id);
    assert.equal(row.ai, 'codex');
    assert.equal(row.handoff, true);
    assert.equal(row.title, null, 'an AI\'s title never reaches a team card');
    assert.equal(row.localTitle, 'Fix the parser');
    assert.equal(row.originBoard, undefined, 'no team board: routed by repo (My board by default)');
    assert.equal(row.root, task.repo?.root ?? task.worktree);
    assert.ok(!JSON.stringify(seen).includes('SECRET BRIEF'));
    const boarded = await b.handoff({ request_id: rid('card'), title: 'Boarded job' }, { ...b.caller, origin: { ...ORIGIN, board: KEY } });
    const t2 = await waitFor(() => b.taskOf(boarded.handoff_id), { label: 'task 2' });
    const row2 = (await waitFor(() => seen.findLast((r) => r.some((x) => x.taskId === t2.id)), { label: 'row 2' })).find((x) => x.taskId === t2.id);
    assert.equal(row2.originBoard, KEY);
  } finally { await b.cleanup(); }
});
