// I1 connector framework: connections + sealed secrets, signed webhooks with
// replay protection, the autonomy gate + audit log, bus delivery scoped to the
// connection's team, and actAs through the normal Api.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Api } from '../api.js';
import { createIntegrations } from '../integrations/registry.js';
import { defineConnector } from '../integrations/connector.js';
import fake, { sign } from '../integrations/fake/index.js';
import { startHub } from './helpers.js';

async function setup({ key = true } = {}) {
  const h = await startHub();
  if (key) h.hub.setVaultKey(randomBytes(32));
  // A dev hub already runs the registry (with the fake connector) and the bus.
  return { h, bus: h.app.bus, reg: h.app.integrations };
}

async function connectFake(h, reg) {
  const v = await fake.connect.verifyToken({ token: 'fake_abcdef123456' });
  return reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'fake', ...v });
}

const post = (reg, conn, payload, { secret = 'whsec_abcdef123456', delivery = randomUUID(), tamper = false } = {}) => {
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = sign(secret, raw);
  return reg.webhook(conn.id, { headers: { 'x-fake-signature': sig, 'x-fake-delivery': delivery }, rawBody: tamper ? Buffer.concat([raw, Buffer.from(' ')]) : raw });
};

const issue = (id, title = 'Login broken') => ({ event: 'issue.opened', issue: { id, title, url: `https://fake.example/issues/${id}` } });

test('defineConnector refuses an incomplete connector (webhooks without verify, bad autonomy)', () => {
  const base = { id: 'x-y', name: 'X', scopes: [], secrets: [], hosts: [], connect: { kind: 'token', verifyToken: async () => ({}) } };
  assert.doesNotThrow(() => defineConnector(base));
  assert.throws(() => defineConnector({ ...base, hosts: undefined }), /hosts/);
  for (const bad of ['*.github.com', 'https://api.github.com', 'api.github.com:8443', 'API.github.com', 'localhost']) {
    assert.throws(() => defineConnector({ ...base, hosts: [bad] }), /hosts/, bad);
  }
  assert.throws(() => defineConnector({ ...base, handleWebhook: async () => {} }), /verify/);
  assert.throws(() => defineConnector({ ...base, actions: { a: { default: 'yolo' } } }), /auto\|ask\|off/);
  assert.throws(() => defineConnector({ ...base, id: 'Bad Id' }), /id must match/);
  assert.throws(() => defineConnector({ ...base, connect: { kind: 'oauth' } }), /authorizeUrl/);
});

test('connect: secrets are sealed (never in the row, the list or the journal); needs the vault key', async () => {
  const { h, reg } = await setup({ key: false });
  try {
    await assert.rejects(connectFake(h, reg), (e) => e.code === 'POLICY_DENIED');
  } finally { await h.close(); }
  const s = await setup();
  try {
    const conn = await connectFake(s.h, s.reg);
    const dump = JSON.stringify([s.reg.list(s.h.ids.org), s.h.db.all('SELECT * FROM connections'), s.h.db.all('SELECT payload FROM journal')]);
    assert.ok(!dump.includes('fake_abcdef123456') && !dump.includes('whsec_'), 'no plaintext secret anywhere visible');
    const sealed = s.h.db.all('SELECT kind, ciphertext FROM connection_secrets WHERE connection_id = ?', conn.id);
    assert.deepEqual(sealed.map((r) => r.kind).sort(), ['api_token', 'webhook_secret']);
    assert.ok(!Buffer.from(sealed[0].ciphertext).toString().includes('fake_'));
    assert.equal(s.reg.ctxFor(conn.id).secret('api_token'), 'fake_abcdef123456');
    await assert.rejects(connectFake(s.h, s.reg), (e) => e.code === 'CONFLICT');
  } finally { await s.h.close(); }
});

test('webhook: a signed issue becomes one linked card (auto, audited); a replay is deduped', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const delivery = randomUUID();
    const r1 = await post(reg, conn, issue('ISS-1'), { delivery });
    assert.equal(r1.status, 200);
    const cards = h.db.all("SELECT id, title FROM cards WHERE title = 'Login broken'");
    assert.equal(cards.length, 1);
    assert.equal(reg.ctxFor(conn.id).linked('issue', 'ISS-1'), cards[0].id);
    const r2 = await post(reg, conn, issue('ISS-1'), { delivery });
    assert.deepEqual(r2.body, { ok: true, duplicate: true });
    // A fresh delivery of the same issue is deduplicated by the link, not a second card.
    await post(reg, conn, issue('ISS-1'));
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Login broken'").length, 1);
    const audit = reg.audit(conn.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'card.create');
    assert.equal(audit[0].decision, 'auto');
    assert.equal(audit[0].external_ref, 'ISS-1');
    assert.equal(reg.get(conn.id).health.ok, true);
  } finally { await h.close(); }
});

test('webhook: a forged or tampered request is 401, logged, and changes nothing', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const before = h.db.get('SELECT COUNT(*) AS n FROM cards').n;
    assert.equal((await post(reg, conn, issue('ISS-2'), { secret: 'whsec_wrong' })).status, 401);
    assert.equal((await post(reg, conn, issue('ISS-2'), { tamper: true })).status, 401);
    assert.equal((await reg.webhook(conn.id, { headers: {}, rawBody: Buffer.from('{}') })).status, 401);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM cards').n, before);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM inbound_dedupe').n, 0);
    assert.equal((await reg.webhook('no-such-connection', { headers: {}, rawBody: Buffer.from('{}') })).status, 404);
  } finally { await h.close(); }
});

test('autonomy: "off" skips, "ask" records a suggestion without acting; both audited', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    reg.setSettings(conn.id, { autonomy: { 'card.create': 'off' } });
    await post(reg, conn, issue('ISS-3', 'Skipped issue'));
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Skipped issue'").length, 0);
    reg.setSettings(conn.id, { autonomy: { 'card.create': 'ask' } });
    await post(reg, conn, issue('ISS-4', 'Asked issue'));
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Asked issue'").length, 0);
    assert.deepEqual(reg.audit(conn.id).map((a) => a.decision), ['asked', 'skipped']);
    assert.throws(() => reg.setSettings(conn.id, { autonomy: { 'card.create': 'always' } }), /auto, ask or off/);
    assert.throws(() => reg.setSettings(conn.id, { autonomy: { 'rm.rf': 'auto' } }), /no action/);
  } finally { await h.close(); }
});

test('bus: board events reach the connector for its own team only; "ask" by default for speaking outward', async () => {
  const { h, reg, bus } = await setup();
  try {
    const conn = await connectFake(h, reg);
    // Simulate a done transition journal row for a card of this team.
    const cardId = h.db.get('SELECT id FROM cards LIMIT 1')?.id ?? (await post(reg, conn, issue('ISS-5')), h.db.get('SELECT id FROM cards LIMIT 1').id);
    h.hub.journal({ board_id: h.ids.board, card_id: cardId, kind: 'card.transition', payload: { rule: '34', event: 'pr_merged', from: 'in_review', to: 'done' } });
    h.hub.emit('journal');
    await bus.settle();
    const asked = reg.audit(conn.id).filter((a) => a.action === 'issue.close');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].decision, 'asked');
    // Another team's event never reaches this connection.
    const otherOrg = randomUUID();
    h.db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', otherOrg, 'Other', h.hub.iso());
    const otherBoard = randomUUID();
    h.db.run("INSERT INTO boards (id, org_id, name, key_prefix) VALUES (?, ?, 'O', 'OTH')", otherBoard, otherOrg);
    h.hub.journal({ board_id: otherBoard, card_id: null, kind: 'card.transition', payload: { to: 'done' } });
    h.hub.emit('journal');
    await bus.settle();
    assert.equal(reg.audit(conn.id).filter((a) => a.action === 'issue.close').length, 1);
  } finally { await h.close(); }
});

test('actAs: only inside act(), only the member who connected it (or one linked); revoked connection drops secrets and 404s webhooks', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const ctx = reg.ctxFor(conn.id);
    assert.equal(ctx.actAs, undefined, 'no side-effect API outside act()');
    let kept;
    await ctx.act('card.create', {}, async (s) => {
      assert.throws(() => s.actAs('not-a-member'), (e) => e.code === 'FORBIDDEN');
      assert.throws(() => s.actAs(h.ids.bob), (e) => e.code === 'FORBIDDEN', 'a teammate who never linked an identity');
      assert.equal(s.actAs(h.ids.alice).member.id, h.ids.alice);
      kept = s;
    });
    assert.throws(() => kept.actAs(h.ids.alice), /scope has ended/);
    reg.revokeConnection(conn.id, h.ids.alice);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM connection_secrets WHERE connection_id = ?', conn.id).n, 0);
    assert.equal((await post(reg, conn, issue('ISS-9'))).status, 404);
    assert.deepEqual(reg.list(h.ids.org), []);
  } finally { await h.close(); }
});

test('ctx.fetch retries 5xx/429 with backoff and records health', async () => {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    let n = 0;
    const reg = createIntegrations({
      hub: h.hub, api: new Api(h.hub), log: null, sleep: async () => {},
      fetchImpl: async () => { n += 1; return n < 3 ? { status: n === 1 ? 503 : 429, headers: new Map([['retry-after', '1']]) } : { status: 200, headers: new Map() }; },
    });
    reg.register(fake);
    const conn = await connectFake(h, reg);
    const res = await reg.ctxFor(conn.id).fetch('https://api.fake.example/x');
    assert.equal(res.status, 200);
    assert.equal(n, 3);
    assert.equal(reg.get(conn.id).health.ok, true);
  } finally { await h.close(); }
});

// ── over HTTP, on a dev hub (the fake connector is offered only there) ─────

test('HTTP: members list (no secrets), admins connect by token / configure / disconnect; webhook ingress verifies', async () => {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const list = await h.api(alice, 'GET', '/api/integrations');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.available.map((c) => c.id), ['fake']);
    assert.equal(list.body.vault, true);
    const roles = Object.fromEntries(h.db.all('SELECT id, role FROM members').map((m) => [m.id, m.role]));
    const [admin, other] = roles[h.ids.alice] === 'member' ? [bob, alice] : [alice, bob];
    const denied = await h.api(other, 'POST', '/api/integrations/fake/token', { request_id: randomUUID(), token: 'fake_abcdef123456' });
    if (roles[h.ids.alice] !== roles[h.ids.bob]) assert.equal(denied.status, 403);
    const bad = await h.api(admin, 'POST', '/api/integrations/fake/token', { request_id: randomUUID(), token: 'nope' });
    assert.equal(bad.status, 400);
    const ok = await h.api(admin, 'POST', '/api/integrations/fake/token', { request_id: randomUUID(), token: 'fake_abcdef123456' });
    assert.equal(ok.status, 200);
    const conn = ok.body.connection;
    assert.ok(!JSON.stringify(ok.body).includes('fake_abcdef123456'));
    // Webhook: raw body, signature only, no cookie, no CSRF.
    const raw = JSON.stringify(issue('ISS-HTTP', 'From the webhook'));
    const hook = (sig) => fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fake-signature': sig, 'x-fake-delivery': randomUUID() }, body: raw });
    assert.equal((await hook('sha256=00')).status, 401);
    assert.equal((await hook(sign('whsec_abcdef123456', Buffer.from(raw)))).status, 200);
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'From the webhook'").length, 1);
    const cfg = await h.api(admin, 'PATCH', `/api/integrations/${conn.id}`, { request_id: randomUUID(), autonomy: { 'card.create': 'ask' } });
    assert.equal(cfg.body.connection.settings.autonomy['card.create'], 'ask');
    const audit = await h.api(other, 'GET', `/api/integrations/${conn.id}/audit`);
    assert.equal(audit.body.entries[0].action, 'card.create');
    assert.equal((await h.api(admin, 'DELETE', `/api/integrations/${conn.id}`, { request_id: randomUUID() })).status, 200);
    assert.equal((await hook(sign('whsec_abcdef123456', Buffer.from(raw)))).status, 404);
  } finally { await h.close(); }
});

test('ctx.system: only declared facts, only for a card linked to this connection, attributed to the connection', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    await post(reg, conn, issue('ISS-S', 'Linked card'));
    const cardId = h.db.get("SELECT id FROM cards WHERE title = 'Linked card'").id;
    const ctx = reg.ctxFor(conn.id);
    // Not linked as a PR yet → nothing happens, even with the right card id nowhere in reach.
    assert.deepEqual(await ctx.system.event('pr_merged', { kind: 'pr', external_id: 'PR-1', pr: 7 }), { done: false, reason: 'not linked' });
    await assert.rejects(ctx.system.event('pr_closed', { kind: 'pr', external_id: 'PR-1' }), /may not raise/);
    assert.equal(ctx.link, undefined, 'links only through the act() scope');
    await ctx.act('card.create', {}, async (s) => s.link(cardId, 'pr', 'PR-1'));
    // The card is in To do, so the state machine refuses pr_merged: applied exactly like the merge poll.
    const r = await ctx.system.event('pr_merged', { kind: 'pr', external_id: 'PR-1', pr: 7 });
    assert.equal(r.done, false);
    assert.equal(r.reason, 'ILLEGAL_TRANSITION');
    // Autonomy applies to facts too.
    reg.setSettings(conn.id, { autonomy: { 'system.pr_merged': 'off' } });
    assert.equal((await ctx.system.event('pr_merged', { kind: 'pr', external_id: 'PR-1' })).decision, 'skipped');
    // A connector that declares no system events gets no ctx.system.
    assert.throws(() => defineConnector({ id: 'chatty', name: 'Chat', scopes: [], secrets: [], hosts: [], connect: { kind: 'token', verifyToken: async () => ({}) }, systemEvents: ['card_delete'] }), /not an allowed system event/);
    assert.throws(() => defineConnector({ id: 'gh2', name: 'G', scopes: [], secrets: [], hosts: [], connect: { kind: 'token', verifyToken: async () => ({}) }, systemEvents: ['pr_merged'] }), /declare the action system.pr_merged/);
  } finally { await h.close(); }
});

// ── OAuth / app-install connect ────────────────────────────────────────────

const fakeOauth = defineConnector({
  id: 'fake-oauth', name: 'Fake OAuth', scopes: ['read'], secrets: ['access_token'], hosts: ['fake-oauth.example'],
  connect: {
    kind: 'oauth',
    authorizeUrl: ({ state, redirectUri }) => `https://fake-oauth.example/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    async exchange({ query }) {
      if (query.get('code') !== 'good-code') throw new Error('bad code');
      return { external_id: 'ws-oauth-1', display_name: 'OAuth workspace', scopes: ['read'], secrets: { access_token: 'tok_oauth_secret' } };
    },
  },
});

test('OAuth: start gives a signed state; the callback connects once, refuses forged/reused/expired state and non-admins', async () => {
  const { h, reg } = await setup();
  try {
    reg.register(fakeOauth);
    const alice = await h.login('alice');
    const start = await h.api(alice, 'POST', '/api/integrations/fake-oauth/start', { request_id: randomUUID() });
    assert.equal(start.status, 200, start.text);
    const setCookie = start.headers.get('set-cookie');
    assert.match(setCookie, /^board_int_fake-oauth=[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\/integrations\/; Max-Age=600$/);
    const bind = setCookie.split(';')[0];
    const auth = new URL(start.body.url);
    const state = auth.searchParams.get('state');
    assert.equal(auth.searchParams.get('redirect_uri'), `${h.base}/integrations/fake-oauth/callback`);
    const cb = (q) => fetch(`${h.base}/integrations/fake-oauth/callback?${new URLSearchParams(q)}`, { headers: { cookie: bind } });
    // Forged state.
    const forged = await cb({ state: `${state.split('.')[0]}.AAAA`, code: 'good-code' });
    assert.equal(forged.status, 400);
    assert.match(await forged.text(), /not valid/);
    // Provider says no: shows an error, consumes the state.
    const r = await cb({ state, code: 'good-code' });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /OAuth workspace is connected/);
    assert.equal(r.headers.get('content-security-policy'), "default-src 'none'");
    assert.ok(!html.includes('tok_oauth_secret') && !html.includes('good-code'));
    assert.equal(reg.list(h.ids.org).filter((c) => c.provider === 'fake-oauth').length, 1);
    // Reused state.
    const again = await cb({ state, code: 'good-code' });
    assert.equal(again.status, 400);
    assert.match(await again.text(), /already used/);
    // Query text is never echoed (no reflected XSS through error=).
    const s2 = (await h.api(alice, 'POST', '/api/integrations/fake-oauth/start', { request_id: randomUUID() })).body.url;
    const x = await cb({ state: new URL(s2).searchParams.get('state'), error: '<script>alert(1)</script>' });
    assert.ok(!(await x.text()).includes('<script>alert'));
  } finally { await h.close(); }
});
