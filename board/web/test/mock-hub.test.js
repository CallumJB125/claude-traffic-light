// The mock hub speaks the contract: every frame validates, first answer wins,
// the scripted story walks the real state machine to done, and a drop refuses
// reconnects. Loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createMockHub } from '../mock/server.js';
import { validate } from '../../shared/protocol.js';
import { replay } from '../../shared/journal.js';
import { dashboardMetrics } from '../js/metrics.js';

async function withHub(fn, opts = {}) {
  const hub = createMockHub(opts);
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
  // team.presence follows the snapshot at once; it has its own test below.
  const pushed = frames.filter((f) => f.type !== 'team.presence');
  assert.deepEqual(pushed.map((f) => f.type), ['welcome', 'snapshot']);
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

const getJson = async (base, path, cookie) => (await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).json();

async function allJournal(base, cookie, limit = 1000) {
  const rows = [];
  let after = 0;
  for (;;) {
    const page = await getJson(base, `/api/boards/board-bdl/journal?after_seq=${after}&limit=${limit}`, cookie);
    rows.push(...page.rows);
    if (page.rows.length < limit) return rows;
    after = page.next_after_seq;
  }
}

test('journal: member-only, pages by after_seq, and replays to the snapshot', () => withHub(async ({ base, login }) => {
  assert.equal((await fetch(`${base}/api/boards/board-bdl/journal`)).status, 401);
  const cookie = await login('alice');
  assert.equal((await fetch(`${base}/api/boards/nope/journal`, { headers: { Cookie: cookie } })).status, 404);
  const first = await getJson(base, '/api/boards/board-bdl/journal?after_seq=0&limit=5', cookie);
  assert.deepEqual(first.rows.map((r) => r.seq), [1, 2, 3, 4, 5]);
  assert.equal(first.next_after_seq, 5);
  assert.deepEqual(Object.keys(first.rows[0]).sort(), ['actor_id', 'actor_kind', 'at_hub', 'board_id', 'card_id', 'hub_epoch', 'kind', 'payload', 'run_id', 'seq']);
  const rows = await allJournal(base, cookie, 7);
  assert.ok(rows.every((r, i) => r.seq === i + 1));
  assert.ok(rows.every((r, i) => i === 0 || Date.parse(r.at_hub) >= Date.parse(rows[i - 1].at_hub)));
  const snap = await getJson(base, '/api/boards/board-bdl', cookie);
  const replayed = replay(rows);
  for (const c of snap.cards) {
    const r = replayed.get(c.id);
    assert.ok(r, `${c.key} has a card.create`);
    assert.equal(r.run_state ?? 'todo', c.run_state, `${c.key} run_state`);
    assert.equal(r.column_name, c.column, `${c.key} column`);
  }
  // A human column move is journalled as the hub does it (DB column name).
  const card = snap.cards.find((c) => c.id === 'c-150');
  const patch = await fetch(`${base}/api/cards/c-150`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ request_id: 'j1', version: card.version, column: 'done' }) });
  assert.equal(patch.status, 200);
  const tail = await getJson(base, `/api/boards/board-bdl/journal?after_seq=${rows.at(-1).seq}`, cookie);
  assert.deepEqual(tail.rows.map((r) => [r.kind, r.payload.fields?.column_name]), [['card.update', ['todo', 'done']]]);
}));

test('journal with history: a month of finished cards on the board and in the journal', () => withHub(async ({ base, login }) => {
  const cookie = await login('alice');
  const rows = await allJournal(base, cookie);
  const snap = await getJson(base, '/api/boards/board-bdl', cookie);
  const done = snap.cards.filter((c) => c.column === 'done');
  assert.ok(done.length >= 20);
  const m = dashboardMetrics({ rows, cards: snap.cards, now: Date.now() });
  assert.ok(m.throughput.total >= 20);
  assert.ok(m.share.claude > 0 && m.share.human > 0);
  assert.ok(m.blocked.total_ms > 0);
  assert.ok(m.cycle.median_ms > 0);
  const replayed = replay(rows);
  for (const c of snap.cards) assert.equal(replayed.get(c.id)?.run_state ?? 'todo', c.run_state, c.key);
}, { history: true }));

test('presence: team.presence follows the snapshot, /__mock/presence pushes a change, GET serves the same body', () => withHub(async ({ base, port, login }) => {
  const cookie = await login('alice');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/board`, { headers: { Cookie: cookie } });
  const frames = [];
  const got = (type) => new Promise((resolve) => { const t = setInterval(() => { if (frames.some((f) => f.type === type)) { clearInterval(t); resolve(); } }, 10); });
  ws.on('message', (d) => frames.push(JSON.parse(d)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1 }));
  ws.send(JSON.stringify({ type: 'subscribe', board_id: 'board-bdl' }));
  await got('team.presence');
  assert.deepEqual(frames.map((f) => f.type), ['welcome', 'snapshot', 'team.presence']);
  const first = frames[2];
  assert.equal(validate('hub→browser', first), null);
  assert.ok(first.members.length >= 3);
  const all = first.members.flatMap((m) => m.sessions);
  assert.ok(new Set(all.map((s) => s.agent)).size >= 3);
  assert.ok(all.some((s) => s.state === 'waiting') && all.some((s) => s.state === 'working') && all.some((s) => s.state === 'idle'));
  assert.ok(all.every((s) => Number.isFinite(Date.parse(s.since))));

  const res = await post(base, '/__mock/presence', cookie, { members: [{ member_id: 'm-sam', sessions: [{ agent: 'hermes', repo_short: 'bondly', state: 'idle', since_ago_ms: 5000 }] }, { member_id: 'm-ghost', sessions: [] }] });
  assert.equal(res.status, 200);
  await new Promise((r) => { const t = setInterval(() => { if (frames.filter((f) => f.type === 'team.presence').length === 2) { clearInterval(t); r(); } }, 10); });
  const next = frames.at(-1);
  assert.equal(validate('hub→browser', next), null);
  assert.deepEqual(next.members.map((m) => m.member_id), ['m-sam'], 'non-members are dropped');
  assert.equal(next.members[0].name, 'Sam');

  const http = await fetch(`${base}/api/boards/board-bdl/presence`, { headers: { Cookie: cookie } });
  assert.equal(http.status, 200);
  const body = await http.json();
  assert.deepEqual(body.members.map((m) => m.member_id), ['m-sam']);
  assert.equal((await fetch(`${base}/api/boards/nope/presence`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/boards/board-bdl/presence`)).status, 401);
  ws.close();
}));
