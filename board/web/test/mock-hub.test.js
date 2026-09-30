// The mock hub speaks the contract: every frame validates, first answer wins,
// the scripted story walks the real state machine to done, and a drop refuses
// reconnects. Loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createMockHub } from '../mock/server.js';
import { validate } from '../../shared/protocol.js';

async function withHub(fn) {
  const hub = createMockHub();
  const port = await hub.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const login = async (who) => {
    const r = await fetch(`${base}/api/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ github_login: who }) });
    return r.headers.get('set-cookie').split(';')[0];
  };
  try { await fn({ hub, base, port, login }); } finally { await hub.close(); }
}

const post = (base, path, cookie, body, extra = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...extra }, body: JSON.stringify(body) });

test('auth: /api/me needs the dev cookie; responses carry Board-Protocol and the CSP', () => withHub(async ({ base, login }) => {
  const anon = await fetch(`${base}/api/me`);
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error.code, 'UNAUTHENTICATED');
  const cookie = await login('alice');
  const me = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(me.headers.get('board-protocol'), '1');
  assert.match(me.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await me.json()).member.login, 'alice');
  assert.equal((await fetch(`${base}/shared/migrate.js`)).status, 404);
  assert.equal((await fetch(`${base}/shared/cardface.js`)).status, 200);
}));

test('ws: hello → welcome, subscribe → snapshot; every frame validates', () => withHub(async ({ port, login }) => {
  const cookie = await login('alice');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/board`, { headers: { Cookie: cookie } });
  const frames = [];
  await new Promise((resolve, reject) => {
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', protocol: 1 })); ws.send(JSON.stringify({ type: 'subscribe', board_id: 'board-bdl' })); });
    ws.on('message', (d) => { const m = JSON.parse(d); frames.push(m); if (m.type === 'snapshot') resolve(); });
    ws.on('error', reject);
  });
  ws.close();
  assert.deepEqual(frames.map((f) => f.type), ['welcome', 'snapshot']);
  for (const f of frames) assert.equal(validate('hub→browser', f), null);
  const snap = frames[1];
  assert.ok(snap.cards.length >= 15);
  assert.ok(snap.cards.some((c) => c.live?.green === true), 'some card is hub-green');
}));

test('permission answers: first wins, the second gets ALREADY_ANSWERED with who', () => withHub(async ({ base, login }) => {
  const alice = await login('alice');
  const bob = await login('bob');
  const a = await post(base, '/api/permission-requests/pr-1/answer', alice, { request_id: 'r1', decision: 'allow', scope: 'once' });
  assert.equal(a.status, 200);
  const b = await post(base, '/api/permission-requests/pr-1/answer', bob, { request_id: 'r2', decision: 'deny' });
  assert.equal(b.status, 409);
  const body = await b.json();
  assert.equal(body.error.code, 'ALREADY_ANSWERED');
  assert.equal(body.error.answered_by.name, 'Alice');
  const replay = await post(base, '/api/permission-requests/pr-1/answer', alice, { request_id: 'r1', decision: 'allow' });
  assert.equal(replay.status, 200, 'same request_id replays the first response (D8)');
}));

test('mutations reject cross-origin and non-JSON', () => withHub(async ({ base, login }) => {
  const cookie = await login('alice');
  const x = await post(base, '/api/cards/c-150/actions/dispatch', cookie, { request_id: 'q' }, { Origin: 'https://evil.example' });
  assert.equal(x.status, 403);
  const y = await fetch(`${base}/api/cards/c-150/actions/dispatch`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(y.status, 400);
}));

test('human column moves: allowed for a card without a run, CONFLICT under a run', () => withHub(async ({ base, login }) => {
  const cookie = await login('alice');
  const patch = (id, body) => fetch(`${base}/api/cards/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  assert.equal((await patch('c-151', { request_id: 'a', version: 1, column: 'in_review' })).status, 200);
  const under = await patch('c-146', { request_id: 'b', version: 1, column: 'done' });
  assert.equal(under.status, 409);
  assert.equal((await under.json()).error.code, 'CONFLICT');
}));

test('the scripted story walks BDL-152 through the real state machine to done, then drops', () => withHub(async ({ hub }) => {
  const seen = [];
  for (;;) {
    const r = hub.stepScript();
    seen.push(r.state);
    if (r.done) break;
  }
  for (const s of ['queued', 'claimed', 'running', 'blocked', 'unresponsive', 'orphaned', 'handed_over', 'in_review', 'done', 'dropped']) assert.ok(seen.includes(s), `story reaches ${s}`);
}));
