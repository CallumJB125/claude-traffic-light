// Label registry and archive in an accounts-mode hub (D91, D94): the role
// matrix per team role, and what team and account deletion do to the new rows.
// There is no hard purge yet (P5): a deleted team's label registry is dropped
// at once, inside the deleting transaction; its cards (cover, archived_at,
// archived_by) stay with the soft-deleted team until P5, and every route to
// them is already 404.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy, INVARIANTS } from './fixture.js';

const rid = () => randomUUID();

test('roles per team: members create and recolour labels and archive cards, admins rename and delete, viewers read only', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A } = fx;
    const path = (name = '') => `/api/boards/${A.board}/labels${name ? `/${encodeURIComponent(name)}` : ''}`;
    assert.equal((await as(users.amember, 'POST', path(), { request_id: rid(), name: 'Bug', color: 'red' })).status, 200);
    assert.equal((await as(users.amember, 'PATCH', path('Bug'), { request_id: rid(), color: 'blue' })).status, 200);
    assert.equal((await as(users.amember, 'PATCH', path('Bug'), { request_id: rid(), name: 'Defect' })).status, 403);
    assert.equal((await as(users.amember, 'DELETE', path('Bug'), { request_id: rid() })).status, 403);
    assert.equal((await as(users.aviewer, 'POST', path(), { request_id: rid(), name: 'x', color: 'red' })).status, 403);
    assert.equal((await as(users.aviewer, 'PATCH', path('Bug'), { request_id: rid(), color: 'red' })).status, 403);
    assert.deepEqual((await as(users.aviewer, 'GET', path())).body.labels.map((l) => [l.name, l.color]), [['Bug', 'blue']]);
    assert.equal((await as(users.aadmin, 'PATCH', path('Bug'), { request_id: rid(), name: 'Defect' })).status, 200);
    assert.equal((await as(users.aadmin, 'DELETE', path('Defect'), { request_id: rid() })).status, 200);
    assert.equal((await as(users.aviewer, 'POST', `/api/cards/${A.card}/archive`, { request_id: rid() })).status, 403);
    assert.equal((await as(users.amember, 'POST', `/api/cards/${A.card}/archive`, { request_id: rid() })).status, 200);
    assert.equal((await as(users.aviewer, 'POST', `/api/cards/${A.card}/restore`, { request_id: rid() })).status, 403);
    assert.equal((await as(users.aadmin, 'POST', `/api/cards/${A.card}/restore`, { request_id: rid() })).status, 200);
    for (const [name, sql] of Object.entries(INVARIANTS)) assert.deepEqual(fx.db.all(sql), [], name);
  } finally {
    await fx.h.close();
  }
});

test('team deletion drops the team\'s label registry in the same transaction and 404s the new routes; the other team keeps its own', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, B, db, h } = fx;
    await as(users.ua, 'POST', `/api/boards/${A.board}/labels`, { request_id: rid(), name: 'keep', color: 'green' });
    await as(users.ub, 'PATCH', `/api/cards/${B.card}`, { request_id: rid(), version: db.get('SELECT version FROM cards WHERE id = ?', B.card).version, cover: 'red' });
    assert.equal(db.get('SELECT COUNT(*) AS n FROM board_labels WHERE board_id = ?', B.board).n, 1);
    const slug = db.get('SELECT slug FROM orgs WHERE id = ?', B.team).slug;
    const del = await as(users.ub, 'DELETE', `/api/teams/${B.team}`, { confirm_slug: slug, flow_id: await h.stepUp(users.ub.token, users.ub.email, 'delete_team') });
    assert.equal(del.status, 200, del.text);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM board_labels WHERE board_id = ?', B.board).n, 0, 'B\'s registry is gone');
    assert.deepEqual(db.all('SELECT name FROM board_labels WHERE board_id = ?', A.board).map((r) => r.name), ['keep']);
    for (const [m, p] of [['GET', `/api/boards/${B.board}/labels`], ['POST', `/api/boards/${B.board}/labels`], ['POST', `/api/cards/${B.card}/archive`], ['POST', `/api/cards/${B.card}/restore`]]) {
      assert.equal((await as(users.ub, m, p, m === 'GET' ? undefined : { request_id: rid(), name: 'x', color: 'red' })).status, 404, `${m} ${p}`);
    }
    // Cards wait for the P5 purge with the rest of the team's rows.
    assert.equal(db.get('SELECT cover FROM cards WHERE id = ?', B.card).cover, 'red');
  } finally {
    await fx.h.close();
  }
});

test('account deletion: a team that goes with its only member loses its registry; in a shared team the labels and archive marks stay, pointing at the pseudonymised member', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, db, h } = fx;
    // N creates a team of their own, labels it, then deletes the account.
    const t = await as(users.n, 'POST', '/api/teams', { name: 'Solo' });
    assert.equal(t.status, 200, t.text);
    await as(users.n, 'POST', `/api/boards/${t.body.board.id}/labels`, { request_id: rid(), name: 'mine', color: 'pink' });
    // A's member labels and archives in team A, then deletes the account.
    await as(users.amember, 'POST', `/api/boards/${A.board}/labels`, { request_id: rid(), name: 'theirs', color: 'teal' });
    await as(users.amember, 'POST', `/api/cards/${A.card}/archive`, { request_id: rid() });
    for (const u of [users.n, users.amember]) {
      const r = await as(u, 'DELETE', '/api/account', { flow_id: await h.stepUp(u.token, u.email) });
      assert.equal(r.status, 200, r.text);
    }
    assert.equal(db.get('SELECT COUNT(*) AS n FROM board_labels WHERE board_id = ?', t.body.board.id).n, 0, 'the solo team\'s registry went with it');
    const kept = db.get("SELECT l.created_by, m.display_name, m.email FROM board_labels l JOIN members m ON m.id = l.created_by WHERE l.name = 'theirs'");
    assert.deepEqual([kept.created_by, kept.display_name, kept.email], [A.member, 'Deleted user', null]);
    const card = db.get('SELECT c.archived_by, m.display_name, m.email FROM cards c JOIN members m ON m.id = c.archived_by WHERE c.id = ?', A.card);
    assert.deepEqual([card.archived_by, card.display_name, card.email], [A.member, 'Deleted user', null]);
    const view = (await as(users.ua, 'GET', `/api/boards/${A.board}?include_archived=1`)).body.cards.find((c) => c.id === A.card);
    assert.equal(view.archived.by_name, 'Deleted user');
  } finally {
    await fx.h.close();
  }
});
