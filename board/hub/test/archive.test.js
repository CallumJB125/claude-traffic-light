// Archive / restore (CONTRACT D94): only with no live run, read-only while
// archived on every mutating route, left out of the snapshot, agent listings,
// offers, alerts and the merge poll, an integration's action audited
// `skipped`, journalled and replayed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { STATES } from '../../shared/states.js';
import { replay } from '../../shared/journal.js';
import { defineConnector } from '../integrations/connector.js';
import { startHub, settle } from './helpers.js';

const rid = () => randomUUID();
const archive = (h, cookie, id) => h.api(cookie, 'POST', `/api/cards/${id}/archive`, { request_id: rid() });
const restore = (h, cookie, id) => h.api(cookie, 'POST', `/api/cards/${id}/restore`, { request_id: rid() });

// Put a card straight into a run state (the CHECKs tie run_state to column).
function force(h, id, fields) {
  h.db.raw.exec('PRAGMA ignore_check_constraints = ON');
  const keys = Object.keys(fields);
  h.db.run(`UPDATE cards SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
  h.db.raw.exec('PRAGMA ignore_check_constraints = OFF');
}

test('only a card with no run, or done / failed, can be archived; anything else is RUN_ACTIVE; both routes are idempotent and bump the version', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    for (const state of STATES) {
      const card = await h.createCard(alice);
      if (state !== 'todo') force(h, card.id, { run_state: state });
      const r = await archive(h, alice, card.id);
      if (['todo', 'done', 'failed'].includes(state)) {
        assert.equal(r.status, 200, `${state}: ${r.text}`);
        assert.equal(r.body.card.archived.by_name, 'Alice');
      } else {
        assert.equal(r.status, 409, state);
        assert.deepEqual([r.body.error.code, r.body.error.reason], ['CONFLICT', 'RUN_ACTIVE'], state);
        assert.equal(h.card(card.id).archived_at, null);
      }
    }
    const card = await h.createCard(alice);
    const v = h.card(card.id).version;
    await archive(h, alice, card.id);
    await archive(h, alice, card.id);
    assert.equal(h.card(card.id).version, v + 1);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM journal WHERE card_id = ? AND kind = 'card.archive'", card.id).n, 1);
    const back = await restore(h, alice, card.id);
    assert.equal(back.body.card.archived, null);
    await restore(h, alice, card.id);
    assert.equal(h.card(card.id).version, v + 2);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM journal WHERE card_id = ? AND kind = 'card.restore'", card.id).n, 1);
    // Viewers cannot archive or restore.
    h.db.insert('members', { id: randomUUID(), org_id: h.ids.org, github_id: -9, github_login: 'vera', email: 'vera@dev.local', display_name: 'Vera', role: 'viewer', created_at: h.hub.iso() });
    const vera = await h.login('vera');
    assert.equal((await archive(h, vera, card.id)).status, 403);
    await archive(h, alice, card.id);
    assert.equal((await restore(h, vera, card.id)).status, 403);
  } finally {
    await h.destroy();
  }
});

test('an archived card is read-only until restored: PATCH, comments, every action and permission answers are CONFLICT ARCHIVED', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    assert.equal((await h.action(alice, run.card_id, 'stop')).status, 200);
    await h.hub.idle();
    assert.equal(h.card(run.card_id).run_state, 'failed');
    const pr = randomUUID();
    h.db.insert('permission_requests', { id: pr, run_id: run.run_id, card_id: run.card_id, tool: 'Bash', input_summary: 'ls', state: 'parked', approvers: JSON.stringify([h.ids.alice]), created_at: h.hub.iso() });
    assert.equal((await archive(h, alice, run.card_id)).status, 200);
    const before = JSON.stringify([h.card(run.card_id), h.db.get('SELECT COUNT(*) AS n FROM journal').n, h.db.get('SELECT COUNT(*) AS n FROM comments').n]);
    const id = run.card_id;
    const calls = [
      ['PATCH', `/api/cards/${id}`, { version: h.card(id).version, title: 'x' }],
      ['PATCH', `/api/cards/${id}`, { version: h.card(id).version, cover: 'red' }],
      ['POST', `/api/cards/${id}/comments`, { body: 'hi' }],
      ['POST', `/api/permission-requests/${pr}/answer`, { decision: 'allow' }],
      ...['dispatch', 'cancel', 'stop', 'retry', 'take_over', 'hand_over', 'take_over_with_claude', 'take_over_myself', 'request_changes', 'approve_done', 'answer']
        .map((a) => ['POST', `/api/cards/${id}/actions/${a}`, { comment: 'c', target: { kind: 'queue' } }]),
    ];
    for (const [m, p, body] of calls) {
      const res = await h.api(alice, m, p, { request_id: rid(), ...body });
      assert.equal(res.status, 409, `${m} ${p} ${res.text}`);
      assert.equal(res.body.error.reason, 'ARCHIVED', `${m} ${p}`);
    }
    assert.equal(JSON.stringify([h.card(id), h.db.get('SELECT COUNT(*) AS n FROM journal').n, h.db.get('SELECT COUNT(*) AS n FROM comments').n]), before, 'nothing changed');
    assert.equal((await h.api(alice, 'GET', `/api/cards/${id}`)).status, 200, 'still readable');
    assert.equal((await restore(h, alice, id)).status, 200);
    assert.equal((await h.api(alice, 'POST', `/api/cards/${id}/comments`, { request_id: rid(), body: 'back' })).status, 200);
    assert.equal((await h.action(alice, id, 'retry')).status, 200, 'restore re-includes it in dispatch');
  } finally {
    await h.destroy();
  }
});

test('archived cards leave the snapshot (HTTP and WS: card.remove, then card.upsert on restore), the alerts feed and the agent card list; include_archived=1 shows them', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const b = await h.browser(alice);
    const card = await h.createCard(alice, { assignees: [h.ids.alice] });
    h.hub.notifications.push({ id: randomUUID(), rule: 'failed', card_id: card.id, key: card.key, board_id: h.ids.board, to: [h.ids.alice], at: h.hub.iso() });
    assert.equal((await h.api(alice, 'GET', `/api/boards/${h.ids.board}/alerts`)).body.notifications.length, 1);
    await archive(h, alice, card.id);
    assert.deepEqual(await b.next('card.remove'), { type: 'card.remove', board_id: h.ids.board, card_id: card.id, __taken: true });
    const snap = (await h.api(alice, 'GET', `/api/boards/${h.ids.board}`)).body;
    assert.ok(!snap.cards.some((c) => c.id === card.id));
    const all = (await h.api(alice, 'GET', `/api/boards/${h.ids.board}?include_archived=1`)).body;
    const view = all.cards.find((c) => c.id === card.id);
    assert.equal(view.archived.by_name, 'Alice');
    assert.equal(typeof view.archived.at_age_ms, 'number');
    const alerts = (await h.api(alice, 'GET', `/api/boards/${h.ids.board}/alerts`)).body;
    assert.deepEqual(alerts.notifications, []);
    assert.ok(!JSON.stringify(alerts.alerts).includes(card.id));
    const b2 = await h.browser(alice);
    assert.ok(!b2.snapshot.cards.some((c) => c.id === card.id), 'a fresh WS snapshot leaves it out');

    // A change to it (a label rename touching it) is not broadcast while archived.
    b.clear();
    await h.api(alice, 'POST', `/api/boards/${h.ids.board}/labels`, { request_id: rid(), name: 'x', color: 'red' });
    await settle();
    assert.equal(b.all('card.upsert').length, 0);
    await restore(h, alice, card.id);
    assert.equal((await b.next('card.upsert', (m) => m.card.id === card.id)).card.archived, null);

    // The agent's board_list_cards leaves archived cards out.
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    await archive(h, alice, card.id);
    const list = await r.rpc(run, 'board_list_cards', {});
    assert.ok(list.result.cards.length >= 1);
    assert.ok(!list.result.cards.some((c) => c.key === card.key));
  } finally {
    await h.destroy();
  }
});

test('archived cards are never offered to a runner and never moved by the merge poll; restore re-includes them', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const card = await h.createCard(alice);
    await archive(h, alice, card.id);
    // A queued archived card can't happen through the API; prove the hub's own guards anyway.
    force(h, card.id, { run_state: 'queued' });
    h.db.insert('dispatches', { request_id: randomUUID(), card_id: card.id, dispatched_by: h.ids.alice, state: 'pending', seed: '{}', created_at: h.hub.iso() });
    assert.equal(h.hub.offerFrame(card.id), null);
    const runner = await h.runner(await h.enroll(alice));
    await settle(50);
    assert.equal(runner.all('offer', (o) => o.card_id === card.id).length, 0);
    h.db.run('UPDATE cards SET archived_at = NULL, archived_by = NULL WHERE id = ?', card.id);
    assert.equal(h.hub.offerFrame(card.id).card_id, card.id);

    // Merge poll.
    const r2 = await h.runner(await h.enroll(alice, 'Other'));
    const run = await h.startRun(alice, r2);
    h.github.setPull(5, { head_ref: run.branch });
    const ev = await r2.rpc(run, 'board_attach_evidence', { kind: 'pr', ref: '#5' });
    const nt = await r2.rpc(run, 'board_attach_evidence', { kind: 'no_tests_reason', ref: 'docs' });
    assert.deepEqual((await r2.rpc(run, 'board_complete', { evidence_ids: [ev.result.evidence_id, nt.result.evidence_id] })).result, { state: 'in_review' });
    h.github.setPull(5, { head_ref: run.branch, state: 'closed', merged: true, merged_by: 'alice', merged_at: '2026-09-30T10:05:00Z' });
    h.db.run('UPDATE cards SET archived_at = ?, archived_by = ? WHERE id = ?', h.hub.iso(), h.ids.alice, run.card_id);
    await h.hub.pollMerges();
    await h.hub.idle();
    assert.equal(h.card(run.card_id).run_state, 'in_review', 'the poll skips an archived card');
    h.db.run('UPDATE cards SET archived_at = NULL, archived_by = NULL WHERE id = ?', run.card_id);
    await h.hub.pollMerges();
    await h.hub.idle();
    assert.equal(h.card(run.card_id).run_state, 'done');
  } finally {
    await h.destroy();
  }
});

test('an integration acting on an archived card is audited skipped (archived) and changes nothing; after restore it applies', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    h.hub.setVaultKey(randomBytes(32));
    h.app.integrations.register(defineConnector({
      id: 'tracker', name: 'Tracker', scopes: [], secrets: [], hosts: [],
      connect: { kind: 'token', verifyToken: async () => ({ external_id: 'w1' }) },
      systemEvents: ['pr_closed'],
      actions: { 'comment.post': { default: 'auto' }, 'link.issue': { default: 'auto' }, 'system.pr_closed': { default: 'auto' } },
    }));
    const conn = h.app.integrations.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'tracker', external_id: 'w1' });
    const ctx = h.app.integrations.ctxFor(conn.id);
    const card = await h.createCard(alice);
    await ctx.act('link.issue', {}, async (s) => s.link(card.id, 'issue', 'i-1'));
    await archive(h, alice, card.id);
    const before = JSON.stringify([h.card(card.id), h.db.get('SELECT COUNT(*) AS n FROM comments').n, h.db.get('SELECT COUNT(*) AS n FROM journal').n]);
    const comment = (meta) => ctx.act('comment.post', meta, (s) => s.actAs(h.ids.alice).comment(card.id, { request_id: rid(), body: 'from the tracker' }));
    assert.deepEqual(await comment({ card_id: card.id }), { done: false, decision: 'skipped', reason: 'archived' });
    assert.deepEqual(await comment({}), { done: false, decision: 'skipped', reason: 'archived' }, 'found only when the handler acts');
    assert.deepEqual(await ctx.system.event('pr_closed', { kind: 'issue', external_id: 'i-1' }), { done: false, decision: 'skipped', reason: 'archived' });
    const audit = h.app.integrations.audit(conn.id).filter((a) => a.card_id === card.id || a.action === 'comment.post').slice(0, 3);
    for (const a of audit) assert.deepEqual([a.decision, a.error], ['skipped', 'archived'], a.action);
    assert.equal(JSON.stringify([h.card(card.id), h.db.get('SELECT COUNT(*) AS n FROM comments').n, h.db.get('SELECT COUNT(*) AS n FROM journal').n]), before);
    await restore(h, alice, card.id);
    assert.equal((await comment({ card_id: card.id })).decision, 'auto');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM comments WHERE card_id = ?', card.id).n, 1);
  } finally {
    await h.destroy();
  }
});

test('replay rebuilds archived_at / archived_by from card.archive and card.restore', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const a = await h.createCard(alice);
    const b = await h.createCard(alice);
    await archive(h, alice, a.id);
    await archive(h, alice, b.id);
    h.clock.advance(5000);
    await restore(h, alice, b.id);
    const cards = replay(h.db.all('SELECT * FROM journal ORDER BY seq'));
    for (const id of [a.id, b.id]) {
      const live = h.card(id);
      assert.deepEqual([cards.get(id).archived_at, cards.get(id).archived_by], [live.archived_at, live.archived_by]);
    }
    assert.equal(cards.get(a.id).archived_by, h.ids.alice);
  } finally {
    await h.destroy();
  }
});
