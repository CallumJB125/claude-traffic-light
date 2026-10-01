// Pending connections (D97, slice B1): connect.prepare spends an admin's
// pasted configuration token once, seals what comes back on a pending row
// (1 h, one per org+provider and per admin), and only the OAuth callback of
// the admin who prepared it promotes the row to a connection, when exchange()
// reproduces the pinned match. The token never lands anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac, createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { defineConnector } from '../integrations/connector.js';
import { startHub } from './helpers.js';
import { createLogger } from '../log.js';

// Token-shaped strings are built at runtime (no secret-shaped literals in the repo).
const configToken = () => ['xoxe', '1', randomBytes(20).toString('hex').toUpperCase()].join('-');
const CS = `csec${randomBytes(8).toString('hex')}`;
const SS = `ssec${randomBytes(8).toString('hex')}`;
const BOT = `bot${randomBytes(8).toString('hex')}`;
const APP = { app_id: 'A0PEND1', client_id: '111.222' };

// The connector under test: config token → apps.create → secrets + match; no
// token → needs a paste; pasted fields → the same shape.
function pendConnector(beh, id = 'pend') {
  return defineConnector({
    id, name: 'Pend', scopes: ['chat:write'], secrets: ['client_secret', 'signing_secret', 'bot_token'], hosts: ['api.pend.example', 'pend.example'],
    workspaceUnique: true,
    connect: {
      kind: 'oauth',
      prepareInputs: ['config_token', 'app_id', 'client_id', 'client_secret', 'signing_secret'],
      async prepare(args) {
        beh.prepared.push({ ...args, input: { ...args.input } });
        if (beh.prepare) return beh.prepare(args);
        const { input, fetch } = args;
        if (input.config_token) {
          const res = await fetch('https://api.pend.example/apps.manifest.create', { method: 'POST', headers: { authorization: `Bearer ${input.config_token}` }, body: '{}' });
          if (!res.ok) throw Object.assign(new Error(`apps.manifest.create refused ${input.config_token}`), { cause: { headers: { authorization: `Bearer ${input.config_token}` } } });
          const b = await res.json();
          return { secrets: { client_secret: b.client_secret, signing_secret: b.signing_secret }, settings: { app_id: b.app_id, client_id: b.client_id }, match: { app_id: b.app_id, client_id: b.client_id }, ...(beh.external_id ? { external_id: beh.external_id } : {}) };
        }
        if (input.app_id) {
          return { secrets: { client_secret: input.client_secret, signing_secret: input.signing_secret }, settings: { app_id: input.app_id, client_id: input.client_id }, match: { app_id: input.app_id, client_id: input.client_id } };
        }
        return { needs: { fields: ['app_id', 'client_id', 'client_secret', 'signing_secret'], create_url: beh.create_url ?? 'https://pend.example/apps?new_app=1' } };
      },
      authorizeUrl: ({ state, config }) => `https://pend.example/authorize?client_id=${encodeURIComponent(config.client_id)}&state=${encodeURIComponent(state)}`,
      async exchange(args) {
        beh.exchanged.push(args);
        if (beh.exchange) return beh.exchange(args);
        return {
          external_id: beh.team ?? 'T1', display_name: 'Pend workspace', scopes: ['chat:write'], secrets: { bot_token: BOT },
          settings: { app_id: 'EXCHANGE-SAYS', bot_user_id: 'UB1' }, match: { app_id: args.config.app_id, client_id: args.config.client_id },
        };
      },
    },
    verify: () => ({ ok: true, dedupe_key: randomUUID() }),
    handleWebhook: async () => { beh.handled += 1; },
  });
}

// The provider's apps.create: answers with the new app's credentials.
function providerFetch(beh) {
  return async (url, init = {}) => {
    beh.requests.push({ url: String(url), init });
    if (beh.fetch) return beh.fetch(url, init);
    return new Response(JSON.stringify({ ok: true, ...APP, client_secret: CS, signing_secret: SS }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const ROOMY = { rateLimits: { integration_prepare_member: { capacity: 1000, per_ms: 3_600_000 }, integration_prepare_org: { capacity: 1000, per_ms: 86_400_000 } } };

async function setup({ config } = {}) {
  const beh = { prepared: [], exchanged: [], requests: [], handled: 0 };
  const lines = [];
  const h = await startHub({ config, fetchImpl: providerFetch(beh), log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) });
  h.hub.setVaultKey(randomBytes(32));
  const reg = h.app.integrations;
  reg.register(pendConnector(beh));
  const alice = await h.login('alice');
  return { h, reg, beh, lines, alice };
}

const addMember = async (h, login, role, orgId) => {
  const id = randomUUID();
  h.db.insert('members', { id, org_id: orgId ?? h.ids.org, github_id: -Math.floor(Math.random() * 1e6) - 10, github_login: login, email: `${login}@dev.local`, display_name: login, role, created_at: h.hub.iso() });
  return { id, cookie: await h.login(login) };
};
const otherOrg = async (h) => {
  const org = randomUUID();
  h.db.insert('orgs', { id: org, name: 'other', created_at: h.hub.iso() });
  return { org, ...(await addMember(h, `dave${randomBytes(3).toString('hex')}`, 'owner', org)) };
};

const prep = (h, cookie, target, input, rid = randomUUID()) => h.api(cookie, 'POST', `/api/integrations/${target}/prepare`, { request_id: rid, ...(input === undefined ? {} : { input }) });
const authorize = (h, cookie, id) => h.api(cookie, 'POST', `/api/integrations/${id}/authorize`, { request_id: randomUUID() });
const del = (h, cookie, id) => h.api(cookie, 'DELETE', `/api/integrations/${id}`, { request_id: randomUUID() });
const stateOf = (r) => new URL(r.body.url).searchParams.get('state');
const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];
const callback = async (h, state, cookie, provider = 'pend') => {
  const res = await fetch(`${h.base}/integrations/${provider}/callback?${new URLSearchParams({ state, code: 'good-code' })}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, text: await res.text() };
};
const ready = async (h, cookie, token = configToken()) => {
  const r = await prep(h, cookie, 'pend', { config_token: token });
  assert.equal(r.status, 200, r.text);
  return { r, id: r.body.pending.id, state: stateOf(r), cookie: cookieOf(r) };
};
const pendingRow = (h, id) => h.db.get('SELECT * FROM integration_pending WHERE id = ?', id);
const pendingSecrets = (h, id) => h.db.all('SELECT * FROM integration_pending_secrets WHERE pending_id = ? ORDER BY kind', id);
const journal = (h, kind) => h.db.all('SELECT * FROM journal WHERE kind = ? ORDER BY seq', kind).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
const sha = (x) => createHash('sha256').update(String(x)).digest('base64url');
// A state signed with the hub secret, as only the hub could: proves the
// callback's own checks, beyond what the routes already refuse.
const forge = (h, st) => {
  const p = Buffer.from(JSON.stringify(st)).toString('base64url');
  return `${p}.${createHmac('sha256', h.hub.secret).update(`integration-state|${p}`).digest('base64url')}`;
};

// ── the happy path, promotion and the vault ──────────────────────────────

test('prepare → url + bind + cookie; the callback promotes the row: same id, pinned match, ciphertext copied unchanged and still opening', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const p = await ready(h, alice);
    assert.equal(p.r.body.pending.provider, 'pend');
    assert.equal(p.r.body.pending.status, 'pending');
    assert.equal(p.r.body.pending.ready, true);
    assert.match(p.r.body.bind, /^[A-Za-z0-9_-]{32}$/);
    assert.match(p.cookie, /^board_int_pend=/);
    assert.equal(p.cookie, `board_int_pend=${p.r.body.bind}`);
    const st = JSON.parse(Buffer.from(p.state.split('.')[0], 'base64url').toString());
    assert.equal(st.pd, 1);
    assert.equal(st.i, p.id);
    assert.equal(st.m, h.ids.alice);
    assert.match(p.r.body.url, /client_id=111\.222/, 'authorizeUrl sees the pending settings in config');
    // prepare got the URLs of the id the connection keeps.
    const args = beh.prepared[0];
    assert.equal(args.webhookUrl, `${h.base}/integrations/${p.id}/webhook`);
    assert.equal(args.redirectUri, `${h.base}/integrations/pend/callback`);
    assert.equal(args.identityRedirectUri, `${h.base}/integrations/pend/identity/callback`);
    assert.deepEqual(pendingSecrets(h, p.id).map((r) => r.kind), ['client_secret', 'signing_secret']);
    const before = pendingSecrets(h, p.id).map((r) => ({ kind: r.kind, key_id: r.key_id, nonce: Buffer.from(r.nonce).toString('hex'), ct: Buffer.from(r.ciphertext).toString('hex') }));
    assert.equal(reg.list(h.ids.org).length, 0, 'a pending row is no connection');

    const out = await callback(h, p.state, p.cookie);
    assert.equal(out.status, 200, out.text);
    assert.match(out.text, /data-connect="ok"/);
    const ex = beh.exchanged[0];
    assert.deepEqual(ex.secrets, { client_secret: CS, signing_secret: SS }, 'exchange gets the pending secrets');
    assert.equal(ex.config.app_id, APP.app_id);
    assert.equal(ex.webhookUrl, args.webhookUrl);

    const c = h.db.get('SELECT * FROM connections WHERE id = ?', p.id);
    assert.ok(c, 'the connection keeps the pending id');
    assert.equal(c.org_id, h.ids.org);
    assert.equal(c.created_by, h.ids.alice);
    assert.equal(c.external_id, 'T1');
    const settings = JSON.parse(c.settings);
    assert.deepEqual(settings.pinned, { app_id: APP.app_id, client_id: APP.client_id });
    // D42 addendum C1: provider facts live in settings.provider (⊇ pinned), never config.
    assert.equal(settings.provider.app_id, APP.app_id, 'the pending settings win over exchange settings');
    assert.equal(settings.provider.bot_user_id, 'UB1');
    for (const [k, v] of Object.entries(settings.pinned)) assert.equal(settings.provider[k], v, `pinned ${k} copied into provider`);
    assert.equal(settings.config, undefined);
    assert.equal(pendingRow(h, p.id), null);
    assert.equal(pendingSecrets(h, p.id).length, 0);
    const after = h.db.all('SELECT * FROM connection_secrets WHERE connection_id = ? ORDER BY kind', p.id);
    assert.deepEqual(after.map((r) => r.kind), ['bot_token', 'client_secret', 'signing_secret']);
    const copied = after.filter((r) => r.kind !== 'bot_token').map((r) => ({ kind: r.kind, key_id: r.key_id, nonce: Buffer.from(r.nonce).toString('hex'), ct: Buffer.from(r.ciphertext).toString('hex') }));
    assert.deepEqual(copied, before, 'the pending ciphertext is copied byte for byte');
    const ctx = reg.ctxFor(p.id);
    assert.equal(ctx.secret('client_secret'), CS);
    assert.equal(ctx.secret('signing_secret'), SS);
    assert.equal(ctx.secret('bot_token'), BOT);
    assert.deepEqual(journal(h, 'integration.connect').map((j) => j.payload), [{ connection_id: p.id, provider: 'pend' }]);
    assert.deepEqual(journal(h, 'integration.prepare').map((j) => j.payload), [{ pending_id: p.id, provider: 'pend' }]);
    assert.match((await callback(h, p.state, p.cookie)).text, /already used/);
  } finally { await h.close(); }
});

test('vault AAD on the copy: a promoted secret opens only as its own (id, kind); a tampered or moved ciphertext does not', async () => {
  const { h, alice } = await setup();
  try {
    const p = await ready(h, alice);
    const other = randomUUID();
    const rows = pendingSecrets(h, p.id);
    const cs = rows.find((r) => r.kind === 'client_secret');
    const v = h.hub.vault;
    assert.equal(v.open(p.id, 'client_secret', cs), CS);
    assert.throws(() => v.open(other, 'client_secret', cs), 'moved to another id');
    assert.throws(() => v.open(p.id, 'signing_secret', cs), 'moved to another kind');
    assert.equal((await callback(h, p.state, p.cookie)).status, 200);
    const row = h.db.get("SELECT * FROM connection_secrets WHERE connection_id = ? AND kind = 'client_secret'", p.id);
    assert.equal(v.open(p.id, 'client_secret', row), CS);
    const bad = Buffer.from(row.ciphertext);
    bad[0] ^= 1;
    assert.throws(() => v.open(p.id, 'client_secret', { ...row, ciphertext: bad }), 'tampered');
    // A ciphertext moved onto another connection's row does not open there.
    const c2 = h.app.integrations.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'pend', external_id: 'T9', secrets: { client_secret: 'x1' } });
    h.db.run("UPDATE connection_secrets SET key_id = ?, nonce = ?, ciphertext = ? WHERE connection_id = ? AND kind = 'client_secret'", row.key_id, row.nonce, row.ciphertext, c2.id);
    assert.throws(() => h.app.integrations.ctxFor(c2.id).secret('client_secret'));
  } finally { await h.close(); }
});

// ── amendment 1: the state binds the row and its creator ─────────────────

test('two admins can never finish each other\'s row: routes 404, a state naming another member is refused, a stolen URL needs its bind', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    h.db.run("UPDATE members SET role = 'admin' WHERE id = ?", h.ids.bob);
    const bob = await h.login('bob');
    const p = await ready(h, alice);
    assert.equal((await authorize(h, bob, p.id)).status, 404);
    assert.equal((await prep(h, bob, p.id, { app_id: 'X' })).status, 404);
    const conflict = await prep(h, bob, 'pend', { config_token: configToken() });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.reason, 'PENDING_EXISTS');
    assert.equal(conflict.body.error.pending_id, p.id);
    // A correctly signed pd state for alice's row that names bob.
    const bind = randomBytes(24).toString('base64url');
    const st = { m: h.ids.bob, o: h.ids.org, p: 'pend', n: randomBytes(16).toString('base64url'), e: Date.now() + 600_000, b: sha(bind), i: p.id, pd: 1 };
    const forged = await callback(h, forge(h, st), `board_int_pend=${bind}`);
    assert.equal(forged.status, 400);
    assert.match(forged.text, /This setup has expired/);
    assert.equal(beh.exchanged.length, 0, 'exchange never ran');
    assert.ok(pendingRow(h, p.id), 'alice\'s row is untouched');
    // Bob's browser with alice's URL: the bind cookie is not his.
    const stolen = await callback(h, p.state, `board_int_pend=${bind}`);
    assert.match(stolen.text, /Open this link in the window/);
    // A pd state for a row that is not ready, or of another provider, is refused too.
    assert.match((await callback(h, forge(h, { ...st, m: h.ids.alice, n: randomBytes(16).toString('base64url'), i: randomUUID() }), `board_int_pend=${bind}`)).text, /expired/);
    assert.equal(reg.list(h.ids.org).length, 0);
    assert.equal((await callback(h, p.state, p.cookie)).status, 200, 'alice still finishes her own');
  } finally { await h.close(); }
});

test('the creator demoted (or removed) before the callback can\'t finish; authorize and the second step need an admin', async () => {
  const { h, reg } = await setup();
  try {
    h.db.run("UPDATE members SET role = 'admin' WHERE id = ?", h.ids.bob);
    const bob = await h.login('bob');
    const p = await ready(h, bob);
    h.db.run("UPDATE members SET role = 'member' WHERE id = ?", h.ids.bob);
    assert.match((await callback(h, p.state, p.cookie)).text, /Only a team admin/);
    assert.equal((await authorize(h, bob, p.id)).status, 403);
    assert.equal(reg.list(h.ids.org).length, 0);
    assert.equal((await prep(h, await h.login('bob'), 'pend', {})).status, 403, 'members cannot prepare');
  } finally { await h.close(); }
});

// ── amendment 2: the triggers ─────────────────────────────────────────────

test('triggers: a pending id can never be a connection id and back; promotion deletes the pending row first; pending rows are fixed and same-team', async () => {
  const { h } = await setup();
  try {
    const now = h.hub.iso();
    const exp = new Date(h.hub.wallMs() + 3_600_000).toISOString();
    const pend = (id, member = h.ids.alice, org = h.ids.org) => h.db.run('INSERT INTO integration_pending (id, org_id, provider, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', id, org, 'pend', member, now, exp);
    const conn = (id) => h.db.run("INSERT INTO connections (id, org_id, provider, external_id, created_by, created_at) VALUES (?, ?, 'pend', ?, ?, ?)", id, h.ids.org, id, h.ids.alice, now);
    const a = randomUUID();
    conn(a);
    assert.throws(() => pend(a), /pending_id_not_connection|is a connection/);
    const b = randomUUID();
    pend(b);
    assert.throws(() => conn(b), /connection_id_not_pending|is still pending/);
    // Insert-then-delete in one transaction aborts at the insert…
    assert.throws(() => h.db.tx(() => { conn(b); h.db.run('DELETE FROM integration_pending WHERE id = ?', b); }), /pending/);
    assert.ok(pendingRow(h, b));
    // …delete-then-insert (the promotion order) commits.
    h.db.tx(() => { h.db.run('DELETE FROM integration_pending WHERE id = ?', b); conn(b); });
    assert.ok(h.db.get('SELECT 1 AS x FROM connections WHERE id = ?', b));
    // Fixed once created: no extending, no moving.
    const c = randomUUID();
    pend(c);
    for (const sql of ["UPDATE integration_pending SET expires_at = '2099-01-01T00:00:00.000Z'", "UPDATE integration_pending SET created_at = '2099-01-01T00:00:00.000Z'", `UPDATE integration_pending SET id = '${randomUUID()}'`, "UPDATE integration_pending SET provider = 'github'", `UPDATE integration_pending SET created_by = '${h.ids.bob}'`]) {
      assert.throws(() => h.db.exec(`${sql} WHERE id = '${c}'`), /fixed/, sql);
    }
    // Same team only.
    const o = await otherOrg(h);
    assert.throws(() => pend(randomUUID(), o.id), /cross-team reference/);
    // Deleting the row purges its secrets.
    h.db.run("INSERT INTO integration_pending_secrets (pending_id, kind, key_id, nonce, ciphertext, created_at) VALUES (?, 'client_secret', 'k', x'00', x'00', ?)", c, now);
    h.db.run('DELETE FROM integration_pending WHERE id = ?', c);
    assert.equal(pendingSecrets(h, c).length, 0);
  } finally { await h.close(); }
});

// ── amendment 3: the configuration token never lands anywhere ────────────

function filesUnder(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

test('sentinel: the config token never reaches the DB (any table, journal, audit), the vault, logs, the D8 cache, any response or any error, on success, provider error, fetch error and a throw', async () => {
  const { h, reg, beh, lines, alice } = await setup({ config: ROOMY });
  const SENT = configToken();
  const texts = [];
  const seenByConnector = [];
  const has = (x) => {
    const s = typeof x === 'string' ? x : JSON.stringify(x) ?? '';
    return s.includes(SENT);
  };
  const noLeak = (e, label) => {
    for (const form of [String(e), e?.stack, inspect(e, { depth: 10, showHidden: true }), JSON.stringify(e), inspect(structuredClone(e), { depth: 10, showHidden: true })]) {
      assert.ok(!String(form).includes(SENT), `${label}: ${String(form).slice(0, 200)}`);
    }
  };
  try {
    const call = async (label) => {
      const rid = randomUUID();
      const r = await prep(h, alice, 'pend', { config_token: SENT }, rid);
      texts.push(r.text, JSON.stringify([...r.headers]));
      assert.ok(!r.text.includes(SENT), label);
      return { r, rid };
    };
    // 1. A provider error: apps.create answers 500; the connector's error names the token.
    beh.fetch = async () => new Response('{"ok":false}', { status: 500 });
    let { r } = await call('provider error');
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: { code: 'VALIDATION', message: 'That was not accepted. Check it and try again.' } });
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM integration_pending').n, 0, 'a failed prepare leaves no row');
    // 2. The fetch itself throws with the request headers in its cause (the
    // realistic leak): the connector only ever sees a rebuilt error.
    beh.fetch = async (url, init) => { throw Object.assign(new TypeError('fetch failed'), { cause: { request: { headers: init.headers } }, headers: init.headers }); };
    beh.prepare = async ({ input, fetch }) => {
      try {
        await fetch('https://api.pend.example/apps.manifest.create', { method: 'POST', headers: { authorization: `Bearer ${input.config_token}` } });
      } catch (e) { seenByConnector.push(e); throw e; }
      return null;
    };
    ({ r } = await call('fetch error'));
    assert.equal(r.status, 400);
    assert.equal(seenByConnector.length, 1);
    noLeak(seenByConnector[0], 'the fetch error the connector got');
    assert.equal(seenByConnector[0].cause, undefined);
    // 3. Throws of every shape: a non-Error, an Error with a cause, and a getter
    // on the answer that throws while the registry reads it.
    for (const thrower of [
      async ({ input }) => { throw { token: input.config_token }; },
      async ({ input }) => { throw new Error(input.config_token, { cause: new Error(input.config_token) }); },
      async ({ input }) => ({ get secrets() { throw new Error(`getter ${input.config_token}`); }, match: { a: 1 } }),
      async ({ input }) => ({ secrets: new Proxy({}, { ownKeys() { throw new Error(input.config_token); } }), match: { a: 1 } }),
      async ({ input }) => ({ needs: { fields: ['app_id'], create_url: `https://evil.example/${input.config_token}` } }),
    ]) {
      beh.prepare = thrower;
      ({ r } = await call('throw'));
      assert.equal(r.status, 400, r.text);
      try {
        await reg.pendingCreate({ member: h.hub.member(h.ids.alice), provider: 'pend', input: { config_token: SENT }, publicUrl: h.base });
        assert.fail('should throw');
      } catch (e) { noLeak(e, 'the thrown error'); }
    }
    // 4. Success, then the same request_id again: a fixed replay.
    beh.prepare = null;
    beh.fetch = null;
    const ok = await call('success');
    assert.equal(ok.r.status, 200, ok.r.text);
    const again = await prep(h, alice, 'pend', { config_token: SENT }, ok.rid);
    texts.push(again.text);
    assert.equal(again.status, 409);
    assert.deepEqual(again.body, { error: { code: 'CONFLICT', message: 'This request was already sent. Reload the page.', reason: 'REPLAYED' } });
    assert.ok(!again.text.includes(ok.r.body.bind), 'the replay never repeats the bind');
    const cb = await callback(h, stateOf(ok.r), cookieOf(ok.r));
    texts.push(cb.text);
    assert.equal(cb.status, 200);
    assert.ok(beh.requests.some((q) => has(q.init.headers)), 'the token did reach the provider');

    for (const t of texts) assert.ok(!t.includes(SENT));
    for (const l of lines) assert.ok(!l.includes(SENT), `log line: ${l.slice(0, 200)}`);
    assert.ok(lines.some((l) => /integration prepare failed/.test(l)), 'failures are logged, as a code only');
    for (const [k, v] of h.hub.requestCache) assert.ok(!has(v.body) && !k.includes(SENT), 'D8 cache');
    // Every table, then the database files themselves after a checkpoint.
    for (const { name } of h.db.all("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      for (const row of h.db.all(`SELECT * FROM "${name}"`)) {
        for (const v of Object.values(row)) assert.ok(!(v != null && (Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).includes(SENT) : String(v).includes(SENT))), `table ${name}`);
      }
    }
    for (const t of ['connection_secrets', 'integration_pending_secrets']) {
      for (const row of h.db.all(`SELECT * FROM ${t}`)) assert.ok(!h.hub.vault.open(row.connection_id ?? row.pending_id, row.kind, row).includes(SENT), `vault ${t}`);
    }
    h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const f of filesUnder(h.dataDir)) assert.ok(!readFileSync(f).includes(SENT), f);
  } finally { await h.close(); }
});

test('input: only declared keys reach prepare; a value over 4096 bytes, a non-string or a non-object input is VALIDATION; fetch reaches only declared hosts', async () => {
  const { h, beh, alice } = await setup();
  try {
    const big = await prep(h, alice, 'pend', { config_token: 'x'.repeat(4097) });
    assert.equal(big.status, 400);
    assert.ok(!big.text.includes('xxxx'));
    for (const input of [{ config_token: 7 }, { config_token: '' }, 'text', [1]]) assert.equal((await prep(h, alice, 'pend', input)).status, 400, JSON.stringify(input));
    assert.equal(beh.prepared.length, 0);
    beh.prepare = async ({ fetch }) => { await fetch('https://evil.example/steal', { method: 'POST' }); return null; };
    const off = await prep(h, alice, 'pend', { config_token: configToken() });
    assert.equal(off.status, 400);
    assert.ok(!beh.requests.some((r) => r.url.includes('evil.example')), 'the off-host request was never made');
    beh.prepare = null;
    const r = await prep(h, alice, 'pend', { config_token: 'y'.repeat(4096), other: 'dropped', __proto__x: 1 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(beh.prepared.at(-1).input), ['config_token']);
  } finally { await h.close(); }
});

// ── paste fallback: needs, then a second prepare ─────────────────────────

test('paste fallback: an empty input answers needs (no secrets yet); the creator\'s second step makes it ready; a second needs is VALIDATION', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const n = await prep(h, alice, 'pend', {});
    assert.equal(n.status, 200, n.text);
    assert.deepEqual(n.body.needs, { fields: ['app_id', 'client_id', 'client_secret', 'signing_secret'], create_url: 'https://pend.example/apps?new_app=1' });
    assert.equal(n.body.url, undefined);
    assert.equal(n.body.pending.ready, false);
    const id = n.body.pending.id;
    assert.equal(pendingSecrets(h, id).length, 0);
    assert.equal((await authorize(h, alice, id)).body.error.reason, 'PENDING_NOT_READY');
    // A second needs answer is refused; the row stays not ready.
    assert.equal((await prep(h, alice, id, {})).status, 400);
    assert.ok(pendingRow(h, id));
    const r = await prep(h, alice, id, { app_id: APP.app_id, client_id: APP.client_id, client_secret: CS, signing_secret: SS });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.pending.id, id);
    assert.equal(r.body.pending.ready, true);
    assert.ok(r.body.url && r.body.bind);
    assert.equal((await prep(h, alice, id, { app_id: 'B' })).body.error.reason, 'PENDING_READY');
    assert.equal((await callback(h, stateOf(r), cookieOf(r))).status, 200);
    assert.equal(reg.ctxFor(id).secret('signing_secret'), SS);
    // needs: create_url must be https on hosts.
    beh.create_url = 'http://pend.example/x';
    assert.equal((await prep(h, alice, 'pend', {})).status, 400);
  } finally { await h.close(); }
});

test('second step: only the keys the earlier needs.fields named; any other key (declared for prepare or not) is VALIDATION and prepare is not called', async () => {
  const { h, beh, alice } = await setup();
  try {
    beh.prepare = ({ input }) => (Object.keys(input).length
      ? { secrets: { client_secret: CS }, settings: { app_id: input.app_id }, match: { app_id: input.app_id } }
      : { needs: { fields: ['app_id', 'client_secret'], create_url: 'https://pend.example/apps?new_app=1' } });
    const n = await prep(h, alice, 'pend', {});
    assert.deepEqual(n.body.needs.fields, ['app_id', 'client_secret']);
    const id = n.body.pending.id;
    const calls = beh.prepared.length;
    for (const input of [{ app_id: 'A1', config_token: configToken() }, { app_id: 'A1', client_id: '1.2' }, { app_id: 'A1', unknown_key: 'x' }, { config_token: configToken() }]) {
      const r = await prep(h, alice, id, input);
      assert.equal(r.status, 400, JSON.stringify(Object.keys(input)));
      assert.equal(r.body.error.code, 'VALIDATION');
    }
    assert.equal(beh.prepared.length, calls, 'prepare never saw a refused input');
    assert.equal(pendingRow(h, id).match, '{}', 'the row is still waiting for its paste');
    const ok = await prep(h, alice, id, { app_id: 'A1', client_secret: CS });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(Object.keys(beh.prepared.at(-1).input).sort(), ['app_id', 'client_secret']);
  } finally { await h.close(); }
});

// ── amendment 4: the pending 404 ──────────────────────────────────────────

test('a webhook to a pending id is exactly the unknown-connection 404 (status, body, headers), over HTTP and in the registry', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const p = await ready(h, alice);
    const send = (id) => fetch(`${h.base}/integrations/${id}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'url_verification', challenge: 'c' }) });
    const norm = async (res) => ({ status: res.status, body: await res.text(), headers: [...res.headers].filter(([k]) => k !== 'date') });
    const a = await norm(await send(p.id));
    const b = await norm(await send(randomUUID()));
    assert.deepEqual(a, b);
    assert.equal(a.status, 404);
    const raw = Buffer.from('{}');
    assert.deepEqual(await reg.webhook(p.id, { headers: {}, rawBody: raw }), await reg.webhook(randomUUID(), { headers: {}, rawBody: raw }));
    assert.equal(reg.webhookTarget(p.id), false);
    assert.equal(beh.handled, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM inbound_dedupe').n, 0);
  } finally { await h.close(); }
});

// ── lifetime ──────────────────────────────────────────────────────────────

test('TTL: at 1 h + 1 ms a row is invisible everywhere at once; the reaper sweep deletes it and its secrets; prepare is allowed again', async () => {
  const { h, reg, alice } = await setup();
  try {
    const p = await ready(h, alice);
    const exp = pendingRow(h, p.id).expires_at;
    assert.equal(Date.parse(exp) - Date.parse(pendingRow(h, p.id).created_at), 3_600_000);
    for (let i = 0; i < 5; i += 1) assert.equal((await authorize(h, alice, p.id)).status, 200);
    assert.equal((await authorize(h, alice, p.id)).status, 429, 'at most 5 authorizes per row');
    assert.equal(pendingRow(h, p.id).expires_at, exp, 'authorize never extends it');
    h.clock.advance(3_600_001);
    assert.equal((await authorize(h, alice, p.id)).status, 404);
    assert.equal((await prep(h, alice, p.id, { app_id: 'x' })).status, 404);
    assert.equal((await del(h, alice, p.id)).status, 404);
    assert.deepEqual((await h.api(alice, 'GET', '/api/integrations')).body.pending, []);
    assert.match((await callback(h, p.state, p.cookie)).text, /This setup has expired/);
    assert.equal(reg.list(h.ids.org).length, 0);
    assert.ok(pendingRow(h, p.id), 'still on disk until the sweep');
    await h.tick();
    assert.equal(pendingRow(h, p.id), null);
    assert.equal(pendingSecrets(h, p.id).length, 0);
    assert.deepEqual(journal(h, 'integration.prepare_expire').map((j) => j.payload), [{ pending_id: p.id, provider: 'pend' }]);
    // An expired row that no sweep reached yet is purged by the next prepare.
    const q = await ready(h, alice);
    h.clock.advance(3_600_001);
    const r = await ready(h, alice);
    assert.notEqual(r.id, q.id);
    assert.equal(pendingRow(h, q.id), null);
  } finally { await h.close(); }
});

test('the sweep runs at most once a minute (the reaper calls it every tick)', async () => {
  const { h, reg } = await setup();
  try {
    const add = () => {
      const id = randomUUID();
      const t = new Date(h.hub.wallMs() - 7_200_000).toISOString();
      h.db.run('INSERT INTO integration_pending (id, org_id, provider, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', id, h.ids.org, 'pend', h.ids.alice, t, new Date(h.hub.wallMs() - 1).toISOString());
      return id;
    };
    reg.sweepPending();
    const a = add();
    reg.sweepPending();
    await h.tick();
    assert.ok(pendingRow(h, a), 'swept less than a minute ago');
    h.clock.advance(60_001);
    await h.tick();
    assert.equal(pendingRow(h, a), null);
  } finally { await h.close(); }
});

// ── limits, one at a time ─────────────────────────────────────────────────

test('one live row per (org, provider) and per admin; another org is independent', async () => {
  const { h, alice } = await setup();
  try {
    h.app.integrations.register(pendConnector({ prepared: [], exchanged: [], requests: [], handled: 0 }, 'pend2'));
    const p = await ready(h, alice);
    const own = await prep(h, alice, 'pend2', {});
    assert.equal(own.status, 409, 'per admin, any provider');
    assert.equal(own.body.error.reason, 'PENDING_EXISTS');
    const o = await otherOrg(h);
    const theirs = await prep(h, o.cookie, 'pend', {});
    assert.equal(theirs.status, 200, theirs.text);
    assert.equal((await h.api(o.cookie, 'GET', '/api/integrations')).body.pending.length, 1);
    assert.deepEqual((await h.api(alice, 'GET', '/api/integrations')).body.pending.map((x) => x.id), [p.id]);
  } finally { await h.close(); }
});

test('rate limits: integration_prepare_member trips at the 6th in an hour (the second step counts); integration_prepare_org at the 11th in a day', async () => {
  const { h, alice } = await setup();
  try {
    const n = await prep(h, alice, 'pend', {});
    const id = n.body.pending.id;
    assert.equal((await prep(h, alice, id, { app_id: APP.app_id, client_id: APP.client_id, client_secret: CS, signing_secret: SS })).status, 200);
    assert.equal((await del(h, alice, id)).status, 200);
    for (let i = 0; i < 3; i += 1) {
      const r = await ready(h, alice);
      assert.equal((await del(h, alice, r.id)).status, 200);
    }
    const over = await prep(h, alice, 'pend', { config_token: configToken() });
    assert.equal(over.status, 429);
    assert.equal(over.body.error.code, 'RATE_LIMITED');
  } finally { await h.close(); }
  const { h: h2, alice: a2 } = await setup();
  try {
    const bob = await addMember(h2, 'bobadmin', 'admin');
    const carol = await addMember(h2, 'carol', 'admin');
    let n = 0;
    for (const who of [a2, bob.cookie, carol.cookie]) {
      for (let i = 0; i < 4 && n < 10; i += 1, n += 1) {
        const r = await ready(h2, who);
        assert.equal((await del(h2, who, r.id)).status, 200);
      }
    }
    const over = await prep(h2, carol.cookie, 'pend', { config_token: configToken() });
    assert.equal(over.status, 429, over.text);
  } finally { await h2.close(); }
});

// ── the callback's match and clash rules ─────────────────────────────────

test('match: a different app_id, a different recorded external_id or a replaced pending secret is refused and the row stays', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const p = await ready(h, alice);
    const base = (args) => ({ external_id: 'T1', display_name: 'W', scopes: [], secrets: { bot_token: BOT }, match: { app_id: args.config.app_id, client_id: args.config.client_id } });
    const cases = [
      [(a) => ({ ...base(a), match: { ...base(a).match, app_id: 'A0OTHER' } }), /does not match/],
      [(a) => ({ ...base(a), match: { app_id: a.config.app_id } }), /does not match/],
      [(a) => ({ ...base(a), match: { ...base(a).match, extra: 1 } }), /does not match/],
      [(a) => ({ ...base(a), match: undefined }), /does not match/],
      [(a) => ({ ...base(a), secrets: { bot_token: BOT, signing_secret: 'replaced1' } }), /Could not save/],
    ];
    for (const [ex, want] of cases) {
      beh.exchange = ex;
      const a = await authorize(h, alice, p.id);
      const out = await callback(h, stateOf(a), cookieOf(a));
      assert.equal(out.status, 400);
      assert.match(out.text, want);
      assert.ok(pendingRow(h, p.id), 'the row stays');
      assert.equal(reg.list(h.ids.org).length, 0);
    }
    await del(h, alice, p.id);
    // A recorded external_id must come back the same.
    beh.external_id = 'T1';
    beh.exchange = (a) => ({ ...base(a), external_id: 'T2' });
    const q = await ready(h, alice);
    assert.match((await callback(h, q.state, q.cookie)).text, /does not match/);
    beh.exchange = null;
    beh.team = 'T1';
    const a = await authorize(h, alice, q.id);
    assert.equal((await callback(h, stateOf(a), cookieOf(a))).status, 200);
  } finally { await h.close(); }
});

test('workspaceUnique is checked inside the promotion transaction (a clash created while exchange ran): CONFLICT, the row is deleted, the page says to delete the app', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const o = await otherOrg(h);
    const p = await ready(h, alice);
    beh.exchange = (args) => {
      reg.createConnection({ orgId: o.org, memberId: o.id, provider: 'pend', external_id: 'T1' });
      return { external_id: 'T1', display_name: 'W', scopes: [], secrets: { bot_token: BOT }, match: { app_id: args.config.app_id, client_id: args.config.client_id } };
    };
    const out = await callback(h, p.state, p.cookie);
    assert.equal(out.status, 400);
    assert.match(out.text, /this Pend is already connected/);
    assert.match(out.text, /Delete the app this setup created on Pend/);
    assert.ok(!out.text.includes(o.org));
    assert.equal(pendingRow(h, p.id), null);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM connections WHERE id = ?', p.id).n, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM connection_secrets WHERE connection_id = ?', p.id).n, 0);
    assert.equal(journal(h, 'integration.prepare_cancel').length, 1);
  } finally { await h.close(); }
});

test('two concurrent callbacks for one row make exactly one connection', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const p = await ready(h, alice);
    const a = await authorize(h, alice, p.id);
    beh.exchange = async (args) => { await new Promise((r) => setTimeout(r, 30)); return { external_id: 'T1', display_name: 'W', scopes: [], secrets: { bot_token: BOT }, match: { app_id: args.config.app_id, client_id: args.config.client_id } }; };
    const outs = await Promise.all([callback(h, p.state, p.cookie), callback(h, stateOf(a), cookieOf(a))]);
    assert.deepEqual(outs.map((o) => o.status).sort(), [200, 400]);
    assert.equal(reg.list(h.ids.org).length, 1);
  } finally { await h.close(); }
});

// ── amendment 9: pinned ───────────────────────────────────────────────────

test('settings.pinned: PATCH and setSettings can\'t write it; a raw update that changes it aborts', async () => {
  const { h, reg, alice } = await setup();
  try {
    const p = await ready(h, alice);
    await callback(h, p.state, p.cookie);
    const pinned = { app_id: APP.app_id, client_id: APP.client_id };
    const r = await h.api(alice, 'PATCH', `/api/integrations/${p.id}`, { request_id: randomUUID(), pinned: { app_id: 'EVIL' }, config: { x: 'cfg' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.connection.settings.pinned, pinned);
    // D42 addendum C1: a config key named after a namespace, and setSettings naming pinned, are VALIDATION.
    assert.equal((await h.api(alice, 'PATCH', `/api/integrations/${p.id}`, { request_id: randomUUID(), config: { pinned: 'cfg' } })).status, 400);
    assert.throws(() => reg.setSettings(p.id, { pinned: { app_id: 'EVIL' } }), (e) => e.code === 'VALIDATION');
    assert.deepEqual(JSON.parse(h.db.get('SELECT settings FROM connections WHERE id = ?', p.id).settings).pinned, pinned);
    assert.throws(() => h.db.run('UPDATE connections SET settings = ? WHERE id = ?', JSON.stringify({ pinned: { app_id: 'EVIL' } }), p.id), /pinned/);
    assert.throws(() => h.db.run('UPDATE connections SET settings = ? WHERE id = ?', JSON.stringify({}), p.id), /pinned/);
    // A connection without pinned can't gain one either.
    const c = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'pend', external_id: 'T7' });
    assert.throws(() => h.db.run('UPDATE connections SET settings = ? WHERE id = ?', JSON.stringify({ pinned: { a: 1 } }), c.id), /pinned/);
    h.db.run('UPDATE connections SET settings = ? WHERE id = ?', JSON.stringify({ autonomy: {} }), c.id);
  } finally { await h.close(); }
});

// ── amendment 8 + routes: DELETE, admin-only, cross-org, CSRF, listing ───

test('DELETE: any admin of the org deletes a live pending row at once (journaled, secrets gone); a member is refused; another org gets 404', async () => {
  const { h, alice } = await setup();
  try {
    const p = await ready(h, alice);
    const member = await h.login('bob');
    assert.equal((await del(h, member, p.id)).status, 403);
    const o = await otherOrg(h);
    assert.equal((await del(h, o.cookie, p.id)).status, 404);
    assert.equal((await authorize(h, o.cookie, p.id)).status, 404);
    assert.equal((await prep(h, o.cookie, p.id, { app_id: 'x' })).status, 404);
    assert.ok(!JSON.stringify((await h.api(o.cookie, 'GET', '/api/integrations')).body).includes(p.id));
    const admin2 = await addMember(h, 'erin', 'admin');
    const r = await del(h, admin2.cookie, p.id);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(pendingRow(h, p.id), null);
    assert.equal(pendingSecrets(h, p.id).length, 0);
    assert.deepEqual(journal(h, 'integration.prepare_cancel').map((j) => j.payload), [{ pending_id: p.id, provider: 'pend' }]);
    assert.match((await callback(h, p.state, p.cookie)).text, /This setup has expired/);
  } finally { await h.close(); }
});

test('routes: admin-only, same-origin JSON only; GET lists pending rows for admins only; connectors() names prepare inputs', async () => {
  const { h, alice } = await setup();
  try {
    const bob = await h.login('bob');
    assert.equal((await prep(h, bob, 'pend', {})).status, 403);
    const cross = await h.api(alice, 'POST', '/api/integrations/pend/prepare', { request_id: randomUUID(), input: {} }, { origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    const res = await fetch(`${h.base}/api/integrations/pend/prepare`, { method: 'POST', headers: { cookie: alice, 'content-type': 'text/plain' }, body: '{"input":{}}' });
    assert.equal(res.status, 400);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM integration_pending').n, 0);
    assert.equal((await prep(h, alice, 'nope', {})).status, 404);
    assert.equal((await prep(h, alice, 'fake', {})).status, 404, 'a connector without prepare');
    const p = await ready(h, alice);
    const list = (await h.api(alice, 'GET', '/api/integrations')).body;
    assert.deepEqual(Object.keys(list.pending[0]).sort(), ['created_at', 'created_by', 'expires_at', 'id', 'provider', 'ready', 'status']);
    assert.equal(list.pending[0].id, p.id);
    assert.deepEqual(list.available.find((c) => c.id === 'pend').prepare, ['config_token', 'app_id', 'client_id', 'client_secret', 'signing_secret']);
    assert.equal(list.available.find((c) => c.id === 'fake').prepare, null);
    const asMember = (await h.api(bob, 'GET', '/api/integrations')).body;
    assert.equal(asMember.pending, undefined);
    assert.equal((await h.api(alice, 'PATCH', `/api/integrations/${p.id}`, { request_id: randomUUID(), autonomy: {} })).status, 404, 'a pending row is not PATCHable');
    assert.equal((await h.api(alice, 'GET', `/api/integrations/${p.id}/audit`)).status, 404);
  } finally { await h.close(); }
});

test('team deletion deletes the team\'s pending rows', async () => {
  const { h, alice } = await setup();
  try {
    const p = await ready(h, alice);
    h.db.run('UPDATE orgs SET deleted_at = ? WHERE id = ?', h.hub.iso(), h.ids.org);
    h.hub.revokeDeletedTeamConnections(h.hub.iso());
    assert.equal(pendingRow(h, p.id), null);
    assert.equal(pendingSecrets(h, p.id).length, 0);
  } finally { await h.close(); }
});

// ── builder-4's gap: one identity redirect URI ───────────────────────────

test('identityRedirectUri: prepare receives exactly what the registry\'s helper returns later for the promoted connection', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const p = await ready(h, alice);
    await callback(h, p.state, p.cookie);
    assert.equal(beh.prepared[0].identityRedirectUri, reg.identityRedirectUri(h.base, p.id));
    assert.equal(reg.identityRedirectUri(h.base, randomUUID()), null);
  } finally { await h.close(); }
});

// ── defineConnector ───────────────────────────────────────────────────────

test('defineConnector refuses prepare without prepareInputs (and back), on a token or manifest connector, and bad input names', () => {
  const base = {
    id: 'pp', name: 'P', scopes: [], secrets: [], hosts: ['p.example'],
    connect: { kind: 'oauth', authorizeUrl: () => 'https://p.example', exchange: async () => ({}) },
  };
  const withConnect = (c) => ({ ...base, connect: { ...base.connect, ...c } });
  const prepare = async () => ({});
  assert.doesNotThrow(() => defineConnector(withConnect({ prepare, prepareInputs: ['config_token'] })));
  assert.throws(() => defineConnector(withConnect({ prepare })), /prepareInputs/);
  assert.throws(() => defineConnector(withConnect({ prepareInputs: ['a'] })), /prepare/);
  assert.throws(() => defineConnector(withConnect({ prepare: 'x', prepareInputs: ['a'] })), /prepare/);
  for (const bad of [[], ['A'], ['a', 'a'], Array.from({ length: 9 }, (_, i) => `k${i}`), ['__proto__'], 'config_token']) {
    assert.throws(() => defineConnector(withConnect({ prepare, prepareInputs: bad })), /prepareInputs/, JSON.stringify(bad));
  }
  assert.throws(() => defineConnector({ ...base, connect: { kind: 'token', verifyToken: async () => ({}), prepare, prepareInputs: ['a'] } }), /prepare/);
  assert.throws(() => defineConnector({ ...base, connect: { kind: 'app_install', exchange: async () => ({}), formHost: 'p.example', manifestForm: () => ({}), prepare, prepareInputs: ['a'] } }), /prepare/);
});

// ── review follow-ups ─────────────────────────────────────────────────────

function plainConnector(beh) {
  return defineConnector({
    id: 'plain', name: 'Plain', scopes: [], secrets: ['bot_token'], hosts: ['plain.example'],
    connect: {
      kind: 'oauth',
      authorizeUrl: ({ state }) => `https://plain.example/authorize?state=${encodeURIComponent(state)}`,
      async exchange() { beh.plain += 1; return { external_id: 'P1', display_name: 'Plain', scopes: [], secrets: { bot_token: BOT } }; },
    },
    verify: () => ({ ok: true, dedupe_key: randomUUID() }),
    handleWebhook: async () => {},
  });
}

test('a prepare connector can\'t be finished without its pending step: /start is 404, a hub-signed state without pd is the invalid link and exchange never runs; a plain connector is unchanged', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const start = await h.api(alice, 'POST', '/api/integrations/pend/start', { request_id: randomUUID() });
    assert.equal(start.status, 404, start.text);
    const p = await ready(h, alice);
    const bind = randomBytes(24).toString('base64url');
    for (const i of [p.id, randomUUID()]) {
      const st = { m: h.ids.alice, o: h.ids.org, p: 'pend', n: randomBytes(16).toString('base64url'), e: Date.now() + 600_000, b: sha(bind), i };
      const out = await callback(h, forge(h, st), `board_int_pend=${bind}`);
      assert.equal(out.status, 400);
      assert.match(out.text, /This link is not valid/);
      assert.equal(h.db.get("SELECT COUNT(*) AS n FROM inbound_dedupe WHERE provider = 'oauth_state' AND dedupe_key = ?", st.n).n, 0, 'refused before the nonce is spent');
    }
    assert.equal(beh.exchanged.length, 0, 'exchange never ran');
    assert.equal(reg.list(h.ids.org).length, 0);
    assert.ok(pendingRow(h, p.id));
    beh.plain = 0;
    reg.register(plainConnector(beh));
    const s = await h.api(alice, 'POST', '/api/integrations/plain/start', { request_id: randomUUID() });
    assert.equal(s.status, 200, s.text);
    const out = await callback(h, new URL(s.body.url).searchParams.get('state'), cookieOf(s), 'plain');
    assert.equal(out.status, 200, out.text);
    assert.equal(beh.plain, 1);
    assert.equal(reg.list(h.ids.org).filter((c) => c.provider === 'plain').length, 1);
  } finally { await h.close(); }
});

test('the creator demoted or removed while exchange runs: the promotion transaction refuses (setup expired), no connection; the row stays until it expires', async () => {
  const { h, reg, beh } = await setup();
  try {
    h.db.run("UPDATE members SET role = 'admin' WHERE id = ?", h.ids.bob);
    const bob = await h.login('bob');
    const p = await ready(h, bob);
    const ok = (args) => ({ external_id: 'T1', display_name: 'W', scopes: [], secrets: { bot_token: BOT }, match: { app_id: args.config.app_id, client_id: args.config.client_id } });
    for (const change of ["UPDATE members SET role = 'member' WHERE id = ?", "UPDATE members SET removed_at = '2026-09-30T10:00:00.000Z' WHERE id = ?"]) {
      h.db.run("UPDATE members SET role = 'admin', removed_at = NULL WHERE id = ?", h.ids.bob);
      beh.exchange = (args) => { h.db.run(change, h.ids.bob); return ok(args); };
      const a = await authorize(h, bob, p.id);
      assert.equal(a.status, 200, a.text);
      const out = await callback(h, stateOf(a), cookieOf(a));
      assert.equal(out.status, 400, change);
      assert.match(out.text, /This setup has expired/, change);
      assert.equal(reg.list(h.ids.org).length, 0, change);
      assert.equal(h.db.get('SELECT COUNT(*) AS n FROM connection_secrets WHERE connection_id = ?', p.id).n, 0);
      assert.ok(pendingRow(h, p.id), 'the row stays');
      assert.equal(pendingSecrets(h, p.id).length, 2);
    }
  } finally { await h.close(); }
});

test('a second step can\'t run beside the first: the reserved row is busy until the first prepare returns', async () => {
  const { h, alice, beh } = await setup({ config: ROOMY });
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    beh.fetch = async () => { await gate; return new Response(JSON.stringify({ ok: true, ...APP, client_secret: CS, signing_secret: SS }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const first = prep(h, alice, 'pend', { config_token: configToken() });
    let row;
    for (let i = 0; i < 200 && !row; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      row = h.db.get('SELECT * FROM integration_pending');
    }
    assert.ok(row, 'the first prepare reserved its row');
    const second = await prep(h, alice, row.id, { app_id: 'A0SECOND', client_id: '9.9', client_secret: 'x1', signing_secret: 'x2' });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.body.error.reason, 'PENDING_BUSY');
    release();
    const r = await first;
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.pending.id, row.id);
    assert.equal(JSON.parse(pendingRow(h, row.id).match).app_id, APP.app_id);
  } finally { await h.close(); }
});

test('the provider made the app but the hub could not save it: the row goes and the answer is a fixed CONFLICT naming the provider', async () => {
  const { h, alice } = await setup({ config: ROOMY });
  try {
    const want = { error: { code: 'CONFLICT', message: 'Could not save this setup. Delete the app it created on Pend.' } };
    h.db.exec("CREATE TEMP TRIGGER pend_fail BEFORE INSERT ON main.integration_pending_secrets BEGIN SELECT RAISE(ABORT, 'boom-provider-text'); END");
    const r = await prep(h, alice, 'pend', { config_token: configToken() });
    assert.equal(r.status, 409, r.text);
    assert.deepEqual(r.body, want);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM integration_pending').n, 0);
    // The second step too.
    h.db.exec('DROP TRIGGER temp.pend_fail');
    const n = await prep(h, alice, 'pend', {});
    assert.equal(n.status, 200, n.text);
    const id = n.body.pending.id;
    h.db.exec("CREATE TEMP TRIGGER pend_fail BEFORE INSERT ON main.integration_pending_secrets BEGIN SELECT RAISE(ABORT, 'boom-provider-text'); END");
    const s = await prep(h, alice, id, { app_id: APP.app_id, client_id: APP.client_id, client_secret: CS, signing_secret: SS });
    assert.equal(s.status, 409, s.text);
    assert.deepEqual(s.body, want);
    assert.ok(!s.text.includes('boom') && !s.text.includes(CS));
    assert.equal(pendingRow(h, id), null);
    assert.equal(pendingSecrets(h, id).length, 0);
    h.db.exec('DROP TRIGGER temp.pend_fail');
  } finally { await h.close(); }
});

test('trigger: a ready pending row\'s match, settings and external_id never change; the first answer and the authorize count still do', async () => {
  const { h } = await setup();
  try {
    const id = randomUUID();
    const exp = new Date(h.hub.wallMs() + 3_600_000).toISOString();
    h.db.run('INSERT INTO integration_pending (id, org_id, provider, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', id, h.ids.org, 'pend', h.ids.alice, h.hub.iso(), exp);
    assert.equal(pendingRow(h, id).match, '{}', 'the unset value');
    h.db.run('UPDATE integration_pending SET external_id = ? WHERE id = ?', 'T0', id);
    h.db.run('UPDATE integration_pending SET match = ?, settings = ?, external_id = ? WHERE id = ?', '{"app_id":"A1"}', '{"app_id":"A1"}', 'T1', id);
    for (const sql of [`UPDATE integration_pending SET match = '{"app_id":"A2"}'`, "UPDATE integration_pending SET match = '{}'", `UPDATE integration_pending SET settings = '{"app_id":"A2"}'`, "UPDATE integration_pending SET external_id = 'T2'", 'UPDATE integration_pending SET external_id = NULL']) {
      assert.throws(() => h.db.exec(`${sql} WHERE id = '${id}'`), /a ready pending connection is fixed/, sql);
    }
    h.db.run('UPDATE integration_pending SET authorize_count = authorize_count + 1 WHERE id = ?', id);
    assert.deepEqual([pendingRow(h, id).match, pendingRow(h, id).authorize_count], ['{"app_id":"A1"}', 1]);
    h.db.run('DELETE FROM integration_pending WHERE id = ?', id);
  } finally { await h.close(); }
});

test('fresh DB after every migration: the id-exclusivity and pinned triggers exist', async () => {
  const { h } = await setup();
  try {
    const names = h.db.all("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'").map((r) => `${r.tbl_name}.${r.name}`);
    for (const t of ['connections.connection_id_not_pending', 'integration_pending.pending_id_not_connection', 'connections.connections_pinned_fixed', 'integration_pending.integration_pending_answer_once',
      'connections.connections_provider_fixed', 'connections.connections_id_never_reused']) {
      assert.ok(names.includes(t), t);
    }
  } finally { await h.close(); }
});

// Member lifecycle: whoever can no longer finish a pending row loses it at once.
const seedPending = (h, memberId, provider, orgId = h.ids.org) => {
  const id = randomUUID();
  h.db.run('INSERT INTO integration_pending (id, org_id, provider, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', id, orgId, provider, memberId, h.hub.iso(), new Date(h.hub.wallMs() + 3_600_000).toISOString());
  h.db.run("INSERT INTO integration_pending_secrets (pending_id, kind, key_id, nonce, ciphertext, created_at) VALUES (?, 'client_secret', 'k', x'00', x'00', ?)", id, h.hub.iso());
  return id;
};
const cancels = (h, id) => journal(h, 'integration.prepare_cancel').filter((j) => j.payload.pending_id === id);
const assertPurged = (h, id, provider) => {
  assert.equal(pendingRow(h, id), null);
  assert.equal(pendingSecrets(h, id).length, 0);
  const j = cancels(h, id);
  assert.equal(j.length, 1);
  assert.deepEqual([j[0].actor_kind, j[0].actor_id, j[0].board_id, j[0].payload], ['system', null, null, { pending_id: id, provider }]);
};
const assertKept = (h, id) => {
  assert.ok(pendingRow(h, id));
  assert.equal(pendingSecrets(h, id).length, 1);
  assert.equal(cancels(h, id).length, 0);
};

test('legacy member removal (DELETE /api/members/:id) purges that member\'s pending rows and secrets in the same transaction, journaled once', async () => {
  const { h, alice } = await setup();
  try {
    const carol = await addMember(h, 'carol', 'admin');
    const mine = seedPending(h, carol.id, 'p1');
    const other = seedPending(h, h.ids.alice, 'p2');
    const r = await h.api(alice, 'DELETE', `/api/members/${carol.id}`, { request_id: randomUUID() });
    assert.equal(r.status, 200, r.text);
    assertPurged(h, mine, 'p1');
    assertKept(h, other);
  } finally { await h.close(); }
});
