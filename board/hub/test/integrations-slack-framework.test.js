// Connector framework additions a chat connector (Slack) needs: parseBody
// (non-JSON bodies, strictly after verify), the early ack's body, a
// per-delivery ackEarly, the createCard board target, a per-provider-user
// card limit, org-scoped read helpers and workspace-unique connections.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { defineConnector } from '../integrations/connector.js';
import { startHub } from './helpers.js';

async function setup() {
  const h = await startHub();
  h.hub.setVaultKey(randomBytes(32));
  return { h, reg: h.app.integrations };
}

const probe = (id, over = {}) => defineConnector({
  id, name: `Probe ${id}`, scopes: [], secrets: [], hosts: ['api.probe.example'],
  connect: { kind: 'token', verifyToken: async () => ({ external_id: 'w1' }) },
  verify: ({ headers }) => (headers['x-ok'] === '1' ? { ok: true, dedupe_key: headers['x-id'] } : { ok: false, reason: 'nope' }),
  handleWebhook: async () => {},
  actions: { 'card.create': { default: 'auto' } },
  ...over,
});

const connect = (h, id, over, { orgId = h.ids.org, memberId = h.ids.alice, external_id = 'w1' } = {}) => {
  if (!h.app.integrations.connectors().some((c) => c.id === id)) h.app.integrations.register(probe(id, over));
  return h.app.integrations.createConnection({ orgId, memberId, provider: id, external_id });
};

const hookIn = (h, conn, body, { ok = true, id = randomUUID(), headers = {} } = {}) => h.app.integrations.webhook(conn.id, {
  headers: { ...(ok ? { 'x-ok': '1', 'x-id': id } : {}), ...headers }, rawBody: Buffer.isBuffer(body) ? body : Buffer.from(body),
});

// A Slack-shaped body: form-encoded, its interactive payload a JSON field.
const formOf = (fields) => new URLSearchParams(fields).toString();
const parseForm = ({ rawBody }) => {
  const f = Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')));
  return f.payload ? JSON.parse(f.payload) : f;
};

// ── F1 parseBody ──────────────────────────────────────────────────────────

test('F1: parseBody reads a form-encoded body (and its payload= JSON field) once verify() passed', async () => {
  const { h } = await setup();
  try {
    const seen = [];
    let parsed = 0;
    const conn = connect(h, 'f1a', {
      parseBody: (a) => { parsed += 1; return parseForm(a); },
      handleWebhook: async ({ payload }) => { seen.push(payload); },
    });
    const r1 = await hookIn(h, conn, formOf({ command: '/plex', text: 'add a card', user_id: 'U1' }));
    assert.equal(r1.status, 200);
    assert.deepEqual(seen[0], { command: '/plex', text: 'add a card', user_id: 'U1' });
    const r2 = await hookIn(h, conn, formOf({ payload: JSON.stringify({ type: 'block_actions', user: { id: 'U2' } }) }));
    assert.equal(r2.status, 200);
    assert.deepEqual(seen[1], { type: 'block_actions', user: { id: 'U2' } });
    // Never on an unverified body.
    assert.equal((await hookIn(h, conn, formOf({ text: 'forged' }), { ok: false })).status, 401);
    assert.equal(parsed, 2, 'parseBody never ran for the forged delivery');
    // Dedupe still keys on the raw body: the same bytes under a new delivery id are a duplicate.
    const again = await hookIn(h, conn, formOf({ command: '/plex', text: 'add a card', user_id: 'U1' }));
    assert.deepEqual(again.body, { ok: true, duplicate: true });
    assert.equal(seen.length, 2);
  } finally { await h.close(); }
});

test('F1: a parseBody that throws or returns a non-object, an array, a Promise or a poisoned object is a fixed 400; nothing runs or is leased', async () => {
  const { h } = await setup();
  try {
    let calls = 0;
    let out;
    const conn = connect(h, 'f1b', { parseBody: () => out(), handleWebhook: async () => { calls += 1; } });
    const poisoned = (k) => () => JSON.parse(`{"${k}": {"x": 1}, "ok": 1}`);
    const bad = [
      () => { throw new Error('<script>echo-me</script>'); }, () => null, () => 'text', () => 7, () => [1, 2],
      () => Promise.resolve({ a: 1 }), () => new Map(), poisoned('__proto__'), poisoned('constructor'), poisoned('prototype'),
    ];
    for (const fn of bad) {
      out = fn;
      const r = await hookIn(h, conn, 'echo-me=<script>');
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: { code: 'VALIDATION', message: 'body could not be read' } });
    }
    assert.equal(calls, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM inbound_dedupe').n, 0);
    out = () => Object.assign(Object.create(null), { ok: 1 });
    assert.equal((await hookIn(h, conn, 'ok=1')).status, 200, 'a null-prototype object is plain');
    assert.equal(calls, 1);
  } finally { await h.close(); }
});

test('F1: the default stays JSON (400 on invalid JSON); defineConnector refuses a parseBody that is not a function', async () => {
  const { h } = await setup();
  try {
    const conn = connect(h, 'f1c');
    assert.deepEqual((await hookIn(h, conn, 'a=1')).body, { error: { code: 'VALIDATION', message: 'body must be JSON' } });
    assert.equal((await hookIn(h, conn, '{"a":1}')).status, 200);
  } finally { await h.close(); }
  assert.throws(() => probe('f1d', { parseBody: 'form' }), /parseBody is a function/);
  assert.throws(() => probe('f1e', { parseBody: () => ({}), handleWebhook: undefined, verify: undefined }), /parseBody/);
});

// ── F2 ackBody ────────────────────────────────────────────────────────────

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const send = (h, conn, body, id = randomUUID()) => fetch(`${h.base}/integrations/${conn.id}/webhook`, {
  method: 'POST', headers: { 'x-ok': '1', 'x-id': id, 'content-type': 'application/x-www-form-urlencoded' }, body,
});
const securityHeaders = (res) => {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
};

test('F2: an ackEarly connector\'s ackBody sets the early answer: undefined is an empty 200, a string text/plain, an object JSON; the handler still runs', async () => {
  const { h } = await setup();
  try {
    let answer;
    const ran = [];
    const conn = connect(h, 'f2a', {
      ackEarly: true, parseBody: parseForm, ackBody: () => answer,
      handleWebhook: async ({ payload }) => { ran.push(payload.n); },
    });
    answer = undefined;
    let res = await send(h, conn, formOf({ n: '1', text: 'reflect-me' }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('content-length'), '0');
    securityHeaders(res);
    answer = 'Adding that card…';
    res = await send(h, conn, formOf({ n: '2' }));
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await res.text(), 'Adding that card…');
    securityHeaders(res);
    answer = { response_type: 'ephemeral', text: 'On it' };
    res = await send(h, conn, formOf({ n: '3' }));
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await res.json(), { response_type: 'ephemeral', text: 'On it' });
    securityHeaders(res);
    await h.hub.idle();
    assert.deepEqual(ran, ['1', '2', '3']);
    // A finished delivery again is still the registry's duplicate answer, never the connector's.
    res = await send(h, conn, formOf({ n: '3' }));
    assert.deepEqual(await res.json(), { ok: true, duplicate: true });
  } finally { await h.close(); }
});

test('F2: an ackBody over 4 KiB, unserialisable, of another type or that throws is an empty 200; nothing of the request is added', async () => {
  const { h } = await setup();
  try {
    let answer;
    const conn = connect(h, 'f2b', { ackEarly: true, parseBody: parseForm, ackBody: () => answer() });
    const circular = {};
    circular.self = circular;
    const cases = [
      () => 'x'.repeat(4097), () => ({ text: 'y'.repeat(4096) }), () => circular, () => ({ n: 10n }), () => [1], () => 42, () => true, () => null,
      () => Promise.resolve('late'), () => { throw new Error('reflect-me'); },
    ];
    for (const [i, c] of cases.entries()) {
      answer = c;
      const res = await send(h, conn, formOf({ i: String(i), text: 'reflect-me' }));
      assert.equal(res.status, 200, `case ${i}`);
      assert.equal(await res.text(), '', `case ${i}`);
      securityHeaders(res);
    }
    answer = () => 'z'.repeat(4096);
    assert.equal((await (await send(h, conn, formOf({ i: 'max' }))).text()).length, 4096, 'exactly 4 KiB is kept');
    await h.hub.idle();
  } finally { await h.close(); }
});

test('F2: without ackBody the early ack is unchanged; ackBody needs ackEarly', async () => {
  const { h } = await setup();
  try {
    const conn = connect(h, 'f2c', { ackEarly: true });
    const res = await send(h, conn, '{"a":1}');
    assert.deepEqual(await res.json(), { ok: true, accepted: true });
    await h.hub.idle();
  } finally { await h.close(); }
  assert.throws(() => probe('f2d', { ackBody: () => undefined }), /ackBody is a function, for a connector that declares ackEarly/);
  assert.throws(() => probe('f2e', { ackEarly: true, ackBody: 'ok' }), /ackBody/);
});

// ── F2b ackEarly per delivery ─────────────────────────────────────────────

test('F2b: ackEarly as a function decides per verified, parsed delivery; a throw or a non-true result answers late', async () => {
  const { h } = await setup();
  try {
    const asked = [];
    let gate = null;
    const conn = connect(h, 'f2b2', {
      parseBody: parseForm,
      ackEarly: ({ payload }) => {
        asked.push(payload.kind);
        if (payload.kind === 'boom') throw new Error('nope');
        if (payload.kind === 'promise') return Promise.resolve(true);
        return payload.kind === 'command';
      },
      ackBody: () => undefined,
      handleWebhook: async ({ payload }) => {
        if (payload.kind === 'command') await new Promise((resolve, reject) => { gate = { resolve, reject }; });
        if (payload.fail) throw new Error('handler said no');
      },
    });
    // Early: answered (empty) while the handler is still waiting.
    const first = await Promise.race([send(h, conn, formOf({ kind: 'command', n: '1' })), tick(2000).then(() => null)]);
    assert.ok(first, 'answered before the handler finished');
    assert.equal(await first.text(), '');
    await tick();
    gate.resolve();
    await h.hub.idle();
    // Late: the handler's own answer, and a failure is a 500 for the provider's retry (not dead-lettered).
    for (const kind of ['event', 'boom', 'promise']) {
      const res = await send(h, conn, formOf({ kind }));
      assert.deepEqual(await res.json(), { ok: true }, kind);
    }
    assert.equal((await send(h, conn, formOf({ kind: 'event', fail: '1' }))).status, 500);
    // An early failure is audited (no provider retry follows).
    const early = send(h, conn, formOf({ kind: 'command', fail: '1' }));
    assert.equal((await early).status, 200);
    await tick();
    gate.resolve();
    await h.hub.idle();
    const dead = h.db.all("SELECT decision, error FROM integration_audit WHERE connection_id = ? AND action = 'webhook'", conn.id).map((r) => ({ ...r }));
    assert.deepEqual(dead, [{ decision: 'failed', error: 'handler_failed' }], 'only the early failure');
    // Never asked about a forged delivery.
    const n = asked.length;
    assert.equal((await fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', body: formOf({ kind: 'command' }) })).status, 401);
    assert.equal(asked.length, n);
  } finally { await h.close(); }
  assert.throws(() => probe('f2b3', { ackEarly: 'sometimes' }), /ackEarly is a boolean or a function/);
});

// ── F6 board target ───────────────────────────────────────────────────────

function addOrg(h, name = 'Other') {
  const org = randomUUID();
  const board = randomUUID();
  const admin = randomUUID();
  const t = h.hub.iso();
  h.db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', org, name, t);
  h.db.run("INSERT INTO boards (id, org_id, name, key_prefix) VALUES (?, ?, 'Zeta', 'OTH')", board, org);
  h.db.run("INSERT INTO members (id, org_id, github_id, github_login, display_name, role, created_at) VALUES (?, ?, ?, ?, 'Carol', 'owner', ?)", admin, org, -Math.floor(Math.random() * 1e9), `carol-${org.slice(0, 8)}`, t);
  return { org, board, admin };
}

const createIn = (ctx, boardId, body) => ctx.act('card.create', { external_ref: body.request_id }, (s) => s.actAs(ctx.connection.created_by).createCard(boardId, body));

test('F6: createCard targets a board of the connection\'s team only (another team\'s or an unknown board is NOT_FOUND before any rate token); the card starts in todo', async () => {
  const { h, reg } = await setup();
  try {
    const conn = connect(h, 'f6a');
    const other = addOrg(h);
    h.hub.limiter.limits.integration_card_conn = { capacity: 1, per_ms: 3_600_000 };
    const ctx = reg.ctxFor(conn.id);
    for (const bad of [other.board, randomUUID(), undefined, 42]) {
      await assert.rejects(createIn(ctx, bad, { request_id: `r-${randomUUID()}`, title: 'Probe' }), (e) => e.code === 'NOT_FOUND' && e.message === 'board not found');
    }
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM cards WHERE title = 'Probe'").n, 0);
    const { result } = await createIn(ctx, h.ids.board, { request_id: 'r-own', title: 'From chat', column: 'done', column_name: 'in_review' });
    assert.equal(result.card.column, 'todo');
    assert.equal(h.db.get('SELECT column_name, board_id FROM cards WHERE id = ?', result.card.id).column_name, 'todo');
    assert.deepEqual(reg.audit(conn.id).map((a) => [a.decision, a.error]).reverse(), [
      ...Array(4).fill(['failed', 'not_found']), ['auto', null],
    ]);
  } finally { await h.close(); }
});
