// Slack slice C (D42 addenda C1–C3): what the provider said at connect time
// lives in settings.provider, written once with the row; PATCH merges an
// admin's config and autonomy key by key and never reaches provider or
// pinned; ctx.hubUrl is the only base for a link to the hub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Api } from '../api.js';
import { createIntegrations } from '../integrations/registry.js';
import { defineConnector } from '../integrations/connector.js';
import { migrate, loadMigrations } from '../../shared/migrate.js';
import { startHub } from './helpers.js';
import { startAccounts } from './accounts-helpers.js';

// Secret-shaped values are built at runtime.
const CS = `csec${randomBytes(8).toString('hex')}`;
const SS = `ssec${randomBytes(8).toString('hex')}`;
const BOT = `bot${randomBytes(8).toString('hex')}`;
const APP = { app_id: 'A0SLICEC', client_id: '111.222' };
const ROOMY = { rateLimits: { integration_prepare_member: { capacity: 1000, per_ms: 3_600_000 }, integration_prepare_org: { capacity: 1000, per_ms: 86_400_000 } } };
const EVIL = 'https://evil-phish.example/login';

// Shaped like the Slack connector: a pending app (prepare → pinned match), an
// OAuth exchange that reports the workspace, identity hooks, and a handler
// that reads provider facts only from settings.provider / external_id and
// builds its one link from ctx.hubUrl.
function slackish(beh, id = 'slackish') {
  return defineConnector({
    id, name: 'Slackish', scopes: ['commands'], secrets: ['client_secret', 'signing_secret', 'bot_token'],
    hosts: ['api.slackish.example', 'slackish.example'], workspaceUnique: true,
    ...(beh.configKeys ? { configKeys: beh.configKeys } : {}),
    connect: {
      kind: 'oauth',
      prepareInputs: ['config_token'],
      async prepare(args) {
        beh.prepared.push(args);
        return { secrets: { client_secret: CS, signing_secret: SS }, settings: { ...APP, ...beh.prepareSettings }, match: { ...APP, ...beh.match } };
      },
      authorizeUrl: ({ state }) => `https://slackish.example/oauth/v2/authorize?state=${encodeURIComponent(state)}`,
      async exchange(args) {
        beh.exchanged.push(args);
        return {
          external_id: beh.team ?? 'T1', display_name: 'Workspace', scopes: ['commands'], secrets: { bot_token: BOT },
          settings: { team_id: beh.teamInSettings ?? beh.team ?? 'T1', bot_user_id: 'UB1', app_id: 'EXCHANGE-SAYS', hub_url: EVIL, ...beh.exchangeSettings },
          match: { app_id: args.config.app_id, client_id: args.config.client_id },
        };
      },
    },
    identity: {
      issuer: 'https://slackish.example', jwksUrl: 'https://slackish.example/openid/connect/keys', workspaceClaim: 'https://slackish.example/team_id', subjectRe: /^U[A-Z0-9]{2,20}$/,
      authorizeUrl(args) { beh.identity.push(args); return 'https://slackish.example/openid/connect/authorize?x=1'; },
      async exchange() { return { id_token: 'x' }; },
    },
    verify: ({ headers }) => (headers['x-ok'] === '1' ? { ok: true, dedupe_key: headers['x-id'] } : { ok: false, reason: 'nope' }),
    async handleWebhook({ payload, ctx }) {
      const provider = ctx.connection.settings.provider;
      // Fail closed: no provider facts (a connection made before 026), or a
      // workspace other than the connection's own.
      if (!provider || provider.team_id !== ctx.connection.external_id || payload.team_id !== ctx.connection.external_id) {
        beh.refused.push(provider ? 'wrong_workspace' : 'no_provider');
        return;
      }
      beh.replies.push({ text: 'Created', link: ctx.hubUrl ? `${ctx.hubUrl}/boards/${encodeURIComponent(ctx.boardIds()[0])}` : null });
    },
    actions: { 'card.create': { default: 'auto' }, 'card.note': { default: 'ask' } },
  });
}

const newBeh = (over = {}) => ({ prepared: [], exchanged: [], identity: [], refused: [], replies: [], ...over });

async function setup({ beh = newBeh(), hubConfig = {} } = {}) {
  const h = await startHub({ config: { ...ROOMY, ...hubConfig } });
  h.hub.setVaultKey(randomBytes(32));
  const reg = h.app.integrations;
  reg.register(slackish(beh));
  const alice = await h.login('alice');
  return { h, reg, beh, alice };
}

// A second registry on the same hub, as app.js would build it with BOARD_PUBLIC_URL.
function registryWith(h, publicUrl, beh) {
  const reg = createIntegrations({ hub: h.hub, api: new Api(h.hub), log: null, publicUrl });
  if (beh) reg.register(slackish(beh));
  return reg;
}

// prepare → authorize → callback, straight through the registry.
async function promote(h, reg, publicUrl = 'http://127.0.0.1') {
  const member = h.hub.member(h.ids.alice);
  const out = await reg.pendingCreate({ member, provider: 'slackish', input: { config_token: `cfg${randomBytes(6).toString('hex')}` }, publicUrl });
  const state = new URL(out.url).searchParams.get('state');
  const r = await reg.oauthCallback({ provider: 'slackish', query: new URLSearchParams({ state, code: 'good' }), publicUrl, bindCookie: out.bind });
  assert.equal(r.ok, true, r.error);
  return r.connection;
}

const stored = (h, id) => JSON.parse(h.db.get('SELECT settings FROM connections WHERE id = ?', id).settings);
const patch = (h, cookie, id, body) => h.api(cookie, 'PATCH', `/api/integrations/${id}`, { request_id: randomUUID(), ...body });
const patchRaw = async (h, cookie, id, json) => {
  const res = await fetch(`${h.base}/api/integrations/${id}`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: json });
  return { status: res.status, body: await res.json() };
};
const journal = (h, kind) => h.db.all('SELECT * FROM journal WHERE kind = ? ORDER BY seq', kind).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
const hookIn = (reg, conn, payload, id = randomUUID()) => reg.webhook(conn.id, { headers: { 'x-ok': '1', 'x-id': id }, rawBody: Buffer.from(JSON.stringify(payload)) });
const withProvider = (h, reg, provider, config = {}, external_id = 'T1') => reg.createConnection({
  orgId: h.ids.org, memberId: h.ids.alice, provider: 'slackish', external_id, settings: { provider, config },
});

// ── C1: settings.provider ─────────────────────────────────────────────────

test('C1 promotion: provider = exchange ⊕ pending settings ⊕ every pinned key ⊕ the registry\'s hub_url (a connector hub_url is dropped); no config; one transaction', async () => {
  const { h } = await setup();
  try {
    const beh = newBeh({ match: { team_hint: 'T1' }, exchangeSettings: { extra: 7 } });
    const reg = registryWith(h, 'https://plex.example/', beh);
    const c = await promote(h, reg, 'https://plex.example');
    const s = stored(h, c.id);
    assert.deepEqual(s.pinned, { ...APP, team_hint: 'T1' });
    assert.deepEqual(s.provider, { team_id: 'T1', bot_user_id: 'UB1', app_id: APP.app_id, extra: 7, client_id: APP.client_id, team_hint: 'T1', hub_url: 'https://plex.example' });
    for (const [k, v] of Object.entries(s.pinned)) assert.equal(s.provider[k], v, `pinned ${k} is in provider`);
    assert.equal(s.config, undefined, 'exchange values never land in config');
    assert.equal(reg.ctxFor(c.id).connection.settings.provider.hub_url, 'https://plex.example');
    // No hub URL: no hub_url key at all, never the connector's.
    const beh2 = newBeh();
    const h2 = await setup({ beh: beh2 });
    try {
      const c2 = await promote(h2.h, h2.reg);
      assert.equal(stored(h2.h, c2.id).provider.hub_url, undefined);
      assert.equal(JSON.stringify(stored(h2.h, c2.id)).includes('evil-phish'), false);
    } finally { await h2.h.close(); }
  } finally { await h.close(); }
});

test('C1 promotion: a prepare that pins hub_url as a match key is refused (provider would not hold every pinned key)', async () => {
  const { h, reg } = await setup({ beh: newBeh({ match: { hub_url: 'x' } }) });
  try {
    const member = h.hub.member(h.ids.alice);
    await assert.rejects(reg.pendingCreate({ member, provider: 'slackish', input: { config_token: 'cfg1' }, publicUrl: 'http://127.0.0.1' }), (e) => e.code === 'VALIDATION');
  } finally { await h.close(); }
});

test('C1 trigger: settings.provider never changes after the insert: not changed, removed, nulled, nor added to a row without one; an id is never re-inserted (no INSERT OR REPLACE)', async () => {
  const { h, reg } = await setup();
  try {
    const c = withProvider(h, reg, { team_id: 'T1', app_id: 'A1' });
    const set = (json, id = c.id) => h.db.run('UPDATE connections SET settings = ? WHERE id = ?', json, id);
    assert.throws(() => h.db.run("UPDATE connections SET settings = json_set(settings, '$.provider.app_id', 'X') WHERE id = ?", c.id), /settings.provider never changes/);
    assert.throws(() => set(JSON.stringify({ config: {} })), /settings.provider never changes/);
    assert.throws(() => set(JSON.stringify({ provider: null })), /settings.provider never changes/);
    assert.throws(() => set(JSON.stringify({ provider: { app_id: 'A1', team_id: 'T1' } })), /settings.provider never changes/, 'reordered is a change');
    set(JSON.stringify({ provider: { team_id: 'T1', app_id: 'A1' }, config: { x: 1 } }));
    const legacy = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'slackish', external_id: 'T2', settings: { config: { team_id: 'T2' } } });
    assert.throws(() => set(JSON.stringify({ config: {}, provider: { team_id: 'T2' } }), legacy.id), /settings.provider never changes/, 'a legacy row never gains provider');
    assert.throws(() => set(JSON.stringify({ config: {}, provider: null }), legacy.id), /settings.provider never changes/, 'not even as JSON null');
    set(JSON.stringify({ config: { team_id: 'T2', x: 1 } }), legacy.id);
    const row = h.db.get('SELECT * FROM connections WHERE id = ?', c.id);
    assert.throws(() => h.db.run('INSERT OR REPLACE INTO connections (id, org_id, provider, external_id, status, settings, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.org_id, row.provider, row.external_id, row.status, JSON.stringify({ provider: { team_id: 'T9' } }), row.created_by, row.created_at), /never reused/);
    assert.deepEqual(stored(h, c.id).provider, { team_id: 'T1', app_id: 'A1' });
  } finally { await h.close(); }
});

test('C1 createConnection takes settings autonomy, config, provider and pinned only, each an object; a provider over 2 KB is refused', async () => {
  const { h, reg } = await setup();
  try {
    const mk = (settings, ext = `T${randomBytes(3).toString('hex')}`) => () => reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'slackish', external_id: ext, settings });
    for (const bad of [{ team_id: 'T1' }, { Provider: {} }, { provider: 'x' }, { config: [] }, { pinned: 1 }, { hub_url: EVIL }]) {
      assert.throws(mk(bad), (e) => e.code === 'VALIDATION', JSON.stringify(bad));
    }
    assert.throws(mk({ provider: { blob: 'x'.repeat(3000) } }), (e) => e.code === 'VALIDATION');
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM connections WHERE provider = 'slackish'").n, 0, 'nothing written');
    const ok = mk({ provider: { team_id: 'T5', hub_url: EVIL, nested: { a: 1 } } }, 'T5')();
    assert.deepEqual(stored(h, ok.id).provider, { team_id: 'T5' }, 'scalars only; a caller-supplied hub_url is dropped');
  } finally { await h.close(); }
});

test('C1 token connect: verifyToken\'s settings land in provider only; it can\'t set autonomy, config or pinned', async () => {
  const { h, reg, alice } = await setup();
  try {
    reg.register(defineConnector({
      id: 'tok', name: 'Tok', scopes: [], secrets: ['api_token'], hosts: ['api.tok.example'],
      connect: { kind: 'token', verifyToken: async ({ token }) => ({ external_id: 'W1', display_name: 'W', scopes: [], secrets: { api_token: token }, settings: { team_id: 'W1', autonomy: { 'card.create': 'off' }, pinned: { a: 1 }, hub_url: EVIL } }) },
      actions: { 'card.create': { default: 'auto' } },
    }));
    const r = await h.api(alice, 'POST', '/api/integrations/tok/token', { request_id: randomUUID(), token: `tok${randomBytes(6).toString('hex')}` });
    assert.equal(r.status, 200, r.text);
    const s = stored(h, r.body.connection.id);
    assert.deepEqual(s, { provider: { team_id: 'W1' } });
    assert.equal(reg.ctxFor(r.body.connection.id).autonomyOf('card.create'), 'auto');
  } finally { await h.close(); }
});

test('C1 configFor (the reconnect hint) is {...config, ...provider}: provider values win; a legacy row without provider falls back to its config', async () => {
  const { h, reg, beh } = await setup();
  try {
    const member = h.hub.member(h.ids.alice);
    const legacy = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'slackish', external_id: 'T7', settings: { config: { app_id: 'LEGACY', org: 'acme' } } });
    await reg.pendingCreate({ member, provider: 'slackish', input: { config_token: 'c1' }, publicUrl: 'http://127.0.0.1' });
    assert.equal(beh.prepared.at(-1).config.app_id, 'LEGACY');
    reg.revokeConnection(legacy.id, h.ids.alice);
    h.db.run('DELETE FROM integration_pending');
    withProvider(h, reg, { app_id: 'PROVIDER' }, { app_id: 'ADMIN', org: 'acme' }, 'T8');
    await reg.pendingCreate({ member, provider: 'slackish', input: { config_token: 'c2' }, publicUrl: 'http://127.0.0.1' });
    assert.equal(beh.prepared.at(-1).config.app_id, 'PROVIDER');
    assert.equal(beh.prepared.at(-1).config.org, 'acme');
  } finally { await h.close(); }
});

// ── C1: PATCH merge ───────────────────────────────────────────────────────

test('C1 PATCH config merges key by key: provider and every other config key stay', async () => {
  const { h, reg, alice } = await setup();
  try {
    const c = withProvider(h, reg, { team_id: 'T1', app_id: 'A1' }, { default_board_id: 'b1', channel: 'C1' });
    const r = await patch(h, alice, c.id, { config: { default_board_id: 'b2' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(stored(h, c.id), { provider: { team_id: 'T1', app_id: 'A1' }, config: { default_board_id: 'b2', channel: 'C1' } });
    assert.deepEqual(r.body.connection.settings.provider, { team_id: 'T1', app_id: 'A1' }, 'admins see provider');
    const bob = await h.login('bob');
    const asMember = (await h.api(bob, 'GET', '/api/integrations')).body.connections.find((x) => x.id === c.id);
    assert.deepEqual(asMember.settings, { autonomy: {} }, 'members never see config or provider');
  } finally { await h.close(); }
});

test('C1 PATCH: a config key provider holds is refused in any letter case, and nothing is written', async () => {
  const { h, reg, alice } = await setup();
  try {
    const c = withProvider(h, reg, { team_id: 'T1', app_id: 'A1', hub_url: 'https://plex.example' }, { channel: 'C1' });
    const before = h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings;
    for (const config of [{ team_id: 'T0OTHER' }, { TEAM_ID: 'T0OTHER' }, { App_Id: 'A9' }, { hub_url: EVIL }, { team_id: null }, { channel: 'C2', team_id: 'T0OTHER' }]) {
      const r = await patch(h, alice, c.id, { config });
      assert.equal(r.status, 400, JSON.stringify(config));
      assert.equal(r.body.error.code, 'VALIDATION');
      assert.match(r.body.error.message, /comes from Slackish and can't be changed here/);
    }
    assert.equal(h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings, before);
    assert.equal(journal(h, 'integration.settings').length, 0);
  } finally { await h.close(); }
});

test('C1 setSettings takes autonomy and config only: provider, pinned and every other spelling or path is VALIDATION', async () => {
  const { h, reg, alice } = await setup();
  try {
    const c = withProvider(h, reg, { team_id: 'T1' });
    const before = h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings;
    for (const p of [{ provider: { team_id: 'T2' } }, { pinned: { app_id: 'X' } }, { Provider: {} }, { PINNED: {} }, { 'settings.provider': {} }, { '$.provider': {} },
      { config: { provider: { team_id: 'T2' } } }, { config: { Pinned: 1 } }, { config: { 'provider.team_id': 'T2' } }, { config: { autonomy: {} } }, { autonomy: { provider: 'auto' } }]) {
      assert.throws(() => reg.setSettings(c.id, p), (e) => e.code === 'VALIDATION', JSON.stringify(p));
    }
    for (const json of ['{"config":{"__proto__":{"team_id":"T2"}}}', '{"config":{"constructor":1}}', '{"config":{"prototype":1}}', '{"autonomy":{"__proto__":"auto"}}',
      '{"config":{"a":{"b":{"__proto__":{"x":1}}}}}', '{"config":{"bad key":1}}', '{"config":{"x\\u0000":1}}', `{"config":{"${'k'.repeat(65)}":1}}`, '{"config":{"deep":[[[[[1]]]]]}}']) {
      const r = await patchRaw(h, alice, c.id, json.replace(/^\{/, `{"request_id":"${randomUUID()}",`));
      assert.equal(r.status, 400, json);
      assert.equal(r.body.error.code, 'VALIDATION', json);
    }
    assert.equal(h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings, before);
    assert.equal({}.team_id, undefined, 'no prototype was touched');
  } finally { await h.close(); }
});

test('C1 PATCH: null deletes a key, {} changes nothing; the merged config is capped at 8 KB before any write', async () => {
  const { h, reg, alice } = await setup();
  try {
    const c = withProvider(h, reg, { team_id: 'T1' }, { a: 1, b: 'two', nested: { x: [1, 2] } });
    assert.equal((await patch(h, alice, c.id, { config: { a: null, nested: { y: true } } })).status, 200);
    assert.deepEqual(stored(h, c.id).config, { b: 'two', nested: { y: true } }, 'null deletes; a nested object is replaced whole');
    const seq = () => h.db.get('SELECT MAX(seq) AS s FROM journal').s;
    const at = seq();
    assert.equal((await patch(h, alice, c.id, { config: {} })).status, 200);
    assert.equal((await patch(h, alice, c.id, { config: { gone: null } })).status, 200, 'deleting an absent key is a no-op');
    assert.equal(seq(), at, 'nothing changed: no journal row');
    assert.equal((await patch(h, alice, c.id, { config: { big1: 'x'.repeat(5000) } })).status, 200);
    const before = h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings;
    const r = await patch(h, alice, c.id, { config: { big2: 'y'.repeat(4000) } });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /8 KB/);
    assert.equal(h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings, before);
    assert.equal((await patch(h, alice, c.id, { config: { big1: null, big2: 'y'.repeat(4000) } })).status, 200, 'the cap is on the merged result');
  } finally { await h.close(); }
});

test('C1 PATCH autonomy merges per action; null resets to the declared default; an undeclared action with null is a no-op, with a value VALIDATION', async () => {
  const { h, reg, alice } = await setup();
  try {
    const c = withProvider(h, reg, { team_id: 'T1' });
    assert.equal((await patch(h, alice, c.id, { autonomy: { 'card.create': 'off' } })).status, 200);
    assert.equal((await patch(h, alice, c.id, { autonomy: { 'card.note': 'auto' } })).status, 200);
    assert.deepEqual(stored(h, c.id).autonomy, { 'card.create': 'off', 'card.note': 'auto' }, 'patching one action keeps the other');
    assert.equal((await patch(h, alice, c.id, { autonomy: { 'card.create': null, 'rm.rf': null } })).status, 200);
    assert.deepEqual(stored(h, c.id).autonomy, { 'card.note': 'auto' });
    assert.equal(reg.ctxFor(c.id).autonomyOf('card.create'), 'auto', 'the declared default');
    assert.equal((await patch(h, alice, c.id, { autonomy: { 'rm.rf': 'auto' } })).status, 400);
    assert.equal((await patch(h, alice, c.id, { autonomy: { 'card.note': 'always' } })).status, 400);
    // One transaction: a valid autonomy beside an invalid config writes nothing.
    const before = h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings;
    assert.equal((await patch(h, alice, c.id, { autonomy: { 'card.create': 'ask' }, config: { team_id: 'T2' } })).status, 400);
    assert.equal(h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings, before);
  } finally { await h.close(); }
});

test('C1 PATCH writes one integration.settings journal row naming the changed keys only, never a value', async () => {
  const { h, reg, alice } = await setup();
  try {
    const c = withProvider(h, reg, { team_id: 'T1' }, { keep: 'k', drop: 'd' });
    const secretish = `val${randomBytes(6).toString('hex')}`;
    const r = await patch(h, alice, c.id, { autonomy: { 'card.note': 'auto' }, config: { channel: secretish, drop: null, keep: 'k' } });
    assert.equal(r.status, 200, r.text);
    const rows = journal(h, 'integration.settings');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].board_id, null);
    assert.equal(rows[0].actor_id, h.ids.alice);
    assert.deepEqual(rows[0].payload, { connection_id: c.id, provider: 'slackish', changed: { autonomy: ['card.note'], config: ['channel', 'drop'] } });
    assert.equal(JSON.stringify(rows).includes(secretish), false);
  } finally { await h.close(); }
});

test('C1 configKeys: defineConnector validates it; a declared list refuses other keys with a value and ignores null for them (no oracle)', async () => {
  const base = { id: 'ck', name: 'Ck', scopes: [], secrets: [], hosts: ['api.ck.example'], connect: { kind: 'token', verifyToken: async () => ({ external_id: 'w' }) } };
  for (const bad of ['x', [], [1], ['a', 'a'], ['__proto__'], ['constructor'], ['a.b'], ['k'.repeat(65)], Array.from({ length: 33 }, (_, i) => `k${i}`)]) {
    assert.throws(() => defineConnector({ ...base, configKeys: bad }), /configKeys/, JSON.stringify(bad));
  }
  assert.ok(defineConnector({ ...base, configKeys: ['default_board_id'] }));
  const { h, reg, alice } = await setup({ beh: newBeh({ configKeys: ['default_board_id', 'channel'] }) });
  try {
    const c = withProvider(h, reg, { team_id: 'T1' }, { legacy_key: 'L' });
    assert.equal((await patch(h, alice, c.id, { config: { default_board_id: 'b1' } })).status, 200);
    const r = await patch(h, alice, c.id, { config: { other: 'x' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION');
    const before = h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings;
    const a = await patch(h, alice, c.id, { config: { other: null } });
    const b = await patch(h, alice, c.id, { config: { legacy_key: null } });
    const z = await patch(h, alice, c.id, { config: {} });
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual(a.body, z.body);
    assert.deepEqual(b.body, z.body);
    assert.equal(h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings, before);
  } finally { await h.close(); }
});

// ── C1: ctx.hubUrl ────────────────────────────────────────────────────────

test('C1 ctx.hubUrl: an https origin only (no path, query, fragment or credentials); http only for loopback on a dev/local hub; else null; not writable', async () => {
  const { h } = await setup();
  try {
    const cases = [
      ['https://plex.example', 'https://plex.example'], ['https://Plex.Example/', 'https://plex.example'], ['https://plex.example:8443/', 'https://plex.example:8443'],
      ['https://plex.example/app', null], ['https://plex.example/?x=1', null], ['https://plex.example/?', null], ['https://plex.example/#a', null],
      ['https://u:p@plex.example', null], ['https://u@plex.example', null], ['http://plex.example', null], ['ftp://plex.example', null], ['javascript:alert(1)', null],
      ['plex.example', null], ['', null], [null, null], [undefined, null], [42, null],
      ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'], ['http://localhost:8787/', 'http://localhost:8787'], ['http://[::1]:8787', 'http://[::1]:8787'],
    ];
    for (const [publicUrl, want] of cases) {
      const reg = registryWith(h, publicUrl, newBeh());
      const c = withProvider(h, reg, { team_id: 'T1' }, {}, `T${randomBytes(4).toString('hex')}`);
      const ctx = reg.ctxFor(c.id);
      assert.equal(ctx.hubUrl, want, String(publicUrl));
      assert.throws(() => { ctx.hubUrl = EVIL; }, TypeError);
      reg.revokeConnection(c.id, h.ids.alice);
    }
  } finally { await h.close(); }
  // An accounts hub on loopback may run on plain http, but its links stay off.
  const acc = await startAccounts({ config: { publicUrl: 'http://127.0.0.1:8787' } });
  try {
    acc.hub.setVaultKey(randomBytes(32));
    acc.app.integrations.register(slackish(newBeh()));
    const c = acc.app.integrations.createConnection({ orgId: acc.ids.org, memberId: acc.ids.alice, provider: 'slackish', external_id: 'T1' });
    assert.equal(acc.app.integrations.ctxFor(c.id).hubUrl, null);
  } finally { await acc.app.close({ graceMs: 200 }); }
});

test('C1 ctx.hubUrl: app.js passes BOARD_PUBLIC_URL at boot; a PATCH of config.hub_url changes nothing', async () => {
  const acc = await startAccounts({ config: { publicUrl: 'https://buddy.example.com', trustCfIp: true, signinMethods: ['google'], accountsDev: false } });
  try {
    acc.hub.setVaultKey(randomBytes(32));
    const reg = acc.app.integrations;
    reg.register(slackish(newBeh()));
    const c = reg.createConnection({ orgId: acc.ids.org, memberId: acc.ids.alice, provider: 'slackish', external_id: 'T1', settings: { config: {} } });
    assert.equal(reg.ctxFor(c.id).hubUrl, 'https://buddy.example.com');
    reg.setSettings(c.id, { config: { hub_url: EVIL } });
    assert.equal(reg.ctxFor(c.id).hubUrl, 'https://buddy.example.com');
  } finally { await acc.app.close({ graceMs: 200 }); }
});

test('C1 a hostile payload naming URLs never reaches a link; links come from ctx.hubUrl only (null → none)', async () => {
  const { h } = await setup();
  try {
    const beh = newBeh();
    const reg = registryWith(h, 'https://plex.example', beh);
    const c = await promote(h, reg, 'https://plex.example');
    const hostile = { team_id: 'T1', hub_url: EVIL, response_url: EVIL, text: `see ${EVIL}`, links: [EVIL], config: { hub_url: EVIL }, settings: { provider: { hub_url: EVIL } } };
    assert.equal((await hookIn(reg, c, hostile)).status, 200);
    assert.equal(beh.replies.length, 1);
    assert.ok(beh.replies[0].link.startsWith('https://plex.example/boards/'), beh.replies[0].link);
    // An admin can't redirect it either.
    const alice = await h.login('alice');
    assert.equal((await patch(h, alice, c.id, { config: { hub_url: EVIL } })).status, 400, 'provider holds hub_url');
    assert.equal(JSON.stringify(beh.replies).includes('evil-phish'), false);
    const beh2 = newBeh();
    const noUrl = registryWith(h, null, beh2);
    reg.revokeConnection(c.id, h.ids.alice);
    const c2 = withProvider(h, noUrl, { team_id: 'T1' }, {}, 'T1');
    assert.equal((await hookIn(noUrl, c2, hostile)).status, 200);
    assert.deepEqual(beh2.replies, [{ text: 'Created', link: null }]);
  } finally { await h.close(); }
});

test('C1 fail closed through the real registry: a legacy connection (no provider) and a provider naming another workspace act on nothing; an admin\'s config can\'t fix either', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const legacy = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'slackish', external_id: 'T1', settings: { config: { team_id: 'T1', app_id: 'A1' } } });
    assert.equal((await hookIn(reg, legacy, { team_id: 'T1' })).status, 200);
    assert.equal((await patch(h, alice, legacy.id, { config: { team_id: 'T1' } })).status, 200, 'a legacy row has no provider key to protect');
    assert.equal((await hookIn(reg, legacy, { team_id: 'T1', n: 2 })).status, 200);
    assert.deepEqual(beh.refused, ['no_provider', 'no_provider']);
    assert.throws(() => h.db.run('UPDATE connections SET settings = ? WHERE id = ?', JSON.stringify({ config: {}, provider: { team_id: 'T1' } }), legacy.id), /settings.provider never changes/);
    reg.revokeConnection(legacy.id, h.ids.alice);
    // exchange says the team is T2 while the workspace (external_id) is T1.
    beh.teamInSettings = 'T2';
    const wrong = await promote(h, reg);
    assert.equal(stored(h, wrong.id).provider.team_id, 'T2');
    assert.equal((await hookIn(reg, wrong, { team_id: 'T1' })).status, 200);
    assert.equal((await hookIn(reg, wrong, { team_id: 'T2' })).status, 200);
    assert.deepEqual(beh.refused.slice(2), ['wrong_workspace', 'wrong_workspace']);
    assert.equal((await patch(h, alice, wrong.id, { config: { team_id: 'T1' } })).status, 400);
    assert.equal(beh.replies.length, 0);
    reg.revokeConnection(wrong.id, h.ids.alice);
    beh.teamInSettings = undefined;
    const good = await promote(h, reg);
    assert.equal((await hookIn(reg, good, { team_id: 'T1' })).status, 200);
    assert.equal(beh.replies.length, 1);
  } finally { await h.close(); }
});

test('C1 the identity hooks get connection {external_id, settings: {pinned, provider}}, frozen, never config or autonomy', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const c = await promote(h, reg);
    assert.equal((await patch(h, alice, c.id, { config: { channel: 'C1' }, autonomy: { 'card.note': 'auto' } })).status, 200);
    await reg.identityStart({ member: h.hub.member(h.ids.alice), connectionId: c.id, publicUrl: 'http://127.0.0.1' });
    const conn = beh.identity[0].connection;
    assert.deepEqual(Object.keys(conn).sort(), ['external_id', 'settings']);
    assert.deepEqual(Object.keys(conn.settings).sort(), ['pinned', 'provider']);
    assert.equal(conn.settings.pinned.client_id, APP.client_id);
    assert.equal(conn.settings.provider.team_id, 'T1');
    assert.ok(Object.isFrozen(conn) && Object.isFrozen(conn.settings) && Object.isFrozen(conn.settings.pinned) && Object.isFrozen(conn.settings.provider));
  } finally { await h.close(); }
});

test('C1 migration 026 applies over a DB at 025 (024 reserved); a legacy row loads unchanged', () => {
  const all = loadMigrations();
  const db = new DatabaseSync(':memory:');
  migrate(db, { migrations: all.filter((m) => m.version <= 25) });
  const NOW = '2026-09-30T10:00:00.000Z';
  db.exec(`
    INSERT INTO orgs (id, name, created_at) VALUES ('oa','A','${NOW}');
    INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at) VALUES ('ma','oa',1,'a','a@x.io','A','owner','${NOW}');
    INSERT INTO connections (id, org_id, provider, external_id, created_by, created_at, settings) VALUES ('ka','oa','github','1','ma','${NOW}','{"config":{"app_id":1}}');
  `);
  assert.deepEqual(migrate(db, { migrations: all }), [26]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN ('connections_provider_fixed', 'connections_id_never_reused')").get().n, 2);
  assert.equal(db.prepare("SELECT settings FROM connections WHERE id = 'ka'").get().settings, '{"config":{"app_id":1}}');
  db.exec(`UPDATE connections SET settings = '{"config":{"app_id":2}}' WHERE id = 'ka'`);
  assert.throws(() => db.exec(`UPDATE connections SET settings = '{"provider":{"app_id":2}}' WHERE id = 'ka'`), /settings.provider never changes/);
  db.close();
});
