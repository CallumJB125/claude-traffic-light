// Tenancy suite v1 beyond the route matrix (ACCOUNTS-DESIGN.md §7.3, CONTRACT
// D61, D63): T-ROLES over HTTP, T-WS-SUB / T-WS-REVOKE, T-JOURNAL, T-IDEMP,
// T-OVL (structural), T-DB invariants and T-TRIG. Two teams, two owners and a
// shared user S; nothing may cross.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy, INVARIANTS, MARK } from './fixture.js';
import { settle } from '../helpers.js';

const rid = () => randomUUID();

test('T-ROLES: per-role answers on team A (owner, admin, member, viewer)', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A } = fx;
    const roles = { owner: users.ua, admin: users.aadmin, member: users.amember, viewer: users.aviewer };
    // [method, path, body] → expected status per role [owner, admin, member, viewer]
    const rows = [
      ['GET', `/api/teams/${A.team}`, undefined, [200, 200, 200, 200]],
      ['GET', `/api/teams/${A.team}/members`, undefined, [200, 200, 200, 200]],
      ['GET', `/api/boards/${A.board}`, undefined, [200, 200, 200, 200]],
      ['GET', `/api/boards/${A.board}/journal`, undefined, [200, 200, 200, 200]],
      ['GET', `/api/cards/${A.card}`, undefined, [200, 200, 200, 200]],
      ['POST', `/api/boards/${A.board}/cards`, () => ({ request_id: rid(), title: 't' }), [200, 200, 200, 403]],
      ['POST', `/api/cards/${A.card}/comments`, () => ({ request_id: rid(), body: 'hi' }), [200, 200, 200, 403]],
      ['PATCH', `/api/teams/${A.team}`, () => ({ request_id: rid(), name: 'Alpha' }), [200, 200, 403, 403]],
      ['POST', `/api/teams/${A.team}/boards`, () => ({ request_id: rid(), name: 'More' }), [200, 200, 403, 403]],
      ['POST', '/api/repos', () => ({ request_id: rid(), url: `git@github.com:alpha/r${rid().slice(0, 6)}.git` }), [200, 200, 403, 403]],
      ['PATCH', `/api/teams/${A.team}/members/${A.s}`, () => ({ request_id: rid(), role: 'member' }), [200, 200, 403, 403]],
    ];
    for (const [method, path, body, want] of rows) {
      const got = [];
      for (const u of Object.values(roles)) got.push((await as(u, method, path, body?.(), { 'x-board-team': A.team })).status);
      assert.deepEqual(got, want, `${method} ${path}`);
    }
  } finally {
    await fx.h.close();
  }
});

test('T-WS-SUB: subscribing to B is NOT_FOUND; 50 B mutations reach no A socket; S on A sees only A', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, B } = fx;
    const ua = await fx.h.browser({ token: users.ua.token });
    ua.send({ type: 'hello', protocol: 1 });
    await ua.next('welcome');
    ua.send({ type: 'subscribe', board_id: B.board });
    assert.equal((await ua.next('error')).code, 'NOT_FOUND');
    await ua.subscribe(A.board);
    const s = await fx.h.browser({ token: users.s.token });
    await s.subscribe(A.board);
    assert.equal(s.snapshot.board.id, A.board);
    assert.ok(!JSON.stringify(s.snapshot).includes(MARK));
    ua.clear();
    s.clear();
    for (let i = 0; i < 25; i++) {
      await as(users.ub, 'POST', `/api/boards/${B.board}/cards`, { request_id: rid(), title: `${MARK} ${i}` });
      await as(users.s, 'POST', `/api/cards/${B.card}/comments`, { request_id: rid(), body: `${MARK} c${i}` });
    }
    await as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { request_id: rid(), title: 'alpha only' });
    await s.next('card.upsert', (m) => m.card.title === 'alpha only');
    await settle();
    for (const b of [ua, s]) {
      const frames = JSON.stringify(b.msgs);
      assert.ok(!frames.includes(MARK), 'no B text on an A socket');
      assert.ok(!frames.includes(B.board) && !frames.includes(B.card), 'no B ids on an A socket');
      assert.ok(b.msgs.every((m) => !m.board_id || m.board_id === A.board));
    }
    // S can move the same socket to B (its own team) and then sees B.
    s.send({ type: 'subscribe', board_id: B.board });
    const snapB = await s.next('snapshot', () => true, { fresh: true });
    assert.equal(snapB.board.id, B.board);
  } finally {
    await fx.h.close();
  }
});

test('T-WS-REVOKE: removal from A closes the A socket (4403) but not S on B; B team deletion closes B sockets', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, B } = fx;
    const sa = await fx.h.browser({ token: users.s.token });
    await sa.subscribe(A.board);
    const sb = await fx.h.browser({ token: users.s.token });
    await sb.subscribe(B.board);
    assert.equal((await as(users.ua, 'DELETE', `/api/teams/${A.team}/members/${A.s}`, {})).status, 200);
    assert.equal(await sa.closed(), 4403);
    await settle();
    assert.equal(sb.closeCode, null, 'the B socket stays');
    await as(users.ub, 'POST', `/api/boards/${B.board}/cards`, { request_id: rid(), title: 'still here' });
    await sb.next('card.upsert', (m) => m.card.title === 'still here');
    assert.equal((await as(users.ub, 'DELETE', `/api/teams/${B.team}`, { confirm_slug: fx.db.get('SELECT slug FROM orgs WHERE id = ?', B.team).slug })).status, 200);
    assert.equal(await sb.closed(), 4403);
  } finally {
    await fx.h.close();
  }
});

test('T-JOURNAL + T-IDEMP: B journal is 404 from A; S writes land in the right board; one request_id in A and B = two effects', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, B, db } = fx;
    assert.equal((await as(users.ua, 'GET', `/api/boards/${B.board}/journal`)).status, 404);
    const id = rid();
    const inA = await as(users.s, 'POST', `/api/boards/${A.board}/cards`, { request_id: id, title: 'S in A' });
    const inB = await as(users.s, 'POST', `/api/boards/${B.board}/cards`, { request_id: id, title: 'S in B' });
    assert.equal(inA.status, 200);
    assert.equal(inB.status, 200);
    assert.equal(inB.headers.get('board-replayed'), null, 'not a replay of the A answer');
    assert.notEqual(inA.body.card.id, inB.body.card.id);
    const replay = await as(users.s, 'POST', `/api/boards/${A.board}/cards`, { request_id: id, title: 'S in A' });
    assert.equal(replay.headers.get('board-replayed'), '1');
    assert.equal(replay.body.card.id, inA.body.card.id);
    const rows = db.all("SELECT board_id, card_id FROM journal WHERE kind = 'card.create' AND card_id IN (?, ?)", inA.body.card.id, inB.body.card.id);
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.card_id, r.board_id])), { [inA.body.card.id]: A.board, [inB.body.card.id]: B.board });
    const ja = await as(users.s, 'GET', `/api/boards/${A.board}/journal`);
    assert.ok(ja.body.rows.every((r) => r.board_id === A.board));
    assert.ok(!ja.text.includes(MARK));
  } finally {
    await fx.h.close();
  }
});

test('T-DB + T-OVL: the §7.2 invariants hold; the shared repo URL is two rows, one per team', async () => {
  const fx = await tenancy();
  try {
    const repos = fx.db.all("SELECT org_id FROM repos WHERE canonical_url = 'github.com/shared/app'").map((r) => r.org_id).sort();
    assert.deepEqual(repos, [fx.A.team, fx.B.team].sort());
    for (const [name, sql] of Object.entries(INVARIANTS)) assert.deepEqual(fx.db.all(sql), [], name);
  } finally {
    await fx.h.close();
  }
});

test('T-TRIG: direct writes that point across teams raise "cross-team reference"', async () => {
  const fx = await tenancy();
  try {
    const { db, A, B } = fx;
    const now = fx.h.hub.iso();
    const card = (over) => ({ id: rid(), board_id: A.board, key: `X-${rid().slice(0, 4)}`, title: 't', created_by: A.owner, created_at: now, updated_at: now, ...over });
    const bad = {
      'card with B repo': () => db.insert('cards', card({ repo_id: B.repo })),
      'card created by a B member': () => db.insert('cards', card({ created_by: B.owner })),
      'card moved to B board': () => db.run('UPDATE cards SET board_id = ? WHERE id = ?', B.board, A.card),
      'card stopped by a B member': () => db.run('UPDATE cards SET stopped_by = ? WHERE id = ?', B.owner, A.card),
      'board_repos A board + B repo': () => db.insert('board_repos', { board_id: A.board, repo_id: B.repo }),
      'assignee from B': () => db.insert('card_assignees', { card_id: A.card, member_id: B.owner, role: 'collaborator' }),
      'dispatch by a B member': () => db.insert('dispatches', { request_id: rid(), card_id: A.card, dispatched_by: B.owner, created_at: now }),
      'dispatch targeting a B member': () => db.insert('dispatches', { request_id: rid(), card_id: A.card, dispatched_by: A.owner, target_member_id: B.owner, created_at: now }),
      'run on a B device': () => {
        const d = rid();
        db.insert('dispatches', { request_id: d, card_id: A.card, dispatched_by: A.owner, state: 'claimed', created_at: now });
        db.insert('runs', { id: rid(), card_id: A.card, fence: 9, device_id: B.device, on_behalf_of: A.owner, dispatched_by: A.owner, dispatch_request_id: d, backend: 'claude_cli', repo_id: A.repo, base_ref: 'main', started_at: now });
      },
      'comment by a B member': () => db.insert('comments', { id: rid(), card_id: A.card, author_member_id: B.owner, source: 'web', trusted: 1, body: 'x', created_at: now }),
      'ask answered by an A member': () => db.run('UPDATE asks SET answered_by = ? WHERE id = ?', A.owner, B.ask),
      'permission answered by an A member': () => db.run('UPDATE permission_requests SET answered_by = ? WHERE id = ?', A.owner, B.permission),
      'memory with a B repo': () => db.insert('memories', { id: rid(), org_id: A.team, repo_id: B.repo, kind: 'gotcha', body: 'x', author_member_id: A.owner, created_at: now, updated_at: now }),
      'lesson with a B card': () => db.insert('lessons', { id: rid(), org_id: A.team, repo_id: A.repo, card_id: B.card, text: 'a lesson text', created_at: now }),
      'runner_repos B device + A repo': () => db.insert('runner_repos', { device_id: B.device, repo_id: A.repo, advertised_at: now }),
    };
    for (const [name, fn] of Object.entries(bad)) assert.throws(() => db.tx(fn), /cross-team reference/, name);
    // The same writes inside one team are fine.
    db.insert('card_assignees', { card_id: A.card, member_id: A.member, role: 'collaborator' });
    db.insert('comments', { id: rid(), card_id: A.card, author_member_id: A.s, source: 'web', trusted: 1, body: 'ok', created_at: now });
    for (const [name, sql] of Object.entries(INVARIANTS)) assert.deepEqual(db.all(sql), [], name);
  } finally {
    await fx.h.close();
  }
});
