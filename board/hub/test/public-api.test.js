// Public API v1 and team API tokens (docs/PUBLIC-API.md, migration 070):
// token lifecycle and audit, scope enforcement, expired/revoked/removed
// tokens refused, the per-token rate limit, and the read/comment endpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';
import { dumpDb } from './accounts-helpers.js';

const rid = () => randomUUID();

async function token(fx, scopes, extra = {}, u = fx.users.ua) {
  const r = await fx.as(u, 'POST', `/api/teams/${fx.A.team}/api-tokens`, { name: 'CI bot', scopes, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.body;
}

const pub = (fx, secret, method, path, body) => fx.h.call(method, `/api/public/v1${path}`, { token: secret, body });

test('lifecycle: admins create a token shown once (hash stored), it works, last-used and audit rows are kept, revoke stops it', async () => {
  const fx = await tenancy();
  try {
    const { users, A } = fx;
    assert.equal((await fx.as(users.amember, 'POST', `/api/teams/${A.team}/api-tokens`, { name: 'x', scopes: ['read:boards'] })).status, 403, 'members cannot');
    assert.equal((await fx.as(users.aviewer, 'GET', `/api/teams/${A.team}/api-tokens`)).status, 403, 'viewers cannot list');
    assert.equal((await fx.as(users.ua, 'POST', `/api/teams/${A.team}/api-tokens`, { name: 'x', scopes: ['admin:everything'] })).status, 400, 'unknown scope');
    assert.equal((await fx.as(users.ua, 'POST', `/api/teams/${A.team}/api-tokens`, { name: 'x', scopes: ['read:boards'], expires_days: 999 })).status, 400, 'expiry bounded');
    const made = await token(fx, ['read:boards'], {}, users.aadmin);
    assert.match(made.secret, /^plx_pat_[A-Za-z0-9_-]{43}$/);
    assert.equal(made.token.hint, made.secret.slice(-4));
    assert.ok(!dumpDb(fx.db).includes(made.secret), 'only the hash is stored');
    const list = await fx.as(users.ua, 'GET', `/api/teams/${A.team}/api-tokens`);
    assert.equal(list.status, 200, list.text);
    assert.ok(!list.text.includes(made.secret), 'never shown again');
    assert.deepEqual(list.body.tokens.map((t) => [t.name, t.scopes, t.last_used_at]), [['CI bot', ['read:boards'], null]]);

    const boards = await pub(fx, made.secret, 'GET', '/boards');
    assert.equal(boards.status, 200, boards.text);
    assert.equal(boards.headers.get('plexiform-api-version'), '1');
    assert.deepEqual(boards.body.boards.map((b) => b.id), [A.board], 'only the token team\'s boards');
    assert.ok(!boards.text.includes(fx.B.board));
    await pub(fx, made.secret, 'GET', '/boards');
    const row = fx.db.get('SELECT * FROM api_tokens WHERE id = ?', made.token.id);
    assert.ok(row.last_used_at);
    const uses = () => fx.db.all("SELECT * FROM audit WHERE action = 'api_token.use' AND target = ?", made.token.id).length;
    assert.equal(uses(), 1, 'a use is audited at most hourly');
    fx.h.clock.advance(61 * 60_000);
    await pub(fx, made.secret, 'GET', '/boards');
    assert.equal(uses(), 2);

    const rv = await fx.as(users.ua, 'DELETE', `/api/teams/${A.team}/api-tokens/${made.token.id}`, {});
    assert.equal(rv.status, 200, rv.text);
    assert.ok(rv.body.token.revoked_at);
    const after = await pub(fx, made.secret, 'GET', '/boards');
    assert.equal(after.status, 401);
    assert.match(after.headers.get('www-authenticate'), /Bearer/);
    const actions = fx.db.all('SELECT action, org_id FROM audit WHERE target = ? ORDER BY id', made.token.id);
    assert.deepEqual([...new Set(actions.map((a) => a.action))], ['api_token.create', 'api_token.use', 'api_token.revoke']);
    assert.ok(actions.every((a) => a.org_id === A.team));
  } finally { await fx.h.close(); }
});

test('expired, malformed, unknown and orphaned tokens are refused; a session never counts on the public API', async () => {
  const fx = await tenancy();
  try {
    const { users, A } = fx;
    const short = await token(fx, ['read:boards'], { expires_days: 1 });
    assert.equal((await pub(fx, short.secret, 'GET', '/boards')).status, 200);
    fx.h.clock.advance(86_400_000 + 1);
    assert.equal((await pub(fx, short.secret, 'GET', '/boards')).status, 401, 'expired');
    for (const bad of ['', 'plx_pat_short', `plx_pat_${'A'.repeat(43)}`, users.ua.token]) {
      assert.equal((await pub(fx, bad, 'GET', '/boards')).status, 401, `refused: ${bad.slice(0, 12)}`);
    }
    const byAdmin = await token(fx, ['read:boards'], {}, users.aadmin);
    assert.equal((await pub(fx, byAdmin.secret, 'GET', '/boards')).status, 200);
    fx.db.run('UPDATE members SET removed_at = ? WHERE id = ?', fx.h.hub.iso(), A.admin);
    assert.equal((await pub(fx, byAdmin.secret, 'GET', '/boards')).status, 401, 'its maker left the team');
    assert.equal((await pub(fx, short.secret, 'GET', '/nope')).status, 404);
  } finally { await fx.h.close(); }
});

test('scopes: read:boards cannot read cards or comment; write:cards-comment comments as the maker; other teams are 404', async () => {
  const fx = await tenancy();
  try {
    const { A, B } = fx;
    const boardsOnly = await token(fx, ['read:boards']);
    const r1 = await pub(fx, boardsOnly.secret, 'GET', `/boards/${A.board}/cards`);
    assert.equal(r1.status, 403);
    assert.equal(r1.body.error.reason, 'SCOPE');
    assert.equal((await pub(fx, boardsOnly.secret, 'GET', `/cards/${A.card}`)).status, 403);
    assert.equal((await pub(fx, boardsOnly.secret, 'POST', `/cards/${A.card}/comments`, { body: 'hi' })).status, 403);

    const reader = await token(fx, ['read:cards']);
    assert.equal((await pub(fx, reader.secret, 'POST', `/cards/${A.card}/comments`, { body: 'hi' })).status, 403, 'read never writes');
    const card = await pub(fx, reader.secret, 'GET', `/cards/${A.card}`);
    assert.equal(card.status, 200, card.text);
    assert.equal(card.body.card.title, 'Alpha card');
    for (const path of [`/cards/${B.card}`, `/cards/${B.card}/events`, `/boards/${B.board}/cards`]) {
      const x = await pub(fx, reader.secret, 'GET', path);
      assert.equal(x.status, 404, path);
      assert.ok(!x.text.includes('Beta'), path);
    }

    const writer = await token(fx, ['read:cards', 'write:cards-comment']);
    const request_id = rid();
    const c = await pub(fx, writer.secret, 'POST', `/cards/${A.card}/comments`, { body: 'Build 42 passed', request_id });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.body.comment.author_member_id, A.owner);
    const again = await pub(fx, writer.secret, 'POST', `/cards/${A.card}/comments`, { body: 'Build 42 passed', request_id });
    assert.equal(again.body.comment.id, c.body.comment.id, 'request_id replays');
    const stored = fx.db.get('SELECT * FROM comments WHERE id = ?', c.body.comment.id);
    assert.equal(stored.for_agent, 0, 'never addressed to a running agent');
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM comments WHERE body = ?', 'Build 42 passed').n, 1);
    assert.equal((await pub(fx, writer.secret, 'POST', `/cards/${B.card}/comments`, { body: 'x' })).status, 404);
    const adminWriter = await token(fx, ['write:cards-comment'], {}, fx.users.aadmin);
    assert.equal((await pub(fx, adminWriter.secret, 'POST', `/cards/${A.card}/comments`, { body: 'y' })).status, 200);
    fx.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", A.admin);
    assert.equal((await pub(fx, adminWriter.secret, 'POST', `/cards/${A.card}/comments`, { body: 'x' })).status, 403, 'a maker who can no longer write cannot comment');
  } finally { await fx.h.close(); }
});

test('cards page with a cursor; a card and its events read back', async () => {
  const fx = await tenancy();
  try {
    const { users, A } = fx;
    for (let i = 0; i < 4; i++) {
      fx.h.clock.advance(1000);
      const r = await fx.as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { request_id: rid(), title: `Card ${i}`, body: `secret body ${i}` });
      assert.equal(r.status, 200, r.text);
    }
    const reader = await token(fx, ['read:cards']);
    const seen = [];
    let cursor = null;
    for (let n = 0; n < 5; n++) {
      const page = await pub(fx, reader.secret, 'GET', `/boards/${A.board}/cards?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(page.status, 200, page.text);
      assert.ok(!page.text.includes('secret body'), 'lists carry no card text');
      seen.push(...page.body.cards.map((c) => c.title));
      cursor = page.body.next_cursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, ['Alpha card', 'Card 0', 'Card 1', 'Card 2', 'Card 3']);
    assert.equal((await pub(fx, reader.secret, 'GET', `/boards/${A.board}/cards?limit=999`)).status, 400);
    assert.equal((await pub(fx, reader.secret, 'GET', `/boards/${A.board}/cards?cursor=zzz`)).status, 400);
    const ev = await pub(fx, reader.secret, 'GET', `/cards/${A.card}/events`);
    assert.equal(ev.status, 200, ev.text);
    assert.ok(ev.body.events.some((e) => e.kind === 'card.create' && e.types.includes('card.created')));
    assert.ok(ev.body.events.every((e) => !('payload' in e)), 'no raw journal payloads');
  } finally { await fx.h.close(); }
});

test('rate limit: a token over its bucket gets 429 with Retry-After; failed tokens are limited per network', async () => {
  const fx = await tenancy({ config: { rateLimits: { public_api_token: { capacity: 2, per_ms: 60_000 }, public_api_fail_ip: { capacity: 3, per_ms: 60_000 } } } });
  try {
    const t = await token(fx, ['read:boards']);
    assert.equal((await pub(fx, t.secret, 'GET', '/boards')).status, 200);
    assert.equal((await pub(fx, t.secret, 'GET', '/boards')).status, 200);
    const third = await pub(fx, t.secret, 'GET', '/boards');
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
    fx.h.clock.advance(60_000);
    assert.equal((await pub(fx, t.secret, 'GET', '/boards')).status, 200, 'refills');
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await pub(fx, `plx_pat_${'B'.repeat(43)}`, 'GET', '/boards')).status);
    assert.deepEqual(codes, [401, 401, 401, 429]);
  } finally { await fx.h.close(); }
});
