import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub, until } from './helpers.js';
import { tenancy } from './tenancy/fixture.js';
import { Workflows } from '../workflows.js';
import { PLAN_APPROVAL_LABEL } from '../../shared/states.js';

const def = (name = 'Delivery') => ({ name, description: 'Reviewable task set', steps: [
  { title: 'Plan the work', body: 'Write the brief', acceptance: 'Human reviews the plan', plan_approval: true },
  { title: 'Verify and deliver', body: 'Record actual checks', acceptance: 'Human approves the result', plan_approval: false },
] });
async function create(h, cookie, over = {}) {
  const result = await h.api(cookie, 'POST', '/api/workflows', { request_id: randomUUID(), definition: def(), ...over });
  assert.equal(result.status, 200, result.text); return result.body.workflow;
}

test('immutable versions and exact task-set creation bind durable retries and retain original provenance', async () => {
  const h = await startHub();
  try {
    const cookie = await h.login('alice'), request = randomUUID(), original = def();
    const w = await create(h, cookie, { request_id: request, definition: original });
    const replay = await h.api(cookie, 'POST', '/api/workflows', { request_id: request, definition: original });
    assert.deepEqual(replay.body.workflow, w);
    assert.equal((await h.api(cookie, 'POST', '/api/workflows', { request_id: request, definition: def('Changed') })).status, 409);
    const version = await h.api(cookie, 'POST', `/api/workflows/${w.id}/versions`, { request_id: randomUUID(), expected_version: 1, definition: def('Delivery v2') });
    assert.equal(version.status, 200, version.text); assert.equal(version.body.workflow.version, 2);
    assert.throws(() => h.db.run('UPDATE workflow_versions SET definition = ? WHERE recipe_id = ? AND version = 1', JSON.stringify(def('Tampered')), w.id), /immutable/);
    const payload = { request_id: randomUUID(), version: 1, content_hash: w.content_hash, context: 'Client needs keyboard access', title_prefix: 'Website' };
    const path = `/api/boards/${h.ids.board}/workflows/${w.id}/apply`;
    const first = await h.api(cookie, 'POST', path, payload); assert.equal(first.status, 200, first.text);
    assert.equal(first.body.instance.version, 1); assert.equal(first.body.instance.steps.length, 2);
    assert.deepEqual((await h.api(cookie, 'POST', path, payload)).body, first.body);
    assert.equal((await h.api(cookie, 'POST', path, { ...payload, context: 'Different context' })).status, 409);
    for (const s of first.body.instance.steps) {
      const c = h.hub.card(s.id); assert.equal(c.repo_id, null); assert.equal(c.run_state, null); assert.equal(c.active_run_id, null); assert.equal(c.column_name, 'todo'); assert.equal(c.created_by, h.ids.alice); assert.match(c.body, /Client needs keyboard access/);
      assert.equal(h.db.get('SELECT COUNT(*) n FROM dispatches WHERE card_id = ?', c.id).n, 0);
    }
    assert.deepEqual(JSON.parse(h.hub.card(first.body.instance.steps[0].id).labels), [PLAN_APPROVAL_LABEL]);
    const detail = await h.api(cookie, 'GET', `/api/workflows/${w.id}`); assert.equal(detail.body.versions.length, 2); assert.equal(detail.body.instances[0].version, 1);
    const id = first.body.instance.steps[0].id; h.db.run("UPDATE cards SET column_name = 'done' WHERE id = ?", id);
    assert.equal((await h.api(cookie, 'GET', `/api/workflows/${w.id}`)).body.instances[0].steps[0].column, 'done');
    const changed = await h.api(cookie, 'PATCH', `/api/cards/${id}`, { request_id: randomUUID(), version: h.hub.card(id).version, body: 'Updated private client context' }); assert.equal(changed.status, 200, changed.text);
    const journal = h.db.all("SELECT payload FROM journal WHERE card_id = ? AND kind = 'card.update'", id); assert.ok(!JSON.stringify(journal).includes('Updated private client context')); assert.ok(JSON.stringify(journal).includes('body_hmac'));
    assert.equal((await h.api(cookie, 'POST', path, { ...payload, request_id: randomUUID(), content_hash: '0'.repeat(64) })).status, 409);
    assert.equal((await h.api(cookie, 'POST', `/api/workflows/${w.id}/versions`, { request_id: randomUUID(), expected_version: 1, definition: original })).status, 409);
  } finally { await h.close(); }
});

test('all steps, keys, provenance and notifications commit atomically or roll back', async () => {
  const h = await startHub();
  try {
    const cookie = await h.login('alice'), w = await create(h, cookie);
    const before = JSON.stringify({ key: h.hub.board(h.ids.board).next_key, cards: h.db.all('SELECT id FROM cards'), journal: h.db.all('SELECT seq FROM journal'), instances: h.db.all('SELECT * FROM workflow_instances') });
    const insert = h.db.insert.bind(h.db); let steps = 0;
    h.db.insert = (table, row) => { if (table === 'workflow_step_cards' && ++steps === 2) throw Error('forced storage failure'); return insert(table, row); };
    const result = await h.api(cookie, 'POST', `/api/boards/${h.ids.board}/workflows/${w.id}/apply`, { request_id: randomUUID(), version: 1, content_hash: w.content_hash });
    h.db.insert = insert; assert.equal(result.status, 500);
    const after = JSON.stringify({ key: h.hub.board(h.ids.board).next_key, cards: h.db.all('SELECT id FROM cards'), journal: h.db.all('SELECT seq FROM journal'), instances: h.db.all('SELECT * FROM workflow_instances') }); assert.equal(after, before);
  } finally { await h.close(); }
});

test('workflow read/write/archive scope denies guests and foreign teams while viewers can read', async () => {
  const f = await tenancy();
  try {
    const { users, A, B, as } = f;
    const body = { request_id: randomUUID(), definition: def() };
    assert.equal((await as(users.aadmin, 'POST', '/api/workflows', body)).status, 200);
    assert.equal((await as(users.aviewer, 'GET', '/api/workflows')).body.workflows.length, 1);
    assert.equal((await as(users.aviewer, 'POST', '/api/workflows', { ...body, request_id: randomUUID() })).status, 403);
    assert.equal((await as(users.ua, 'GET', `/api/workflows/${B.workflow}`)).status, 404);
    assert.equal((await as(users.bguest, 'GET', `/api/workflows/${B.workflow}`)).status, 404);
    assert.equal((await as(users.ua, 'POST', `/api/boards/${A.board}/workflows/${B.workflow}/apply`, { request_id: randomUUID(), version: 1, content_hash: B.workflowHash })).status, 404);
    assert.equal((await as(users.ub, 'POST', `/api/workflows/${B.workflow}/archive`, { archived: true })).status, 200);
    assert.equal((await as(users.ub, 'GET', '/api/workflows')).body.workflows.length, 0);
    assert.equal((await as(users.ub, 'POST', `/api/boards/${B.board}/workflows/${B.workflow}/apply`, { request_id: randomUUID(), version: 1, content_hash: B.workflowHash })).status, 409);
    assert.equal((await as(users.ub, 'POST', `/api/workflows/${B.workflow}/archive`, { archived: false })).status, 200);
  } finally { await f.h.close(); }
});

for (const operation of ['publish', 'apply']) test(`queued workflow ${operation} rechecks membership and credential before writing`, async () => {
  const f = await tenancy(); let release;
  try {
    const { h, A, users, as } = f, created = await as(users.amember, 'POST', '/api/workflows', { request_id: randomUUID(), definition: def() }); assert.equal(created.status, 200, created.text); const w = created.body.workflow;
    const key = operation === 'publish' ? `workflows:${A.team}` : A.board;
    const held = h.hub.withBoard(key, () => new Promise((resolve) => { release = resolve; })); await new Promise((resolve) => setImmediate(resolve));
    const before = h.db.get('SELECT COUNT(*) n FROM cards').n, withBoard = h.hub.withBoard.bind(h.hub); let queued = false;
    h.hub.withBoard = (id, fn) => { if (id === key) queued = true; return withBoard(id, fn); };
    const pending = operation === 'publish' ? as(users.amember, 'POST', `/api/workflows/${w.id}/versions`, { request_id: randomUUID(), expected_version: 1, definition: def('Queued') }) : as(users.amember, 'POST', `/api/boards/${A.board}/workflows/${w.id}/apply`, { request_id: randomUUID(), version: 1, content_hash: w.content_hash });
    await until(() => queued); h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", A.member); release(); await held;
    assert.equal((await pending).status, 403); assert.equal(h.db.get('SELECT COUNT(*) n FROM cards').n, before); assert.equal(h.db.get('SELECT latest_version FROM workflow_recipes WHERE id = ?', w.id).latest_version, 1);
    const service = new Workflows(h.hub); assert.throws(() => service.list(h.hub.member(A.owner), { kind: 'device', id: 'missing' }), /sign in again/);
  } finally { release?.(); await f.h.close(); }
});

test('closed workflow definitions cannot carry executable config, authority or unbounded task sets', async () => {
  const h = await startHub();
  try {
    const cookie = await h.login('alice');
    for (const definition of [{ ...def(), steps: Array.from({ length: 9 }, () => def().steps[0]) }, { ...def(), ai: 'codex' }, { ...def(), steps: [{ ...def().steps[0], repo_id: randomUUID() }] }, { ...def(), steps: [{ ...def().steps[0], plan_approval: 'allow' }] }, { ...def(), name: '\u0000' }]) assert.equal((await h.api(cookie, 'POST', '/api/workflows', { request_id: randomUUID(), definition })).status, 400);
    const w = await create(h, cookie), path = `/api/boards/${h.ids.board}/workflows/${w.id}/apply`;
    assert.equal((await h.api(cookie, 'POST', path, { request_id: randomUUID(), version: 1, content_hash: w.content_hash, dispatch: true })).status, 400);
    await h.api(cookie, 'POST', `/api/workflows/${w.id}/archive`, { archived: true });
    assert.equal((await h.api(cookie, 'POST', `/api/workflows/${w.id}/versions`, { request_id: randomUUID(), expected_version: 1, definition: def('No') })).status, 409);
  } finally { await h.close(); }
});
