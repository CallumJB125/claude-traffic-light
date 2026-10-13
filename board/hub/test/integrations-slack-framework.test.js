// Connector framework additions a chat connector (Slack) needs: parseBody
// (non-JSON bodies, strictly after verify), the early ack's body, a
// per-delivery ackEarly, the createCard board target, a per-provider-user
// card limit, org-scoped read helpers and workspace-unique connections.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { defineConnector } from '../integrations/connector.js';
import { startHub } from './helpers.js';
import { silentLogger } from '../log.js';

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

// ── F8 per-provider-user card limit ───────────────────────────────────────

test('F8: act() meta.subject caps createCard at 5/h per (connection, provider user), beside the connection cap; replays are free; the subject is never stored or logged raw', async () => {
  const { h, reg } = await setup();
  const logs = [];
  const saved = { ...silentLogger };
  for (const k of ['debug', 'info', 'warn', 'error']) silentLogger[k] = (...a) => logs.push(a);
  try {
    const conn = connect(h, 'f8a');
    const ctx = reg.ctxFor(conn.id);
    // Built at runtime: a distinctive provider user id to search for.
    const [u1, u2, u3] = ['A', 'B', 'C'].map((x) => `U${x}${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`);
    // Each user is linked (D98): act(…, {subject}) acts only as that user's member.
    const carol = randomUUID();
    h.db.insert('members', { id: carol, org_id: h.ids.org, github_id: -77, github_login: 'carol', email: 'carol@dev.local', display_name: 'carol', role: 'member', created_at: h.hub.iso() });
    for (const [u, m] of [[u1, h.ids.alice], [u2, h.ids.bob], [u3, carol]]) {
      h.db.insert('external_identities', { provider: conn.provider, workspace_id: conn.external_id, subject: u, member_id: m, connection_id: conn.id, verified_via: 'oauth_link', linked_at: h.hub.iso() });
    }
    h.hub.limiter.limits.integration_card_conn = { capacity: 12, per_ms: 3_600_000 };
    const make = (subject, rid) => ctx.act('card.create', { subject, external_ref: rid }, (s) => s.actAs(subject ? ctx.memberFor(subject) : ctx.connection.created_by).createCard(h.ids.board, { request_id: rid, title: `Card ${rid}` }));
    for (let i = 0; i < 5; i += 1) assert.equal((await make(u1, `u1-${i}`)).decision, 'auto');
    await assert.rejects(make(u1, 'u1-5'), (e) => e.code === 'RATE_LIMITED');
    assert.deepEqual([reg.audit(conn.id)[0].decision, reg.audit(conn.id)[0].error], ['failed', 'rate_limited']);
    // A D8 replay of an earlier request answers its card without spending anything.
    assert.equal((await make(u1, 'u1-0')).decision, 'auto');
    // Another provider user still can; the connection's own cap (12 here) still holds.
    for (let i = 0; i < 5; i += 1) await make(u2, `u2-${i}`);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM cards WHERE title LIKE 'Card u2-%'").n, 5);
    // 10 of 12 spent: u1's refused card took none of the connection's.
    await make(u3, 'u3-0');
    await make(u3, 'u3-1');
    await assert.rejects(make(u3, 'u3-2'), (e) => e.code === 'RATE_LIMITED', 'the connection total caps across users');
    // Without a subject only the connection cap applies (unchanged).
    await assert.rejects(make(undefined, 'none-0'), (e) => e.code === 'RATE_LIMITED');
    // Validated: never another type, empty or over 128 chars; nothing is audited for it.
    const before = reg.audit(conn.id).length;
    for (const bad of ['', 'x'.repeat(129), 42, { id: u1 }]) await assert.rejects(make(bad, 'bad'), (e) => e.code === 'VALIDATION');
    assert.equal(reg.audit(conn.id).length, before);
    await assert.rejects(make(null, 'null-ok'), (e) => e.code === 'RATE_LIMITED', 'null is no subject: it reaches the connection cap, not VALIDATION');
    // Never stored or logged raw: every table but the identity links (which hold it by design, D98), the limiter's keys and the logs.
    const tables = h.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'external_identities'").map((t) => t.name);
    const dump = JSON.stringify([tables.map((t) => h.db.all(`SELECT * FROM "${t}"`)), [...h.hub.limiter.buckets.keys()], logs]);
    for (const u of [u1, u2, u3]) assert.ok(!dump.includes(u), 'no raw subject anywhere');
    assert.ok([...h.hub.limiter.buckets.keys()].some((k) => k.startsWith(`integration_card_subject|${conn.id}|`)));
  } finally {
    Object.assign(silentLogger, saved);
    await h.close();
  }
});

// ── F5 read helpers ───────────────────────────────────────────────────────

test('F5: ctx.boards() lists this team\'s boards (id, title; by title; at most 100) and ctx.card(id) a card\'s face; another team\'s or an unknown id is null', async () => {
  const { h, reg } = await setup();
  try {
    const conn = connect(h, 'f5a');
    const ctx = reg.ctxFor(conn.id);
    const other = addOrg(h);
    const own = h.db.get('SELECT id, name FROM boards WHERE id = ?', h.ids.board);
    for (const [i, name] of ['beta', 'Alpha'].entries()) h.db.run("INSERT INTO boards (id, org_id, name, key_prefix, settings) VALUES (?, ?, ?, ?, '{\"default_budget_usd\":5}')", randomUUID(), h.ids.org, name, `XB${i}`);
    const boards = ctx.boards();
    assert.ok(boards.every((b) => Object.keys(b).join() === 'id,title'));
    assert.ok(!boards.some((b) => b.id === other.board), 'never another team\'s board');
    assert.deepEqual(boards.map((b) => b.title), h.db.all('SELECT name FROM boards WHERE org_id = ? ORDER BY name, id', h.ids.org).map((b) => b.name));
    assert.ok(boards.some((b) => b.id === own.id && b.title === own.name));
    for (let i = 0; i < 120; i += 1) h.db.run("INSERT INTO boards (id, org_id, name, key_prefix) VALUES (?, ?, ?, ?)", randomUUID(), h.ids.org, `z-${String(i).padStart(3, '0')}`, `XC${i}`);
    assert.equal(ctx.boards().length, 100);
    // A card: its face only.
    const { result } = await createIn(ctx, h.ids.board, { request_id: 'f5-1', title: 'Face only', body: 'private goal', acceptance: 'private acceptance', labels: ['secret-label'] });
    assert.deepEqual(ctx.card(result.card.id), { id: result.card.id, key: result.card.key, title: 'Face only', board_id: h.ids.board, column_name: 'todo' });
    const t = h.hub.iso();
    const foreign = randomUUID();
    h.db.run("INSERT INTO cards (id, board_id, key, title, created_by, created_at, updated_at) VALUES (?, ?, 'OTH-1', 'Theirs', ?, ?, ?)", foreign, other.board, other.admin, t, t);
    for (const id of [foreign, randomUUID(), undefined, null, 7, { id: result.card.id }]) assert.equal(ctx.card(id), null);
  } finally { await h.close(); }
});

// ── F10 workspaceUnique ───────────────────────────────────────────────────

test('F10: a workspaceUnique connector allows one live connection per external_id across teams; the refusal is the same-team CONFLICT, writes nothing and names no team', async () => {
  const { h, reg } = await setup();
  try {
    const other = addOrg(h, 'Rival Team Name');
    const first = connect(h, 'f10a', { workspaceUnique: true }, { external_id: 'T-SHARED' });
    const counts = () => ['connections', 'connection_secrets', 'journal'].map((t) => h.db.get(`SELECT COUNT(*) AS n FROM ${t}`).n);
    const before = counts();
    const attempt = (orgId, memberId) => {
      try { reg.createConnection({ orgId, memberId, provider: 'f10a', external_id: 'T-SHARED' }); } catch (e) { return { code: e.code, message: e.message, extra: e.extra ?? null, keys: Object.keys(e) }; }
      return null;
    };
    const sameTeam = attempt(h.ids.org, h.ids.alice);
    const otherTeam = attempt(other.org, other.admin);
    assert.equal(sameTeam.code, 'CONFLICT');
    assert.deepEqual(otherTeam, sameTeam, 'byte-identical: no oracle for whether another team holds it');
    assert.ok(!JSON.stringify(otherTeam).includes('Rival') && !JSON.stringify(otherTeam).includes(h.ids.org));
    assert.deepEqual(counts(), before, 'nothing written: no row, secret or journal entry');
    // Another workspace is fine; once revoked, another team may connect it.
    assert.ok(reg.createConnection({ orgId: other.org, memberId: other.admin, provider: 'f10a', external_id: 'T-OTHER' }));
    reg.revokeConnection(first.id, h.ids.alice);
    const moved = reg.createConnection({ orgId: other.org, memberId: other.admin, provider: 'f10a', external_id: 'T-SHARED' });
    assert.equal(reg.orgOf(moved.id), other.org);
    // Without the flag two teams may still connect one workspace (D41).
    connect(h, 'f10b', {}, { external_id: 'T-SHARED' });
    assert.ok(reg.createConnection({ orgId: other.org, memberId: other.admin, provider: 'f10b', external_id: 'T-SHARED' }));
  } finally { await h.close(); }
  assert.throws(() => probe('f10c', { workspaceUnique: 'yes' }), /workspaceUnique is a boolean/);
});
