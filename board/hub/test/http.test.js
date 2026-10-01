// HTTP surface: health, protocol header, static files (CSP, ETag, the shared
// whitelist, no traversal), CSRF guards, the request_id replay cache, PATCH
// optimistic concurrency, viewer restrictions, body limits and the browser WS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { startHub } from './helpers.js';

test('health, Board-Protocol header, static web + shared whitelist, ETag/304, CSP, no traversal', async () => {
  const h = await startHub();
  try {
    const health = await h.api(null, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('board-protocol'), '1');
    assert.deepEqual(Object.keys(health.body).sort(), ['auth', 'hub_epoch', 'ok', 'protocol', 'uptime_ms']);
    assert.equal(health.body.auth, 'dev');

    const index = await h.api(null, 'GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.text, /Board test fixture/);
    assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(index.headers.get('cache-control'), 'no-cache');
    const etag = index.headers.get('etag');
    const cached = await h.api(null, 'GET', '/', null, { 'if-none-match': etag });
    assert.equal(cached.status, 304);

    const app = await h.api(null, 'GET', '/web/js/app.js');
    assert.equal(app.status, 200);
    assert.match(app.headers.get('content-type'), /text\/javascript/);
    const shared = await h.api(null, 'GET', '/shared/states.js');
    assert.equal(shared.status, 200);
    assert.match(shared.text, /export function step/);
    for (const p of ['/shared/migrate.js', '/shared/schema.sql', '/web/../hub.js', '/web/%2e%2e/%2e%2e/hub/hub.js', '/hub/hub.js']) {
      assert.equal((await h.api(null, 'GET', p)).status, 404, p);
    }
  } finally {
    await h.destroy();
  }
});

test('CSRF: cross-origin and non-JSON mutations are refused; unauthenticated → 401', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const url = `/api/boards/${h.ids.board}/cards`;
    const cross = await h.api(alice, 'POST', url, { request_id: randomUUID(), title: 'x' }, { origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    const form = await fetch(`${h.base}${url}`, { method: 'POST', headers: { cookie: alice, 'content-type': 'text/plain' }, body: '{"title":"x"}' });
    assert.equal(form.status, 400);
    const same = await h.api(alice, 'POST', url, { request_id: randomUUID(), title: 'x' }, { origin: h.base });
    assert.equal(same.status, 200);
    const anon = await h.api(null, 'GET', `/api/boards/${h.ids.board}`);
    assert.equal(anon.status, 401);
    const forged = await h.api('board_dev=someone.AAAA', 'GET', `/api/boards/${h.ids.board}`);
    assert.equal(forged.status, 401);
    const big = await h.api(alice, 'POST', url, { request_id: randomUUID(), title: 'x', body: 'y'.repeat(1024 * 1024 + 10) });
    assert.equal(big.status, 413);
  } finally {
    await h.destroy();
  }
});

test('request_id replay, PATCH version conflict, column moves only without a run, viewers are read-only', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const rid = randomUUID();
    const url = `/api/boards/${h.ids.board}/cards`;
    const a = await h.api(alice, 'POST', url, { request_id: rid, title: 'One', repo_id: h.ids.repo, labels: ['bug'] });
    const b = await h.api(alice, 'POST', url, { request_id: rid, title: 'One', repo_id: h.ids.repo, labels: ['bug'] });
    assert.equal(a.body.card.id, b.body.card.id);
    assert.equal(b.headers.get('board-replayed'), '1');
    assert.equal(h.db.get('SELECT count(*) AS n FROM cards').n, 1);
    assert.equal(a.body.card.key, 'DEV-1');

    const card = a.body.card;
    const p1 = await h.api(alice, 'PATCH', `/api/cards/${card.id}`, { request_id: randomUUID(), version: card.version, title: 'One!' });
    assert.equal(p1.status, 200);
    assert.equal(p1.body.card.version, card.version + 1);
    const stale = await h.api(alice, 'PATCH', `/api/cards/${card.id}`, { request_id: randomUUID(), version: card.version, title: 'lost update' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    const moved = await h.api(alice, 'PATCH', `/api/cards/${card.id}`, { request_id: randomUUID(), version: p1.body.card.version, column: 'in_progress' });
    assert.equal(moved.body.card.column, 'in_progress');

    await h.action(alice, card.id, 'dispatch');
    const v = h.card(card.id).version;
    const underRun = await h.api(alice, 'PATCH', `/api/cards/${card.id}`, { request_id: randomUUID(), version: v, column: 'done' });
    assert.equal(underRun.body.error.code, 'CONFLICT');
    const illegal = await h.action(alice, card.id, 'approve_done');
    assert.equal(illegal.status, 409);
    assert.equal(illegal.body.error.code, 'ILLEGAL_TRANSITION');
    const noRepo = await h.api(alice, 'POST', url, { request_id: randomUUID(), title: 'no repo' });
    const nr = await h.action(alice, noRepo.body.card.id, 'dispatch');
    assert.equal(nr.body.error.code, 'NO_REPO');
    const codex = await h.action(alice, noRepo.body.card.id, 'dispatch', { backend: 'codex_cli', budget_usd: null });
    assert.equal(codex.body.error.code, 'NO_REPO');

    await h.api(alice, 'POST', '/api/members', { request_id: randomUUID(), github_login: 'vic', github_id: -9, email: 'vic@dev.local', role: 'viewer' });
    const vic = await h.login('vic');
    const vr = await h.api(vic, 'POST', url, { request_id: randomUUID(), title: 'nope' });
    assert.equal(vr.status, 403);
    const vs = await h.api(vic, 'GET', `/api/boards/${h.ids.board}`);
    assert.equal(vs.status, 200);
    assert.equal(vs.body.cards.length, 2);
    const vd = await h.action(vic, card.id, 'cancel');
    assert.equal(vd.status, 403);
    const notAdmin = await h.api(await h.login('bob'), 'POST', '/api/repos', { request_id: randomUUID(), url: 'git@github.com:a/b.git' });
    assert.equal(notAdmin.status, 403);
  } finally {
    await h.destroy();
  }
});

test('browser WS: hello → welcome, subscribe → snapshot, pushes upserts + events; cross-origin upgrade refused', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const b = await h.browser(alice);
    assert.equal(b.snapshot.board.key_prefix, 'DEV');
    assert.deepEqual(b.snapshot.members.map((m) => m.login).sort(), ['alice', 'bob']);
    const card = await h.createCard(alice, { title: 'pushed' });
    const up = await b.next('card.upsert', (m) => m.card.id === card.id);
    assert.equal(up.card.title, 'pushed');
    const c = await h.api(alice, 'POST', `/api/cards/${card.id}/comments`, { request_id: randomUUID(), body: '@claude also check the tests', for_agent: true });
    assert.equal(c.status, 200);
    const ev = await b.next('event.append', (m) => m.card_id === card.id && m.event.kind === 'comment');
    assert.equal(ev.event.actor_name, 'Alice');
    b.send({ type: 'ping' });
    await b.next('pong');
    b.send({ type: 'nope' });
    assert.equal((await b.next('error')).code, 'VALIDATION');

    const alerts = await h.api(alice, 'GET', `/api/boards/${h.ids.board}/alerts`);
    assert.equal(alerts.status, 200);
    assert.ok(Array.isArray(alerts.body.alerts.items));

    const code = await new Promise((resolve) => {
      const ws = new WebSocket(`${h.base.replace('http', 'ws')}/ws/board`, { headers: { cookie: alice, origin: 'https://evil.example' } });
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('error', () => {});
    });
    assert.equal(code, 403);
    const anon = await new Promise((resolve) => {
      const ws = new WebSocket(`${h.base.replace('http', 'ws')}/ws/board`);
      ws.on('close', (c2) => resolve(c2));
      ws.on('error', () => {});
    });
    assert.equal(anon, 4401);
  } finally {
    await h.destroy();
  }
});
