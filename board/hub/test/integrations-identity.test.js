// Identity links (D98, slice B2): a member links their own provider account
// (Sign in with Slack, OIDC) to their membership; the registry verifies the
// id_token itself; act(…, {subject}) may act only as that subject's linked
// member. A fake OIDC provider whose JWKS and signing key the test controls;
// every key and token is made at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, createHmac, createHash, sign as cryptoSign } from 'node:crypto';
import { defineConnector } from '../integrations/connector.js';
import { startHub } from './helpers.js';
import { tenancy } from './tenancy/fixture.js';
import { createLogger } from '../log.js';
import { dumpDb } from './accounts-helpers.js';

const b64 = (x) => Buffer.from(x).toString('base64url');
const sha = (x) => createHash('sha256').update(String(x)).digest('base64url');
const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = `kid-${randomBytes(4).toString('hex')}`;
const ISS = 'https://slk.example';
const JWKS_URL = 'https://slk.example/openid/connect/keys';
const TEAM_CLAIM = 'https://slk.example/team_id';
const APP = { app_id: 'A0IDENT1', client_id: `${randomBytes(3).toString('hex')}.${randomBytes(3).toString('hex')}` };
const CS = `csec${randomBytes(8).toString('hex')}`;
const userId = () => `U${randomBytes(5).toString('hex').toUpperCase()}`;

function signJwt(claims, { alg = 'RS256', kid = KID, privateKey = KEY.privateKey, hmacKey = null, sig = null } = {}) {
  const head = b64(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64(JSON.stringify(claims));
  const input = `${head}.${body}`;
  if (sig !== null) return `${input}.${sig}`;
  if (hmacKey) return `${input}.${b64(createHmac('sha256', hmacKey).update(input).digest())}`;
  return `${input}.${b64(cryptoSign('RSA-SHA256', Buffer.from(input), privateKey))}`;
}

// A Slack-shaped connector: prepare → pinned app; connect exchange; identity hooks.
function slkConnector(beh, { id = 'slk', iss = ISS, jwksUrl = JWKS_URL, hosts = ['slk.example', 'api.slk.example'], identity = true } = {}) {
  return defineConnector({
    id, name: 'Slk', scopes: ['chat:write'], secrets: ['client_secret', 'bot_token'], hosts, workspaceUnique: true,
    connect: {
      kind: 'oauth',
      prepareInputs: ['config_token'],
      async prepare(args) {
        beh.prepared.push(args);
        return { secrets: { client_secret: CS }, settings: { ...APP }, match: { ...APP } };
      },
      authorizeUrl: ({ state, config }) => `https://${hosts[0]}/oauth/v2/authorize?client_id=${encodeURIComponent(config.client_id)}&state=${encodeURIComponent(state)}`,
      async exchange({ config }) {
        return { external_id: beh.team ?? 'T1', display_name: 'Workspace', scopes: ['chat:write'], secrets: { bot_token: `bot${randomBytes(6).toString('hex')}` }, match: { app_id: config.app_id, client_id: config.client_id } };
      },
    },
    ...(identity ? {
      identity: {
        issuer: iss, jwksUrl, workspaceClaim: TEAM_CLAIM, subjectRe: /^[UW][A-Z0-9]{2,20}$/,
        authorizeUrl(args) {
          beh.authorized.push(args);
          const u = new URL(`https://${hosts[0]}/openid/connect/authorize`);
          for (const [k, v] of Object.entries({ response_type: 'code', scope: 'openid', client_id: args.connection.settings.pinned.client_id, state: args.state, nonce: args.nonce, redirect_uri: args.redirectUri })) u.searchParams.set(k, v);
          return beh.authorizeUrl ? beh.authorizeUrl(args) : u.href;
        },
        async exchange(args) {
          beh.idExchanged.push(args);
          if (beh.idExchange) return beh.idExchange(args);
          const st = JSON.parse(Buffer.from(args.state.split('.')[0], 'base64url').toString());
          const t = Math.floor(beh.now() / 1000);
          const claims = { iss, aud: args.connection.settings.pinned.client_id, sub: beh.sub, [TEAM_CLAIM]: args.connection.external_id, nonce: st.k, iat: t, exp: t + 300, ...beh.claims };
          for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
          return { id_token: signJwt(claims, beh.sign ?? {}) };
        },
      },
    } : {}),
    actions: { 'card.create': { default: 'auto' } },
    verify: () => ({ ok: true, dedupe_key: randomUUID() }),
    handleWebhook: async () => {},
  });
}

function providerFetch(beh) {
  return async (url, init = {}) => {
    const u = String(url);
    beh.requests.push(u);
    if (u === JWKS_URL || u === beh.jwksUrl2) {
      beh.jwksFetches += 1;
      if (beh.jwks) return beh.jwks(init);
      return new Response(JSON.stringify({ keys: [{ ...KEY.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256' }, ...(beh.extraKeys ?? [])] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
}

const ROOMY = { rateLimits: { integration_identity_member: { capacity: 1000, per_ms: 3_600_000 }, integration_link_fail_ip: { capacity: 1000, per_ms: 600_000 } } };

const addMember = (h, login, role, orgId = h.ids.org) => {
  const id = randomUUID();
  h.db.insert('members', { id, org_id: orgId, github_id: -Math.floor(Math.random() * 1e6) - 10, github_login: login, email: `${login}@dev.local`, display_name: login, role, created_at: h.hub.iso() });
  return id;
};

// A dev hub with the connector, alice's promoted connection (pinned app, team T1), and a member and a viewer.
async function setup({ config = ROOMY, log } = {}) {
  const beh = { prepared: [], authorized: [], idExchanged: [], requests: [], jwksFetches: 0, sub: userId(), claims: {} };
  const h = await startHub({ config, fetchImpl: providerFetch(beh), ...(log ? { log } : {}) });
  beh.now = () => h.hub.wallMs();
  h.hub.setVaultKey(randomBytes(32));
  const reg = h.app.integrations;
  reg.register(slkConnector(beh));
  const alice = await h.login('alice');
  const bob = await h.login('bob');
  const p = await h.api(alice, 'POST', '/api/integrations/slk/prepare', { request_id: randomUUID(), input: { config_token: `xoxe-${randomBytes(8).toString('hex')}` } });
  assert.equal(p.status, 200, p.text);
  const cb = await fetch(`${h.base}/integrations/slk/callback?${new URLSearchParams({ state: new URL(p.body.url).searchParams.get('state'), code: 'c' })}`, { headers: { cookie: p.headers.get('set-cookie').split(';')[0] } });
  assert.equal(cb.status, 200, await cb.text());
  const conn = p.body.pending.id;
  const carolId = addMember(h, 'carol', 'member');
  const violaId = addMember(h, 'viola', 'viewer');
  return { h, reg, beh, alice, bob, conn, carol: await h.login('carol'), carolId, viola: await h.login('viola'), violaId };
}

const start = (h, cookie, conn, body = {}) => h.api(cookie, 'POST', `/api/integrations/${conn}/identity/start`, { request_id: randomUUID(), ...body });
const stateOf = (r) => new URL(r.body.url).searchParams.get('state');
const bindOf = (r) => r.headers.get('set-cookie').split(';')[0];
const decode = (state) => JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString());
async function callback(h, state, cookie, { provider = 'slk', extra = {}, code = 'good-code' } = {}) {
  const res = await fetch(`${h.base}/integrations/${provider}/identity/callback?${new URLSearchParams({ state, code, ...extra })}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
// start + callback as one member → the callback page.
async function link(h, cookie, conn, { provider } = {}) {
  const r = await start(h, cookie, conn);
  assert.equal(r.status, 200, r.text);
  return callback(h, stateOf(r), bindOf(r), { provider });
}
const links = (h) => h.db.all('SELECT * FROM external_identities ORDER BY linked_at, rowid');
const journal = (h, kind) => h.db.all('SELECT * FROM journal WHERE kind = ? ORDER BY seq', kind).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
const forge = (h, st, domain = 'integration-identity') => {
  const p = b64(JSON.stringify(st));
  return `${p}.${createHmac('sha256', h.hub.secret).update(`${domain}|${p}`).digest('base64url')}`;
};

// ── the happy path ───────────────────────────────────────────────────────

test('link: start → {url, bind} + the D42 bind cookie; the callback verifies the id_token and writes the link (connection_id, oauth_link); journal and audit hold no subject', async () => {
  const { h, reg, beh, bob, conn } = await setup();
  try {
    const r = await start(h, bob, conn);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.body).sort(), ['bind', 'url']);
    assert.equal(bindOf(r), `board_int_slk=${r.body.bind}`, 'the D42 bind cookie, same name');
    const url = new URL(r.body.url);
    assert.equal(url.origin, 'https://slk.example');
    assert.equal(url.searchParams.get('client_id'), APP.client_id, 'the pinned client id');
    const st = decode(stateOf(r));
    assert.equal(st.m, h.ids.bob);
    assert.equal(st.o, h.ids.org);
    assert.equal(st.c, conn);
    assert.equal(st.p, 'slk');
    assert.equal(st.b, sha(r.body.bind));
    assert.equal(st.s, null, 'no accounts credential in dev mode');
    const a = beh.authorized[0];
    assert.equal(a.nonce, st.k);
    assert.deepEqual(a.connection, { external_id: 'T1', settings: JSON.parse(h.db.get('SELECT settings FROM connections WHERE id = ?', conn).settings) });
    assert.equal(a.connection.settings.pinned.client_id, APP.client_id);
    assert.equal(a.config, undefined, 'never the admin-editable config');
    assert.equal(a.secrets.client_secret, CS);
    // The one identity redirect URI: what prepare got, what the hooks get, what the helper says.
    assert.equal(a.redirectUri, beh.prepared[0].identityRedirectUri);
    assert.equal(a.redirectUri, reg.identityRedirectUri(h.base, conn));
    assert.equal(a.redirectUri, `${h.base}/integrations/slk/identity/callback`);

    const out = await callback(h, stateOf(r), bindOf(r));
    assert.equal(out.status, 200, out.text);
    assert.match(out.text, /data-connect="ok"/);
    assert.match(out.headers.get('set-cookie') ?? '', /board_int_slk=;.*Max-Age=0/, 'the bind cookie is cleared');
    const x = beh.idExchanged[0];
    assert.equal(x.redirectUri, a.redirectUri);
    assert.equal(x.state, stateOf(r));
    assert.equal(x.query.get('code'), 'good-code');
    assert.deepEqual(x.connection, a.connection);
    assert.equal(x.config, undefined);
    const [l] = links(h);
    assert.deepEqual({ ...l, linked_at: undefined }, { provider: 'slk', workspace_id: 'T1', subject: beh.sub, member_id: h.ids.bob, connection_id: conn, verified_via: 'oauth_link', linked_at: undefined });
    assert.deepEqual(journal(h, 'integration.identity_link').map((j) => j.payload), [{ connection_id: conn, provider: 'slk', member_id: h.ids.bob }]);
    const audit = reg.audit(conn).find((e) => e.action === 'identity.link');
    assert.equal(audit.decision, 'auto');
    const all = JSON.stringify([h.db.all('SELECT * FROM journal'), h.db.all('SELECT * FROM integration_audit')]);
    assert.ok(!all.includes(beh.sub), 'the subject is in no journal or audit row');
    // Reads.
    const list = await h.api(bob, 'GET', '/api/integrations');
    assert.equal(list.body.available.find((c) => c.id === 'slk').identity, true);
    assert.equal(list.body.connections.find((c) => c.id === conn).linked, true);
    assert.equal((await h.api(await h.login('alice'), 'GET', '/api/integrations')).body.connections.find((c) => c.id === conn).linked, false);
    const mine = await h.api(bob, 'GET', `/api/integrations/${conn}/identity`);
    assert.equal(mine.body.linked, true);
    assert.equal(mine.body.linked_at, l.linked_at);
    assert.ok(!mine.text.includes(beh.sub));
    const ctx = reg.ctxFor(conn);
    assert.equal(ctx.memberFor(beh.sub), h.ids.bob);
    assert.equal(ctx.subjectFor(h.ids.bob), beh.sub);
    // Single use.
    assert.match((await callback(h, stateOf(r), bindOf(r))).text, /already used/);
  } finally { await h.close(); }
});

// ── state, bind and CSRF ─────────────────────────────────────────────────

test('domain separation: a connect state never verifies at the identity callback, nor an identity state at the connect callback', async () => {
  const { h, beh, alice, bob, conn } = await setup();
  try {
    const c = await h.api(alice, 'POST', '/api/integrations/slk/start', { request_id: randomUUID() });
    assert.equal(c.status, 200, c.text);
    const connectState = new URL(c.body.url).searchParams.get('state');
    const asId = await callback(h, connectState, bindOf(c));
    assert.equal(asId.status, 400);
    assert.match(asId.text, /not valid/);
    const r = await start(h, bob, conn);
    const res = await fetch(`${h.base}/integrations/slk/callback?${new URLSearchParams({ state: stateOf(r), code: 'c' })}`, { headers: { cookie: bindOf(r) } });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /not valid/);
    // The same payload signed under the connect domain is not an identity state.
    const st = decode(stateOf(r));
    assert.match((await callback(h, forge(h, st, 'integration-state'), bindOf(r))).text, /not valid/);
    assert.equal(beh.idExchanged.length, 0);
    assert.equal(links(h).length, 0);
    // Both still work for their own callback.
    assert.equal((await callback(h, stateOf(r), bindOf(r))).status, 200);
  } finally { await h.close(); }
});

test('bind: no cookie or another browser\'s cookie is refused without spending the state (login-CSRF, a stolen URL); a tampered or expired state is refused', async () => {
  const { h, beh, bob, carol, carolId, conn } = await setup();
  try {
    const r = await start(h, bob, conn);
    const none = await callback(h, stateOf(r), null);
    assert.equal(none.status, 400);
    assert.match(none.text, /Open this link in the window/);
    // Carol's own bind cookie with bob's state (her browser, his URL), and the reverse.
    const c = await start(h, carol, conn);
    assert.match((await callback(h, stateOf(r), bindOf(c))).text, /Open this link in the window/);
    assert.match((await callback(h, stateOf(c), bindOf(r))).text, /Open this link in the window/);
    assert.equal(beh.idExchanged.length, 0);
    // Tampered: another member in a payload signed for bob.
    const [payload, sig] = stateOf(r).split('.');
    const moved = b64(JSON.stringify({ ...decode(stateOf(r)), m: carolId }));
    assert.match((await callback(h, `${moved}.${sig}`, bindOf(r))).text, /not valid/);
    assert.match((await callback(h, `${payload}.${sig}x`, bindOf(r))).text, /not valid/);
    // The refusals spent nothing: bob's state still works once.
    assert.equal((await callback(h, stateOf(r), bindOf(r))).status, 200);
    // Expired after 10 minutes.
    const e = await start(h, carol, conn);
    h.clock.advance(10 * 60_000 + 1);
    assert.match((await callback(h, stateOf(e), bindOf(e))).text, /expired/);
    assert.equal(links(h).length, 1);
  } finally { await h.close(); }
});

test('a state for another provider\'s callback path, or naming a connection that is not active, is refused', async () => {
  const { h, reg, beh, bob, conn } = await setup();
  try {
    reg.register(slkConnector(beh, { id: 'slk2' }));
    const r = await start(h, bob, conn);
    assert.match((await callback(h, stateOf(r), `board_int_slk2=${r.body.bind}`, { provider: 'slk2' })).text, /expired|not valid/);
    reg.revokeConnection(conn, h.ids.alice);
    assert.match((await callback(h, stateOf(r), bindOf(r))).text, /can no longer be used/);
    assert.equal(links(h).length, 0);
  } finally { await h.close(); }
});

test('the member removed or demoted to viewer between start and callback is refused, and nothing is written', async () => {
  const { h, beh, alice, bob, carol, carolId, conn } = await setup();
  try {
    const r = await start(h, bob, conn);
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.bob);
    assert.match((await callback(h, stateOf(r), bindOf(r))).text, /can no longer be used/);
    const c = await start(h, carol, conn);
    assert.equal((await h.api(alice, 'DELETE', `/api/members/${carolId}`, { request_id: randomUUID() })).status, 200);
    assert.match((await callback(h, stateOf(c), bindOf(c))).text, /can no longer be used/);
    assert.equal(beh.idExchanged.length, 0, 'the provider is never called for them');
    assert.equal(links(h).length, 0);
  } finally { await h.close(); }
});

// ── the id_token (the registry verifies it) ──────────────────────────────

test('id_token: alg none, HS256 under the client secret, unknown kid, bad signature, wrong iss/aud/azp, expired, future iat, nonce, team and subject are each refused with nothing written', async () => {
  const { h, beh, bob, conn } = await setup();
  try {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const t = () => Math.floor(h.hub.wallMs() / 1000);
    const cases = [
      ['alg none', {}, { alg: 'none', sig: '' }],
      ['HS256 signed with the client secret', {}, { alg: 'HS256', hmacKey: CS }],
      ['unknown kid', {}, { kid: 'nope' }],
      ['bad signature', {}, { privateKey: other.privateKey }],
      ['wrong iss', { iss: 'https://evil.example' }],
      ['another client id', { aud: 'someone-else' }],
      ['several aud, other azp', { aud: [APP.client_id, 'x'], azp: 'x' }],
      ['several aud, no azp', { aud: [APP.client_id, 'x'] }],
      ['expired', { exp: t() - 61, iat: t() - 400 }],
      ['iat in the future', { iat: t() + 120, exp: t() + 600 }],
      ['nonce mismatch', { nonce: 'n'.repeat(22) }],
      ['no nonce', { nonce: undefined }],
      ['another workspace', { [TEAM_CLAIM]: 'T999' }],
      ['no workspace claim', { [TEAM_CLAIM]: undefined }],
      ['subject fails subjectRe', { sub: 'x-not-a-user' }],
      ['subject not a string', { sub: 12345 }],
    ];
    for (const [name, claims, sign] of cases) {
      beh.claims = claims;
      beh.sign = sign;
      const out = await link(h, bob, conn);
      assert.equal(out.status, 400, `${name}: ${out.text}`);
      assert.match(out.text, /data-connect="error"/, name);
      assert.equal(links(h).length, 0, name);
    }
    assert.match((beh.claims = { [TEAM_CLAIM]: 'T999' }, await link(h, bob, conn)).text, /another workspace/);
    beh.claims = {};
    beh.sign = {};
    // A connector that throws, or answers anything but a string id_token.
    for (const bad of [() => { throw new Error(`boom ${CS}`); }, () => ({}), () => ({ id_token: 42 }), () => ({ id_token: 'x'.repeat(17 * 1024) })]) {
      beh.idExchange = bad;
      const out = await link(h, bob, conn);
      assert.equal(out.status, 400);
      assert.ok(!out.text.includes(CS), 'never the connector\'s error text');
    }
    beh.idExchange = null;
    // Within the 60 s skew is fine.
    beh.claims = { exp: t() - 30 };
    assert.equal((await link(h, bob, conn)).status, 200);
    assert.equal(links(h).length, 1);
    assert.equal(journal(h, 'integration.identity_link').length, 1);
  } finally { await h.close(); }
});

test('OIDC mix-up: a token signed by another provider\'s key (its own issuer), or minted for another connection\'s client and team, is refused', async () => {
  const { h, reg, beh, bob, conn } = await setup();
  try {
    const k2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // Another provider's key is not in this connector's JWKS.
    beh.claims = { iss: 'https://other.example' };
    beh.sign = { kid: 'other-kid', privateKey: k2.privateKey };
    assert.equal((await link(h, bob, conn)).status, 400);
    // Even with this issuer, a key from elsewhere does not verify.
    beh.claims = {};
    assert.equal((await link(h, bob, conn)).status, 400);
    // A genuine token of this provider, for another connection (its client id and team).
    beh.sign = {};
    beh.claims = { aud: 'another.client', [TEAM_CLAIM]: 'T2' };
    assert.equal((await link(h, bob, conn)).status, 400);
    assert.equal(links(h).length, 0);
    assert.equal(reg.ctxFor(conn).memberFor(beh.sub), null);
  } finally { await h.close(); }
});

test('JWKS: fetched through the restricted fetch; a flood of random-kid tokens costs one refetch a minute; an oversized or slow JWKS is refused', async () => {
  const { h, beh, bob, conn } = await setup();
  try {
    assert.equal((await link(h, bob, conn)).status, 200);
    assert.equal(beh.jwksFetches, 1);
    h.db.run('DELETE FROM external_identities');
    for (let i = 0; i < 8; i += 1) {
      beh.sign = { kid: randomBytes(6).toString('hex') };
      assert.equal((await link(h, bob, conn)).status, 400);
    }
    assert.equal(beh.jwksFetches, 1, 'within a minute of the last fetch no unknown kid refetches');
    h.clock.advance(60_000);
    await link(h, bob, conn);
    await link(h, bob, conn);
    assert.equal(beh.jwksFetches, 2, 'a minute later: one refetch, then none again');
    // Over 64 KiB: refused (a new hub so the cache is cold).
  } finally { await h.close(); }
  const big = await setup();
  try {
    big.beh.jwks = () => new Response(JSON.stringify({ keys: [], pad: 'x'.repeat(70 * 1024) }), { status: 200 });
    assert.equal((await link(big.h, big.bob, big.conn)).status, 400);
    assert.equal(links(big.h).length, 0);
  } finally { await big.h.close(); }
  const slow = await setup();
  try {
    slow.beh.jwks = (init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
    const t0 = Date.now();
    assert.equal((await link(slow.h, slow.bob, slow.conn)).status, 400);
    const took = Date.now() - t0;
    assert.ok(took >= 4_500 && took < 9_000, `gave up after ${took} ms (≈ 5 s)`);
  } finally { await slow.h.close(); }
});

test('sentinel: the id_token, the client secret and the authorization code never reach a response, a log line, the DB or a returned/thrown error, on success and on every failure', async () => {
  const lines = [];
  const { h, reg, beh, bob, conn } = await setup({ log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) });
  const CODE = `code-${randomBytes(12).toString('hex')}`;
  const tokens = [];
  const texts = [];
  const errors = [];
  const keep = (args) => {
    const t = Math.floor(beh.now() / 1000);
    const st = JSON.parse(Buffer.from(args.state.split('.')[0], 'base64url').toString());
    const id_token = signJwt({ iss: ISS, aud: APP.client_id, sub: beh.sub, [TEAM_CLAIM]: 'T1', nonce: st.k, iat: t, exp: t + 300, ...beh.claims }, beh.sign ?? {});
    tokens.push(id_token);
    return id_token;
  };
  try {
    const run = async (label) => {
      const r = await start(h, bob, conn);
      const out = await callback(h, stateOf(r), bindOf(r), { code: CODE });
      texts.push(out.text, JSON.stringify([...out.headers]));
      return out;
    };
    // 1. Success.
    beh.idExchange = (args) => ({ id_token: keep(args) });
    assert.equal((await run('ok')).status, 200);
    h.db.run('DELETE FROM external_identities');
    // 2. A token that fails verification (wrong aud).
    beh.claims = { aud: 'other' };
    assert.equal((await run('bad aud')).status, 400);
    beh.claims = {};
    // 3. The connector throws an error naming everything, with a cause carrying the request.
    beh.idExchange = (args) => {
      const id_token = keep(args);
      throw Object.assign(new Error(`token endpoint refused ${CODE} ${args.secrets.client_secret} ${id_token}`), { cause: { body: `client_secret=${args.secrets.client_secret}&code=${CODE}`, id_token } });
    };
    assert.equal((await run('throws')).status, 400);
    // 4. A JWKS that fails, and a token whose kid is unknown.
    beh.idExchange = (args) => ({ id_token: keep(args) });
    beh.sign = { kid: 'unknown' };
    assert.equal((await run('unknown kid')).status, 400);
    beh.sign = {};
    // 5. Directly: what identityCallback returns or throws.
    const r = await start(h, bob, conn);
    beh.idExchange = (args) => { keep(args); throw new Error(`${CODE} ${CS}`); };
    try {
      const v = await reg.identityCallback({ provider: 'slk', query: new URLSearchParams({ state: stateOf(r), code: CODE }), publicUrl: h.base, bindCookie: r.body.bind, ip: '127.0.0.1' });
      errors.push(v);
    } catch (e) { errors.push(e); }
    const secrets = [CS, CODE, ...tokens, ...tokens.map((t) => t.split('.')[2])];
    const haystacks = [
      ...texts, ...lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))), dumpDb(h.db),
      ...errors.flatMap((e) => [String(e), JSON.stringify(e), JSON.stringify(structuredClone(e)), e?.stack ?? '']),
    ];
    for (const s of secrets) for (const hay of haystacks) assert.ok(!String(hay).includes(s), `leaked into: ${String(hay).slice(0, 160)}`);
    assert.ok(tokens.length >= 4, 'tokens were minted');
  } finally { await h.close(); }
});

// ── who may link, and the routes ─────────────────────────────────────────

test('start: a viewer is FORBIDDEN; another team\'s, a revoked or a pending id is NOT_FOUND; a connector without identity is POLICY_DENIED; 11 starts in an hour are RATE_LIMITED', async () => {
  const { h, reg, beh, alice, bob, viola, conn } = await setup({ config: {} });
  try {
    const v = await start(h, viola, conn);
    assert.equal(v.status, 403);
    assert.equal(v.body.error.message, 'viewers cannot link an account');
    // Another org's member.
    const org = randomUUID();
    h.db.insert('orgs', { id: org, name: 'other', created_at: h.hub.iso() });
    addMember(h, 'dave', 'owner', org);
    assert.equal((await start(h, await h.login('dave'), conn)).status, 404);
    assert.equal((await start(h, bob, randomUUID())).status, 404);
    // A connector without identity.
    reg.register(slkConnector(beh, { id: 'plain', identity: false }));
    const plain = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'plain', external_id: 'P1', secrets: {}, settings: { pinned: { client_id: 'x' } } });
    assert.equal((await start(h, bob, plain.id)).body.error.code, 'POLICY_DENIED');
    // A pending id.
    const pend = await h.api(alice, 'POST', '/api/integrations/plain/prepare', { request_id: randomUUID(), input: {} });
    if (pend.status === 200) assert.equal((await start(h, bob, pend.body.pending.id)).status, 404);
    for (let i = 0; i < 10; i += 1) assert.equal((await start(h, bob, conn)).status, 200, `start ${i}`);
    const over = await start(h, bob, conn);
    assert.equal(over.status, 429);
    assert.equal(over.body.error.code, 'RATE_LIMITED');
    reg.revokeConnection(conn, h.ids.alice);
    assert.equal((await start(h, await h.login('carol'), conn)).status, 404);
  } finally { await h.close(); }
});

test('a connection without a pinned client id cannot link (POLICY_DENIED): the audience never comes from admin-editable config', async () => {
  const { h, reg, beh, bob } = await setup();
  try {
    reg.register(slkConnector(beh, { id: 'nopin' }));
    const c = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'nopin', external_id: 'N1', secrets: {}, settings: { config: { client_id: APP.client_id } } });
    const r = await start(h, bob, c.id);
    assert.equal(r.status, 403, r.text);
    assert.equal(r.body.error.code, 'POLICY_DENIED');
  } finally { await h.close(); }
});

test('the member comes only from the signed state and the subject only from the verified token: body and query member_id, subject and email are ignored; there is no route that links someone else', async () => {
  const { h, beh, bob, conn, carolId } = await setup();
  try {
    const r = await start(h, bob, conn, { member_id: carolId, subject: 'UEVIL1', email: 'carol@dev.local' });
    assert.equal(decode(stateOf(r)).m, h.ids.bob);
    const out = await callback(h, stateOf(r), bindOf(r), { extra: { member_id: carolId, subject: 'UEVIL1', email: 'carol@dev.local', sub: 'UEVIL1' } });
    assert.equal(out.status, 200, out.text);
    assert.deepEqual(links(h).map((l) => [l.member_id, l.subject]), [[h.ids.bob, beh.sub]]);
    const routes = h.app.routes.filter((x) => /identit/.test(x.pattern)).map((x) => `${x.method} ${x.pattern}`).sort();
    assert.deepEqual(routes, [
      'DELETE /api/integrations/:id/identities/:member_id', 'DELETE /api/integrations/:id/identity',
      'GET /api/integrations/:id/identities', 'GET /api/integrations/:id/identity', 'POST /api/integrations/:id/identity/start',
    ]);
  } finally { await h.close(); }
});

test('one account per (workspace, member) and per (workspace, subject): a second link for either is a clean CONFLICT that writes nothing; the same link again is a no-op', async () => {
  const { h, beh, bob, carol, conn } = await setup();
  try {
    const u1 = beh.sub;
    assert.equal((await link(h, carol, conn)).status, 200);
    const before = JSON.stringify(links(h));
    const taken = await link(h, bob, conn);
    assert.equal(taken.status, 400);
    assert.match(taken.text, /already linked to another member/);
    assert.equal(JSON.stringify(links(h)), before);
    beh.sub = userId();
    const twice = await link(h, carol, conn);
    assert.match(twice.text, /You already linked another account/);
    assert.equal(JSON.stringify(links(h)), before);
    beh.sub = u1;
    assert.equal((await link(h, carol, conn)).status, 200, 'the same link again');
    assert.equal(JSON.stringify(links(h)), before, 'nothing rewritten');
    assert.equal(journal(h, 'integration.identity_link').length, 1);
  } finally { await h.close(); }
});

test('unlink (self, any role) and revoke (admin): idempotent, journaled without the subject; a member cannot revoke; another team\'s member is NOT_FOUND; the admin list holds no subject', async () => {
  const { h, beh, alice, bob, carol, carolId, conn } = await setup();
  try {
    await link(h, bob, conn);
    beh.sub = userId();
    await link(h, carol, conn);
    const list = await h.api(alice, 'GET', `/api/integrations/${conn}/identities`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.identities.map((i) => i.member_id).sort(), [h.ids.bob, carolId].sort());
    assert.ok(list.body.identities.every((i) => Object.keys(i).sort().join() === 'display_name,linked_at,member_id'));
    assert.ok(!list.text.includes(beh.sub));
    assert.equal((await h.api(bob, 'GET', `/api/integrations/${conn}/identities`)).status, 403);
    assert.equal((await h.api(bob, 'DELETE', `/api/integrations/${conn}/identities/${carolId}`, { request_id: randomUUID() })).status, 403);
    // Bob, demoted to viewer, can still unlink himself.
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.bob);
    const u = await h.api(bob, 'DELETE', `/api/integrations/${conn}/identity`, { request_id: randomUUID() });
    assert.deepEqual(u.body, { ok: true, removed: true });
    assert.deepEqual((await h.api(bob, 'DELETE', `/api/integrations/${conn}/identity`, { request_id: randomUUID() })).body, { ok: true, removed: false });
    const rv = await h.api(alice, 'DELETE', `/api/integrations/${conn}/identities/${carolId}`, { request_id: randomUUID() });
    assert.deepEqual(rv.body, { ok: true, removed: true });
    assert.deepEqual((await h.api(alice, 'DELETE', `/api/integrations/${conn}/identities/${carolId}`, { request_id: randomUUID() })).body, { ok: true, removed: false });
    const org = randomUUID();
    h.db.insert('orgs', { id: org, name: 'other', created_at: h.hub.iso() });
    const dave = addMember(h, 'dave', 'member', org);
    assert.equal((await h.api(alice, 'DELETE', `/api/integrations/${conn}/identities/${dave}`, { request_id: randomUUID() })).status, 404);
    assert.equal((await h.api(alice, 'DELETE', `/api/integrations/${conn}/identities/${randomUUID()}`, { request_id: randomUUID() })).status, 404);
    assert.deepEqual(journal(h, 'integration.identity_unlink').map((j) => j.payload), [
      { connection_id: conn, provider: 'slk', member_id: h.ids.bob, by: 'self' },
      { connection_id: conn, provider: 'slk', member_id: carolId, by: 'admin' },
    ]);
    assert.equal(links(h).length, 0);
    assert.ok(!JSON.stringify(h.db.all('SELECT * FROM journal')).includes(beh.sub));
  } finally { await h.close(); }
});

test('member removal, connection revoke and team deletion delete the links', async () => {
  const { h, reg, beh, alice, bob, carol, carolId, conn } = await setup();
  try {
    await link(h, bob, conn);
    beh.sub = userId();
    await link(h, carol, conn);
    assert.equal((await h.api(alice, 'DELETE', `/api/members/${carolId}`, { request_id: randomUUID() })).status, 200);
    assert.deepEqual(links(h).map((l) => l.member_id), [h.ids.bob]);
    reg.revokeConnection(conn, h.ids.alice);
    assert.equal(links(h).length, 0);
    assert.equal(reg.ctxFor(conn).memberFor(beh.sub), null);
  } finally { await h.close(); }
  const t = await setup();
  try {
    await link(t.h, t.bob, t.conn);
    t.h.db.run('UPDATE orgs SET deleted_at = ? WHERE id = ?', t.h.hub.iso(), t.h.ids.org);
    t.h.hub.revokeDeletedTeamConnections(t.h.hub.iso());
    assert.equal(links(t.h).length, 0);
  } finally { await t.h.close(); }
});

test('rate limit: integration_link_fail_ip refuses the callback (429 page) once spent, even with a good state', async () => {
  const { h, bob, conn } = await setup({ config: { rateLimits: { integration_link_fail_ip: { capacity: 3, per_ms: 600_000 } } } });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await callback(h, 'garbage.state', null)).status, 400);
    const r = await start(h, bob, conn);
    const out = await callback(h, stateOf(r), bindOf(r));
    assert.equal(out.status, 429);
    assert.match(out.text, /Too many attempts/);
    assert.equal(links(h).length, 0);
  } finally { await h.close(); }
});

// ── ctx.memberFor / subjectFor and the act() subject binding ─────────────

test('memberFor: null for an unlinked subject, a viewer, a removed member and a link on another connection; subjectFor keeps a viewer\'s, not a removed or other-team member\'s', async () => {
  const { h, reg, beh, alice, bob, carol, carolId, conn } = await setup();
  try {
    const ctx = reg.ctxFor(conn);
    assert.equal(ctx.memberFor(userId()), null);
    assert.equal(ctx.memberFor(undefined), null);
    assert.equal(ctx.memberFor(42), null);
    const ub = beh.sub;
    await link(h, bob, conn);
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.bob);
    assert.equal(ctx.memberFor(ub), null, 'a viewer acts as nobody');
    assert.equal(ctx.subjectFor(h.ids.bob), ub, 'but can still be reached');
    h.db.run("UPDATE members SET role = 'member' WHERE id = ?", h.ids.bob);
    assert.equal(ctx.memberFor(ub), h.ids.bob);
    beh.sub = userId();
    const uc = beh.sub;
    await link(h, carol, conn);
    assert.equal((await h.api(alice, 'DELETE', `/api/members/${carolId}`, { request_id: randomUUID() })).status, 200);
    assert.equal(ctx.memberFor(uc), null);
    assert.equal(ctx.subjectFor(carolId), null);
    // Another org's connection of another workspace: its links are not this connection's.
    const org = randomUUID();
    h.db.insert('orgs', { id: org, name: 'other', created_at: h.hub.iso() });
    const dave = addMember(h, 'dave', 'owner', org);
    const c2 = reg.createConnection({ orgId: org, memberId: dave, provider: 'slk', external_id: 'T2', secrets: {}, settings: { pinned: { ...APP } } });
    const ud = userId();
    h.db.insert('external_identities', { provider: 'slk', workspace_id: 'T2', subject: ud, member_id: dave, connection_id: c2.id, verified_via: 'oauth_link', linked_at: h.hub.iso() });
    assert.equal(reg.ctxFor(c2.id).memberFor(ud), dave);
    assert.equal(ctx.memberFor(ud), null);
    assert.equal(ctx.subjectFor(dave), null);
  } finally { await h.close(); }
});

test('act(…, {subject}): actAs only memberFor(subject) — an unlinked user can\'t act as the admin who connected it, a viewer-linked user acts as nobody; audited failed/forbidden; no subject is unchanged', async () => {
  const { h, reg, beh, bob, conn } = await setup();
  try {
    const ctx = reg.ctxFor(conn);
    const make = (subject, as) => ctx.act('card.create', { subject }, (s) => s.actAs(as).createCard(h.ids.board, { request_id: randomUUID(), title: 'From chat' }));
    const stranger = userId();
    await assert.rejects(make(stranger, h.ids.alice), (e) => e.code === 'FORBIDDEN');
    assert.deepEqual([reg.audit(conn)[0].decision, reg.audit(conn)[0].error], ['failed', 'forbidden']);
    const ub = beh.sub;
    await link(h, bob, conn);
    await assert.rejects(make(ub, h.ids.alice), (e) => e.code === 'FORBIDDEN', 'a linked user never acts as someone else');
    assert.equal((await make(ub, h.ids.bob)).decision, 'auto');
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.bob);
    for (const as of [h.ids.bob, h.ids.alice]) await assert.rejects(make(ub, as), (e) => e.code === 'FORBIDDEN', 'a viewer-linked user can do nothing');
    h.db.run("UPDATE members SET role = 'member' WHERE id = ?", h.ids.bob);
    // A handle taken while linked stops working once the link goes.
    await assert.rejects(ctx.act('card.create', { subject: ub }, async (s) => {
      const as = s.actAs(h.ids.bob);
      h.db.run('DELETE FROM external_identities WHERE member_id = ?', h.ids.bob);
      await as.createCard(h.ids.board, { request_id: randomUUID(), title: 'late' });
    }), (e) => e.code === 'FORBIDDEN');
    // Without a subject (notifications, onEvent) created_by still acts.
    assert.equal((await make(undefined, h.ids.alice)).decision, 'auto');
  } finally { await h.close(); }
});

// ── accounts mode: the credential binding ────────────────────────────────

test('accounts: the state names the credential that started it; a callback carrying another user\'s, or another session of the same user, is refused; signed out in between is refused; a desktop start finishes in a cookie-less window', async () => {
  const beh = { prepared: [], authorized: [], idExchanged: [], requests: [], jwksFetches: 0, sub: userId(), claims: {} };
  const fx = await tenancy({ config: ROOMY, fetchImpl: providerFetch(beh) });
  const { h, A, users, as } = fx;
  try {
    beh.now = () => h.hub.wallMs();
    h.app.integrations.register(slkConnector(beh));
    // Integrations need a public URL in accounts mode: this hub's own.
    h.hub.config.publicUrl = h.base;
    const conn = h.app.integrations.createConnection({ orgId: A.team, memberId: A.owner, provider: 'slk', external_id: 'TA', secrets: { client_secret: CS }, settings: { pinned: { ...APP } } }).id;
    const startAs = (u, headers = {}) => as(u, 'POST', `/api/integrations/${conn}/identity/start`, { request_id: randomUUID() }, headers);
    const cb = (r, cookie) => callback(h, new URL(r.body.url).searchParams.get('state'), cookie);
    const bind = (r) => r.headers.get('set-cookie').split(';')[0];
    // Viewer: refused at start.
    assert.equal((await startAs(users.aviewer)).status, 403);
    // Desktop (Bearer) start, cookie-less window finish.
    const d = await startAs(users.amember);
    assert.equal(d.status, 200, d.text);
    const st = decode(new URL(d.body.url).searchParams.get('state'));
    assert.equal(st.s, sha(`device:${users.amember.device_id}`));
    // Another user's web session at the callback.
    const other = await h.webSignIn(users.aadmin.email);
    assert.match((await cb(d, `${bind(d)}; ${other.cookie}`)).text, /can no longer be used/);
    // A web session start: another session of the same user at the callback is refused.
    const w1 = await h.webSignIn(users.ua.email);
    const ws = await h.call('POST', `/api/integrations/${conn}/identity/start`, { cookie: w1.cookie, body: { request_id: randomUUID() }, headers: { origin: h.base, 'x-csrf-token': w1.csrf } });
    assert.equal(ws.status, 200, ws.text);
    const w2 = await h.webSignIn(users.ua.email);
    assert.match((await cb(ws, `${bind(ws)}; ${w2.cookie}`)).text, /can no longer be used/);
    // Signed out between start and callback.
    const ws2 = await h.call('POST', `/api/integrations/${conn}/identity/start`, { cookie: w1.cookie, body: { request_id: randomUUID() }, headers: { origin: h.base, 'x-csrf-token': w1.csrf } });
    h.db.run('DELETE FROM sessions WHERE user_id = ?', users.ua.id);
    assert.match((await cb(ws2, bind(ws2))).text, /can no longer be used/);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM external_identities').n, 0);
    // The desktop flow, finished in a window with no session, links.
    const d2 = await startAs(users.amember);
    const ok = await cb(d2, bind(d2));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(h.db.get('SELECT member_id FROM external_identities').member_id, A.member);
  } finally { await h.close(); }
});

// ── defineConnector ──────────────────────────────────────────────────────

test('defineConnector: identity needs workspaceUnique, an https issuer and jwksUrl on hosts, a string workspaceClaim, a non-global RegExp subjectRe and both hooks', () => {
  const beh = { prepared: [], authorized: [], idExchanged: [] };
  const good = slkConnector(beh);
  const spec = { ...good, identity: { ...good.identity } };
  const bad = (over, top = {}) => () => defineConnector({ ...spec, ...top, identity: { ...spec.identity, ...over } });
  assert.doesNotThrow(bad({}));
  assert.throws(bad({}, { workspaceUnique: false }), /workspaceUnique/);
  assert.throws(bad({}, { workspaceUnique: undefined }), /workspaceUnique/);
  for (const [k, v] of [
    ['issuer', 'https://elsewhere.example'], ['issuer', 'http://slk.example'], ['issuer', 42],
    ['jwksUrl', 'https://elsewhere.example/keys'], ['jwksUrl', 'http://slk.example/keys'], ['jwksUrl', 'https://slk.example:8443/keys'],
    ['workspaceClaim', ''], ['workspaceClaim', 7],
    ['subjectRe', '^U'], ['subjectRe', /^U/g], ['subjectRe', /^U/y],
    ['authorizeUrl', 'x'], ['exchange', undefined],
  ]) assert.throws(bad({ [k]: v }), /identity/, `${k}=${String(v)}`);
  assert.throws(() => defineConnector({ ...spec, identity: 'yes' }), /identity/);
});
