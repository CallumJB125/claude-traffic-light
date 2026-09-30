// T-ROUTES (ACCOUNTS-DESIGN.md §7.3, CONTRACT D63): every HTTP route of an
// accounts-mode hub, called by a user of team A (and by a user in no team)
// with team B's ids, answers 404 with none of B's data, and leaves B's rows
// untouched. The route table is read from the hub itself: a route missing
// from MATRIX below fails the coverage test, so a new route can't skip it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy, MARK } from './fixture.js';

// kind:
//   cross    – names B's resources in the path; expect 404
//   team     – no resource in the path; sent with X-Board-Team: <B>; expect 404
//   self     – acts only on the caller's own account (no foreign id possible)
//   public   – no auth (health, sign-in, invite preview): proven in their own tests
//   (a cross entry may name another expected `status` when 404 isn't the generic answer)
//   create   – makes a new team for the caller (teams.test.js)
// For cross routes `path(fx)` fills B's ids; `alt` adds calls that mix A's
// team with B's sub-resource ids (also 404).
const MATRIX = {
  'GET /api/health': { kind: 'public' },
  'POST /api/auth/email/start': { kind: 'public' },
  'POST /api/auth/email/verify': { kind: 'public' },
  'POST /api/auth/signout': { kind: 'self' },
  'GET /api/account': { kind: 'self' },
  'DELETE /api/account': { kind: 'self' },
  'GET /api/account/devices': { kind: 'self' },
  'DELETE /api/account/devices/:id': { kind: 'cross', path: (fx) => `/api/account/devices/${fx.users.ub.device_id}` },
  'GET /api/me': { kind: 'team' },
  'POST /api/teams': { kind: 'create' },
  'GET /api/teams/:team_id': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}` },
  'PATCH /api/teams/:team_id': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}`, body: { name: 'pwned' } },
  'DELETE /api/teams/:team_id': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}`, body: { confirm_slug: 'x' } },
  'POST /api/teams/:team_id/boards': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/boards`, body: { name: 'pwned' } },
  'GET /api/teams/:team_id/members': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/members` },
  'PATCH /api/teams/:team_id/members/:member_id': {
    kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/members/${fx.B.s}`, body: { role: 'admin' },
    alt: (fx) => [`/api/teams/${fx.A.team}/members/${fx.B.owner}`],
  },
  'DELETE /api/teams/:team_id/members/:member_id': {
    kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/members/${fx.B.s}`,
    alt: (fx) => [`/api/teams/${fx.A.team}/members/${fx.B.owner}`],
  },
  'GET /api/teams/:team_id/invites': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/invites` },
  'POST /api/teams/:team_id/invites': { kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/invites`, body: { email: 'x@pwned.test', role: 'member' } },
  'DELETE /api/teams/:team_id/invites/:invite_id': {
    kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/invites/${fx.B.invite}`,
    alt: (fx) => [`/api/teams/${fx.A.team}/invites/${fx.B.invite}`],
  },
  'POST /api/teams/:team_id/invites/:invite_id/resend': {
    kind: 'cross', path: (fx) => `/api/teams/${fx.B.team}/invites/${fx.B.invite}/resend`,
    alt: (fx) => [`/api/teams/${fx.A.team}/invites/${fx.B.invite}/resend`],
  },
  'POST /api/invites/preview': { kind: 'public' },
  // Token / own-address acceptance: invites.test.js proves the email binding.
  'POST /api/invites/accept': { kind: 'self' },
  // An invite addressed to someone else is as unknown as a made-up id: the one
  // generic INVALID_TOKEN (not 404), and nothing about it in the answer.
  'POST /api/account/invites/:invite_id/accept': { kind: 'cross', status: 400, path: (fx) => `/api/account/invites/${fx.B.invite}/accept` },
  'GET /api/boards/:board_id': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}` },
  'GET /api/boards/:board_id/alerts': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/alerts` },
  'GET /api/boards/:board_id/journal': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/journal` },
  'GET /api/boards/:board_id/presence': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/presence` },
  'POST /api/boards/:board_id/cards': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/cards`, body: { title: 'pwned' } },
  'POST /api/boards/:board_id/repos': { kind: 'cross', path: (fx) => `/api/boards/${fx.B.board}/repos`, body: (fx) => ({ repo_id: fx.B.repo }) },
  'GET /api/cards/:card_id': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}` },
  'PATCH /api/cards/:card_id': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}`, body: { title: 'pwned', version: 0 } },
  'POST /api/cards/:card_id/actions/:action': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/actions/stop`, body: {} },
  'POST /api/cards/:card_id/comments': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/comments`, body: { body: 'pwned' } },
  'GET /api/cards/:card_id/handover': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/handover` },
  'GET /api/cards/:card_id/overlap-preview': { kind: 'cross', path: (fx) => `/api/cards/${fx.B.card}/overlap-preview` },
  'POST /api/permission-requests/:id/answer': { kind: 'cross', path: (fx) => `/api/permission-requests/${fx.B.permission}/answer`, body: { decision: 'allow' } },
  'GET /api/devices': { kind: 'team' },
  'POST /api/devices': { kind: 'team', body: { name: 'pwned' } },
  'DELETE /api/devices/:id': { kind: 'cross', path: (fx) => `/api/devices/${fx.B.device}` },
  'GET /api/repos': { kind: 'team' },
  'POST /api/repos': { kind: 'team', body: { url: 'git@github.com:pwned/app.git' } },
};

const key = (r) => `${r.method} ${r.pattern}`;

test('T-ROUTES coverage: every hub route is in the tenancy matrix, and the matrix names no dead route', async () => {
  const fx = await tenancy();
  try {
    const live = fx.h.app.routes.map(key);
    const missing = live.filter((k) => !MATRIX[k]);
    assert.deepEqual(missing, [], `routes without a tenancy entry: ${missing.join(', ')}`);
    const stale = Object.keys(MATRIX).filter((k) => !live.includes(k));
    assert.deepEqual(stale, [], `matrix entries for routes that no longer exist: ${stale.join(', ')}`);
    // Every route that takes an id from the URL is exercised cross-team.
    for (const r of fx.h.app.routes) {
      if (r.pattern.includes('/:')) assert.equal(MATRIX[key(r)].kind, 'cross', `${key(r)} takes an id: it must be a cross entry`);
    }
  } finally {
    await fx.h.close();
  }
});

async function sweep(fx, caller) {
  const before = fx.snapshotB();
  const leaks = [];
  let calls = 0;
  const check = async (label, method, path, body, headers = {}, status = 404) => {
    calls++;
    const r = await fx.as(caller, method, path, method === 'GET' ? undefined : { request_id: randomUUID(), ...body }, headers);
    if (r.status !== status) leaks.push(`${label} ${path} → ${r.status} ${r.text.slice(0, 120)}`);
    else if (r.text.includes(MARK) || r.text.includes(fx.B.team) || r.text.includes(fx.B.board) || /beta\.test/.test(r.text)) leaks.push(`${label} ${path}: ${status} body mentions B`);
  };
  for (const r of fx.h.app.routes) {
    const e = MATRIX[key(r)];
    const body = typeof e.body === 'function' ? e.body(fx) : e.body ?? {};
    if (e.kind === 'cross') {
      await check(key(r), r.method, e.path(fx), body, {}, e.status);
      for (const p of e.alt?.(fx) ?? []) await check(`${key(r)} (alt)`, r.method, p, body);
    } else if (e.kind === 'team') {
      await check(key(r), r.method, r.pattern, body, { 'x-board-team': fx.B.team });
      await check(`${key(r)} ?team=`, r.method, `${r.pattern}?team=${fx.B.team}`, body);
    }
  }
  assert.deepEqual(leaks, []);
  assert.ok(calls >= 30, `only ${calls} cross-team calls made`);
  assert.equal(fx.snapshotB(), before, "team B's rows changed");
}

test('T-ROUTES: a team-A owner gets 404 and no B data from every route, with B ids or the B team header', async () => {
  const fx = await tenancy();
  try {
    await sweep(fx, fx.users.ua);
  } finally {
    await fx.h.close();
  }
});

test('T-ROUTES: a signed-in user in no team gets 404 from every route that names a resource or team', async () => {
  const fx = await tenancy();
  try {
    await sweep(fx, fx.users.n);
  } finally {
    await fx.h.close();
  }
});

test('T-ROUTES: the shared user S reaches B only through B ids; A ids never answer with B data', async () => {
  const fx = await tenancy();
  try {
    const { as, users, A, B } = fx;
    // S names B's board with the A team header: header and resource disagree → 404.
    assert.equal((await as(users.s, 'GET', `/api/boards/${B.board}`, undefined, { 'x-board-team': A.team })).status, 404);
    assert.equal((await as(users.s, 'GET', `/api/boards/${B.board}`, undefined, { 'board-org': A.team })).status, 404);
    const own = await as(users.s, 'GET', `/api/boards/${B.board}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.board.id, B.board);
    const a = await as(users.s, 'GET', `/api/boards/${A.board}`);
    assert.ok(!a.text.includes(MARK), 'the A snapshot holds no B data');
    // Without a resource, S must choose; the header picks only S's own teams.
    assert.equal((await as(users.s, 'GET', '/api/me')).status, 409);
    assert.equal((await as(users.s, 'GET', '/api/me', undefined, { 'x-board-team': A.team })).body.org.id, A.team);
    assert.equal((await as(users.s, 'GET', `/api/me?team=${B.team}`)).body.org.id, B.team);
    assert.equal((await as(users.ua, 'GET', '/api/me', undefined, { 'x-board-team': B.team })).status, 404);
    assert.equal((await as(users.ua, 'GET', '/api/me', undefined, { 'x-board-team': randomUUID() })).status, 404);
  } finally {
    await fx.h.close();
  }
});
