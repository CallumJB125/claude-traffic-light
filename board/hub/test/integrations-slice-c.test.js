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
import { createLogger } from '../log.js';

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
          match: { app_id: args.provider.app_id, client_id: args.provider.client_id, ...beh.match },
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
// createConnection takes provider and pinned only: an admin's config is added
// the way PATCH stores it (provider unchanged, so the triggers allow it).
const withProvider = (h, reg, provider, config = {}, external_id = 'T1') => {
  const c = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'slackish', external_id, settings: { provider } });
  h.db.run('UPDATE connections SET settings = ? WHERE id = ?', JSON.stringify({ ...stored(h, c.id), config }), c.id);
  return c;
};
// A connection made before 026: exchange's values in config, no provider.
const legacyWith = (h, reg, config, external_id, provider = 'slackish') => {
  const c = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider, external_id });
  h.db.run('UPDATE connections SET settings = ? WHERE id = ?', JSON.stringify({ config }), c.id);
  return c;
};

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
    const legacy = legacyWith(h, reg, { team_id: 'T2' }, 'T2');
    assert.throws(() => set(JSON.stringify({ config: {}, provider: { team_id: 'T2' } }), legacy.id), /settings.provider never changes/, 'a legacy row never gains provider');
    assert.throws(() => set(JSON.stringify({ config: {}, provider: null }), legacy.id), /settings.provider never changes/, 'not even as JSON null');
    set(JSON.stringify({ config: { team_id: 'T2', x: 1 } }), legacy.id);
    const row = h.db.get('SELECT * FROM connections WHERE id = ?', c.id);
    assert.throws(() => h.db.run('INSERT OR REPLACE INTO connections (id, org_id, provider, external_id, status, settings, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.org_id, row.provider, row.external_id, row.status, JSON.stringify({ provider: { team_id: 'T9' } }), row.created_by, row.created_at), /never reused/);
    assert.deepEqual(stored(h, c.id).provider, { team_id: 'T1', app_id: 'A1' });
  } finally { await h.close(); }
});

test('C1 createConnection takes settings provider and pinned only, each an object (never autonomy or config: no caller can seed what PATCH validates); a provider over 2 KB is refused', async () => {
  const { h, reg } = await setup();
  try {
    const mk = (settings, ext = `T${randomBytes(3).toString('hex')}`) => () => reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'slackish', external_id: ext, settings });
    for (const bad of [{ team_id: 'T1' }, { Provider: {} }, { provider: 'x' }, { config: [] }, { pinned: 1 }, { hub_url: EVIL },
      { config: {} }, { config: { 'provider.team_id': 'T2' } }, { autonomy: { 'card.create': 'off' } }, { autonomy: {} }, { provider: { team_id: 'T1' }, config: { team_id: 'T2' } }]) {
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

test('C1 the reconnect hint: connectors get provider (the stored provider facts) and config (the admin\'s, declared configKeys only) apart; an admin\'s config never reaches provider; a legacy row\'s config is its provider', async () => {
  const { h, reg, beh } = await setup();
  try {
    const member = h.hub.member(h.ids.alice);
    const legacy = legacyWith(h, reg, { app_id: 'LEGACY', org: 'acme' }, 'T7');
    await reg.pendingCreate({ member, provider: 'slackish', input: { config_token: 'c1' }, publicUrl: 'http://127.0.0.1' });
    assert.deepEqual(beh.prepared.at(-1).provider, { app_id: 'LEGACY', org: 'acme' });
    assert.deepEqual(beh.prepared.at(-1).config, {});
    reg.revokeConnection(legacy.id, h.ids.alice);
    h.db.run('DELETE FROM integration_pending');
    // An admin set org and app_id in config; provider holds app_id only.
    withProvider(h, reg, { app_id: 'PROVIDER' }, { app_id: 'ADMIN', org: 'evil-org' }, 'T8');
    await reg.pendingCreate({ member, provider: 'slackish', input: { config_token: 'c2' }, publicUrl: 'http://127.0.0.1' });
    assert.deepEqual(beh.prepared.at(-1).provider, { app_id: 'PROVIDER' });
    assert.deepEqual(beh.prepared.at(-1).config, { app_id: 'ADMIN', org: 'evil-org' });
  } finally { await h.close(); }
  // Through a promotion: exchange sees the pending settings as provider, the admin's config apart.
  const beh2 = newBeh({ configKeys: ['default_board_id'] });
  const s2 = await setup({ beh: beh2 });
  try {
    const old = withProvider(s2.h, s2.reg, { team_id: 'T0', app_id: 'OLD' }, { default_board_id: 'b1', org: 'evil-org' }, 'T0');
    s2.reg.revokeConnection(old.id, s2.h.ids.alice);
    withProvider(s2.h, s2.reg, { team_id: 'T9', app_id: 'NEWER' }, { default_board_id: 'b2', org: 'evil-org' }, 'T9');
    s2.h.db.run("UPDATE connections SET status = 'revoked' WHERE external_id = 'T9'");
    const live = withProvider(s2.h, s2.reg, { team_id: 'T3', app_id: 'A3' }, { default_board_id: 'b3', org: 'evil-org' }, 'T3');
    const c = await promote(s2.h, s2.reg);
    const ex = beh2.exchanged.at(-1);
    assert.deepEqual(ex.config, { default_board_id: 'b3' }, 'undeclared keys never reach a connector that declares configKeys');
    assert.deepEqual(ex.provider, { team_id: 'T3', app_id: APP.app_id, client_id: APP.client_id }, 'the active row\'s facts overlaid with the pending settings');
    assert.equal(beh2.prepared.at(-1).provider.org, undefined);
    assert.equal(JSON.stringify(stored(s2.h, c.id)).includes('evil-org'), false);
    assert.equal(stored(s2.h, live.id).config.org, 'evil-org', 'the stored config itself is untouched');
  } finally { await s2.h.close(); }
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
    const c = withProvider(h, registryWith(h, 'https://plex.example', newBeh()), { team_id: 'T1', app_id: 'A1' }, { channel: 'C1' });
    assert.equal(stored(h, c.id).provider.hub_url, 'https://plex.example');
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
  const acc = await startAccounts({ config: { publicUrl: 'https://buddy.acme.test', trustCfIp: true, signinMethods: ['google'], accountsDev: false } });
  try {
    acc.hub.setVaultKey(randomBytes(32));
    const reg = acc.app.integrations;
    reg.register(slackish(newBeh()));
    const c = reg.createConnection({ orgId: acc.ids.org, memberId: acc.ids.alice, provider: 'slackish', external_id: 'T1' });
    assert.equal(reg.ctxFor(c.id).hubUrl, 'https://buddy.acme.test');
    reg.setSettings(c.id, { config: { hub_url: EVIL } });
    assert.equal(reg.ctxFor(c.id).hubUrl, 'https://buddy.acme.test');
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
    const legacy = legacyWith(h, reg, { team_id: 'T1', app_id: 'A1' }, 'T1');
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
  assert.deepEqual(migrate(db, { migrations: all }), [26, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN ('connections_provider_fixed', 'connections_id_never_reused')").get().n, 2);
  assert.equal(db.prepare("SELECT settings FROM connections WHERE id = 'ka'").get().settings, '{"config":{"app_id":1}}');
  db.exec(`UPDATE connections SET settings = '{"config":{"app_id":2}}' WHERE id = 'ka'`);
  assert.throws(() => db.exec(`UPDATE connections SET settings = '{"provider":{"app_id":2}}' WHERE id = 'ka'`), /settings.provider never changes/);
  db.close();
});

// ── 026 follow-up: what SQLite and JS read is the same; rows stay ────────

const insertConn = (h, row, over) => h.db.run('INSERT INTO connections (id, org_id, provider, external_id, status, settings, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  over.id ?? randomUUID(), row.org_id, row.provider, over.external_id ?? `T${randomBytes(3).toString('hex')}`, over.status ?? 'active', over.settings ?? '{}', row.created_by, row.created_at);

test('026 connections.settings is strict JSON with no duplicate key at any depth: a duplicate (top level, nested, escaped), JSON5, a non-object or a JSONB blob aborts an UPDATE or INSERT; the registry\'s own writes pass', async () => {
  const { h, reg, alice } = await setup();
  try {
    const c = await promote(h, reg);
    const before = h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings;
    const { provider, pinned } = JSON.parse(before);
    const P = JSON.stringify(provider);
    const PIN = JSON.stringify(pinned);
    const evil = `{"provider":${P},"pinned":${PIN},"provider":${JSON.stringify({ ...provider, team_id: 'T2' })},"pinned":${JSON.stringify({ ...pinned, app_id: 'EVIL' })}}`;
    // The bypass: SQLite reads the first duplicate, JS the last.
    assert.equal(h.db.get("SELECT json_extract(?, '$.provider.team_id') AS t", evil).t, 'T1');
    assert.equal(JSON.parse(evil).provider.team_id, 'T2');
    const bad = [
      evil,
      `{"provider":${P},"pinned":${PIN},"\\u0070rovider":{"team_id":"T2"}}`,
      `{"provider":${P},"pinned":${PIN},"config":{"channel":"C1","channel":"C2"}}`,
      `{"provider":${P},"pinned":${PIN},"config":{"deep":[{"a":1,"a":2}]}}`,
      `{provider:${P},"pinned":${PIN}}`,
      `{"provider":${P},"pinned":${PIN},}`,
      `{"provider":${P},"pinned":${PIN} /* hi */}`,
      `{"provider":${P},"pinned":${PIN},"config":{'channel':'C1'}}`,
      `{"provider":${P},"pinned":${PIN},"config":{"n":0x10}}`,
    ];
    for (const b of bad) assert.throws(() => h.db.run('UPDATE connections SET settings = ? WHERE id = ?', b, c.id), /settings must be strict JSON without duplicate keys/, b);
    assert.throws(() => h.db.run('UPDATE connections SET settings = jsonb(settings) WHERE id = ?', c.id), /strict JSON/, 'a JSONB blob');
    assert.equal(h.db.get('SELECT settings FROM connections WHERE id = ?', c.id).settings, before);
    const row = h.db.get('SELECT * FROM connections WHERE id = ?', c.id);
    for (const b of [...bad, '[]', '"x"', 'null', '1']) assert.throws(() => insertConn(h, row, { settings: b }), /settings must be strict JSON without duplicate keys/, b);
    assert.throws(() => h.db.run("INSERT INTO connections (id, org_id, provider, external_id, settings, created_by, created_at) VALUES (?, ?, 'slackish', 'TB', jsonb('{}'), ?, ?)", randomUUID(), row.org_id, row.created_by, row.created_at), /strict JSON/);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM connections WHERE provider = 'slackish'").n, 1, 'nothing inserted');
    // Ordinary JSON, as the registry writes it, still passes (repeated keys in sibling objects are not duplicates).
    assert.equal((await patch(h, alice, c.id, { config: { channel: 'C1', list: [{ a: 1 }, { a: 2 }] }, autonomy: { 'card.note': 'auto' } })).status, 200);
    assert.deepEqual(stored(h, c.id).config, { channel: 'C1', list: [{ a: 1 }, { a: 2 }] });
    insertConn(h, row, { settings: JSON.stringify({ provider: { team_id: 'TX' }, config: { a: { b: 1 }, c: { b: 2 } } }) });
  } finally { await h.close(); }
});

test('026 integration_pending match and settings are strict JSON too (insert and update): JS reads them for promotion', async () => {
  const { h } = await setup();
  try {
    const t = h.hub.iso();
    const exp = new Date(h.hub.wallMs() + 3_600_000).toISOString();
    const ins = (id, match, settings = '{}') => h.db.run('INSERT INTO integration_pending (id, org_id, provider, created_by, match, settings, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, h.ids.org, 'slackish', h.ids.alice, match, settings, t, exp);
    const dup = '{"app_id":"A1","client_id":"1.2","app_id":"EVIL"}';
    for (const [m, st] of [[dup, '{}'], ['{}', dup], ['{app_id:"A1"}', '{}'], ['{}', '{"a":1,}'], ['[]', '{}'], ['{}', '{"x":{"y":1,"y":2}}']]) {
      assert.throws(() => ins(randomUUID(), m, st), /strict JSON/, `${m} ${st}`);
    }
    const id = randomUUID();
    ins(id, '{}');
    for (const [col, v] of [['match', dup], ['settings', dup], ['match', '{"app_id":"A1" // c\n}'], ['settings', '{"needs_fields":["x"],}']]) {
      assert.throws(() => h.db.run(`UPDATE integration_pending SET ${col} = ? WHERE id = ?`, v, id), /strict JSON/, `${col} ${v}`);
    }
    h.db.run('UPDATE integration_pending SET match = ?, settings = ? WHERE id = ?', '{"app_id":"A1","client_id":"1.2"}', '{"app_id":"A1"}', id);
    assert.equal(h.db.get('SELECT match FROM integration_pending WHERE id = ?', id).match, '{"app_id":"A1","client_id":"1.2"}');
  } finally { await h.close(); }
});

test('026 a connection row is never deleted (not by DELETE, nor by a REPLACE on its live key) and its id never changes; revoke and team deletion still keep it', async () => {
  const { h, reg } = await setup();
  try {
    const c = withProvider(h, reg, { team_id: 'T1' });
    const row = h.db.get('SELECT * FROM connections WHERE id = ?', c.id);
    assert.throws(() => h.db.run('DELETE FROM connections WHERE id = ?', c.id), /a connection is never deleted/);
    assert.throws(() => h.db.run('DELETE FROM connections'), /a connection is never deleted/);
    assert.throws(() => h.db.run('UPDATE connections SET id = ? WHERE id = ?', randomUUID(), c.id), /a connection id never changes/);
    h.db.run('UPDATE connections SET id = id, display_name = ? WHERE id = ?', 'same id', c.id);
    // REPLACE deletes the conflicting row without firing delete triggers: refused before it gets there.
    assert.throws(() => h.db.run('INSERT OR REPLACE INTO connections (id, org_id, provider, external_id, status, settings, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      randomUUID(), row.org_id, row.provider, row.external_id, 'active', JSON.stringify({ provider: { team_id: 'T9' } }), row.created_by, row.created_at), /a live connection is never replaced/);
    reg.revokeConnection(c.id, h.ids.alice);
    const again = withProvider(h, reg, { team_id: 'T1' });
    assert.throws(() => h.db.run("UPDATE OR REPLACE connections SET status = 'active', revoked_at = NULL WHERE id = ?", c.id), /a live connection is never replaced/);
    assert.equal(h.db.get('SELECT status FROM connections WHERE id = ?', again.id).status, 'active');
    h.db.run('UPDATE orgs SET deleted_at = ? WHERE id = ?', h.hub.iso(), h.ids.org);
    h.hub.revokeDeletedTeamConnections(h.hub.iso());
    assert.deepEqual(h.db.all('SELECT id, status FROM connections ORDER BY created_at, rowid').map((r) => r.status), ['revoked', 'revoked']);
  } finally { await h.close(); }
});

test('after every migration the 026 follow-up triggers exist', async () => {
  const { h } = await setup();
  try {
    const names = h.db.all("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'").map((r) => `${r.tbl_name}.${r.name}`);
    for (const t of ['connections.connections_settings_strict', 'connections.connections_settings_strict_ins', 'connections.connections_never_deleted', 'connections.connections_live_never_replaced',
      'connections.connections_live_never_replaced_upd', 'connections.connections_id_fixed', 'integration_pending.integration_pending_json_strict', 'integration_pending.integration_pending_json_strict_ins']) {
      assert.ok(names.includes(t), t);
    }
  } finally { await h.close(); }
});

// ── C2: actor scope, linkState, early-ack failure, card tokens ───────────

// A chat-shaped connector whose handler and bus consumer the test drives.
const actorConnector = (beh, over = {}) => defineConnector({
  id: 'cmd', name: 'Cmd', scopes: [], secrets: [], hosts: ['api.cmd.example'],
  connect: { kind: 'token', verifyToken: async () => ({ external_id: 'W1' }) },
  verify: ({ headers }) => (headers['x-ok'] === '1' ? { ok: true, dedupe_key: headers['x-id'] } : { ok: false, reason: 'nope' }),
  async handleWebhook({ payload, ctx }) { return beh.handle(payload, ctx); },
  consumes: ['card.transition'],
  async onEvent(row, ctx) { return beh.onEvent?.(row, ctx); },
  actions: { 'card.create': { default: 'auto' } },
  ...over,
});

async function actorSetup({ over = {}, reg: makeReg = null } = {}) {
  const h = await startHub({ config: ROOMY });
  h.hub.setVaultKey(randomBytes(32));
  const beh = { calls: 0, caught: [] };
  const reg = makeReg ? makeReg(h) : h.app.integrations;
  reg.register(actorConnector(beh, over));
  const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'cmd', external_id: 'W1' });
  const linkSubject = (subject, memberId, connectionId = conn.id) => h.db.run("INSERT INTO external_identities (provider, workspace_id, subject, member_id, connection_id, verified_via, linked_at) VALUES ('cmd', 'W1', ?, ?, ?, 'oauth_link', ?)", subject, memberId, connectionId, h.hub.iso());
  const ua = `U${randomBytes(4).toString('hex').toUpperCase()}`;
  const ub = `U${randomBytes(4).toString('hex').toUpperCase()}`;
  linkSubject(ua, h.ids.alice);
  linkSubject(ub, h.ids.bob);
  return { h, reg, beh, conn, ua, ub, linkSubject };
}

const sendHttp = async (h, conn, payload, id = randomUUID()) => {
  const res = await fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers: { 'x-ok': '1', 'x-id': id, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const headers = Object.fromEntries([...res.headers].filter(([k]) => k !== 'date'));
  return { status: res.status, text: await res.text(), headers };
};
const webhookAudit = (h, conn) => h.db.all("SELECT decision, error FROM integration_audit WHERE connection_id = ? AND action = 'webhook'", conn.id).map((r) => ({ ...r }));
const actAudit = (h, conn) => h.db.all("SELECT decision, error FROM integration_audit WHERE connection_id = ? AND action = 'card.create' ORDER BY at, rowid", conn.id).map((r) => ({ ...r }));
const health = (h, conn) => h.db.get('SELECT health FROM connections WHERE id = ?', conn.id).health;

// The handler resolves its member, then (in the race this simulates) the
// member is demoted or removed before it acts.
const actForSubject = (h, beh, { catchIt = false } = {}) => async (payload, ctx) => {
  beh.calls += 1;
  const m = ctx.memberFor(payload.user);
  if (payload.demote) h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", m);
  if (payload.remove) h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), m);
  try {
    await ctx.act('card.create', { subject: payload.user }, (s) => s.actAs(m).createCard(h.ids.board, { request_id: payload.rid, title: 'From chat' }));
  } catch (e) {
    if (!catchIt) throw e;
    beh.caught.push({ code: e.code, scope: e.scope, linkState: ctx.linkState(payload.user) });
  }
};

test('C2 a linked member demoted after memberFor: ACTOR_UNAVAILABLE scope member, audited for that act; the answer is byte-for-byte a success; no health change, no dead letter; the delivery is done', async () => {
  const { h, beh, conn, ua, ub } = await actorSetup();
  try {
    beh.handle = actForSubject(h, beh);
    const ok = await sendHttp(h, conn, { user: ua, rid: 'r-ok' });
    assert.equal(ok.status, 200, ok.text);
    const healthy = health(h, conn);
    const id = randomUUID();
    const skipped = await sendHttp(h, conn, { user: ub, rid: 'r-demoted', demote: true }, id);
    assert.deepEqual(skipped, ok, 'same status, body and headers as a success');
    assert.equal(health(h, conn), healthy, 'health untouched');
    assert.deepEqual(webhookAudit(h, conn), []);
    assert.deepEqual(actAudit(h, conn).at(-1), { decision: 'failed', error: 'actor_unavailable' });
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'From chat'").length, 1);
    const again = await sendHttp(h, conn, { user: ub, rid: 'r-demoted', demote: true }, id);
    assert.equal(JSON.parse(again.text).duplicate, true, 'done, not released');
    assert.equal(beh.calls, 2);
  } finally { await h.close(); }
});

test('C2 the connector sees ACTOR_UNAVAILABLE {scope:\'member\'} (demoted or removed linked member) and linkState says unavailable; a member the subject does not map to stays FORBIDDEN', async () => {
  const { h, reg, beh, conn, ua, ub } = await actorSetup();
  try {
    beh.handle = actForSubject(h, beh, { catchIt: true });
    assert.equal((await hookIn(reg, conn, { user: ub, rid: 'r1', demote: true })).status, 200);
    assert.deepEqual(beh.caught[0], { code: 'ACTOR_UNAVAILABLE', scope: 'member', linkState: 'unavailable' });
    h.db.run("UPDATE members SET role = 'member' WHERE id = ?", h.ids.bob);
    assert.equal((await hookIn(reg, conn, { user: ub, rid: 'r2', remove: true })).status, 200);
    assert.deepEqual(beh.caught[1], { code: 'ACTOR_UNAVAILABLE', scope: 'member', linkState: 'none' }, 'removal deletes the link (023), the act still names the member');
    const ctx = reg.ctxFor(conn.id);
    await assert.rejects(ctx.act('card.create', { subject: ua }, (s) => s.actAs(h.ids.bob)), (e) => e.code === 'FORBIDDEN');
    assert.equal(JSON.parse(health(h, conn) ?? '{}').ok !== false, true);
  } finally { await h.close(); }
});

test('C2 created_by unavailable keeps today\'s answer and flips health (webhook and bus); a linked member on the bus changes no health', async () => {
  const { h, reg, beh, conn, ub } = await actorSetup();
  try {
    const cardId = (await h.createCard(await h.login('alice'), { title: 'Bus card' })).id;
    const bus = h.app.bus;
    const fire = async () => {
      h.hub.journal({ board_id: h.ids.board, card_id: cardId, kind: 'card.transition', payload: { to: 'done' } });
      h.hub.emit('journal');
      await bus.settle();
    };
    // A linked member, demoted, acted for on the bus: no health change.
    beh.onEvent = async (row, ctx) => ctx.act('card.create', { subject: ub }, (s) => s.actAs(h.ids.bob));
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.bob);
    await fire();
    assert.equal(health(h, conn), null, 'no health written for a member');
    assert.deepEqual(actAudit(h, conn).at(-1), { decision: 'failed', error: 'actor_unavailable' });
    // created_by demoted: bus and webhook flip health.
    h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", h.ids.bob);
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.alice);
    beh.onEvent = async (row, ctx) => ctx.act('card.create', {}, (s) => s.actAs(ctx.connection.created_by));
    await fire();
    assert.equal(JSON.parse(health(h, conn)).last_error, 'actor_unavailable');
    h.db.run("UPDATE connections SET health = NULL WHERE id = ?", conn.id);
    beh.handle = async (payload, ctx) => ctx.act('card.create', {}, (s) => s.actAs(ctx.connection.created_by));
    const r = await hookIn(reg, conn, { n: 1 });
    assert.deepEqual([r.status, r.body], [200, { ok: true, skipped: true }]);
    assert.equal(JSON.parse(health(h, conn)).last_error, 'actor_unavailable');
  } finally { await h.close(); }
});

test('C2 ctx.linkState: active, unavailable (viewer, paused connection), none (unlinked, bad subject, another connection\'s subject); never a member id', async () => {
  const { h, reg, conn, ua, ub } = await actorSetup();
  try {
    const ctx = reg.ctxFor(conn.id);
    assert.equal(ctx.linkState(ua), 'active');
    assert.equal(ctx.linkState(ub), 'active');
    for (const bad of [undefined, null, '', 7, {}, ['x'], 'U'.repeat(129), 'UNLINKED1']) assert.equal(ctx.linkState(bad), 'none', String(bad));
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.bob);
    assert.equal(ctx.linkState(ub), 'unavailable');
    h.db.run("UPDATE connections SET status = 'paused' WHERE id = ?", conn.id);
    assert.equal(ctx.linkState(ua), 'unavailable');
    h.db.run("UPDATE connections SET status = 'active' WHERE id = ?", conn.id);
    // A subject linked on another connection (another workspace) is none here.
    const other = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'cmd', external_id: 'W2' });
    const uo = 'UOTHERWS1';
    h.db.run("INSERT INTO external_identities (provider, workspace_id, subject, member_id, connection_id, verified_via, linked_at) VALUES ('cmd', 'W2', ?, ?, ?, 'oauth_link', ?)", uo, h.ids.alice, other.id, h.hub.iso());
    assert.equal(ctx.linkState(uo), 'none');
    assert.equal(reg.ctxFor(other.id).linkState(uo), 'active');
    assert.equal(ctx.linkState.length, 1);
  } finally { await h.close(); }
});

test('C2 early ack: a failed handler is audited and the delivery marked done (the same bytes answer duplicate, never re-run); onAckedFailure gets a short code, a payload copy and the restricted fetch', async () => {
  const fetched = [];
  const { h, reg, beh, conn } = await actorSetup({
    over: {
      ackEarly: true,
      async onAckedFailure(a) { beh.failures.push({ ...a, payloadKeys: Object.keys(a.payload) }); fetched.push(await a.fetch('https://evil.example/x').then(() => 'reached', (e) => e.healthCode)); },
    },
  });
  try {
    beh.failures = [];
    beh.handle = async (payload) => { beh.calls += 1; payload.mutated = true; throw Object.assign(new Error(`views.open refused ${payload.secretish}`), { healthCode: 'provider_error' }); };
    const id = randomUUID();
    const body = { secretish: 'trigger-123', n: 1 };
    for (let i = 0; i < 3; i += 1) {
      const r = await hookIn(reg, conn, body, id);
      assert.equal(r.status, 200);
      await h.hub.idle();
      if (i > 0) assert.deepEqual(r.body, { ok: true, duplicate: true });
    }
    assert.equal(beh.calls, 1, 'ran once');
    assert.deepEqual(webhookAudit(h, conn), [{ decision: 'failed', error: 'provider_error' }]);
    assert.deepEqual([...new Set(h.db.all("SELECT state FROM inbound_dedupe WHERE provider = 'cmd'").map((r) => r.state))], ['done']);
    assert.equal(beh.failures.length, 1);
    assert.equal(beh.failures[0].error_code, 'provider_error');
    assert.deepEqual(beh.failures[0].payload, body, 'the payload as parsed, not as the handler left it');
    assert.equal(beh.failures[0].headers['x-id'], id);
    assert.equal(JSON.stringify(beh.failures[0]).includes('views.open'), false, 'never the error');
    assert.deepEqual(fetched, ['host_refused']);
    // Success calls nothing.
    beh.handle = async () => {};
    assert.equal((await hookIn(reg, conn, { n: 2 })).status, 200);
    await h.hub.idle();
    assert.equal(beh.failures.length, 1);
  } finally { await h.close(); }
});

test('C2 early ack: a handler that times out is done at the timeout and stays done when it later fails; a late (non-early) delivery is still released so the provider retry runs (GitHub unchanged)', async () => {
  let gate;
  const { h, reg, beh, conn } = await actorSetup({
    over: { ackEarly: ({ payload }) => payload.early === true, onAckedFailure: (a) => { beh.codes.push(a.error_code); throw new Error('ignored'); } },
    reg: (hh) => createIntegrations({ hub: hh.hub, api: new Api(hh.hub), log: null, handlerTimeoutMs: 30 }),
  });
  try {
    beh.codes = [];
    beh.handle = async (payload) => {
      beh.calls += 1;
      if (payload.early) await new Promise((resolve, reject) => { gate = { resolve, reject }; });
      else throw new Error('late failure');
    };
    const id = randomUUID();
    assert.equal((await hookIn(reg, conn, { early: true }, id)).status, 200);
    await h.hub.idle();
    assert.deepEqual(beh.codes, ['handler_timeout']);
    assert.deepEqual((await hookIn(reg, conn, { early: true }, id)).body, { ok: true, duplicate: true }, 'done at the timeout, while it still runs');
    gate.reject(new Error('late fail'));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...new Set(h.db.all("SELECT state FROM inbound_dedupe WHERE provider = 'cmd'").map((r) => r.state))], ['done']);
    assert.deepEqual((await hookIn(reg, conn, { early: true }, id)).body, { ok: true, duplicate: true });
    assert.equal(beh.calls, 1);
    // Late: released, and run again on the retry; onAckedFailure never called.
    const late = randomUUID();
    assert.equal((await hookIn(reg, conn, { early: false }, late)).status, 500);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM inbound_dedupe WHERE provider = 'cmd' AND dedupe_key LIKE ?", `${conn.id}:${late}`).n, 0);
    assert.equal((await hookIn(reg, conn, { early: false }, late)).status, 500);
    assert.equal(beh.calls, 3);
    assert.deepEqual(beh.codes, ['handler_timeout']);
  } finally { await h.close(); }
  const github = (await import('../integrations/github/index.js')).default;
  assert.equal(github.ackEarly, undefined, 'GitHub answers late: its failures stay released for its retries');
  assert.equal(github.onAckedFailure, undefined);
});

test('C2 early ack: a handler that never settles is done at the timeout; after lease_until the same bytes answer duplicate and never re-run', async () => {
  const { h, reg, beh, conn } = await actorSetup({
    over: { ackEarly: true },
    reg: (hh) => createIntegrations({ hub: hh.hub, api: new Api(hh.hub), log: null, handlerTimeoutMs: 30 }),
  });
  try {
    beh.handle = () => { beh.calls += 1; return new Promise(() => {}); };
    const id = randomUUID();
    assert.equal((await hookIn(reg, conn, { n: 1 }, id)).status, 200);
    await h.hub.idle();
    const rows = h.db.all("SELECT state, lease_until FROM inbound_dedupe WHERE provider = 'cmd'");
    assert.ok(rows.length >= 1);
    for (const r of rows) assert.deepEqual({ ...r }, { state: 'done', lease_until: null });
    h.clock.advance(30 + 30_000 + 1_000);
    assert.deepEqual((await hookIn(reg, conn, { n: 1 }, id)).body, { ok: true, duplicate: true });
    await h.hub.idle();
    assert.equal(beh.calls, 1);
  } finally { await h.close(); }
});

test('C2 defineConnector: onAckedFailure is a function, only with ackEarly', () => {
  const beh = {};
  assert.throws(() => actorConnector(beh, { onAckedFailure: () => {} }), /onAckedFailure/);
  assert.throws(() => actorConnector(beh, { ackEarly: true, onAckedFailure: 'x' }), /onAckedFailure/);
  assert.ok(actorConnector(beh, { ackEarly: true, onAckedFailure: () => {} }));
});

test('C2 F-2: a request integration_requests already holds spends integration_conn but no card token, for another member too; naming another board is CONFLICT with no card token', async () => {
  const { h, reg, conn, ua, ub } = await actorSetup();
  try {
    const ctx = reg.ctxFor(conn.id);
    const card = (subject, member, rid, board = h.ids.board) => ctx.act('card.create', { subject }, (s) => s.actAs(member).createCard(board, { request_id: rid, title: 'Same message' }));
    const bucket = (rule, key) => h.hub.limiter.buckets.get(`${rule}|${key}`);
    const subjKey = (s) => `${conn.id}|${h.hub.refHash(s)}`;
    const first = await card(ua, h.ids.alice, 'msg-1');
    const second = await card(ub, h.ids.bob, 'msg-1');
    assert.equal(second.result.card.id, first.result.card.id, 'one card');
    assert.equal(bucket('integration_card_subject', subjKey(ub)), undefined, 'the second member\'s card bucket untouched');
    assert.equal(bucket('integration_card_conn', conn.id).tokens, 19, 'card_conn spent once');
    assert.equal(bucket('integration_conn', conn.id).tokens, 118, 'integration_conn on every call');
    const board2 = randomUUID();
    h.db.run("INSERT INTO boards (id, org_id, name, key_prefix) VALUES (?, ?, 'Two', 'TWO')", board2, h.ids.org);
    const carol = randomUUID();
    h.db.insert('members', { id: carol, org_id: h.ids.org, github_id: -424242, github_login: 'carolc', email: 'carolc@dev.local', display_name: 'carol', role: 'member', created_at: h.hub.iso() });
    const uc = 'UCAROL01';
    h.db.run("INSERT INTO external_identities (provider, workspace_id, subject, member_id, connection_id, verified_via, linked_at) VALUES ('cmd', 'W1', ?, ?, ?, 'oauth_link', ?)", uc, carol, conn.id, h.hub.iso());
    await assert.rejects(card(uc, carol, 'msg-1', board2), (e) => e.code === 'CONFLICT');
    assert.equal(bucket('integration_card_subject', subjKey(uc)), undefined);
    assert.equal(bucket('integration_card_conn', conn.id).tokens, 19);
  } finally { await h.close(); }
});

test('C2 F-2: a repeat of a request that made its card answers the same whether the caller\'s card bucket is full or spent (no probe)', async () => {
  const { h, reg, conn, ua, ub } = await actorSetup();
  try {
    const ctx = reg.ctxFor(conn.id);
    const card = (subject, member, rid) => ctx.act('card.create', { subject }, (s) => s.actAs(member).createCard(h.ids.board, { request_id: rid, title: 'Probe' }));
    const made = await card(ua, h.ids.alice, 'msg-probe');
    const carol = randomUUID();
    h.db.insert('members', { id: carol, org_id: h.ids.org, github_id: -434343, github_login: 'carold', email: 'carold@dev.local', display_name: 'carol', role: 'member', created_at: h.hub.iso() });
    const uc = 'UCAROL02';
    h.db.run("INSERT INTO external_identities (provider, workspace_id, subject, member_id, connection_id, verified_via, linked_at) VALUES ('cmd', 'W1', ?, ?, ?, 'oauth_link', ?)", uc, carol, conn.id, h.hub.iso());
    const full = await card(ub, h.ids.bob, 'msg-probe');
    for (let i = 0; i < 5; i += 1) await card(uc, carol, `own-${i}`);
    await assert.rejects(card(uc, carol, 'own-5'), (e) => e.code === 'RATE_LIMITED', 'carol\'s bucket is spent');
    const spent = await card(uc, carol, 'msg-probe');
    assert.equal(full.result.card.id, made.result.card.id);
    assert.equal(spent.result.card.id, made.result.card.id);
    assert.deepEqual(Object.keys(spent), Object.keys(full));
    assert.equal(spent.decision, full.decision);
  } finally { await h.close(); }
});

// ── C3: per-user command bucket ──────────────────────────────────────────

const cmdConnector = (beh, over = {}) => defineConnector({
  id: 'ucmd', name: 'Ucmd', scopes: [], secrets: [], hosts: ['api.ucmd.example'],
  connect: { kind: 'token', verifyToken: async () => ({ external_id: 'W1' }) },
  verify: ({ headers }) => (headers['x-ok'] === '1' ? { ok: true, dedupe_key: headers['x-id'] } : { ok: false, reason: 'nope' }),
  ackEarly: true,
  ackBody: (a) => { beh.acks.push({ ...a }); return a.rateLimited ? { text: 'Slow down a little.' } : undefined; },
  rateSubject: ({ payload }) => beh.subject ? beh.subject(payload) : payload.user ?? null,
  async handleWebhook({ payload }) { beh.ran.push(payload.n); },
  ...over,
});

async function cmdSetup({ over = {}, hubOpts = {} } = {}) {
  const lines = [];
  const h = await startHub({ log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }), ...hubOpts });
  h.hub.setVaultKey(randomBytes(32));
  const beh = { ran: [], acks: [] };
  const reg = h.app.integrations;
  reg.register(cmdConnector(beh, over));
  const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'ucmd', external_id: 'W1' });
  const send = async (payload, id = randomUUID()) => { const r = await reg.webhook(conn.id, { headers: { 'x-ok': '1', 'x-id': id }, rawBody: Buffer.from(JSON.stringify(payload)) }); await h.hub.idle(); return r; };
  return { h, reg, beh, conn, send, lines };
}
const userOf = () => `U${randomBytes(5).toString('hex').toUpperCase()}`;
const rateAudit = (h, conn) => h.db.all("SELECT decision, error, card_id, external_ref, detail FROM integration_audit WHERE connection_id = ? AND action = 'webhook'", conn.id).map((r) => ({ ...r }));

test('C3 integration_user_cmd: 30 a minute per provider user, then nothing runs and ackBody answers with rateLimited:true; webhook_conn unspent, no dedupe row kept; another user unaffected', async () => {
  const { h, beh, conn, send } = await cmdSetup();
  try {
    const u1 = userOf();
    const u2 = userOf();
    for (let n = 0; n < 30; n += 1) assert.equal((await send({ user: u1, n })).status, 200);
    assert.equal(beh.ran.length, 30);
    const webhookTokens = h.hub.limiter.buckets.get(`webhook_conn|${conn.id}`).tokens;
    const id = randomUUID();
    const over = await send({ user: u1, n: 30 }, id);
    assert.equal(over.status, 200);
    assert.equal(over.raw, JSON.stringify({ text: 'Slow down a little.' }));
    assert.equal(over.type, 'application/json; charset=utf-8');
    assert.equal(beh.ran.length, 30, 'no handler ran');
    assert.equal(beh.acks.at(-1).rateLimited, true);
    assert.deepEqual(beh.acks.at(-1).payload, { user: u1, n: 30 });
    assert.equal(beh.acks.filter((a) => a.rateLimited === undefined).length, 30, 'a normal early answer has no rateLimited');
    assert.equal(h.hub.limiter.buckets.get(`webhook_conn|${conn.id}`).tokens, webhookTokens, 'webhook_conn unspent');
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM inbound_dedupe WHERE dedupe_key = ?", `${conn.id}:${id}`).n, 0, 'the lease was released');
    assert.equal((await send({ user: u2, n: 99 })).status, 200);
    assert.deepEqual(beh.ran.at(-1), 99, 'another user is unaffected');
    // The released delivery runs once the user is under the limit again.
    h.clock.advance(60_000);
    const later = await send({ user: u1, n: 30 }, id);
    assert.equal(later.status, 200);
    assert.equal(beh.ran.at(-1), 30);
    assert.deepEqual((await send({ user: u1, n: 30 }, id)).body, { ok: true, duplicate: true });
  } finally { await h.close(); }
});

test('C3 a replay of a finished delivery (or one in progress) spends no integration_user_cmd', async () => {
  const { h, conn, send } = await cmdSetup();
  try {
    const u = userOf();
    const id = randomUUID();
    assert.equal((await send({ user: u, n: 1 }, id)).status, 200);
    const key = `integration_user_cmd|${conn.id}|${h.hub.refHash(u)}`;
    const left = h.hub.limiter.buckets.get(key).tokens;
    for (let i = 0; i < 40; i += 1) assert.deepEqual((await send({ user: u, n: 1 }, id)).body, { ok: true, duplicate: true });
    assert.equal(h.hub.limiter.buckets.get(key).tokens, left);
    assert.equal((await send({ user: u, n: 2 })).status, 200, 'the user still has their budget');
  } finally { await h.close(); }
});

test('C3 refusals are audited webhook/failed/rate_limited at most 6 a minute per connection, with no ids or text', async () => {
  const { h, conn, send, beh } = await cmdSetup({ hubOpts: { config: { rateLimits: { integration_user_cmd: { capacity: 1, per_ms: 60_000 } } } } });
  try {
    const u = userOf();
    for (let n = 0; n < 21; n += 1) await send({ user: u, n });
    assert.equal(beh.ran.length, 1);
    const rows = rateAudit(h, conn);
    assert.equal(rows.length, 6);
    for (const r of rows) assert.deepEqual(r, { decision: 'failed', error: 'rate_limited', card_id: null, external_ref: null, detail: '{}' });
  } finally { await h.close(); }
});

test('C3 rateSubject that throws, or returns \'\', 129 chars, a number, an object or a Promise: no bucket, the delivery runs', async () => {
  const outs = [() => { throw new Error('no'); }, () => '', () => 'U'.repeat(129), () => 42, () => ({ id: 'U1' }), () => Promise.resolve('U1')];
  for (const fn of outs) {
    const { h, beh, conn, send } = await cmdSetup({ hubOpts: { config: { rateLimits: { integration_user_cmd: { capacity: 1, per_ms: 60_000 } } } } });
    try {
      beh.subject = fn;
      for (let n = 0; n < 3; n += 1) assert.equal((await send({ n })).status, 200);
      assert.equal(beh.ran.length, 3, String(fn));
      assert.equal([...h.hub.limiter.buckets.keys()].some((k) => k.startsWith('integration_user_cmd|')), false);
      assert.equal(rateAudit(h, conn).length, 0);
    } finally { await h.close(); }
  }
  // The same rig with a valid subject is limited: the cases above were not.
  const { h, beh, send } = await cmdSetup({ hubOpts: { config: { rateLimits: { integration_user_cmd: { capacity: 1, per_ms: 60_000 } } } } });
  try {
    beh.subject = () => 'U'.repeat(128);
    for (let n = 0; n < 3; n += 1) await send({ n });
    assert.deepEqual(beh.ran, [0]);
  } finally { await h.close(); }
});

test('C3 without ackBody: over the limit is 429 RATE_LIMITED with Retry-After over HTTP; a late connector too', async () => {
  const { h, beh, conn } = await cmdSetup({ over: { ackEarly: undefined, ackBody: undefined }, hubOpts: { config: { rateLimits: { integration_user_cmd: { capacity: 1, per_ms: 60_000 } } } } });
  try {
    const u = userOf();
    const post = (n) => fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers: { 'x-ok': '1', 'x-id': randomUUID(), 'content-type': 'application/json' }, body: JSON.stringify({ user: u, n }) });
    assert.equal((await post(1)).status, 200);
    const r = await post(2);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    const body = await r.json();
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.equal(JSON.stringify(body).includes(u), false);
    assert.deepEqual(beh.ran, [1]);
  } finally { await h.close(); }
});

test('C3 with ackBody but ackEarly() false for this delivery (a late one): over the limit is 429 RATE_LIMITED with Retry-After, never ackBody\'s 200; the lease is released', async () => {
  const { h, beh, conn } = await cmdSetup({ over: { ackEarly: ({ payload }) => payload.early === true }, hubOpts: { config: { rateLimits: { integration_user_cmd: { capacity: 1, per_ms: 60_000 } } } } });
  try {
    const u = userOf();
    const post = (body, id = randomUUID()) => fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers: { 'x-ok': '1', 'x-id': id, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ user: u, n: 1 })).status, 200);
    const id = randomUUID();
    const r = await post({ user: u, n: 2 }, id);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal((await r.json()).error.code, 'RATE_LIMITED');
    assert.equal(beh.acks.some((a) => a.rateLimited), false, 'ackBody is not asked for a late delivery');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM inbound_dedupe WHERE dedupe_key = ?', `${conn.id}:${id}`).n, 0, 'the lease was released');
    // An early one over the limit still gets ackBody's rateLimited answer.
    const e = await post({ user: u, n: 3, early: true });
    assert.equal(e.status, 200);
    assert.deepEqual(await e.json(), { text: 'Slow down a little.' });
    assert.deepEqual(beh.ran, [1]);
  } finally { await h.close(); }
});

test('C3 defineConnector: rateSubject is a function, for a connector that takes webhooks', () => {
  const beh = { ran: [], acks: [] };
  assert.throws(() => cmdConnector(beh, { rateSubject: 'user_id' }), /rateSubject/);
  assert.throws(() => defineConnector({ id: 'nohook', name: 'N', scopes: [], secrets: [], hosts: [], connect: { kind: 'token', verifyToken: async () => ({}) }, rateSubject: () => null }), /rateSubject/);
  assert.ok(cmdConnector(beh));
});

test('C3 the subject is never stored or logged: only its keyed hash is in the bucket key (no DB row, audit, journal or log line holds it)', async () => {
  const { h, conn, send, lines } = await cmdSetup({ hubOpts: { config: { rateLimits: { integration_user_cmd: { capacity: 2, per_ms: 60_000 } } } } });
  try {
    const u = userOf();
    for (let n = 0; n < 5; n += 1) await send({ user: u, n });
    const keys = [...h.hub.limiter.buckets.keys()].filter((k) => k.startsWith('integration_user_cmd|'));
    assert.deepEqual(keys, [`integration_user_cmd|${conn.id}|${h.hub.refHash(u)}`]);
    assert.equal(keys.some((k) => k.includes(u)), false);
    assert.equal(lines.join('\n').includes(u), false, 'no log line');
    for (const t of ['integration_audit', 'journal', 'inbound_dedupe', 'connections']) {
      assert.equal(JSON.stringify(h.db.all(`SELECT * FROM ${t}`)).includes(u), false, t);
    }
    assert.ok(lines.some((l) => /rate_limited/.test(typeof l === 'string' ? l : JSON.stringify(l))), 'refusals still counted in the log, by code');
  } finally { await h.close(); }
});
