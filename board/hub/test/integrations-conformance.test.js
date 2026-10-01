// Conformance: every connector the registry holds that trades a code
// (connect.exchange, identity.exchange) reads it from what the registry's
// callbacks hand over, the callback URL's URLSearchParams, and reaches its
// provider with it. The connectors come from the registry itself (the hub's
// own list plus the ones registered here), so a new connector is covered
// without editing this file; one that reads `query.code` off a plain object
// fails it (the second test proves the check can fail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { defineConnector } from '../integrations/connector.js';
import { connectorsFor } from '../integrations/index.js';
import { startHub } from './helpers.js';

const rnd = () => randomBytes(12).toString('hex');

// A Slack-shaped connector (prepare → pinned app, OAuth exchange, OIDC
// identity) that trades the code the way a real one does.
function slackShaped({ id = 'slk-shape', connectRead = (q) => q.get('code'), identityRead = (q) => q.get('code') } = {}) {
  return defineConnector({
    id, name: 'Slk', scopes: ['chat:write'], secrets: ['client_secret', 'bot_token'], hosts: ['slk.example'], workspaceUnique: true,
    connect: {
      kind: 'oauth',
      prepareInputs: ['config_token'],
      prepare: async () => ({ secrets: { client_secret: rnd() }, settings: { client_id: 'c1' }, match: { client_id: 'c1' } }),
      authorizeUrl: ({ state, provider }) => `https://slk.example/oauth/v2/authorize?client_id=${encodeURIComponent(provider.client_id)}&state=${encodeURIComponent(state)}`,
      async exchange({ query, fetch, provider, secrets }) {
        const res = await fetch('https://slk.example/api/oauth.v2.access', { method: 'POST', body: new URLSearchParams({ code: String(connectRead(query) ?? ''), client_id: String(provider.client_id), client_secret: String(secrets.client_secret ?? '') }) });
        if (!res.ok) throw new Error('exchange refused');
        return {};
      },
    },
    identity: {
      issuer: 'https://slk.example', jwksUrl: 'https://slk.example/openid/connect/keys', workspaceClaim: 'https://slk.example/team_id', subjectRe: /^U[A-Z0-9]{2,20}$/,
      authorizeUrl: ({ state, nonce, redirectUri }) => `https://slk.example/openid/connect/authorize?${new URLSearchParams({ state, nonce, redirect_uri: redirectUri })}`,
      async exchange({ query, fetch }) {
        const res = await fetch('https://slk.example/api/openid.connect.token', { method: 'POST', body: new URLSearchParams({ code: String(identityRead(query) ?? '') }) });
        if (!res.ok) throw new Error('exchange refused');
        return {};
      },
    },
    actions: {},
    verify: () => ({ ok: true, dedupe_key: randomUUID() }),
    handleWebhook: async () => {},
  });
}

// What the restricted fetch let through: every URL, header and body, as text.
async function hubWith(extra) {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    sent.push([String(url), JSON.stringify(init.headers ?? {}), init.body == null ? '' : String(init.body)].join('\n'));
    return new Response('{}', { status: 404 });
  };
  const h = await startHub({ fetchImpl });
  h.hub.setVaultKey(randomBytes(32));
  for (const c of extra) h.app.integrations.register(c);
  // The registry's own list, and the object behind each id: the hub's
  // connectors (as createApp registered them) and this file's.
  const objects = new Map([...connectorsFor(h.hub.config), ...extra].map((c) => [c.id, c]));
  const ids = h.app.integrations.connectors().map((c) => c.id).sort();
  assert.deepEqual(ids, [...objects.keys()].sort(), 'every registered connector is known here');
  return { h, reg: h.app.integrations, sent, objects, ids };
}

const placeholders = (conn) => Object.fromEntries(conn.secrets.map((k) => [k, rnd()]));
const stateIn = (u) => new URL(u).searchParams.get('state');

// A ready pending row (D97) of `conn`, as prepare would leave it, for its creator.
function readyPending(h, conn) {
  const id = randomUUID();
  const t = h.hub.iso();
  h.db.insert('integration_pending', { id, org_id: h.ids.org, provider: conn.id, created_by: h.ids.alice, created_at: t, expires_at: new Date(h.hub.wallMs() + 600_000).toISOString() });
  h.db.run('UPDATE integration_pending SET match = ?, settings = ? WHERE id = ?', JSON.stringify({ conformance: 'pending' }), '{}', id);
  for (const [kind, value] of Object.entries(placeholders(conn))) {
    const s = h.hub.vault.seal(id, kind, value);
    h.db.insert('integration_pending_secrets', { pending_id: id, kind, key_id: s.key_id, nonce: s.nonce, ciphertext: s.ciphertext, created_at: t });
  }
  return id;
}

// Each code-trading exchange of every registered connector, through the real
// callbacks → the ones that never reached their provider with the code.
async function unreadCodes({ h, reg, sent, objects, ids }) {
  const member = h.hub.member(h.ids.alice);
  const failed = [];
  for (const id of ids) {
    const conn = objects.get(id);
    if (typeof conn.connect.exchange === 'function') {
      const pending = conn.connect.prepare ? readyPending(h, conn) : null;
      const out = pending
        ? reg.pendingAuthorize({ member, id: pending, publicUrl: h.base })
        : reg.oauthStart({ member, provider: id, publicUrl: h.base });
      const state = stateIn(out.url ?? out.form.action);
      assert.ok(state, `${id}: the start carries its state`);
      const code = rnd();
      const query = new URLSearchParams({ state, code });
      await reg.oauthCallback({ provider: id, query, publicUrl: h.base, bindCookie: out.bind });
      // One pending row per admin: the next prepare connector needs the slot.
      if (pending) h.db.run('DELETE FROM integration_pending WHERE id = ?', pending);
      if (!sent.some((x) => x.includes(code))) failed.push(`${id}:connect`);
    }
    if (typeof conn.identity?.exchange === 'function') {
      const c = reg.createConnection({
        external_id: `W${rnd()}`, display_name: 'Conformance', scopes: [], secrets: placeholders(conn),
        settings: { provider: {}, pinned: { client_id: 'conformance-client' } }, orgId: h.ids.org, memberId: h.ids.alice, provider: id,
      });
      const out = await reg.identityStart({ member, connectionId: c.id, publicUrl: h.base });
      const code = rnd();
      await reg.identityCallback({ provider: id, query: new URLSearchParams({ state: stateIn(out.url), code }), publicUrl: h.base, bindCookie: out.bind, ip: '203.0.113.9' });
      if (!sent.some((x) => x.includes(code))) failed.push(`${id}:identity`);
    }
  }
  return failed;
}

test('conformance: every registered connector (GitHub, the fake one, a Slack-shaped one) reads the code from the callback\'s URLSearchParams and reaches its provider with it', async () => {
  const env = await hubWith([slackShaped()]);
  try {
    assert.ok(env.ids.includes('github') && env.ids.includes('fake') && env.ids.includes('slk-shape'), env.ids.join());
    assert.deepEqual(await unreadCodes(env), []);
    // Each trade really ran: GitHub's manifest conversion, Slack's two token endpoints.
    for (const want of [/^https:\/\/api\.github\.com\/app-manifests\/[0-9a-f]{24}\/conversions$/m, /^https:\/\/slk\.example\/api\/oauth\.v2\.access$/m, /^https:\/\/slk\.example\/api\/openid\.connect\.token$/m]) {
      assert.ok(env.sent.some((x) => want.test(x)), String(want));
    }
  } finally { await env.h.close(); }
});

test('conformance: a connector that reads the code off a plain object fails the check (connect and identity apart)', async () => {
  const plain = (q) => q?.code;
  const env = await hubWith([
    slackShaped({ id: 'plain-connect', connectRead: plain }),
    slackShaped({ id: 'plain-identity', identityRead: plain }),
  ]);
  try {
    assert.deepEqual((await unreadCodes(env)).sort(), ['plain-connect:connect', 'plain-identity:identity']);
  } finally { await env.h.close(); }
});
