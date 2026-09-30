// P-1 (CONTRACT §15): the append-only journal. Triggers refuse UPDATE/DELETE,
// every mutation writes a row in its own transaction, the board API pages it,
// and shared/journal.replay() rebuilds every card's state from it alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replay, CARD_STATE } from '../../shared/journal.js';
import { TTL_MS } from '../../shared/liveness.js';
import { startHub, runMsg, runHb } from './helpers.js';

const TRACKED = [...CARD_STATE, 'title', 'labels', 'budget_cents', 'repo_id', 'base_ref', 'key', 'parent_card_id'];

export function assertReplayMatches(db, boardId = null) {
  const rows = db.all(`SELECT * FROM journal ${boardId ? 'WHERE board_id = ? OR board_id IS NULL' : ''} ORDER BY seq`, ...(boardId ? [boardId] : []));
  const cards = replay(rows);
  const live = db.all(`SELECT * FROM cards ${boardId ? 'WHERE board_id = ?' : ''}`, ...(boardId ? [boardId] : []));
  assert.equal(cards.size, live.length, 'every card has a journal history');
  for (const c of live) {
    const r = cards.get(c.id);
    for (const f of TRACKED) assert.deepEqual(r[f] ?? null, c[f] ?? null, `${c.key}.${f}`);
  }
  return rows;
}

test('journal rows are append-only: UPDATE and DELETE raise', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    await h.createCard(alice);
    const n = h.db.get('SELECT COUNT(*) AS n FROM journal').n;
    assert.ok(n >= 1);
    assert.throws(() => h.db.run("UPDATE journal SET kind = 'x'"), /append-only/);
    assert.throws(() => h.db.run('DELETE FROM journal'), /append-only/);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM journal').n, n);
  } finally {
    await h.destroy();
  }
});

test('every change journals: create, PATCH before/after, dispatch→claim→run, asks, approvals, handover, evidence; replay rebuilds the cards', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const card = await h.createCard(alice, { labels: ['x'] });
    const p = await h.api(alice, 'PATCH', `/api/cards/${card.id}`, { request_id: randomUUID(), version: card.version, title: 'Renamed', labels: ['x', 'y'] });
    assert.equal(p.status, 200);
    const upd = h.db.get("SELECT payload FROM journal WHERE card_id = ? AND kind = 'card.update'", card.id);
    assert.deepEqual(JSON.parse(upd.payload).fields.title, ['Fix it', 'Renamed']);

    const run = await h.startRun(alice, r);
    const ap = await r.rpc(run, 'approval', { tool_name: 'Bash', input_summary: 'make' });
    await h.api(alice, 'POST', `/api/permission-requests/${ap.result.permission_request_id}/answer`, { request_id: randomUUID(), decision: 'allow' });
    const ask = await r.rpc(run, 'board_ask_human', { kind: 'question', text: 'which?' });
    await h.action(alice, run.card_id, 'answer', { ask_id: ask.result.ask_id, answer: 'that one' });
    await r.out({ kind: 'handover.write', ...runMsg(run), patch: { next: 'n' } });
    await r.rpc(run, 'board_attach_evidence', { kind: 'test_run', ref: 'npm test', summary: 'ok', result: 'pass' });
    const child = await r.rpc(run, 'board_create_card', { title: 'follow-up' });
    assert.equal(replay(h.db.all('SELECT * FROM journal ORDER BY seq')).get(child.result.card_id).parent_card_id, run.card_id, 'replay keeps the parent link');
    // Dark and back: hb silence → unresponsive → hb → recover.
    await h.run(TTL_MS + 1000);
    assert.equal(h.card(run.card_id).run_state, 'unresponsive');
    await r.hb([runHb(run)]);
    await h.action(alice, run.card_id, 'stop');
    await h.hub.idle();

    const kinds = new Set(h.db.all('SELECT kind FROM journal WHERE card_id = ?', run.card_id).map((x) => x.kind));
    for (const k of ['card.create', 'card.transition', 'run.create', 'permission.create', 'permission.answer', 'ask.create', 'ask.answer', 'handover.version', 'evidence.create']) assert.ok(kinds.has(k), k);
    const trans = h.db.all("SELECT payload, actor_kind FROM journal WHERE card_id = ? AND kind = 'card.transition' ORDER BY seq", run.card_id).map((x) => ({ ...JSON.parse(x.payload), actor_kind: x.actor_kind }));
    assert.deepEqual(trans.map((t) => t.rule), ['1', '3', '4', '8', '9', '8', '9', '14', '15', '23']);
    assert.deepEqual(trans.map((t) => t.actor_kind), ['member', 'runner', 'runner', 'runner', 'member', 'runner', 'member', 'system', 'runner', 'member']);
    assertReplayMatches(h.db);

    const page = await h.api(alice, 'GET', `/api/boards/${h.ids.board}/journal?after_seq=0&limit=3`);
    assert.equal(page.status, 200);
    assert.equal(page.body.rows.length, 3);
    const next = await h.api(alice, 'GET', `/api/boards/${h.ids.board}/journal?after_seq=${page.body.next_after_seq}&limit=1000`);
    assert.ok(next.body.rows[0].seq > page.body.rows[2].seq);
    assert.equal(typeof next.body.rows[0].payload, 'object');
    assert.equal((await h.api(alice, 'GET', '/api/boards/nope/journal')).status, 404);
    assert.equal((await h.api(null, 'GET', `/api/boards/${h.ids.board}/journal`)).status, 401);
  } finally {
    await h.destroy();
  }
});

test('restore bump is journalled: replay across a restore still matches', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-journal-'));
  const h1 = await startHub({ dataDir });
  let run;
  try {
    const alice = await h1.login('alice');
    const r = await h1.runner(await h1.enroll(alice));
    run = await h1.startRun(alice, r);
  } finally {
    await h1.close();
  }
  writeFileSync(join(dataDir, 'board.db.restored'), '');
  const h2 = await startHub({ dataDir });
  try {
    assert.equal(h2.card(run.card_id).fence, run.fence + 1000);
    assert.ok(h2.db.get("SELECT 1 AS x FROM journal WHERE kind = 'hub.restore_bump'"));
    assertReplayMatches(h2.db);
  } finally {
    await h2.destroy();
  }
});
