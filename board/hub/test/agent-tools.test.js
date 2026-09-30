// board_create_card (D31) and board_add_lesson (D32): least-privilege scope,
// repo and org scoping, rate limits and journal rows, like their neighbours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { replay } from '../../shared/journal.js';
import { startHub } from './helpers.js';

async function setup(opts) {
  const h = await startHub(opts);
  const alice = await h.login('alice');
  const dev = await h.enroll(alice);
  const r = await h.runner(dev);
  const run = await h.startRun(alice, r);
  return { h, alice, dev, r, run };
}

test('board_create_card: a todo child of the run\'s card, same board and repo, journalled, never dispatched', async () => {
  const { h, r, run } = await setup();
  try {
    const parent = h.card(run.card_id);
    const res = await r.rpc(run, 'board_create_card', {
      title: 'Handle cents in the bank client', body: 'amounts are cents', acceptance: 'tests pass',
      // Out-of-scope fields are ignored, not honoured.
      repo_id: 'other', board_id: 'other', labels: ['never_auto'], assignees: ['m-x'], budget_usd: 99, column_name: 'in_progress', parent_card_id: 'x',
    });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const c = h.card(res.result.card_id);
    assert.equal(res.result.key, c.key);
    assert.deepEqual(
      [c.board_id, c.repo_id, c.parent_card_id, c.column_name, c.run_state, c.labels, c.budget_cents, c.title, c.body, c.acceptance],
      [parent.board_id, run.repo_id, parent.id, 'todo', null, '[]', null, 'Handle cents in the bank client', 'amounts are cents', 'tests pass'],
    );
    assert.equal(c.created_by, h.db.get('SELECT on_behalf_of FROM runs WHERE id = ?', run.run_id).on_behalf_of);
    assert.equal(h.db.get('SELECT count(*) AS n FROM card_assignees WHERE card_id = ?', c.id).n, 0);
    assert.equal(h.db.get('SELECT count(*) AS n FROM dispatches WHERE card_id = ?', c.id).n, 0);
    const j = h.db.get("SELECT * FROM journal WHERE kind = 'card.create' AND card_id = ?", c.id);
    assert.deepEqual([j.actor_kind, j.actor_id, j.run_id], ['runner', h.db.get('SELECT device_id FROM runs WHERE id = ?', run.run_id).device_id, run.run_id]);
    assert.equal(JSON.parse(j.payload).parent_card_id, parent.id);
    assert.equal(replay(h.db.all('SELECT * FROM journal ORDER BY seq')).get(c.id).title, c.title, 'replay rebuilds it');
    assert.ok(h.db.get("SELECT 1 AS x FROM events WHERE card_id = ? AND kind = 'created'", c.id));
    const back = await r.rpc(run, 'board_get_card', { key: c.key });
    assert.equal(back.result.card.key, c.key, 'the child is readable from the parent run (card:read)');
    assert.equal(c.created_by_run_id, run.run_id);
    const alice = await h.login('alice');
    const detail = await h.api(alice, 'GET', `/api/cards/${c.id}`);
    assert.deepEqual([detail.body.card.agent_suggested, detail.body.card.parent_card_id], [true, parent.id], 'cardDetail marks it agent-suggested');
    const parentView = await h.api(alice, 'GET', `/api/cards/${parent.id}`);
    assert.equal(parentView.body.card.agent_suggested, false, 'a human-created card is not');
  } finally {
    await h.destroy();
  }
});

test('board_create_card: the child inherits the parent\'s policy labels (never_auto, plan-approval) and no others', async () => {
  const { h, r, run } = await setup();
  try {
    h.db.run('UPDATE cards SET labels = ? WHERE id = ?', JSON.stringify(['never_auto', 'plan-approval', 'bug']), run.card_id);
    const res = await r.rpc(run, 'board_create_card', { title: 'follow-up', labels: [] });
    const c = h.card(res.result.card_id);
    assert.deepEqual(JSON.parse(c.labels), ['never_auto', 'plan-approval']);
    const j = h.db.get("SELECT payload FROM journal WHERE kind = 'card.create' AND card_id = ?", c.id);
    assert.deepEqual(JSON.parse(JSON.parse(j.payload).labels), ['never_auto', 'plan-approval'], 'the journal carries the same labels');
  } finally {
    await h.destroy();
  }
});

test('board_create_card: scope denial (foreign repo, viewer member, bad input) writes nothing', async () => {
  const { h, alice, r, run } = await setup();
  try {
    const count = () => h.db.get('SELECT count(*) AS n FROM cards').n;
    const n0 = count();
    const other = await h.api(alice, 'POST', '/api/repos', { request_id: randomUUID(), url: 'https://github.com/acme/secret.git' });
    await h.api(alice, 'POST', `/api/boards/${h.ids.board}/repos`, { request_id: randomUUID(), repo_id: other.body.repo.id });
    const foreign = await r.rpc(run, 'board_create_card', { title: 'leak' }, { repo_id: other.body.repo.id });
    assert.deepEqual([foreign.ok, foreign.error.code], [false, 'FORBIDDEN']);
    for (const params of [{}, { title: '' }, { title: 'x'.repeat(201) }, { title: 't', body: 5 }]) {
      const bad = await r.rpc(run, 'board_create_card', params);
      assert.equal(bad.error.code, 'VALIDATION', JSON.stringify(params));
    }
    const memberId = h.db.get('SELECT on_behalf_of FROM runs WHERE id = ?', run.run_id).on_behalf_of;
    h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", h.ids.bob);   // a team keeps an owner (D59 trigger)
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", memberId);
    const viewer = await r.rpc(run, 'board_create_card', { title: 'as a viewer' });
    assert.deepEqual([viewer.ok, viewer.error.code], [false, 'FORBIDDEN']);
    h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", memberId);
    h.db.run('DELETE FROM board_repos WHERE board_id = ? AND repo_id = ?', h.ids.board, other.body.repo.id);
    assert.equal(count(), n0, 'no card was created');
  } finally {
    await h.destroy();
  }
});

test('board_create_card and board_add_lesson are rate limited per member', async () => {
  const { h, r, run } = await setup({ config: { rateLimits: { agent_card_member: { capacity: 2, per_ms: 3_600_000 }, agent_lesson_member: { capacity: 2, per_ms: 3_600_000 } } } });
  try {
    for (const t of ['one', 'two']) assert.equal((await r.rpc(run, 'board_create_card', { title: t })).ok, true);
    const third = await r.rpc(run, 'board_create_card', { title: 'three' });
    assert.equal(third.error.code, 'RATE_LIMITED');
    assert.ok(third.error.retry_after_s >= 1);
    assert.equal((await r.rpc(run, 'board_add_lesson', { text: 'first lesson of the day' })).ok, true);
    const again = await r.rpc(run, 'board_add_lesson', { text: 'first lesson of the day' });
    assert.equal(again.result.duplicate, true, 'a repeat is answered from the table');
    assert.equal((await r.rpc(run, 'board_add_lesson', { text: 'first lesson of the day' })).error.code, 'RATE_LIMITED', 'but the lookup costs a token, so it is no free oracle');
    assert.equal((await r.rpc(run, 'board_add_lesson', { text: 'a different second lesson' })).error.code, 'RATE_LIMITED');
  } finally {
    await h.destroy();
  }
});

test('board_add_lesson: append-only, org- and repo-scoped, journal carries no text', async () => {
  const { h, r, run } = await setup();
  try {
    const res = await r.rpc(run, 'board_add_lesson', { text: '  Run   db:reset before\nthe API tests. ', evidence: 'FK error in users_test' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.result.status, 'suggested');
    const l = h.db.get('SELECT * FROM lessons WHERE id = ?', res.result.lesson_id);
    const orgId = h.db.get('SELECT org_id FROM boards WHERE id = ?', h.ids.board).org_id;
    assert.deepEqual([l.org_id, l.repo_id, l.card_id, l.author_run_id, l.text, l.evidence], [orgId, run.repo_id, run.card_id, run.run_id, 'Run db:reset before the API tests.', 'FK error in users_test']);
    const j = h.db.get("SELECT * FROM journal WHERE kind = 'lesson.create'");
    assert.deepEqual(JSON.parse(j.payload), { lesson_id: l.id, repo_id: run.repo_id });
    assert.equal(j.actor_kind, 'runner');
    const dup = await r.rpc(run, 'board_add_lesson', { text: 'Run db:reset before the API tests.' });
    assert.deepEqual(dup.result, { lesson_id: l.id, status: 'suggested', duplicate: true });
    assert.throws(() => h.db.run("UPDATE lessons SET text = 'rewritten lesson text' WHERE id = ?", l.id), /append-only/);
    assert.throws(() => h.db.run('DELETE FROM lessons WHERE id = ?', l.id), /append-only/);
    for (const params of [{}, { text: 'short' }, { text: 'x'.repeat(501) }, { text: 'long enough text', evidence: 'x'.repeat(1001) }]) {
      assert.equal((await r.rpc(run, 'board_add_lesson', params)).error.code, 'VALIDATION', JSON.stringify(params));
    }
    const foreign = await r.rpc(run, 'board_add_lesson', { text: 'a lesson for another repo' }, { repo_id: 'repo-elsewhere' });
    assert.equal(foreign.error.code, 'FORBIDDEN');
    assert.equal(h.db.get('SELECT count(*) AS n FROM lessons').n, 1);
  } finally {
    await h.destroy();
  }
});

test('cross-org: another org\'s cards are unreachable and its device cannot use our run', async () => {
  const { h, r, run } = await setup();
  try {
    const now = new Date().toISOString();
    h.db.insert('orgs', { id: 'o2', name: 'other', created_at: now });
    h.db.insert('members', { id: 'm-eve', org_id: 'o2', github_id: 99, github_login: 'eve', email: 'eve@x.io', display_name: 'Eve', role: 'owner', created_at: now });
    h.db.insert('repos', { id: 'r2', org_id: 'o2', canonical_url: 'github.com/other/app', short_name: 'app' });
    h.db.insert('boards', { id: 'b2', org_id: 'o2', name: 'Other', key_prefix: 'DEV', next_key: 78 });
    h.db.insert('board_repos', { board_id: 'b2', repo_id: 'r2' });
    h.db.insert('cards', { id: 'c2', board_id: 'b2', key: 'DEV-77', title: 'Their secret', body: 'secret body', repo_id: 'r2', created_by: 'm-eve', created_at: now, updated_at: now });

    const peek = await r.rpc(run, 'board_get_card', { key: 'DEV-77' });
    assert.deepEqual([peek.ok, peek.error.code], [false, 'NOT_FOUND']);
    const listed = await r.rpc(run, 'board_list_cards', {});
    assert.ok(!listed.result.cards.some((c) => c.title === 'Their secret'));
    const pointed = await r.rpc(run, 'board_create_card', { title: 'into their board' }, { repo_id: 'r2' });
    assert.equal(pointed.error.code, 'FORBIDDEN');

    const eve = await h.login('eve');
    const re = await h.runner(await h.enroll(eve), { advertise: false });
    for (const [method, params] of [['board_create_card', { title: 'borrowed token' }], ['board_add_lesson', { text: 'borrowed token lesson' }]]) {
      const stolen = await re.rpc(run, method, params);
      assert.deepEqual([stolen.ok, stolen.error.code], [false, 'FORBIDDEN'], method);
    }
    const made = await r.rpc(run, 'board_create_card', { title: 'ours' });
    assert.equal(h.card(made.result.card_id).board_id, h.ids.board);
    assert.equal((await h.api(eve, 'GET', `/api/cards/${made.result.card_id}`)).status, 404, 'eve cannot see the new card');
    assert.equal(h.db.get("SELECT count(*) AS n FROM cards WHERE board_id = 'b2'").n, 1, 'nothing landed in the other org');
    assert.equal(h.db.get("SELECT count(*) AS n FROM lessons WHERE org_id = 'o2'").n, 0);
  } finally {
    await h.destroy();
  }
});
