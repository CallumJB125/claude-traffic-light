import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tenancy } from './tenancy/fixture.js';
import { loadMigrations, migrate } from '../../shared/migrate.js';
import { prefixAudit } from '../board-prefix-audit.js';

test('every team role lists all its boards; admin rename keeps keys; foreign resources are opaque', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, B, h } = fx;
    const created = await as(users.ua, 'POST', `/api/teams/${A.team}/boards`, { name: 'Design' });
    assert.equal(created.status, 200, created.text);
    const id = created.body.board.id;
    for (const u of [users.ua, users.aadmin, users.amember, users.aviewer]) {
      const r = await as(u, 'GET', `/api/teams/${A.team}/boards`);
      assert.deepEqual(r.body.boards.map((b) => b.id), [A.board, id]);
    }
    const beforeKey = h.hub.card(A.card).key;
    assert.equal((await as(users.ua, 'GET', `/api/cards/${A.card}`)).body.card.board_id, A.board);
    const socket = await h.browser({ token: users.aviewer.token });
    await socket.subscribe(A.board);
    const renamed = await as(users.aadmin, 'PATCH', `/api/boards/${A.board}`, { name: 'Delivery' });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.board.key_prefix, 'ALP');
    assert.equal(h.hub.card(A.card).key, beforeKey);
    const event = await socket.next('team.boards');
    assert.equal(event.org_id, A.team);
    assert.equal(event.boards.find((b) => b.id === A.board).name, 'Delivery');
    for (const u of [users.amember, users.aviewer]) {
      assert.equal((await as(u, 'PATCH', `/api/boards/${A.board}`, { name: 'No' })).status, 403);
      assert.equal((await as(u, 'POST', `/api/boards/${id}/archive`, {})).status, 403);
      assert.equal((await as(u, 'POST', '/api/boards', { name: 'No' })).status, 403);
    }
    const snapshot = fx.snapshotB();
    for (const path of [`/api/boards/${B.board}`, `/api/boards/${B.board}/archive`, `/api/boards/${B.board}/restore`]) {
      const r = await as(users.ua, path.endsWith(B.board) ? 'PATCH' : 'POST', path, { name: 'No' });
      assert.equal(r.status, 404, r.text);
    }
    assert.equal(fx.snapshotB(), snapshot);
    assert.equal((await as(users.ua, 'GET', `/api/teams/${B.team}/boards?include_archived=1`)).status, 404);
  } finally { await fx.h.close(); }
});

test('simultaneous automatic prefixes are unique; explicit conflicts409 and prefixes stay reserved after archive', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, h } = fx;
    const make = (body) => as(users.ua, 'POST', `/api/teams/${A.team}/boards`, body);
    const made = await Promise.all([make({ name: 'Alpha Design' }), make({ name: 'Alpha Research' })]);
    assert.ok(made.every((r) => r.status === 200), JSON.stringify(made));
    assert.deepEqual(made.map((r) => r.body.board.key_prefix).sort(), ['ALPA', 'ALPB']);
    assert.deepEqual([(await make({ name: 'Explicit', key_prefix: 'ALP' })).status, (await make({ name: 'Bad', key_prefix: 'bad' })).status], [409, 400]);
    const board = made[0].body.board;
    assert.equal((await as(users.ua, 'POST', `/api/boards/${board.id}/archive`, {})).status, 200);
    assert.equal((await make({ name: 'Reserved', key_prefix: board.key_prefix })).status, 409);
    assert.throws(() => h.db.insert('boards', { id: randomUUID(), org_id: A.team, name: 'Duplicate', key_prefix: 'ALP' }), /UNIQUE/);
  } finally { await fx.h.close(); }
});

test('archive/restore journals and pushes lifecycle; archives are readable, read-only, hidden from active lists', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, h } = fx;
    const next = await as(users.ua, 'POST', '/api/boards', { name: 'Second' });
    assert.equal(next.status, 200, next.text);
    const sock = await h.browser({ token: users.amember.token });
    await sock.subscribe(A.board);
    const archive = await as(users.ua, 'POST', `/api/boards/${A.board}/archive`, {});
    assert.equal(archive.status, 200, archive.text);
    assert.ok(archive.body.board.archived_at);
    assert.equal((await sock.next('team.boards')).boards.find((b) => b.id === A.board).archived_at, archive.body.board.archived_at);
    for (const route of ['/api/boards', `/api/teams/${A.team}/boards`, '/api/me']) {
      const r = await as(users.ua, 'GET', route);
      assert.deepEqual(r.body.boards.map((b) => b.id), [next.body.board.id]);
    }
    assert.deepEqual((await as(users.ua, 'GET', '/api/account')).body.teams[0].boards.map((b) => b.id), [next.body.board.id]);
    assert.equal((await as(users.aviewer, 'GET', `/api/boards/${A.board}`)).body.board.archived_at, archive.body.board.archived_at);
    assert.equal((await as(users.amember, 'GET', `/api/cards/${A.card}`)).status, 200);
    const attempts = [
      ['POST', `/api/boards/${A.board}/cards`, { title: 'No' }],
      ['PATCH', `/api/cards/${A.card}`, { version: h.hub.card(A.card).version, title: 'No' }],
      ['POST', `/api/cards/${A.card}/comments`, { body: 'No' }],
      ['POST', `/api/cards/${A.card}/actions/dispatch`, { request_id: randomUUID() }],
      ['POST', `/api/cards/${A.card}/archive`, {}],
      ['POST', `/api/cards/${A.card}/restore`, {}],
      ['POST', `/api/boards/${A.board}/labels`, { name: 'No', color: 'red' }],
      ['POST', `/api/boards/${A.board}/repos`, { repo_id: A.repo }],
      ['PATCH', `/api/boards/${A.board}`, { name: 'No' }],
    ];
    for (const [method, path, body] of attempts) {
      const r = await as(users.ua, method, path, body);
      assert.deepEqual([r.status, r.body.error.reason], [409, 'BOARD_ARCHIVED'], `${method} ${path}: ${r.text}`);
    }
    assert.equal((await as(users.ua, 'POST', `/api/boards/${next.body.board.id}/archive`, {})).body.error.reason, 'LAST_ACTIVE_BOARD');
    assert.equal((await as(users.aadmin, 'POST', `/api/boards/${A.board}/restore`, {})).status, 200);
    assert.equal((await as(users.ua, 'POST', `/api/boards/${A.board}/restore`, {})).status, 200, 'idempotent');
    assert.equal((await as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { title: 'Restored' })).status, 200);
    assert.deepEqual(h.db.all("SELECT kind FROM journal WHERE board_id = ? AND kind LIKE 'board.%' ORDER BY seq", A.board).map((r) => r.kind), ['board.create', 'board.archive', 'board.restore']);
  } finally { await fx.h.close(); }
});

test('active runs and queueing block archive; simultaneous archiving preserves the last active board', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, B, h } = fx;
    assert.equal((await as(users.ub, 'POST', `/api/teams/${B.team}/boards`, { name: 'Spare' })).status, 200);
    const blocked = await as(users.ub, 'POST', `/api/boards/${B.board}/archive`, {});
    assert.deepEqual([blocked.status, blocked.body.error.reason], [409, 'ACTIVE_RUN']);
    // The actual API queue must recheck board archival before a waiting mutation runs.
    const member = h.hub.member(A.owner);
    let release;
    const held = h.hub.withBoard(A.board, () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    const spare = (await as(users.ua, 'POST', '/api/boards', { name: 'Spare' })).body.board.id;
    const archive = h.app.api.setBoardArchived(member, A.board, true);
    const waiting = h.app.api.createCard(member, A.board, { title: 'Late' });
    release(); await held; await archive;
    await assert.rejects(waiting, (e) => e.extra?.reason === 'BOARD_ARCHIVED');
    await h.app.api.setBoardArchived(member, A.board, false);
    const results = await Promise.all([as(users.ua, 'POST', `/api/boards/${A.board}/archive`, {}), as(users.ua, 'POST', `/api/boards/${spare}/archive`, {})]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(h.hub.boardList(A.team).length, 1);
  } finally { await fx.h.close(); }
});

test('queued lifecycle changes recheck admin authority after a demotion', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, h } = fx;
    await as(users.ua, 'POST', '/api/boards', { name: 'Spare' });
    for (const operation of ['rename', 'archive', 'restore']) {
      h.db.run("UPDATE members SET role = 'admin' WHERE id = ?", A.admin);
      if (operation === 'restore') await h.app.api.setBoardArchived(h.hub.member(A.owner), A.board, true);
      let release;
      const held = h.hub.withBoard(A.board, () => new Promise((resolve) => { release = resolve; }));
      await new Promise((resolve) => setImmediate(resolve));
      const actor = h.hub.member(A.admin);
      const pending = operation === 'rename' ? h.app.api.updateBoard(actor, A.board, { name: 'Late rename' }) : h.app.api.setBoardArchived(actor, A.board, operation === 'archive');
      h.db.run("UPDATE members SET role = 'member' WHERE id = ?", A.admin);
      release(); await held;
      await assert.rejects(pending, (e) => e.code === 'FORBIDDEN');
      assert.equal(h.hub.board(A.board).name, 'Alpha');
      assert.equal(!!h.hub.board(A.board).archived_at, operation === 'restore');
    }
  } finally { await fx.h.close(); }
});

test('an in-flight merge poll cannot change an archived board; restore resumes polling', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, h } = fx;
    await as(users.ua, 'POST', '/api/boards', { name: 'Spare' });
    h.db.run("UPDATE cards SET run_state = 'in_review', column_name = 'in_review' WHERE id = ?", A.card);
    h.db.insert('evidence', { id: randomUUID(), card_id: A.card, kind: 'pr', ref: '#5', verification: 'hub_verified', created_at: h.hub.iso() });
    const pull = { number: 5, html_url: 'https://github.com/shared/app/pull/5', head_ref: `board/${h.hub.card(A.card).key}-r1`, head_repo_id: 100, base_repo_id: 100, base_ref: 'main', state: 'closed', merged: true };
    let release, began;
    const started = new Promise((resolve) => { began = resolve; });
    h.hub.github.getPull = () => { began(); return new Promise((resolve) => { release = () => resolve(pull); }); };
    const pending = h.hub.pollMerges();
    await started;
    assert.equal((await as(users.ua, 'POST', `/api/boards/${A.board}/archive`, {})).status, 200);
    release(); await pending;
    assert.equal(h.hub.card(A.card).run_state, 'in_review');
    assert.equal(h.hub.prStatus.has(A.card), false);
    await as(users.ua, 'POST', `/api/boards/${A.board}/restore`, {});
    h.hub.github.getPull = async () => pull;
    await h.hub.pollMerges();
    assert.equal(h.hub.card(A.card).run_state, 'done');
  } finally { await fx.h.close(); }
});

test('integration default is per connection, team-scoped, durable and pauses on archive instead of rerouting', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, B, h } = fx;
    const spare = (await as(users.ub, 'POST', `/api/teams/${B.team}/boards`, { name: 'Intake' })).body.board;
    const reg = h.app.integrations;
    const ctx = reg.ctxFor(B.connection);
    assert.equal(ctx.boardIds()[0], B.board);
    const patch = (target_board_id, u = users.ub) => as(u, 'PATCH', `/api/integrations/${B.connection}`, { target_board_id });
    assert.equal((await patch(A.board)).status, 404);
    assert.equal((await patch(spare.id, users.s)).status, 403);
    assert.equal((await patch(spare.id)).body.connection.target_board_id, spare.id);
    assert.equal(ctx.boardIds()[0], spare.id, 'a retained context reads the current target');
    await assert.rejects(ctx.act('card.create', {}, (s) => s.actAs(B.owner).createCard(spare.id, { title: 'Stale intake', request_id: 'target-stale' })), (e) => e.code === 'FORBIDDEN' && e.cacheable === false);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM cards WHERE title = 'Stale intake'").n, 0, 'a settings change retires captured write authority');
    const current = reg.ctxFor(B.connection);
    const created = await current.act('card.create', {}, (s) => s.actAs(B.owner).createCard(current.boardIds()[0], { title: 'Intake', request_id: 'target-first' }));
    const card = created.result.card;
    assert.equal(h.hub.card(card.id).board_id, spare.id);
    assert.equal((await as(users.ub, 'POST', `/api/boards/${spare.id}/archive`, {})).status, 200);
    assert.deepEqual(ctx.boardIds(), []);
    assert.ok(!ctx.boards().some((b) => b.id === spare.id));
    assert.equal((await patch(spare.id)).status, 200, 'same selection remains visible while paused');
    await assert.rejects(current.act('card.create', {}, (s) => s.actAs(B.owner).createCard(spare.id, { title: 'No', request_id: 'target-archived' })), (e) => e.extra?.reason === 'BOARD_ARCHIVED');
    assert.throws(() => h.db.run('UPDATE connections SET target_board_id = ? WHERE id = ?', A.board, B.connection), /another team/);
    await as(users.ub, 'POST', `/api/boards/${spare.id}/restore`, {});
    assert.equal(reg.ctxFor(B.connection).boardIds()[0], spare.id);
  } finally { await fx.h.close(); }
});

test('migration029 refuses legacy duplicate prefixes atomically; read-only audit names boards and repair choices', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const migrations = loadMigrations();
    migrate(db, { migrations: migrations.filter((m) => m.version < 29) });
    db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run('org', 'Legacy', '2000-01-01');
    const add = db.prepare('INSERT INTO boards (id, org_id, name, key_prefix) VALUES (?, ?, ?, ?)');
    add.run('one', 'org', 'First', 'OLD'); add.run('two', 'org', 'Second', 'OLD');
    const before = JSON.stringify(db.prepare('SELECT * FROM boards').all());
    const preview = prefixAudit(db);
    assert.equal(preview.ready, false);
    assert.deepEqual(preview.collisions[0].boards.map((b) => b.id), ['one', 'two']);
    assert.match(preview.collisions[0].options.join(' '), /preserve historical links/);
    const through29 = migrations.filter((m) => m.version <= 29);
    assert.throws(() => migrate(db, { migrations: through29 }), /duplicate board key prefixes.*board-prefix-audit/);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM boards').all()), before);
    assert.ok(!db.prepare("SELECT name FROM pragma_table_info('boards') WHERE name = 'archived_at'").get());
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 28);
    db.prepare('UPDATE boards SET key_prefix = ? WHERE id = ?').run('NEW', 'two');
    assert.deepEqual(migrate(db, { migrations: through29 }), [29]);
    assert.equal(prefixAudit(db).ready, true);
  } finally { db.close(); }
});
