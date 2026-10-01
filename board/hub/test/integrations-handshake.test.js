// The pending handshake (D97, slice B3) and amendment 4: a ready pending id
// answers exactly one delivery, a url_verification whose signature verifies
// under that row's own secrets, with its challenge and nothing else done.
// Every other webhook to an id that is not a live connection (unknown,
// revoked, pending but not ready, expired, deleted) is one byte-identical
// 404, reached after the same body read and an HMAC over the body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { request } from 'node:http';
import { defineConnector } from '../integrations/connector.js';
import { startHub } from './helpers.js';
import { createLogger } from '../log.js';

// Token-shaped strings are built at runtime (no secret-shaped literals in the repo).
const configToken = () => ['xoxe', '1', randomBytes(20).toString('hex').toUpperCase()].join('-');
const APP = { app_id: 'A0HAND1', client_id: '333.444' };

// Slack's scheme: v0=HMAC(signing secret, "v0:<ts>:<raw body>"), ±5 min.
const sigOf = (secret, ts, raw) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;

function handSpec(beh, { id = 'hand', handshake, ackBody, prepare = true } = {}) {
  return {
    id, name: 'Hand', scopes: ['chat:write'], secrets: ['client_secret', 'signing_secret', 'bot_token'], hosts: ['api.hand.example', 'hand.example'],
    workspaceUnique: true,
    connect: {
      kind: 'oauth',
      ...(prepare ? {
        prepareInputs: ['config_token'],
        async prepare({ input, fetch }) {
          if (!input.config_token) return { needs: { fields: ['config_token'], create_url: 'https://hand.example/apps?new_app=1' } };
          const b = await (await fetch('https://api.hand.example/apps.manifest.create', { method: 'POST', body: '{}' })).json();
          return { secrets: { client_secret: b.client_secret, signing_secret: b.signing_secret }, settings: { app_id: b.app_id, client_id: b.client_id }, match: { app_id: b.app_id, client_id: b.client_id } };
        },
      } : {}),
      authorizeUrl: ({ state, config }) => `https://hand.example/authorize?client_id=${encodeURIComponent(config.client_id ?? '')}&state=${encodeURIComponent(state)}`,
      async exchange({ config }) {
        return { external_id: 'T1', display_name: 'Hand workspace', scopes: ['chat:write'], secrets: { bot_token: `bot${randomBytes(8).toString('hex')}` }, match: { app_id: config.app_id, client_id: config.client_id } };
      },
      ...(handshake === undefined ? { handshake: ({ payload }) => payload.type === 'url_verification' } : handshake ? { handshake } : {}),
    },
    verify({ headers, rawBody, secrets, now }) {
      beh.verified.push(secrets.signing_secret);
      const ts = Number(headers['x-hand-ts']);
      if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return { ok: false, reason: 'stale' };
      const want = Buffer.from(sigOf(secrets.signing_secret ?? '', ts, rawBody));
      const got = Buffer.from(String(headers['x-hand-signature'] ?? ''));
      if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'bad signature' };
      return { ok: true, dedupe_key: `${ts}:${headers['x-hand-signature']}` };
    },
    parseBody: ({ rawBody }) => JSON.parse(rawBody.toString('utf8')),
    async handleWebhook({ payload }) { beh.handled.push(payload.type); },
    ackEarly: ({ payload }) => payload.type === 'url_verification',
    ackBody: ackBody ?? (({ payload }) => {
      if (beh.ackThrows) throw new Error(`ack failed ${payload.challenge}`);
      return payload.challenge;
    }),
  };
}
const handConnector = (beh, opts) => defineConnector(handSpec(beh, opts));

async function setup({ config, connector } = {}) {
  const beh = { issued: [], verified: [], handled: [] };
  const lines = [];
  const fetchImpl = async () => {
    const signing_secret = `ssec${randomBytes(12).toString('hex')}`;
    beh.issued.push(signing_secret);
    return new Response(JSON.stringify({ ok: true, ...APP, client_secret: `csec${randomBytes(8).toString('hex')}`, signing_secret }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const h = await startHub({
    config: { ...config, rateLimits: { integration_prepare_member: { capacity: 1000, per_ms: 3_600_000 }, integration_prepare_org: { capacity: 1000, per_ms: 86_400_000 }, ...config?.rateLimits } },
    fetchImpl, log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }),
  });
  h.hub.setVaultKey(randomBytes(32));
  const reg = h.app.integrations;
  reg.register(connector ? connector(beh) : handConnector(beh));
  const alice = await h.login('alice');
  return { h, reg, beh, lines, alice };
}

const otherAdmin = async (h) => {
  const org = randomUUID();
  h.db.insert('orgs', { id: org, name: `other-${org.slice(0, 6)}`, created_at: h.hub.iso() });
  const login = `dave${randomBytes(3).toString('hex')}`;
  h.db.insert('members', { id: randomUUID(), org_id: org, github_id: -Math.floor(Math.random() * 1e6) - 10, github_login: login, email: `${login}@dev.local`, display_name: login, role: 'owner', created_at: h.hub.iso() });
  return h.login(login);
};

// → {id, secret, state, cookie}: a ready pending row and its signing secret.
const ready = async (h, beh, cookie, input = { config_token: configToken() }) => {
  const r = await h.api(cookie, 'POST', '/api/integrations/hand/prepare', { request_id: randomUUID(), input });
  assert.equal(r.status, 200, r.text);
  return { id: r.body.pending.id, secret: input.config_token ? beh.issued.at(-1) : null, state: r.body.url ? new URL(r.body.url).searchParams.get('state') : null, cookie: r.body.url ? r.headers.get('set-cookie').split(';')[0] : null };
};

const nowTs = () => Math.floor(Date.now() / 1000);
const challengeOf = () => `ch${randomBytes(12).toString('hex')}`;
// → the request a sender makes: {raw, headers} signed with `secret` (none: unsigned).
const signed = (payload, secret, { ts = nowTs(), raw = JSON.stringify(payload) } = {}) => ({
  raw, headers: { 'content-type': 'application/json', 'x-hand-ts': String(ts), ...(secret ? { 'x-hand-signature': sigOf(secret, ts, raw) } : {}) },
});
const send = (h, id, { raw, headers }) => fetch(`${h.base}/integrations/${id}/webhook`, { method: 'POST', headers, body: raw });
const norm = async (res) => ({ status: res.status, body: await res.text(), headers: [...res.headers].filter(([k]) => k !== 'date') });
const verification = (challenge = challengeOf()) => ({ token: 'legacy', challenge, type: 'url_verification' });

// Every table, every row: "nothing written" means this is unchanged.
const snapshot = (h) => {
  const out = {};
  for (const { name } of h.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    out[name] = JSON.stringify(h.db.all(`SELECT * FROM "${name}"`));
  }
  return out;
};
const bucketKeys = (h) => [...h.hub.limiter.buckets.keys()].sort();

// ── the one answer ────────────────────────────────────────────────────────

test('a correctly signed url_verification to a ready pending row → 200, exactly the challenge as text/plain; nothing written, no rate bucket, no handler, never promoted', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const p = await ready(h, beh, alice);
    const challenge = challengeOf();
    const before = snapshot(h);
    const buckets = bucketKeys(h);
    const res = await send(h, p.id, signed(verification(challenge), p.secret));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(await res.text(), challenge);
    assert.deepEqual(beh.verified, [p.secret], 'verify() saw the pending row\'s own secret');
    await h.hub.idle();
    assert.deepEqual(beh.handled, []);
    assert.deepEqual(snapshot(h), before, 'no table changed (journal, integration_audit, inbound_dedupe, connections, pending rows…)');
    assert.deepEqual(bucketKeys(h), buckets, 'no rate bucket taken (webhook_conn, webhook_fail_ip)');
    assert.equal(reg.list(h.ids.org).length, 0, 'not promoted');
    assert.ok(h.db.get('SELECT id FROM integration_pending WHERE id = ?', p.id));
    // The registry answers the same, without the HTTP layer.
    const s = signed(verification(challenge), p.secret);
    assert.deepEqual(await reg.webhook(p.id, { headers: s.headers, rawBody: Buffer.from(s.raw) }), { status: 200, raw: challenge, type: 'text/plain; charset=utf-8' });
  } finally { await h.close(); }
});

test('forged url_verification (no signature, bad signature, wrong secret, another pending row\'s secret, an old timestamp) → the unknown-id 404 byte for byte; nothing written', async () => {
  const { h, beh, alice } = await setup();
  try {
    const p = await ready(h, beh, alice);
    const q = await ready(h, beh, await otherAdmin(h));
    assert.notEqual(p.secret, q.secret);
    const unknown = await norm(await send(h, randomUUID(), signed(verification(), p.secret)));
    assert.equal(unknown.status, 404);
    const before = snapshot(h);
    const forged = [
      signed(verification(), null),
      { ...signed(verification(), p.secret), headers: { ...signed(verification(), p.secret).headers, 'x-hand-signature': `v0=${'0'.repeat(64)}` } },
      signed(verification(), `ssec${randomBytes(12).toString('hex')}`),
      signed(verification(), q.secret),
      signed(verification(), p.secret, { ts: nowTs() - 600 }),
    ];
    for (const [i, f] of forged.entries()) assert.deepEqual(await norm(await send(h, p.id, f)), unknown, `forgery ${i}`);
    assert.deepEqual(snapshot(h), before);
    assert.ok(!bucketKeys(h).some((k) => k.includes(p.id) || k.includes(q.id)), 'no bucket keyed on a pending id');
    assert.equal((await send(h, p.id, signed(verification(), p.secret))).status, 200, 'the row still answers its own signature');
  } finally { await h.close(); }
});

test('a correctly signed delivery that is not a handshake (event_callback) → 404; nothing runs or is written', async () => {
  const { h, beh, alice } = await setup();
  try {
    const p = await ready(h, beh, alice);
    const unknown = await norm(await send(h, randomUUID(), signed({ type: 'event_callback' }, p.secret)));
    const before = snapshot(h);
    for (const payload of [{ type: 'event_callback', event: { type: 'message' } }, { type: 'URL_VERIFICATION', challenge: 'x' }, { challenge: 'x' }]) {
      assert.deepEqual(await norm(await send(h, p.id, signed(payload, p.secret))), unknown, JSON.stringify(payload));
    }
    // Not a plain object, or a poison key: parseBody's rule, before handshake is asked.
    for (const raw of ['[1]', 'not json', '{"__proto__":{"type":"url_verification"},"type":"url_verification","challenge":"x"}']) {
      assert.deepEqual(await norm(await send(h, p.id, signed(null, p.secret, { raw }))), unknown, raw);
    }
    await h.hub.idle();
    assert.deepEqual(beh.handled, []);
    assert.deepEqual(snapshot(h), before);
    assert.equal((await send(h, p.id, signed(verification(), p.secret))).status, 200, 'the same row answers its handshake');
  } finally { await h.close(); }
});

test('the challenge must be a string of 1–256 printable ASCII characters: too long, empty, non-printable, non-ASCII, not a string, or an ackBody throw → 404', async () => {
  const { h, beh, alice } = await setup();
  try {
    const p = await ready(h, beh, alice);
    const unknown = await norm(await send(h, randomUUID(), signed(verification(), p.secret)));
    for (const challenge of ['a'.repeat(257), '', 'ab\u0001c', 'tab\there', 'line\n', 'café', 42, { a: 1 }, ['x'], null, true]) {
      assert.deepEqual(await norm(await send(h, p.id, signed(verification(challenge), p.secret))), unknown, JSON.stringify(challenge));
    }
    const edge = '~'.repeat(256);
    const ok = await send(h, p.id, signed(verification(edge), p.secret));
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), edge, '256 printable characters is the limit');
    beh.ackThrows = true;
    assert.deepEqual(await norm(await send(h, p.id, signed(verification(), p.secret))), unknown, 'ackBody throws');
  } finally { await h.close(); }
});

test('handshake must return exactly true: a throw, a truthy non-true value or a Promise → 404', async () => {
  for (const handshake of [() => { throw new Error('nope'); }, () => 'yes', () => 1, async () => true, () => ({})]) {
    const { h, beh, alice } = await setup({ connector: (b) => handConnector(b, { handshake }) });
    try {
      const p = await ready(h, beh, alice);
      const unknown = await norm(await send(h, randomUUID(), signed(verification(), p.secret)));
      assert.deepEqual(await norm(await send(h, p.id, signed(verification(), p.secret))), unknown, String(handshake));
      assert.deepEqual(beh.verified, [p.secret], 'verified under the row\'s secret, then refused at handshake');
    } finally { await h.close(); }
  }
});

// ── amendment 4: one 404 for every non-connection id ──────────────────────

test('not-ready, expired, deleted, unknown and revoked ids, and a ready row of a connector without handshake: a byte-identical 404, each after the dummy HMAC over the body', async () => {
  const { h, reg, beh, alice } = await setup();
  const real = crypto.createHmac;
  const seen = [];
  try {
    const promoted = await ready(h, beh, await otherAdmin(h));
    const cb = await fetch(`${h.base}/integrations/hand/callback?${new URLSearchParams({ state: promoted.state, code: 'c' })}`, { headers: { cookie: promoted.cookie } });
    assert.equal(cb.status, 200, await cb.text());
    const revokeCookie = await h.login(h.db.get('SELECT m.github_login FROM members m JOIN connections c ON c.created_by = m.id WHERE c.id = ?', promoted.id).github_login);
    assert.equal((await h.api(revokeCookie, 'DELETE', `/api/integrations/${promoted.id}`, { request_id: randomUUID() })).status, 200);
    const notReady = await ready(h, beh, await otherAdmin(h), {});
    const deleted = await ready(h, beh, await otherAdmin(h));
    const delCookie = await h.login(h.db.get('SELECT m.github_login FROM members m JOIN integration_pending p ON p.created_by = m.id WHERE p.id = ?', deleted.id).github_login);
    assert.equal((await h.api(delCookie, 'DELETE', `/api/integrations/${deleted.id}`, { request_id: randomUUID() })).status, 200);
    const expiring = await ready(h, beh, alice);

    // The spy: every HMAC the hub computes over a body, by its bytes.
    crypto.createHmac = (...a) => {
      const m = real(...a);
      const up = m.update.bind(m);
      m.update = (d, ...r) => { seen.push(Buffer.from(d)); return up(d, ...r); };
      return m;
    };
    syncBuiltinESMExports();
    const ran = (raw) => seen.some((b) => b.includes(Buffer.from(raw)));
    const probe = async (id, secret = null) => {
      const s = signed({ ...verification(), marker: randomUUID() }, secret);
      const out = await norm(await send(h, id, s));
      return { out, hmac: ran(s.raw) };
    };
    const unknown = await probe(randomUUID());
    assert.equal(unknown.out.status, 404);
    assert.deepEqual(JSON.parse(unknown.out.body), { error: { code: 'NOT_FOUND', message: 'not found' } });
    assert.ok(unknown.hmac, 'the unknown id ran an HMAC over the body');
    for (const [name, id, secret] of [['revoked connection', promoted.id, promoted.secret], ['not ready', notReady.id, null], ['deleted', deleted.id, deleted.secret], ['ready, unsigned', expiring.id, null]]) {
      const r = await probe(id, secret);
      assert.deepEqual(r.out, unknown.out, name);
      assert.ok(r.hmac, `${name}: an HMAC over the body`);
    }
    h.clock.advance(3_600_001);
    const exp = await probe(expiring.id, expiring.secret);
    assert.deepEqual(exp.out, unknown.out, 'expired, signed with its own secret');
    assert.ok(exp.hmac);
    // In the registry too: one answer for all of them.
    const raw = Buffer.from('{"type":"url_verification","challenge":"x"}');
    const want = await reg.webhook(randomUUID(), { headers: {}, rawBody: raw });
    assert.deepEqual(want, { status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } });
    for (const id of [promoted.id, notReady.id, deleted.id, expiring.id]) assert.deepEqual(await reg.webhook(id, { headers: {}, rawBody: raw }), want, id);
  } finally {
    crypto.createHmac = real;
    syncBuiltinESMExports();
    await h.close();
  }
});

test('a ready pending row of a connector without handshake answers nothing, even a correctly signed url_verification', async () => {
  const { h, beh, alice } = await setup({ connector: (b) => handConnector(b, { handshake: null }) });
  try {
    const p = await ready(h, beh, alice);
    const unknown = await norm(await send(h, randomUUID(), signed(verification(), p.secret)));
    assert.deepEqual(await norm(await send(h, p.id, signed(verification(), p.secret))), unknown);
    assert.deepEqual(beh.verified, [], 'verify() never ran on a row that can\'t answer');
    assert.ok(bucketKeys(h).includes('webhook_fail_ip|-|127.0.0.1'), 'read and refused as a non-connection id');
  } finally { await h.close(); }
});

test('cross-org: each pending id answers only under its own row\'s secret; no org leaks either way', async () => {
  const { h, beh, alice } = await setup();
  try {
    const a = await ready(h, beh, alice);
    const b = await ready(h, beh, await otherAdmin(h));
    const unknown = await norm(await send(h, randomUUID(), signed(verification(), b.secret)));
    assert.deepEqual(await norm(await send(h, a.id, signed(verification(), b.secret))), unknown, 'org B\'s signature on org A\'s id');
    assert.deepEqual(await norm(await send(h, b.id, signed(verification(), a.secret))), unknown, 'org A\'s signature on org B\'s id');
    const c = challengeOf();
    const res = await send(h, b.id, signed(verification(c), b.secret));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), c);
  } finally { await h.close(); }
});

test('after promotion a url_verification is an ordinary delivery: leased, handled, acknowledged early with the challenge', async () => {
  const { h, reg, beh, alice } = await setup();
  try {
    const p = await ready(h, beh, alice);
    assert.equal((await send(h, p.id, signed(verification(), p.secret))).status, 200, 'pending: the handshake answer');
    assert.equal(reg.list(h.ids.org).length, 0, 'which promotes nothing');
    const cb = await fetch(`${h.base}/integrations/hand/callback?${new URLSearchParams({ state: p.state, code: 'c' })}`, { headers: { cookie: p.cookie } });
    assert.equal(cb.status, 200);
    assert.equal(reg.get(p.id).status, 'active');
    assert.deepEqual(beh.handled, []);
    const c = challengeOf();
    const res = await send(h, p.id, signed(verification(c), p.secret));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), c);
    await h.hub.idle();
    assert.deepEqual(beh.handled, ['url_verification']);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM inbound_dedupe WHERE provider = 'hand'").n, 2, 'leased under both keys');
    const forged = await send(h, p.id, signed(verification(), null));
    assert.equal(forged.status, 401, 'a live connection\'s bad signature is the D42 401 again');
  } finally { await h.close(); }
});

// ── the ingress limits still apply ────────────────────────────────────────

function slow(h, id) {
  const u = new URL(`${h.base}/integrations/${id}/webhook`);
  const out = { status: null };
  out.answered = new Promise((resolve) => {
    out.req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-length': String(500_000) } }, (res) => {
      res.resume();
      out.status = res.statusCode;
      resolve(res.statusCode);
    });
  });
  out.req.on('error', () => {});
  out.req.write('{"partial":');
  return out;
}
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('in-flight read caps and the read deadline apply alike to pending and unknown ids', async () => {
  const { h, beh, alice } = await setup({ config: { webhookReads: { perPair: 1, perIp: 4, perConn: 4, deadlineMs: 400 } } });
  try {
    const p = await ready(h, beh, alice);
    const u = randomUUID();
    const held = [slow(h, p.id), slow(h, u)];
    await tick();
    const over = [slow(h, p.id), slow(h, u)];
    assert.deepEqual(await Promise.all(over.map((x) => x.answered)), [503, 503], 'a second read on each pair is refused unread');
    assert.deepEqual(await Promise.all(held.map((x) => x.answered)), [408, 408], 'the deadline ends both reads');
    for (const x of [...held, ...over]) x.req.destroy();
  } finally { await h.close(); }
});

test('their 404s spend webhook_fail_ip on the client IP alone (no bucket per chosen id) and then answer 429 alike; a verified handshake is never refused', async () => {
  const { h, beh, alice } = await setup({ config: { rateLimits: { webhook_fail_ip: { capacity: 2, per_ms: 60_000 } } } });
  try {
    const p = await ready(h, beh, alice);
    const ids = [randomUUID(), p.id, randomUUID(), p.id];
    const got = [];
    for (const id of ids) got.push(await norm(await send(h, id, signed(verification(), null))));
    assert.deepEqual(got.map((g) => g.status), [404, 404, 429, 429]);
    assert.deepEqual(got[2], got[3], 'the 429 of an unknown id and of a pending id are alike');
    assert.ok(!bucketKeys(h).some((k) => ids.some((id) => k.includes(id))), 'no bucket keyed on an id');
    const c = challengeOf();
    const ok = await send(h, p.id, signed(verification(c), p.secret));
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), c);
  } finally { await h.close(); }
});

// ── what is never kept ────────────────────────────────────────────────────

test('sentinel: the signing secret and the challenge reach no log line and no table; the challenge appears only in its own 200', async () => {
  const { h, beh, alice, lines } = await setup();
  try {
    const p = await ready(h, beh, alice);
    const c = challengeOf();
    const bodies = [];
    for (const s of [signed(verification(c), null), signed(verification(c), p.secret, { ts: nowTs() - 900 }), signed({ type: 'event_callback', challenge: c }, p.secret), signed(verification(c), p.secret)]) {
      bodies.push(await (await send(h, p.id, s)).text());
    }
    beh.ackThrows = true;
    bodies.push(await (await send(h, p.id, signed(verification(c), p.secret))).text());
    assert.deepEqual(bodies.map((b) => b === c), [false, false, false, true, false]);
    assert.ok(!bodies.some((b) => b !== c && b.includes(c)));
    const log = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
    assert.ok(!log.includes(p.secret), 'signing secret in a log line');
    assert.ok(!log.includes(c), 'challenge in a log line');
    const dump = JSON.stringify(snapshot(h));
    assert.ok(!dump.includes(c));
    assert.ok(!dump.includes(p.secret));
  } finally { await h.close(); }
});

// ── defineConnector ───────────────────────────────────────────────────────

test('defineConnector refuses handshake without ackBody, without connect.prepare, or when not a function', () => {
  const beh = { verified: [], handled: [] };
  assert.doesNotThrow(() => handConnector(beh));
  const base = handSpec(beh);
  const { ackBody, ...noAck } = base;
  assert.ok(ackBody);
  assert.throws(() => defineConnector(noAck), /handshake/);
  assert.doesNotThrow(() => defineConnector({ ...noAck, connect: { ...base.connect, handshake: undefined } }), 'the same connector without handshake is fine');
  assert.throws(() => handConnector(beh, { prepare: false }), /handshake/);
  assert.doesNotThrow(() => handConnector(beh, { prepare: false, handshake: null }));
  assert.throws(() => defineConnector({ ...base, connect: { ...base.connect, handshake: true } }), /handshake/);
  assert.throws(() => defineConnector({ ...base, connect: { ...base.connect, handshake: 'url_verification' } }), /handshake/);
});

// ── review follow-up: one read bucket for every non-connection id ─────────

// → {answered, req}: a read held open (part of a body sent, the rest withheld).
function held(h, id, { length = 500_000, headers = {} } = {}) {
  const u = new URL(`${h.base}/integrations/${id}/webhook`);
  const out = {};
  out.answered = new Promise((resolve) => {
    out.req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-length': String(length), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve({ status: res.statusCode, body: null }));
    });
    out.req.on('error', () => resolve({ status: null, body: null }));
  });
  out.req.write('{"partial":');
  return out;
}
const promote = async (h, p) => {
  const cb = await fetch(`${h.base}/integrations/hand/callback?${new URLSearchParams({ state: p.state, code: 'c' })}`, { headers: { cookie: p.cookie } });
  assert.equal(cb.status, 200, await cb.text());
};

test('every id that is not a live connection shares one in-flight read bucket (perUnknown): when it is full a random UUID and a ready pending id get the same unread 503; a live connection\'s reads are counted apart, both ways', async () => {
  const { h, beh, alice } = await setup({ config: { webhookReads: { perPair: 4, perIp: 100, perConn: 2, perUnknown: 2, deadlineMs: 5_000 } } });
  try {
    const l = await ready(h, beh, alice);
    await promote(h, l);
    const p = await ready(h, beh, await otherAdmin(h));

    // The live connection's own cap full: pending and unknown ids still read.
    const liveHeld = [held(h, l.id), held(h, l.id)];
    await tick();
    assert.equal((await send(h, l.id, signed(verification(), l.secret))).status, 503, 'the live connection is at its own cap');
    const c0 = challengeOf();
    const ok0 = await send(h, p.id, signed(verification(c0), p.secret));
    assert.equal(ok0.status, 200, 'a pending id is not held up by a live connection\'s reads');
    assert.equal(await ok0.text(), c0);
    assert.equal((await send(h, randomUUID(), signed(verification(), null))).status, 404);
    for (const x of liveHeld) x.req.destroy();
    await tick();

    // The non-connection bucket full, from two different chosen ids.
    const unknownHeld = [held(h, randomUUID()), held(h, randomUUID())];
    await tick();
    const verifiedBefore = beh.verified.length;
    const u = await norm(await send(h, randomUUID(), signed(verification(), p.secret)));
    const pend = await norm(await send(h, p.id, signed(verification(), p.secret)));
    assert.equal(u.status, 503);
    assert.deepEqual(pend, u, 'a ready pending id and a random UUID: the same 503');
    assert.deepEqual(JSON.parse(u.body), { error: { code: 'UNAVAILABLE', message: 'too many deliveries in flight; retry' } });
    assert.ok(u.headers.some(([k, v]) => k === 'retry-after' && v === '1'));
    assert.equal(beh.verified.length, verifiedBefore, 'body unread: verify() never ran');
    const c1 = challengeOf();
    const ok1 = await send(h, l.id, signed(verification(c1), l.secret));
    assert.equal(ok1.status, 200, 'the live connection still reads while the bucket is full');
    assert.equal(await ok1.text(), c1);

    // An aborted read gives its slot back.
    for (const x of unknownHeld) x.req.destroy();
    await tick();
    const c2 = challengeOf();
    const ok2 = await send(h, p.id, signed(verification(c2), p.secret));
    assert.equal(ok2.status, 200, 'slots released on abort');
    assert.equal(await ok2.text(), c2);
    await h.hub.idle();
  } finally { await h.close(); }
});

test('the non-connection read slot is released when a read ends: success, an over-size body, the deadline', async () => {
  const { h, beh, alice } = await setup({ config: { webhookReads: { perPair: 4, perIp: 100, perUnknown: 1, deadlineMs: 400 }, rateLimits: { webhook_fail_ip: { capacity: 1000, per_ms: 60_000 } } } });
  try {
    const p = await ready(h, beh, alice);
    for (let i = 0; i < 3; i++) assert.equal((await send(h, randomUUID(), signed(verification(), null))).status, 404, `success ${i}`);
    // Chunked: no content-length to refuse up front, so the read itself hits the cap.
    const big = await new Promise((resolve) => {
      const u = new URL(`${h.base}/integrations/${randomUUID()}/webhook`);
      const r = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on('error', () => {});
      r.write(Buffer.alloc(1024 * 1024 + 10, 0x20));
    });
    assert.equal(big, 413);
    await tick();
    assert.equal((await send(h, randomUUID(), signed(verification(), null))).status, 404, 'released after a 413');
    const slowOne = held(h, randomUUID());
    assert.equal((await slowOne.answered).status, 408);
    slowOne.req.destroy();
    const c = challengeOf();
    const ok = await send(h, p.id, signed(verification(c), p.secret));
    assert.equal(ok.status, 200, 'released after the deadline');
    assert.equal(await ok.text(), c);
  } finally { await h.close(); }
});

test('a declared content-length over 1 MiB is 413 at once, unread, for every id alike (live, pending, unknown); the non-connection ones byte-identical', async () => {
  const { h, beh, alice } = await setup({ config: { webhookReads: { deadlineMs: 5_000 } } });
  try {
    const l = await ready(h, beh, alice);
    await promote(h, l);
    const p = await ready(h, beh, await otherAdmin(h));
    const got = [];
    for (const id of [randomUUID(), p.id, l.id]) {
      const x = held(h, id, { length: 1024 * 1024 + 1 });
      got.push(await x.answered);
      x.req.destroy();
    }
    assert.deepEqual(got.map((g) => g.status), [413, 413, 413]);
    assert.equal(got[0].body, got[1].body);
    assert.deepEqual(JSON.parse(got[2].body), { error: { code: 'PAYLOAD_TOO_LARGE', message: 'body over 1 MiB' } });
  } finally { await h.close(); }
});

test('an unknown id, a not-ready pending id and a ready pending id without a timestamp header each pay one HMAC over the body', async () => {
  const { h, reg, beh, alice } = await setup();
  const real = crypto.createHmac;
  const seen = [];
  try {
    const notReady = await ready(h, beh, await otherAdmin(h), {});
    const p = await ready(h, beh, alice);
    crypto.createHmac = (...a) => {
      const m = real(...a);
      const up = m.update.bind(m);
      m.update = (d, ...r) => { seen.push(Buffer.from(d)); return up(d, ...r); };
      return m;
    };
    syncBuiltinESMExports();
    for (const [name, id] of [['unknown', randomUUID()], ['not ready', notReady.id], ['ready, no timestamp', p.id]]) {
      const raw = Buffer.from(JSON.stringify({ ...verification(), marker: randomUUID() }));
      const out = await reg.webhook(id, { headers: { 'content-type': 'application/json' }, rawBody: raw });
      assert.equal(out.status, 404, name);
      assert.equal(seen.filter((b) => b.includes(raw)).length, 1, `${name}: one HMAC over the body`);
    }
  } finally {
    crypto.createHmac = real;
    syncBuiltinESMExports();
    await h.close();
  }
});

test('a pending row whose connector has no connect object is the unknown-id 404, not a throw', async () => {
  const { h, reg } = await setup();
  try {
    reg.register({ id: 'bare', name: 'Bare', verify: () => ({ ok: true, dedupe_key: 'k' }), ackBody: () => 'x' });
    const member = h.db.get('SELECT id FROM members WHERE org_id = ? LIMIT 1', h.ids.org).id;
    const id = randomUUID();
    h.db.insert('integration_pending', { id, org_id: h.ids.org, provider: 'bare', created_by: member, match: '{"app_id":"A1"}', created_at: h.hub.iso(), expires_at: new Date(h.hub.wallMs() + 3_600_000).toISOString() });
    const raw = Buffer.from(JSON.stringify(verification()));
    assert.deepEqual(await reg.webhook(id, { headers: {}, rawBody: raw }), await reg.webhook(randomUUID(), { headers: {}, rawBody: raw }));
  } finally { await h.close(); }
});

test('an id promoted while its body is read is answered as the live connection it now is: its failure spends the connection\'s own bucket', async () => {
  const { h, beh, alice } = await setup({ config: { webhookReads: { deadlineMs: 5_000 } } });
  try {
    const p = await ready(h, beh, alice);
    const body = `{"partial":${JSON.stringify(verification())}}`;
    const x = held(h, p.id, { length: Buffer.byteLength(body), headers: { 'content-type': 'application/json', 'x-hand-ts': String(nowTs()) } });
    await tick();
    await promote(h, p);
    x.req.end(body.slice('{"partial":'.length));
    const got = await x.answered;
    assert.equal(got.status, 401, 'a live connection\'s bad signature');
    assert.ok(bucketKeys(h).includes(`webhook_fail_ip|${p.id}|127.0.0.1`), 'spent on the connection + client IP');
    assert.ok(!bucketKeys(h).includes('webhook_fail_ip|-|127.0.0.1'), 'not on the non-connection bucket');
  } finally { await h.close(); }
});
