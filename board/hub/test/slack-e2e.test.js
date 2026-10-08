// The Slack connector end to end on a real hub: the real registry and
// connector (index.js) from setup to cards. The connection is made the D97
// way (POST prepare → the OAuth callback promotes the pending row when
// exchange's match equals what prepare pinned), and alice links her Slack
// account the D98 way (identity start → callback; the registry verifies the
// RS256 id_token against the fake slack.com JWKS). Behind the registry's
// checked fetch, a fake slack.com / hooks.slack.com.
//
// Two layers:
//   - "registry e2e": deliveries through reg.webhook() (verify → parseBody →
//     lease → ackEarly / ackBody → handler) with the registry's own ctx.
//   - "shim e2e": slack-shim.js's shimPipeline around the same registry ctx,
//     which exposes the handler's outcome (dead letters, settled promise).
// Secrets, keys and tokens are made at run time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign } from 'node:crypto';
import connector from '../integrations/slack/index.js';
import { spec } from '../integrations/slack/spec.js';
import { startHub } from './helpers.js';
import { createIntegrations } from '../integrations/registry.js';
import { Api } from '../api.js';
import {
  raw, fixture, signed, interactionBody, commandBody, fakeSlack, shimPipeline, botToken, signingSecret, clientSecret, nowS, TEAM, APP, CONFIG, PINNED, MARKERS,
} from './slack-shim.js';
import { UNLINKED, VIEWER, INACTIVE, FAILED, SLOW } from '../integrations/slack/spec.js';

const TODO_MARKER = 'slackfixture-marker-todo-4b1e';
const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = `kid-${randomBytes(4).toString('hex')}`;
const TEAM_CLAIM = 'https://slack.com/team_id';
const b64 = (x) => Buffer.from(x).toString('base64url');
function idToken(claims) {
  const input = `${b64(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`;
  return `${input}.${b64(cryptoSign('RSA-SHA256', Buffer.from(input), KEY.privateKey))}`;
}

// slack.com's connect and identity answers, from what the test controls.
function answers(env) {
  return (method, init) => {
    if (env.providerAnswer) { const own = env.providerAnswer(method, init); if (own !== undefined) return own; }
    const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    if (method === 'apps.manifest.create') {
      env.manifests.push(JSON.parse(form.get('manifest')));
      return { ok: true, app_id: APP, credentials: { client_id: CONFIG.client_id, client_secret: env.secrets.client_secret, signing_secret: env.secrets.signing_secret, verification_token: 'v' } };
    }
    if (method === 'oauth.v2.access') return { ...fixture('oauth-v2-access.json'), access_token: env.secrets.bot_token, app_id: env.installedApp };
    if (method === 'openid.connect.token') {
      const t = Math.floor(env.h.hub.wallMs() / 1000);
      return { ok: true, access_token: 'opaque', token_type: 'Bearer', id_token: idToken({ iss: 'https://slack.com', aud: CONFIG.client_id, sub: env.linkAs, [TEAM_CLAIM]: TEAM, nonce: env.nonce, iat: t, exp: t + 300 }) };
    }
    if (method === '/openid/connect/keys') return { keys: [{ ...KEY.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] };
    return undefined;
  };
}

/** A dev hub with the real Slack connector; nothing connected yet. */
async function bare({ installedApp = APP, fail = {}, config = {} } = {}) {
  const env = { manifests: [], nonce: null, linkAs: 'U0ALICE', installedApp, secrets: { bot_token: botToken(), signing_secret: signingSecret(), client_secret: clientSecret() } };
  env.slack = fakeSlack({ answer: answers(env), fail });
  env.h = await startHub({ fetchImpl: env.slack.fetch, config });
  env.h.hub.setVaultKey(randomBytes(32));
  env.reg = env.h.app.integrations;
  env.reg.register(connector);
  env.alice = await env.h.login('alice');
  return env;
}

const prepare = (env, target, input) => env.h.api(env.alice, 'POST', `/api/integrations/${target}/prepare`, { request_id: randomUUID(), input });
const pasted = (env) => ({ app_id: APP, client_id: CONFIG.client_id, client_secret: env.secrets.client_secret, signing_secret: env.secrets.signing_secret });
async function callback(env, prepared, path = 'callback', code = '1234.5678.abcd') {
  const res = await fetch(`${env.h.base}/integrations/slack/${path}?${new URLSearchParams({ state: new URL(prepared.body.url).searchParams.get('state'), code })}`, { headers: { cookie: prepared.headers.get('set-cookie').split(';')[0] } });
  return { status: res.status, text: await res.text() };
}
const connRow = (env, id) => env.h.db.get('SELECT * FROM connections WHERE id = ?', id);

/** A member links their Slack account through the real identity flow → the start response. */
async function linkAlice(env, cookie = env.alice, subject = 'U0ALICE') {
  env.linkAs = subject;
  const s = await env.h.api(cookie, 'POST', `/api/integrations/${env.conn.id}/identity/start`, { request_id: randomUUID() });
  assert.equal(s.status, 200, s.text);
  env.nonce = new URL(s.body.url).searchParams.get('nonce');
  const out = await callback(env, s, 'identity/callback', '99.88.ff');
  assert.equal(out.status, 200, out.text);
  assert.match(out.text, /data-connect="ok"/);
  return s;
}

/** Connected with a pasted-in config token, and alice linked. */
async function hub(opts) {
  const env = await bare(opts);
  const p = await prepare(env, 'slack', { config_token: randomBytes(16).toString('hex') });
  assert.equal(p.status, 200, p.text);
  const cb = await callback(env, p);
  assert.equal(cb.status, 200, cb.text);
  env.conn = { id: p.body.pending.id };
  env.reg.setSettings(env.conn.id, { target_board_id: env.h.ids.board, config: { channel_id: 'C0CHAN1' } });
  env.identityStart = await linkAlice(env);
  env.setupCalls = env.slack.calls.splice(0);
  const { h, reg, conn } = env;
  env.ctxOf = () => reg.ctxFor(conn.id);
  env.cards = () => h.db.all("SELECT id, board_id, key, title, body, labels, created_by FROM cards WHERE labels LIKE '%via:slack%' ORDER BY created_at, rowid");
  env.links = () => h.db.all('SELECT card_id, kind, external_id, url FROM external_links WHERE connection_id = ?', conn.id).map((l) => ({ ...l }));
  // Everything the hub keeps about these flows, as one string to grep.
  env.kept = () => JSON.stringify({
    journal: h.db.all('SELECT * FROM journal'), audit: h.db.all('SELECT * FROM integration_audit'),
    links: env.links(), dedupe: h.db.all('SELECT * FROM inbound_dedupe'), connections: h.db.all('SELECT * FROM connections'),
    requests: h.db.all('SELECT * FROM integration_requests'),
  });
  // The connection's own audit, without the identity link it starts with.
  env.audit = () => reg.audit(conn.id).filter((a) => a.action !== 'identity.link');
  return env;
}

function shim(env) {
  const p = shimPipeline(spec, { secrets: env.secrets, ctxOf: env.ctxOf });
  const send = async (body, opts) => {
    const r = await p.deliver(signed(env.secrets.signing_secret, body, opts));
    if (r.settled) await r.settled;
    return r;
  };
  return { ...p, send };
}

const submissionFrom = (env, viewsOpenCall, { board, trigger } = {}) => {
  const view = JSON.parse(viewsOpenCall.body).view;
  const p = fixture('view-submission.json');
  p.view.private_metadata = view.private_metadata;
  p.view.state.values.board_block.board.selected_option.value = board ?? env.h.ids.board;
  if (trigger) p.trigger_id = trigger;
  return interactionBody(p);
};

test('shim e2e: /plex todo from a linked user → empty early ack → one card as that member; a replay is a duplicate', async () => {
  const env = await hub();
  const { send } = shim(env);
  try {
    const r = await send(raw('slash-command-todo.form'));
    assert.deepEqual([r.status, r.early, r.body], [200, true, undefined], 'acked before the handler, with an empty body');
    const [card] = env.cards();
    assert.equal(env.cards().length, 1);
    assert.equal(card.title, `Draft the launch post ${TODO_MARKER}`);
    assert.equal(card.board_id, env.h.ids.board);
    assert.equal(card.created_by, env.h.ids.alice);
    assert.deepEqual(JSON.parse(card.labels), ['via:slack']);
    const [reply] = env.slack.replies();
    assert.equal(reply.response_type, 'ephemeral');
    // No link: a dev hub has no BOARD_PUBLIC_URL, so ctx.hubUrl is null (C1).
    assert.equal(reply.text, `Created ${card.key}: Draft the launch post ${TODO_MARKER}`);
    assert.equal((await send(raw('slash-command-todo.form'))).duplicate, true);
    assert.equal(env.cards().length, 1);
    assert.deepEqual(env.audit().map((a) => [a.action, a.decision]), [['slack.create_card', 'auto']]);
  } finally { await env.h.close(); }
});

test('shim e2e: the same command handled twice (a manual redelivery) still makes one card (durable request_id)', async () => {
  const env = await hub();
  try {
    const payload = spec.parseBody({ rawBody: raw('slash-command-todo.form'), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    await spec.handleWebhook({ payload, ctx: env.ctxOf() });
    await spec.handleWebhook({ payload, ctx: env.ctxOf() });
    assert.equal(env.cards().length, 1);
  } finally { await env.h.close(); }
});

test('shim e2e: an unlinked Slack user creates nothing and gets one ephemeral via hooks.slack.com', async () => {
  const env = await hub();
  const { send } = shim(env);
  try {
    await send(commandBody({ user_id: 'U0NOBODY', user_name: 'nobody' }));
    assert.equal(env.cards().length, 0);
    assert.equal(env.slack.calls.length, 1);
    assert.equal(env.slack.calls[0].host, 'hooks.slack.com');
    assert.match(env.slack.replies()[0].text, /^Link your Slack account/);
  } finally { await env.h.close(); }
});

test('shim e2e T3: a correctly signed payload naming another team or app creates nothing and fails as wrong_workspace', async () => {
  const env = await hub();
  const { send, deadLetters } = shim(env);
  try {
    assert.equal((await send(commandBody({ team_id: 'T0OTHER', api_app_id: 'A0OTHER' }))).status, 200);
    assert.equal((await send(commandBody({ api_app_id: 'A0OTHER', trigger_id: '9.9.00000000000000000000000000000000' }))).status, 200);
    assert.deepEqual(deadLetters, ['wrong_workspace', 'wrong_workspace']);
    assert.equal(env.cards().length, 0);
    assert.ok(env.slack.calls.every((c) => c.host === 'hooks.slack.com'), 'no Slack API call');
    assert.deepEqual(env.slack.replies().map((r) => r.text), [FAILED, FAILED], 'only onAckedFailure\'s fixed refusal');
  } finally { await env.h.close(); }
});

test('shim e2e C1: a PATCH can\'t set hub_url or ids (configKeys); the card link comes only from the real registry\'s ctx.hubUrl', async () => {
  const env = await hub();
  try {
    for (const config of [{ hub_url: 'https://evil-phish.example/login' }, { team_id: 'T0OTHER' }, { app_id: 'A0OTHER1' }, { client_id: '1.2' }]) {
      assert.throws(() => env.reg.setSettings(env.conn.id, { config }), (e) => e.code === 'VALIDATION', JSON.stringify(config));
    }
    const before = JSON.parse(connRow(env, env.conn.id).settings);
    await shim(env).send(raw('slash-command-todo.form'));
    const [card] = env.cards();
    assert.equal(env.slack.replies()[0].text, `Created ${card.key}: Draft the launch post ${TODO_MARKER}`, 'a dev hub: no ctx.hubUrl, no link');
    assert.deepEqual(JSON.parse(connRow(env, env.conn.id).settings), before);
    // The same connection through a registry booted with an https BOARD_PUBLIC_URL.
    const reg = createIntegrations({ hub: env.h.hub, api: new Api(env.h.hub), log: null, fetchImpl: env.slack.fetch, publicUrl: 'https://board.example.test' });
    reg.register(connector);
    assert.equal(reg.ctxFor(env.conn.id).hubUrl, 'https://board.example.test');
    const p = shimPipeline(spec, { secrets: env.secrets, ctxOf: () => reg.ctxFor(env.conn.id) });
    const r = await p.deliver(signed(env.secrets.signing_secret, commandBody({ text: 'todo linked card', trigger_id: '7.7.00000000000000000000000000000077' })));
    assert.equal(await r.settled, null, String(p.deadLetters));
    const second = env.cards().at(-1);
    assert.equal(env.slack.replies().at(-1).text, `Created <https://board.example.test/#card=${second.id}|${second.key}>: linked card`);
    assert.doesNotMatch(JSON.stringify(env.slack.calls), /evil-phish/);
  } finally { await env.h.close(); }
});

test('shim e2e T1/T2: forged, stale and future requests are refused before anything runs', async () => {
  const env = await hub();
  const { deliver } = shim(env);
  try {
    const body = raw('slash-command-todo.form');
    assert.equal((await deliver(signed(env.secrets.signing_secret, body, { sig: `v0=${'0'.repeat(64)}` }))).status, 401);
    assert.equal((await deliver(signed(signingSecret(), body))).status, 401);
    assert.equal((await deliver(signed(env.secrets.signing_secret, body, { ts: nowS() - 301 }))).status, 401);
    assert.equal((await deliver(signed(env.secrets.signing_secret, body, { ts: nowS() + 301 }))).status, 401);
    assert.equal(env.cards().length, 0);
  } finally { await env.h.close(); }
});

test('shim e2e: shortcut → modal → submit makes one card with the permalink and a thread link; a second submit is the same card', async () => {
  const env = await hub();
  const { send } = shim(env);
  try {
    const opened = await send(interactionBody(fixture('message-action.json')));
    assert.deepEqual([opened.status, opened.body], [200, undefined]);
    const [call] = env.slack.api('views.open');
    assert.ok(call, 'views.open');
    assert.equal(env.cards().length, 0);

    const first = await send(submissionFrom(env, call));
    assert.deepEqual([first.status, first.body], [200, undefined]);
    const [card] = env.cards();
    assert.equal(env.cards().length, 1);
    assert.equal(card.title, 'Fix the <flaky> login test');
    assert.equal(card.body, 'From Slack: https://acme.slack.com/archives/C0CHAN1/p1759312700000200');
    assert.deepEqual(env.links(), [{ card_id: card.id, kind: 'thread', external_id: 'C0CHAN1:1759312700.000200', url: 'https://acme.slack.com/archives/C0CHAN1/p1759312700000200' }]);
    const eph = JSON.parse(env.slack.api('chat.postEphemeral')[0].body);
    assert.equal(eph.text, `Created ${card.key}: Fix the &lt;flaky&gt; login test`);

    await send(submissionFrom(env, call, { trigger: '13345224699.8534564899.ffeeddccbbaa99887766554433221100' }));
    assert.equal(env.cards().length, 1, 'the msg:<channel>:<ts> request id returns the same card');
    assert.equal(env.links().length, 1);
  } finally { await env.h.close(); }
});

test('shim e2e T10: a submit with tampered private_metadata creates nothing', async () => {
  const env = await hub();
  const { send, deadLetters } = shim(env);
  try {
    await send(interactionBody(fixture('message-action.json')));
    const call = env.slack.api('views.open')[0];
    const view = JSON.parse(call.body).view;
    const [b, mac] = view.private_metadata.split('.');
    const moved = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url')), c: 'C0PRIVATE' })).toString('base64url');
    const p = fixture('view-submission.json');
    p.view.private_metadata = `${moved}.${mac}`;
    p.view.state.values.board_block.board.selected_option.value = env.h.ids.board;
    await send(interactionBody(p));
    assert.deepEqual(deadLetters, ['bad_metadata']);
    assert.equal(env.cards().length, 0);
    assert.equal(env.slack.api('chat.getPermalink').length, 0);
  } finally { await env.h.close(); }
});

test('shim e2e T12: the journal, audit, links, dedupe and connection rows hold no Slack message text, author id, token or response_url', async () => {
  const env = await hub();
  const { send } = shim(env);
  try {
    await send(raw('slash-command-todo.form'));
    await send(interactionBody(fixture('message-action.json')));
    await send(submissionFrom(env, env.slack.api('views.open')[0]));
    await send(interactionBody(fixture('block-actions.json')));
    assert.equal(env.cards().length, 2);
    const kept = env.kept();
    for (const m of [...MARKERS, TODO_MARKER, 'U0BOBBYX', 'hooks.slack.com', 'login test', env.secrets.bot_token, env.secrets.signing_secret, env.secrets.client_secret]) {
      assert.ok(!kept.includes(m), `kept rows contain ${m}`);
    }
    // Cards hold only what a person typed or confirmed, and the permalink.
    const cardText = JSON.stringify(env.cards());
    for (const m of [...MARKERS, 'U0BOBBYX', 'U0CAROL']) assert.ok(!cardText.includes(m), m);
  } finally { await env.h.close(); }
});

// ── through the real registry ─────────────────────────────────────────────

const realHub = hub;
const send = async (env, body, opts) => {
  const r = await env.reg.webhook(env.conn.id, signed(env.secrets.signing_secret, body, opts));
  await Promise.all([...env.h.hub.inflight]);
  return r;
};
// An early ack comes back as {raw, type} (registry earlyAck), not as body.
const emptyAck = (r) => r.status === 200 && (r.raw === '' || r.raw === undefined) && r.body === undefined;
const ackJson = (r) => (typeof r.raw === 'string' && r.raw ? JSON.parse(r.raw) : null);

test('registry e2e: /plex todo → empty early ack → one card as the linked member; a replay is a duplicate', async () => {
  const env = await realHub();
  try {
    const r = await send(env, raw('slash-command-todo.form'));
    assert.ok(emptyAck(r), JSON.stringify(r));
    assert.equal(env.cards().length, 1);
    assert.equal(env.cards()[0].created_by, env.h.ids.alice);
    assert.equal((await send(env, raw('slash-command-todo.form'))).body?.duplicate, true);
    assert.equal(env.cards().length, 1);
  } finally { await env.h.close(); }
});

test('registry e2e: /plex help is answered in the ack itself', async () => {
  const env = await realHub();
  try {
    const r = await send(env, commandBody({ text: 'help' }));
    assert.equal(r.status, 200);
    assert.match(r.type, /^application\/json/);
    assert.equal(ackJson(r)?.response_type, 'ephemeral');
    assert.equal(env.slack.calls.length, 0);
  } finally { await env.h.close(); }
});

test('registry e2e: shortcut → modal → submit, twice, makes one card with a thread link', async () => {
  const env = await realHub();
  try {
    assert.ok(emptyAck(await send(env, interactionBody(fixture('message-action.json')))));
    const call = env.slack.api('views.open')[0];
    assert.ok(emptyAck(await send(env, submissionFrom(env, call))));
    await send(env, submissionFrom(env, call, { trigger: '13345224699.8534564899.ffeeddccbbaa99887766554433221100' }));
    assert.equal(env.cards().length, 1);
    assert.equal(env.links().length, 1);
  } finally { await env.h.close(); }
});

test('registry e2e T3: another team\'s signed payload → no card, health wrong_workspace, audited failed', async () => {
  const env = await realHub();
  try {
    assert.equal((await send(env, commandBody({ team_id: 'T0OTHER', api_app_id: 'A0OTHER' }))).status, 200);
    assert.equal(env.cards().length, 0);
    assert.equal(env.reg.get(env.conn.id).health.last_error, 'wrong_workspace');
    assert.deepEqual(env.audit().map((a) => [a.action, a.decision, a.error]), [['webhook', 'failed', 'wrong_workspace']]);
  } finally { await env.h.close(); }
});

test('registry e2e C1: config never binds: even a raw config naming another team, app and client id leaves ours working and theirs refused', async () => {
  const env = await realHub();
  try {
    assert.throws(() => env.reg.setSettings(env.conn.id, { config: { team_id: 'T0OTHER' } }), (e) => e.code === 'VALIDATION');
    const s = JSON.parse(connRow(env, env.conn.id).settings);
    env.h.db.run('UPDATE connections SET settings = ? WHERE id = ?', JSON.stringify({ ...s, config: { ...CONFIG, channel_id: 'C0CHAN1', team_id: 'T0OTHER', app_id: 'A0OTHER1', client_id: '1.2', hub_url: 'https://evil-phish.example/login' } }), env.conn.id);
    assert.equal((await send(env, commandBody({ team_id: 'T0OTHER', api_app_id: 'A0OTHER1', text: 'todo from another workspace' }))).status, 200);
    assert.equal(env.cards().length, 0);
    assert.equal(env.reg.get(env.conn.id).health.last_error, 'wrong_workspace');
    assert.ok(emptyAck(await send(env, raw('slash-command-todo.form'))));
    assert.equal(env.cards().length, 1, 'our own workspace still binds through external_id and provider');
    assert.doesNotMatch(JSON.stringify(env.slack.calls), /evil-phish/);
  } finally { await env.h.close(); }
});

test('registry e2e C1 fail closed: a connection without settings.provider (made before 026) creates nothing; health reconnect_required; one fixed reply', async () => {
  const env = await realHub();
  try {
    const legacy = env.reg.createConnection({ orgId: env.h.ids.org, memberId: env.h.ids.alice, provider: 'slack', external_id: 'T0LEGACY', secrets: { bot_token: env.secrets.bot_token, signing_secret: env.secrets.signing_secret } });
    const id = legacy?.id ?? legacy;
    assert.equal(JSON.parse(connRow(env, id).settings).provider, undefined);
    const r = await env.reg.webhook(id, signed(env.secrets.signing_secret, commandBody({ team_id: 'T0LEGACY' })));
    await Promise.all([...env.h.hub.inflight]);
    assert.ok(emptyAck(r));
    assert.equal(env.cards().length, 0);
    assert.equal(env.reg.get(id).health.last_error, 'reconnect_required');
    assert.deepEqual(env.slack.replies().map((x) => x.text), [FAILED]);
    assert.throws(() => env.h.db.run('UPDATE connections SET settings = json_set(settings, \'$.provider\', json(\'{"app_id":"A0APP01","client_id":"1.2"}\')) WHERE id = ?', id), /provider never changes/, '026: a provider can\'t be added later');
  } finally { await env.h.close(); }
});

test('registry e2e F-3: a Slack Connect user on the shortcut gets one private answer; health stays ok and nothing is audited', async () => {
  const env = await realHub();
  try {
    const p = { ...fixture('message-action.json'), user: { id: 'U0EXT', name: 'ext', team_id: 'T0EXTERNAL' } };
    assert.equal((await send(env, interactionBody(p))).status, 200);
    assert.notEqual(env.reg.get(env.conn.id).health?.ok, false);
    assert.deepEqual(env.audit(), []);
    assert.deepEqual(env.slack.replies().map((r) => r.text), ['Only members of this workspace can use Plexiform.']);
  } finally { await env.h.close(); }
});

test('registry e2e F3: a Slack Connect /plex command (their home team, our app) gets EXTERNAL; health stays ok and nothing is audited', async () => {
  const env = await realHub();
  try {
    assert.ok(emptyAck(await send(env, raw('slash-command-connect.form'))));
    assert.notEqual(env.reg.get(env.conn.id).health?.ok, false);
    assert.deepEqual(env.audit(), []);
    assert.deepEqual(env.slack.replies().map((r) => r.text), ['Only members of this workspace can use Plexiform.']);
    assert.equal(env.cards().length, 0);
  } finally { await env.h.close(); }
});

test('registry e2e F2: a form submitted after the hour is answered "expired" in the ack; health stays ok, no dead letter, no card', async () => {
  const env = await realHub();
  const { sealMeta } = await import('../integrations/slack/webhook.js');
  try {
    const p = fixture('view-submission.json');
    p.view.private_metadata = sealMeta(env.secrets.signing_secret, { team: TEAM, channel: 'C0CHAN1', ts: '1759312700.000200', user: 'U0ALICE' }, Date.now() - 61 * 60_000);
    p.view.state.values.board_block.board.selected_option.value = env.h.ids.board;
    const r = await send(env, interactionBody(p));
    assert.deepEqual(ackJson(r), { response_action: 'errors', errors: { title_block: 'This form expired. Use the shortcut again.' } });
    assert.notEqual(env.reg.get(env.conn.id).health?.ok, false);
    assert.deepEqual(env.audit(), []);
    assert.equal(env.cards().length, 0);
    assert.equal(env.slack.calls.length, 0);
  } finally { await env.h.close(); }
});

test('shim e2e C2: alice (who connected) demoted after actorOf said yes → the real bound() throws ACTOR_UNAVAILABLE scope connection; she is told VIEWER, then it surfaces as actor_unavailable', async () => {
  const env = await realHub();
  try {
    // actorOf ran before the demotion: a ctx whose memberFor still names alice.
    const ctxOf = () => ({ ...env.ctxOf(), memberFor: () => env.h.ids.alice });
    const p = shimPipeline(spec, { secrets: env.secrets, ctxOf });
    env.h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", env.h.ids.bob);
    env.h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", env.h.ids.alice);
    const r = await p.deliver(signed(env.secrets.signing_secret, raw('slash-command-todo.form')));
    await r.settled;
    assert.deepEqual(p.deadLetters, ['actor_unavailable']);
    assert.equal(env.cards().length, 0);
    assert.deepEqual(env.slack.replies().map((x) => x.text), [VIEWER], 'one answer: onAckedFailure stays quiet for actor_unavailable');
    assert.deepEqual(env.audit().map((a) => [a.action, a.decision, a.error]), [['slack.create_card', 'failed', 'actor_unavailable']]);
  } finally { await env.h.close(); }
});

test('shim e2e C2: a linked member (not the connector) demoted or removed mid-request → ACTOR_UNAVAILABLE scope member, answered VIEWER / INACTIVE; nothing thrown', async () => {
  for (const [change, want] of [["UPDATE members SET role = 'viewer' WHERE id = ?", VIEWER], ['UPDATE members SET removed_at = 1 WHERE id = ?', INACTIVE]]) {
    const env = await realHub();
    try {
      await linkAlice(env, await env.h.login('bob'), 'U0BOB');
      const ctxOf = () => ({ ...env.ctxOf(), memberFor: (s) => (s === 'U0BOB' ? env.h.ids.bob : null) });
      const p = shimPipeline(spec, { secrets: env.secrets, ctxOf });
      env.h.db.run(change, env.h.ids.bob);
      const r = await p.deliver(signed(env.secrets.signing_secret, commandBody({ user_id: 'U0BOB', user_name: 'bob' })));
      await r.settled;
      assert.deepEqual(p.deadLetters, [], change);
      assert.equal(env.cards().length, 0);
      assert.deepEqual(env.slack.replies().map((x) => x.text), [want], change);
    } finally { await env.h.close(); }
  }
});

test('registry e2e S-1: a linked viewer (bob, or alice who connected) gets VIEWER and no card through the real registry; nothing runs, health stays ok', async () => {
  const env = await realHub();
  try {
    await linkAlice(env, await env.h.login('bob'), 'U0BOB');
    env.slack.calls.splice(0);
    env.h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", env.h.ids.bob);
    assert.ok(emptyAck(await send(env, commandBody({ user_id: 'U0BOB', user_name: 'bob' }))));
    env.h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", env.h.ids.bob);
    env.h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", env.h.ids.alice);
    assert.ok(emptyAck(await send(env, raw('slash-command-todo.form'))));
    assert.ok(emptyAck(await send(env, interactionBody(fixture('message-action.json')))));
    assert.equal(env.cards().length, 0);
    assert.deepEqual(env.slack.replies().map((x) => x.text), [VIEWER, VIEWER, VIEWER]);
    assert.equal(env.slack.api('views.open').length, 0);
    assert.notEqual(env.reg.get(env.conn.id).health?.ok, false);
    assert.deepEqual(env.audit(), []);
    assert.ok(emptyAck(await send(env, commandBody({ user_id: 'U0NOBODY', user_name: 'nobody', trigger_id: '5.5.00000000000000000000000000000055' }))));
    assert.equal(env.slack.replies().at(-1).text, UNLINKED);
  } finally { await env.h.close(); }
});

test('registry e2e C2/S-2: an early-acked handler that fails gets one fixed "couldn\'t do that" via response_url; a replay of the same bytes is a duplicate and runs nothing', async () => {
  const env = await hub({ fail: { 'views.open': 'invalid_trigger_marker' } });
  try {
    const body = interactionBody(fixture('message-action.json'));
    const s = signed(env.secrets.signing_secret, body);
    assert.ok(emptyAck(await env.reg.webhook(env.conn.id, s)));
    await Promise.all([...env.h.hub.inflight]);
    assert.equal(env.slack.api('views.open').length, 1);
    assert.deepEqual(env.slack.replies(), [{ response_type: 'ephemeral', text: FAILED, unfurl_links: false, unfurl_media: false }]);
    assert.equal(env.slack.calls.at(-1).url, fixture('message-action.json').response_url);
    assert.doesNotMatch(JSON.stringify(env.slack.replies()), /invalid_trigger|provider_error|login test/);
    assert.deepEqual(env.audit().map((a) => [a.action, a.decision, a.error]), [['webhook', 'failed', 'provider_error']]);
    const replay = await env.reg.webhook(env.conn.id, s);
    await Promise.all([...env.h.hub.inflight]);
    assert.equal(replay.body?.duplicate, true);
    assert.equal(env.slack.api('views.open').length, 1, 'not run again');
    assert.equal(env.slack.replies().length, 1);
  } finally { await env.h.close(); }
});

test('registry e2e C3: rateSubject puts each Slack user on integration_user_cmd; over it the command and the modal say SLOW, nothing runs, the refusal is audited, and the same bytes run once under the limit', async () => {
  const env = await hub({ config: { rateLimits: { integration_user_cmd: { capacity: 2, per_ms: 60_000 } } } });
  try {
    const trig = (n) => `8.${n}.${'0'.repeat(30)}${String(n).padStart(2, '0')}`;
    for (const n of [1, 2]) assert.ok(emptyAck(await send(env, commandBody({ text: `todo card ${n}`, trigger_id: trig(n) }))));
    assert.equal(env.cards().length, 2);
    const third = commandBody({ text: `todo ${MARKERS[0]}`, trigger_id: trig(3) });
    const s = signed(env.secrets.signing_secret, third);
    const over = await env.reg.webhook(env.conn.id, s);
    await Promise.all([...env.h.hub.inflight]);
    assert.equal(over.status, 200);
    assert.deepEqual(ackJson(over), { response_type: 'ephemeral', text: SLOW }, 'what the user sees');
    assert.ok(!over.raw.includes(MARKERS[0]), 'nothing echoed');
    assert.equal(env.cards().length, 2);
    const p = fixture('view-submission.json');
    p.view.state.values.board_block.board.selected_option.value = env.h.ids.board;
    assert.deepEqual(ackJson(await send(env, interactionBody(p))), { response_action: 'errors', errors: { title_block: SLOW } });
    assert.ok(emptyAck(await send(env, interactionBody(fixture('message-action.json')))), 'a shortcut\'s ack can carry no text');
    assert.equal(env.slack.api('views.open').length, 0);
    assert.deepEqual(env.audit().map((a) => [a.action, a.decision, a.error]).filter(([a]) => a === 'webhook'), [['webhook', 'failed', 'rate_limited'], ['webhook', 'failed', 'rate_limited'], ['webhook', 'failed', 'rate_limited']]);
    assert.ok(!env.kept().includes('U0ALICE'), 'the subject is never stored');
    await linkAlice(env, await env.h.login('bob'), 'U0BOB');
    assert.ok(emptyAck(await send(env, commandBody({ user_id: 'U0BOB', user_name: 'bob', text: 'todo bob card', trigger_id: trig(4) }))), 'another user has their own bucket');
    assert.equal(env.cards().length, 3);
    env.h.clock.advance(60_000);
    const again = await env.reg.webhook(env.conn.id, s);
    await Promise.all([...env.h.hub.inflight]);
    assert.ok(emptyAck(again), 'released, not done: the same bytes run once under the limit');
    assert.equal(env.cards().length, 4);
  } finally { await env.h.close(); }
});

test('registry e2e: a paused connection never reaches handleWebhook (the registry answers as for an unknown id), and a handler run on its ctx anyway acts as nobody', async () => {
  const env = await realHub();
  try {
    const before = env.h.db.get('SELECT COUNT(*) AS n FROM integration_audit').n;
    env.h.db.run("UPDATE connections SET status = 'paused' WHERE id = ?", env.conn.id);
    for (const body of [commandBody({ text: 'todo while paused' }), interactionBody(fixture('message-action.json'))]) {
      const r = await send(env, body);
      assert.equal(r.status, 404);
      assert.equal(r.live, undefined);
    }
    assert.equal(env.reg.webhookTarget(env.conn.id), false);
    assert.deepEqual([env.cards().length, env.slack.calls.length, env.h.db.get('SELECT COUNT(*) AS n FROM integration_audit').n - before], [0, 0, 0]);
    // Past the registry (a handler already running when the pause landed): no card, no form.
    const ctx = env.ctxOf();
    assert.equal(ctx.memberFor('U0ALICE'), null);
    const p = shimPipeline(spec, { secrets: env.secrets, ctxOf: () => ctx });
    await p.deliver(signed(env.secrets.signing_secret, commandBody({ text: 'todo while paused' })));
    await p.deliver(signed(env.secrets.signing_secret, interactionBody(fixture('message-action.json'))));
    await Promise.all([...env.h.hub.inflight]);
    assert.deepEqual([env.cards().length, env.slack.api('views.open').length, env.slack.api('chat.getPermalink').length], [0, 0, 0]);
  } finally { await env.h.close(); }
});

test('registry e2e T1/T2: forged and out-of-window requests are 401', async () => {
  const env = await realHub();
  try {
    assert.equal((await send(env, raw('slash-command-todo.form'), { sig: `v0=${'0'.repeat(64)}` })).status, 401);
    assert.equal((await send(env, raw('slash-command-todo.form'), { ts: nowS() - 301 })).status, 401);
    assert.equal((await send(env, raw('slash-command-todo.form'), { ts: nowS() + 301 })).status, 401);
  } finally { await env.h.close(); }
});

test('registry e2e T12: no message text, author id, token or response_url in the journal, audit or links', async () => {
  const env = await realHub();
  try {
    await send(env, raw('slash-command-todo.form'));
    await send(env, interactionBody(fixture('message-action.json')));
    await send(env, submissionFrom(env, env.slack.api('views.open')[0]));
    const kept = env.kept();
    assert.equal(env.cards().length, 2);
    for (const m of [...MARKERS, TODO_MARKER, 'U0BOBBYX', 'hooks.slack.com', 'login test', ...Object.values(env.secrets)]) assert.ok(!kept.includes(m), m);
  } finally { await env.h.close(); }
});

// ── setup: D97 prepare → pending → promotion, and the D98 link ───────────────

test('registry e2e D97/D98: a config token makes the app (both callbacks, openid); the callback promotes it with settings.pinned; the link uses the same identity redirect and the pinned client id', async () => {
  const env = await hub();
  try {
    const id = env.conn.id;
    const [m] = env.manifests;
    assert.equal(env.manifests.length, 1);
    assert.deepEqual(m.oauth_config.redirect_urls, [`${env.h.base}/integrations/slack/callback`, env.reg.identityRedirectUri(env.h.base, id)]);
    assert.deepEqual(m.oauth_config.scopes, { bot: ['chat:write', 'commands'], user: ['openid'] });
    assert.equal(m.settings.interactivity.request_url, `${env.h.base}/integrations/${id}/webhook`, 'the pending id is the connection id');
    const start = new URL(env.identityStart.body.url);
    assert.equal(`${start.origin}${start.pathname}`, 'https://slack.com/openid/connect/authorize');
    assert.equal(start.searchParams.get('redirect_uri'), m.oauth_config.redirect_urls[1], 'exactly the redirect prepare put in the manifest');
    assert.equal(start.searchParams.get('client_id'), PINNED.client_id);
    assert.equal(start.searchParams.get('team'), TEAM);
    assert.ok(env.nonce, 'the registry\'s nonce reaches Slack');
    assert.deepEqual(env.setupCalls.map((c) => c.method), ['apps.manifest.create', 'oauth.v2.access', 'openid.connect.token', '/openid/connect/keys'], 'no userInfo read, no auth.revoke');
    const basic = `Basic ${Buffer.from(`${PINNED.client_id}:${env.secrets.client_secret}`).toString('base64')}`;
    assert.equal(env.setupCalls[1].headers.authorization, basic, 'the install trades the code with the pending client secret');
    assert.equal(env.setupCalls[2].headers.authorization, basic, 'so does the link, with the client secret promotion carried over');

    const row = connRow(env, id);
    const settings = JSON.parse(row.settings);
    assert.deepEqual([row.status, row.external_id], ['active', TEAM]);
    assert.deepEqual(settings.pinned, { ...PINNED });
    assert.deepEqual({ ...settings.provider }, { bot_user_id: 'U0BOT001', ...PINNED }, 'C1: prepare, exchange and match in provider; no team_id, and no hub_url on a hub without BOARD_PUBLIC_URL');
    assert.deepEqual(settings.config, { channel_id: 'C0CHAN1' }, 'only the explicit opted channel in config');
    assert.equal(env.h.db.get('SELECT COUNT(*) AS n FROM integration_pending').n, 0, 'the pending row is gone');
    const [link] = env.h.db.all('SELECT provider, workspace_id, subject, member_id, connection_id, verified_via FROM external_identities');
    assert.deepEqual({ ...link }, { provider: 'slack', workspace_id: TEAM, subject: 'U0ALICE', member_id: env.h.ids.alice, connection_id: id, verified_via: 'oauth_link' });
    assert.equal(env.ctxOf().memberFor('U0ALICE'), env.h.ids.alice);

    // A settings PATCH can't move the pinned app or provider; the connection still binds and answers.
    env.reg.setSettings(id, { target_board_id: env.h.ids.board, config: { channel_id: 'C0CHAN1' } });
    assert.deepEqual(JSON.parse(connRow(env, id).settings).pinned, { ...PINNED });
    assert.deepEqual(JSON.parse(connRow(env, id).settings).provider, settings.provider);
    assert.throws(() => env.reg.setSettings(id, { config: { client_id: '1.2' } }), (e) => e.code === 'VALIDATION');
    assert.ok(emptyAck(await send(env, raw('slash-command-todo.form'))));
    assert.equal(env.cards().length, 1);
  } finally { await env.h.close(); }
});

test('registry e2e D97 handshake: nothing pasted → needs; once the app is pasted the pending id answers only a verified url_verification, in plain text', async () => {
  const env = await bare();
  try {
    const first = await prepare(env, 'slack', undefined);
    assert.equal(first.status, 200, first.text);
    const id = first.body.pending.id;
    assert.deepEqual(first.body.needs.fields, ['app_id', 'client_id', 'client_secret', 'signing_secret']);
    const create = new URL(first.body.needs.create_url);
    assert.equal(`${create.origin}${create.pathname}`, 'https://api.slack.com/apps');
    const m = JSON.parse(create.searchParams.get('manifest_json'));
    assert.deepEqual(m.oauth_config.redirect_urls, [`${env.h.base}/integrations/slack/callback`, `${env.h.base}/integrations/slack/identity/callback`]);
    assert.equal(m.settings.interactivity.request_url, `${env.h.base}/integrations/${id}/webhook`);

    const post = async (secret, body) => {
      const s = signed(secret, body);
      const r = await fetch(`${env.h.base}/integrations/${id}/webhook`, { method: 'POST', headers: s.headers, body: s.rawBody });
      return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
    };
    const uv = raw('url-verification.json');
    const before = await post(env.secrets.signing_secret, uv);
    assert.equal(before.status, 404, 'no secrets yet: nothing answers');

    const second = await prepare(env, id, pasted(env));
    assert.equal(second.status, 200, second.text);
    assert.equal(new URL(second.body.url).searchParams.get('client_id'), PINNED.client_id);
    const ok = await post(env.secrets.signing_secret, uv);
    assert.equal(ok.status, 200);
    assert.match(ok.type, /^text\/plain/);
    assert.equal(ok.text, fixture('url-verification.json').challenge);
    for (const [secret, body] of [
      [env.secrets.signing_secret, raw('slash-command-todo.form')],
      [env.secrets.signing_secret, interactionBody(fixture('message-action.json'))],
      [signingSecret(), uv],
    ]) {
      const r = await post(secret, body);
      assert.deepEqual([r.status, r.text], [404, before.text], 'anything else is the unknown-id 404');
    }
    assert.equal(env.h.db.get('SELECT COUNT(*) AS n FROM connections').n, 0, 'never promoted by a delivery');
    assert.equal(env.slack.calls.length, 0, 'pasting and the handshake call nothing at Slack');
  } finally { await env.h.close(); }
});

test('registry e2e D97: an install whose app_id is not the pinned one is refused; nothing is connected', async () => {
  const env = await bare({ installedApp: 'A0OTHER1' });
  try {
    const p = await prepare(env, 'slack', pasted(env));
    assert.equal(p.status, 200, p.text);
    const cb = await callback(env, p);
    assert.match(cb.text, /does not match the one being set up/);
    assert.ok(!cb.text.includes('A0OTHER1'), 'fixed text only');
    assert.ok(!connRow(env, p.body.pending.id));
    assert.equal(env.h.db.get('SELECT COUNT(*) AS n FROM connections').n, 0);
    assert.equal(env.h.db.get('SELECT COUNT(*) AS n FROM connection_secrets').n, 0, 'the bot token is not kept');
  } finally { await env.h.close(); }
});

// Current selected intake; these use the actual registry/API/SQLite queue.
for (const target of [null, 'archived']) test(`selected intake: ${target ?? 'unset'} target pauses without falling back`, async () => {
  const env = await hub();
  try {
    if (target === 'archived') env.h.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', env.h.hub.iso(), env.h.ids.board);
    else env.h.db.run('UPDATE connections SET target_board_id = ? WHERE id = ?', target, env.conn.id);
    await send(env, raw('slash-command-todo.form'));
    await send(env, interactionBody(fixture('message-action.json')));
    assert.equal(env.cards().length, 0); assert.equal(env.links().length, 0);
    assert.equal(env.slack.api('views.open').length, 0);
    assert.equal(env.audit().length, 0, 'missing selection never reaches mutation');
  } finally { await env.h.close(); }
});

test('selected intake: command and shortcut in another channel are refused without provider reads or cards', async () => {
  const env = await hub();
  try {
    await send(env, commandBody({ channel_id: 'C0OTHER', trigger_id: '1000.2000.abcdefabcdefabcdef' }));
    const p = fixture('message-action.json'); p.channel.id = 'C0OTHER';
    await send(env, interactionBody(p));
    assert.equal(env.cards().length + env.links().length, 0);
    assert.equal(env.slack.api('views.open').length + env.slack.api('chat.getPermalink').length, 0);
    assert.equal(env.slack.replies().length, 2);
  } finally { await env.h.close(); }
});

for (const change of ['channel', 'target', 'autonomy', 'linked-member']) test(`selected modal: ${change} change between open and submit refuses the stale form`, async () => {
  const env = await hub();
  try {
    await send(env, interactionBody(fixture('message-action.json')));
    const call = env.slack.api('views.open')[0];
    assert.deepEqual(JSON.parse(call.body).view.blocks[1].element.options.map(o => o.value), [env.h.ids.board]);
    if (change === 'channel') env.reg.setSettings(env.conn.id, { config: { channel_id: 'C0OTHER' } });
    if (change === 'target') env.h.db.run('UPDATE connections SET target_board_id = NULL WHERE id = ?', env.conn.id);
    if (change === 'autonomy') env.reg.setSettings(env.conn.id, { autonomy: { 'slack.create_card': 'off' } });
    if (change === 'linked-member') { const row = env.h.db.get('SELECT * FROM external_identities WHERE connection_id = ? AND subject = ?', env.conn.id, 'U0ALICE'); env.h.db.run('DELETE FROM external_identities WHERE connection_id = ? AND subject = ?', env.conn.id, 'U0ALICE'); env.h.db.insert('external_identities', { ...row, member_id: env.h.ids.bob }); }
    await send(env, submissionFrom(env, call));
    assert.equal(env.cards().length + env.links().length, 0);
    assert.equal(env.slack.api('chat.getPermalink').length, 0);
    assert.match(JSON.parse(env.slack.api('chat.postEphemeral').at(-1).body).text, /connection changed/);
  } finally { await env.h.close(); }
});

for (const change of ['pause', 'autonomy', 'channel', 'target', 'archive', 'creator', 'creator-user', 'linked-member', 'linked-user', 'unlink', 'demote', 'remove']) test(`selected queue: ${change} revocation after API admission leaves zero card/link/receipt effects`, async () => {
  const env = await hub();
  let release, delivery, admitted;
  const original = env.h.app.api.createCard;
  try {
    await linkAlice(env, await env.h.login('bob'), 'U0BOB');
    const selected = env.h.ids.board;
    const held = env.h.hub.withBoard(selected, () => new Promise(r => { release = r; }));
    await new Promise(r => setImmediate(r));
    const entering = new Promise(r => { admitted = r; });
    env.h.app.api.createCard = function (...args) { const result = original.apply(this, args); admitted(); return result; };
    delivery = send(env, commandBody({ user_id: 'U0BOB', user_name: 'bob', trigger_id: '1000.3000.abcdefabcdefabcdef' }));
    await entering;
    const settings = connRow(env, env.conn.id).settings;
    const creator = env.h.hub.member(env.h.ids.alice), linked = env.h.hub.member(env.h.ids.bob);
    const replacement = randomUUID(); env.h.db.insert('users', { id: replacement, display_name: 'Synthetic replacement', created_at: env.h.hub.iso() });
    if (change === 'pause') env.h.db.run("UPDATE connections SET status = 'paused' WHERE id = ?", env.conn.id);
    if (change === 'autonomy') env.reg.setSettings(env.conn.id, { autonomy: { 'slack.create_card': 'off' } });
    if (change === 'channel') env.reg.setSettings(env.conn.id, { config: { channel_id: 'C0OTHER' } });
    if (change === 'target') env.h.db.run('UPDATE connections SET target_board_id = NULL WHERE id = ?', env.conn.id);
    if (change === 'archive') env.h.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', env.h.hub.iso(), selected);
    if (change === 'creator') env.h.db.run('UPDATE connections SET created_by = ? WHERE id = ?', env.h.ids.bob, env.conn.id);
    if (change === 'creator-user') env.h.db.run('UPDATE members SET user_id = ? WHERE id = ?', replacement, env.h.ids.alice);
    if (change === 'linked-member') { const row = env.h.db.get('SELECT * FROM external_identities WHERE connection_id = ? AND subject = ?', env.conn.id, 'U0BOB'); env.h.db.run('DELETE FROM external_identities WHERE connection_id = ? AND subject = ?', env.conn.id, 'U0BOB'); env.h.db.run('DELETE FROM external_identities WHERE connection_id = ? AND member_id = ?', env.conn.id, env.h.ids.alice); env.h.db.insert('external_identities', { ...row, member_id: env.h.ids.alice }); }
    if (change === 'linked-user') env.h.db.run('UPDATE members SET user_id = ? WHERE id = ?', replacement, env.h.ids.bob);
    if (change === 'unlink') env.h.db.run('DELETE FROM external_identities WHERE connection_id = ? AND subject = ?', env.conn.id, 'U0BOB');
    if (change === 'demote') env.h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", env.h.ids.bob);
    if (change === 'remove') env.h.db.run('UPDATE members SET removed_at = 1 WHERE id = ?', env.h.ids.bob);
    release(); await held; await delivery;
    assert.equal(env.cards().length + env.links().length, 0);
    assert.equal(env.h.db.get('SELECT count(*) n FROM integration_requests WHERE connection_id=?', env.conn.id).n, 0);
    // Restore only these synthetic rows, then deliver a genuinely fresh command.
    env.h.db.run("UPDATE connections SET status='active', created_by=?, target_board_id=?, settings=? WHERE id=?", env.h.ids.alice, selected, settings, env.conn.id);
    env.h.db.run('UPDATE boards SET archived_at=NULL WHERE id=?', selected);
    env.h.db.run('UPDATE members SET user_id=?, role=?, removed_at=NULL WHERE id=?', creator.user_id, creator.role, creator.id);
    env.h.db.run('UPDATE members SET user_id=?, role=?, removed_at=NULL WHERE id=?', linked.user_id, linked.role, linked.id);
    env.h.db.run('DELETE FROM external_identities WHERE connection_id = ? AND subject = ?', env.conn.id, 'U0BOB');
    await linkAlice(env, await env.h.login('bob'), 'U0BOB');
    await send(env, commandBody({ user_id: 'U0BOB', trigger_id: '1000.4000.abcdefabcdefabcdef' }));
    assert.equal(env.cards().length, 1, 'restored current authority permits one fresh delivery');
  } finally { release?.(); if (delivery) await delivery; env.h.app.api.createCard = original; await env.h.close(); }
});

test('selected intake: actual loopback command and shortcut ingress preserve signed early acknowledgements', async () => {
  const env = await hub();
  const post = async (body, duplicate = false) => {
    const req = signed(env.secrets.signing_secret, body);
    const res = await fetch(`${env.h.base}/integrations/${env.conn.id}/webhook`, { method: 'POST', headers: req.headers, body: req.rawBody });
    assert.equal(res.status, 200); const text = await res.text(); if (duplicate) assert.deepEqual(JSON.parse(text), { ok: true, duplicate: true }); else assert.equal(text, '');
    await Promise.all([...env.h.hub.inflight]);
  };
  try {
    await post(raw('slash-command-todo.form'));
    await post(interactionBody(fixture('message-action.json')));
    await post(submissionFrom(env, env.slack.api('views.open')[0]));
    assert.equal(env.cards().length, 2); assert.equal(env.links().length, 1);
    await post(submissionFrom(env, env.slack.api('views.open')[0]), true);
    assert.equal(env.cards().length, 2);
  } finally { await env.h.close(); }
});

for (const change of ['channel', 'target', 'pause', 'unlink', 'demote', 'linked-user', 'creator-user']) test(`selected permalink await: ${change} change refuses all mutation`, async () => {
  const env = await hub(); let release, delivery;
  try {
    await linkAlice(env, await env.h.login('bob'), 'U0BOB');
    const shortcut = fixture('message-action.json'); shortcut.user.id = 'U0BOB';
    await send(env, interactionBody(shortcut));
    let enter; const entered = new Promise(r => { enter = r; }); const held = new Promise(r => { release = r; });
    env.providerAnswer = method => method === 'chat.getPermalink' ? (enter(), held.then(() => ({ ok: true, permalink: 'https://acme.slack.com/archives/C0CHAN1/p1759312700000200' }))) : undefined;
    const submit = spec.parseBody({ rawBody: submissionFrom(env, env.slack.api('views.open')[0]), headers: { 'content-type': 'application/x-www-form-urlencoded' } }).body; submit.user.id = 'U0BOB';
    delivery = send(env, interactionBody(submit));
    await entered;
    if (change === 'channel') env.reg.setSettings(env.conn.id, { config: { channel_id: 'C0OTHER' } });
    if (change === 'target') env.h.db.run('UPDATE connections SET target_board_id=NULL WHERE id=?', env.conn.id);
    if (change === 'pause') env.h.db.run("UPDATE connections SET status='paused' WHERE id=?", env.conn.id);
    if (change === 'unlink') env.h.db.run('DELETE FROM external_identities WHERE connection_id=?', env.conn.id);
    if (change === 'demote') env.h.db.run("UPDATE members SET role='viewer' WHERE id=?", env.h.ids.bob);
    if (change === 'linked-user' || change === 'creator-user') { const user = randomUUID(); env.h.db.insert('users', { id: user, display_name: 'Synthetic replacement', created_at: env.h.hub.iso() }); env.h.db.run('UPDATE members SET user_id=? WHERE id=?', user, change === 'linked-user' ? env.h.ids.bob : env.h.ids.alice); }
    release(); await delivery;
    assert.equal(env.cards().length + env.links().length, 0);
    assert.equal(env.h.db.get('SELECT count(*) n FROM integration_requests WHERE connection_id=?', env.conn.id).n, 0);
  } finally { release?.(); if (delivery) await delivery; await env.h.close(); }
});

test('selected intake: a missing or foreign board cannot be installed as a current target', async () => {
  const env = await hub();
  try {
    assert.throws(() => env.reg.setSettings(env.conn.id, { target_board_id: 'missing-board' }), e => e.code === 'NOT_FOUND');
    assert.equal(connRow(env, env.conn.id).target_board_id, env.h.ids.board);
    assert.equal(env.cards().length + env.links().length, 0);
  } finally { await env.h.close(); }
});

test('durable selected message receipt survives a fresh hub process composition and ignores a second confirmed title', async () => {
  const env = await hub(); let restarted;
  try {
    await send(env, interactionBody(fixture('message-action.json')));
    const call = env.slack.api('views.open')[0]; const body = submissionFrom(env, call);
    await send(env, body); assert.equal(env.cards().length, 1);
    const prior = env.cards()[0]; const key = env.h.hub.vaultKey;
    // Retain the synthetic database; a new application/registry has no D8 memory.
    await env.h.close();
    restarted = await startHub({ dataDir: env.h.dataDir, fetchImpl: env.slack.fetch });
    restarted.hub.setVaultKey(key); restarted.app.integrations.register(connector);
    const ctx = restarted.app.integrations.ctxFor(env.conn.id);
    const payload = spec.parseBody({ rawBody: body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    payload.body.view.state.values.title_block.title.value = 'A different confirmed title';
    await spec.handleWebhook({ payload, ctx });
    assert.equal(restarted.db.get("SELECT count(*) n FROM cards WHERE labels LIKE '%via:slack%'").n, 1);
    assert.equal(restarted.db.get('SELECT title FROM cards WHERE id=?', prior.id).title, prior.title);
    assert.equal(restarted.db.get('SELECT count(*) n FROM external_links WHERE connection_id=?', env.conn.id).n, 1);
    assert.match(JSON.parse(env.slack.api('chat.postEphemeral').at(-1).body).text, /Already on the board/);
  } finally { if (restarted) await restarted.close(); else await env.h.close(); }
});

test('selected Slack configuration is admin-only through the actual HTTP settings boundary', async () => {
  const env = await hub();
  try {
    const before = connRow(env, env.conn.id);
    const res = await env.h.api(await env.h.login('bob'), 'PATCH', `/api/integrations/${env.conn.id}`, { request_id: randomUUID(), config: { channel_id: 'C0OTHER' }, target_board_id: null });
    assert.equal(res.status, 403);
    assert.deepEqual(connRow(env, env.conn.id), before);
    assert.equal((await env.h.api(env.alice, 'PATCH', `/api/integrations/${env.conn.id}`, { request_id: randomUUID(), config: { channel_id: 'C0OTHER' } })).status, 200);
    await send(env, raw('slash-command-todo.form')); assert.equal(env.cards().length, 0);
  } finally { await env.h.close(); }
});

test('failed card storage leaves no receipt/link/card and a fresh delivery succeeds after storage restoration', async () => {
  const env = await hub();
  try {
    env.h.db.run("CREATE TEMP TRIGGER slack_synthetic_storage_failure BEFORE INSERT ON cards BEGIN SELECT RAISE(ABORT, 'synthetic storage unavailable'); END");
    await send(env, raw('slash-command-todo.form'));
    assert.equal(env.cards().length + env.links().length, 0);
    assert.equal(env.h.db.get('SELECT count(*) n FROM integration_requests WHERE connection_id=?', env.conn.id).n, 0);
    assert.deepEqual(env.slack.replies().map(r => r.text), [FAILED]);
    env.h.db.run('DROP TRIGGER slack_synthetic_storage_failure');
    await send(env, commandBody({ trigger_id: '1000.5500.abcdefabcdefabcdef' }));
    assert.equal(env.cards().length, 1);
  } finally { await env.h.close(); }
});

test('thread-link storage failure retains the durable card; fresh confirmed delivery repairs the same link', async () => {
  const env = await hub();
  try {
    await send(env, interactionBody(fixture('message-action.json')));
    const call = env.slack.api('views.open')[0];
    env.h.db.run("CREATE TEMP TRIGGER slack_synthetic_link_failure BEFORE INSERT ON external_links BEGIN SELECT RAISE(ABORT, 'synthetic link storage unavailable'); END");
    await send(env, submissionFrom(env, call));
    assert.equal(env.cards().length, 1); assert.equal(env.links().length, 0);
    assert.equal(env.h.db.get('SELECT count(*) n FROM integration_requests WHERE connection_id=?', env.conn.id).n, 1);
    env.h.db.run('DROP TRIGGER slack_synthetic_link_failure');
    await send(env, submissionFrom(env, call, { trigger: '1000.6600.abcdefabcdefabcdef' }));
    assert.equal(env.cards().length, 1); assert.equal(env.links().length, 1);
  } finally { await env.h.close(); }
});

test('explicit selected board overrides alphabetically earlier boards and a forged modal choice never broadens it', async () => {
  const env = await hub();
  try {
    const created = await env.h.api(env.alice, 'POST', '/api/boards', { request_id: randomUUID(), name: 'Z selected Slack board' });
    assert.equal(created.status, 200, created.text);
    const board = created.body.board.id;
    env.reg.setSettings(env.conn.id, { target_board_id: board });
    await send(env, raw('slash-command-todo.form'));
    assert.equal(env.cards()[0].board_id, board);
    await send(env, interactionBody(fixture('message-action.json')));
    const call = env.slack.api('views.open')[0];
    assert.deepEqual(JSON.parse(call.body).view.blocks[1].element.options.map(o => o.value), [board]);
    await send(env, submissionFrom(env, call, { board: env.h.ids.board }));
    assert.equal(env.cards().length, 1); assert.equal(env.links().length, 0);
    assert.equal(env.slack.api('chat.getPermalink').length, 0);
    await send(env, submissionFrom(env, call, { board, trigger: '1000.7700.abcdefabcdefabcdef' }));
    assert.equal(env.cards().length, 2); assert.equal(env.links().length, 1);
    assert.ok(env.cards().every(c => c.board_id === board));
  } finally { await env.h.close(); }
});

test('completed command result rechecks captured principal before disclosing card details', async () => {
  const env = await hub(); const create = env.h.app.api.createCard; let release, delivery;
  try {
    await linkAlice(env, await env.h.login('bob'), 'U0BOB');
    let enter; const entered = new Promise(r => { enter = r; }); const held = new Promise(r => { release = r; });
    env.h.app.api.createCard = async function (...args) { const out = await create.apply(this, args); enter(); await held; return out; };
    delivery = send(env, commandBody({ user_id: 'U0BOB' })); await entered;
    const user = randomUUID(); env.h.db.insert('users', { id: user, display_name: 'Synthetic replacement', created_at: env.h.hub.iso() }); env.h.db.run('UPDATE members SET user_id=? WHERE id=?', user, env.h.ids.bob);
    release(); await delivery;
    assert.equal(env.cards().length, 1, 'card committed under the original current principal');
    assert.deepEqual(env.slack.replies().map(r => r.text), [INACTIVE], 'no stale title/card key exposed after completion');
  } finally { release?.(); if (delivery) await delivery; env.h.app.api.createCard = create; await env.h.close(); }
});


test('command reply reflects a current human edit after card commit and before API return', async () => {
  const env = await hub();
  const original = env.h.app.api.createCard;
  let release, delivery;
  try {
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    env.h.app.api.createCard = async function (...args) {
      const out = await original.apply(this, args);
      enter(); await held; return out;
    };
    delivery = env.reg.webhook(env.conn.id, signed(env.secrets.signing_secret, commandBody({ text: 'todo Old command title' })));
    await delivery; await entered;
    const card = env.cards()[0];
    const edit = await env.h.api(env.alice, 'PATCH', `/api/cards/${card.id}`, {
      request_id: randomUUID(), version: env.h.hub.card(card.id).version, title: 'Human <corrected> & current title',
    });
    assert.equal(edit.status, 200, edit.text);
    release(); await Promise.all([...env.h.hub.inflight]);
    assert.equal(env.cards()[0].title, 'Human <corrected> & current title');
    assert.equal(env.slack.replies().at(-1).text, `Already on the board as ${card.key}: Human &lt;corrected&gt; &amp; current title`);
    assert.equal(env.cards().length, 1);
  } finally {
    release?.(); if (delivery) await delivery; await Promise.all([...env.h.hub.inflight]);
    env.h.app.api.createCard = original; await env.h.close();
  }
});

test('fresh command replay returns current edited title without replacing human card content', async () => {
  const env = await hub();
  try {
    const { send } = shim(env);
    await send(commandBody({ text: 'todo Original command title', trigger_id: '111.222.replay' }));
    const card = env.cards()[0];
    const edit = await env.h.api(env.alice, 'PATCH', `/api/cards/${card.id}`, {
      request_id: randomUUID(), version: env.h.hub.card(card.id).version, title: 'Human maintained title', body: 'Human maintained body',
    });
    assert.equal(edit.status, 200, edit.text);
    await send(commandBody({ text: 'todo A newly requested title', trigger_id: '111.222.replay' }));
    assert.equal(env.cards().length, 1);
    assert.equal(env.cards()[0].title, 'Human maintained title');
    assert.equal(env.cards()[0].body, 'Human maintained body');
    assert.equal(env.slack.replies().at(-1).text, `Already on the board as ${card.key}: Human maintained title`);
  } finally { await env.h.close(); }
});
