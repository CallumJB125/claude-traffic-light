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
