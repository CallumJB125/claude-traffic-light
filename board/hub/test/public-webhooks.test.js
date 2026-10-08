// Outbound webhooks (docs/PUBLIC-API.md, migration 069): signed deliveries
// to a local receiver, ids and titles only unless include_text, SSRF refusals
// (loopback, private, metadata, IPv6 loopback, a host resolving to one, a
// redirect), retry with backoff then disable with an audit row, the delivery
// log and "Send test event". Every receiver is a local http server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';
import { blockedAddress, parseEndpointUrl } from '../public-api/ssrf.js';
import { MAX_ATTEMPTS, BACKOFF_MS, LOG_KEEP, Webhooks, signature } from '../public-api/webhooks.js';

const rid = () => randomUUID();
const LOCAL = { outboundWebhooks: { allowHttp: true, allowPrivate: true } };

async function receiver(answer = () => ({ status: 204 })) {
  const got = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      got.push({ headers: req.headers, body, json: JSON.parse(body || '{}'), path: req.url });
      const a = answer(got.length);
      if (a.hang) return;
      res.writeHead(a.status, a.headers ?? {});
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function endpoint(fx, url, events = ['card.created', 'card.moved', 'card.commented'], extra = {}) {
  const r = await fx.as(fx.users.ua, 'POST', `/api/teams/${fx.A.team}/webhooks`, { url, events, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.body;
}

const settle = async (fx) => {
  await fx.h.app.bus.settle();
  await fx.h.hub.publicApi.webhooks.deliverDue();
};

test('a card event is delivered signed, with an idempotency id and timestamp, ids and titles only', async () => {
  const fx = await tenancy({ config: LOCAL });
  const rx = await receiver();
  try {
    const { users, A } = fx;
    assert.equal((await fx.as(users.amember, 'POST', `/api/teams/${A.team}/webhooks`, { url: rx.url, events: ['card.created'] })).status, 403, 'members cannot');
    assert.equal((await fx.as(users.ua, 'POST', `/api/teams/${A.team}/webhooks`, { url: rx.url, events: ['card.deleted'] })).status, 400, 'unknown event');
    const ep = await endpoint(fx, rx.url);
    assert.match(ep.secret, /^whsec_/);
    const list = await fx.as(users.ua, 'GET', `/api/teams/${A.team}/webhooks`);
    assert.ok(!list.text.includes(ep.secret), 'the secret is shown once');
    assert.equal(list.body.endpoints[0].include_text, false);

    const c = await fx.as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { request_id: rid(), title: 'Ship the API', body: 'PRIVATE goal text' });
    assert.equal(c.status, 200, c.text);
    await settle(fx);
    assert.equal(rx.got.length, 1);
    const d = rx.got[0];
    assert.equal(d.json.type, 'card.created');
    assert.equal(d.json.team_id, A.team);
    assert.equal(d.json.data.card.title, 'Ship the API');
    assert.equal(d.json.data.board.id, A.board);
    assert.ok(!d.body.includes('PRIVATE'), 'no card text by default');
    assert.equal(d.headers['plexiform-delivery'], d.json.id);
    assert.equal(d.headers['plexiform-event'], 'card.created');
    const ts = d.headers['plexiform-timestamp'];
    const expected = `v1=${createHmac('sha256', ep.secret).update(`${ts}.${d.body}`).digest('hex')}`;
    assert.equal(d.headers['plexiform-signature'], expected);
    assert.equal(signature(ep.secret, ts, d.body), expected);
    assert.notEqual(signature('whsec_other', ts, d.body), expected);

    const card = fx.h.hub.card(c.body.card.id);
    assert.equal((await fx.as(users.ua, 'PATCH', `/api/cards/${card.id}`, { request_id: rid(), version: card.version, column: 'in_progress' })).status, 200);
    assert.equal((await fx.as(users.ua, 'POST', `/api/cards/${card.id}/comments`, { request_id: rid(), body: 'PRIVATE comment' })).status, 200);
    await settle(fx);
    const types = rx.got.map((g) => g.json.type);
    assert.deepEqual(types, ['card.created', 'card.moved', 'card.commented']);
    assert.deepEqual([rx.got[1].json.data.from_column, rx.got[1].json.data.to_column], ['todo', 'in_progress']);
    assert.ok(rx.got[2].json.data.comment.id);
    assert.ok(!rx.got.some((g) => g.body.includes('PRIVATE')));

    const log = await fx.as(users.ua, 'GET', `/api/teams/${A.team}/webhooks/${ep.endpoint.id}/deliveries`);
    assert.equal(log.status, 200, log.text);
    assert.deepEqual(log.body.deliveries.map((x) => [x.state, x.status, x.attempts]), [['delivered', 204, 1], ['delivered', 204, 1], ['delivered', 204, 1]]);
    assert.ok(log.body.deliveries.every((x) => Number.isInteger(x.latency_ms)));
    // At-least-once bus: the same journal row never makes a second delivery.
    fx.h.hub.publicApi.webhooks.onJournal({ ...fx.db.get("SELECT * FROM journal WHERE kind = 'card.create' AND card_id = ?", card.id), payload: {} });
    await settle(fx);
    assert.equal(rx.got.length, 3);
  } finally { await rx.close(); await fx.h.close(); }
});

test('include_text adds card and comment text; other teams\' events never reach this endpoint', async () => {
  const fx = await tenancy({ config: LOCAL });
  const rx = await receiver();
  try {
    const { users, A, B } = fx;
    await endpoint(fx, rx.url, ['card.created', 'card.commented'], { include_text: true });
    const c = await fx.as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { request_id: rid(), title: 'T', body: 'the goal' });
    await fx.as(users.ua, 'POST', `/api/cards/${c.body.card.id}/comments`, { request_id: rid(), body: 'a note' });
    await fx.as(users.ub, 'POST', `/api/boards/${B.board}/cards`, { request_id: rid(), title: 'Beta only' });
    await settle(fx);
    assert.deepEqual(rx.got.map((g) => g.json.type), ['card.created', 'card.commented']);
    assert.equal(rx.got[0].json.data.card.body, 'the goal');
    assert.equal(rx.got[1].json.data.comment.body, 'a note');
  } finally { await rx.close(); await fx.h.close(); }
});

test('SSRF: loopback, private, link-local metadata, IPv6 loopback and plain http are refused at registration', async () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00:ec2::254', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '224.0.0.1']) {
    assert.equal(blockedAddress(a), true, a);
  }
  for (const a of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(blockedAddress(a), false, a);
  assert.throws(() => parseEndpointUrl('http://example.com/x'), /https/);
  assert.throws(() => parseEndpointUrl('https://user:pw@example.com/x'), /user name/);
  assert.throws(() => parseEndpointUrl('https://localhost/x'), /public host/);

  const fx = await tenancy();
  try {
    const { users, A } = fx;
    const refused = async (url) => {
      const r = await fx.as(users.ua, 'POST', `/api/teams/${A.team}/webhooks`, { url, events: ['card.created'] });
      assert.equal(r.status, 400, `${url}: ${r.text}`);
      assert.equal(r.body.error.reason, 'URL_REFUSED', url);
    };
    for (const url of ['https://127.0.0.1/hook', 'https://10.0.0.5/hook', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/hook', 'https://2130706433/hook', 'https://0x7f.1/hook', 'http://example.com/hook']) await refused(url);
    const w = fx.h.hub.publicApi.webhooks;
    w.opts.lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }];
    await refused('https://mixed.example.test/hook');
    w.opts.lookup = async () => [{ address: '169.254.169.254', family: 4 }];
    await refused('https://metadata.example.test/hook');
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM webhook_endpoints').n, 0);

    // Registered while the name was public, then it rebinds to a private address: that attempt is refused, nothing is sent.
    w.opts.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const ok = await endpoint(fx, 'https://rebind.example.test/hook', ['card.created']);
    w.opts.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await fx.as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { request_id: rid(), title: 'x' });
    await settle(fx);
    const d = fx.db.get('SELECT * FROM webhook_deliveries WHERE endpoint_id = ?', ok.endpoint.id);
    assert.equal(d.last_error, 'address_refused');
    assert.equal(d.last_status, null);
  } finally { await fx.h.close(); }
});

test('SSRF: a redirect is never followed', async () => {
  const fx = await tenancy({ config: LOCAL });
  const elsewhere = await receiver();
  const rx = await receiver(() => ({ status: 302, headers: { location: elsewhere.url } }));
  try {
    const ep = await endpoint(fx, rx.url);
    const t = await fx.as(fx.users.ua, 'POST', `/api/teams/${fx.A.team}/webhooks/${ep.endpoint.id}/test`, {});
    assert.equal(t.status, 200, t.text);
    assert.deepEqual([t.body.delivery.state, t.body.delivery.status, t.body.delivery.error], ['failed', 302, 'redirect_refused']);
    assert.equal(rx.got.length, 1);
    assert.equal(elsewhere.got.length, 0, 'the redirect target was never contacted');
  } finally { await rx.close(); await elsewhere.close(); await fx.h.close(); }
});

test('a failing endpoint is retried with backoff, then disabled after the last attempt with an audit row', async () => {
  const fx = await tenancy({ config: LOCAL });
  const rx = await receiver(() => ({ status: 500 }));
  try {
    const { users, A } = fx;
    const ep = await endpoint(fx, rx.url, ['card.created']);
    await fx.as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { request_id: rid(), title: 'x' });
    await settle(fx);
    const row = () => fx.db.get('SELECT * FROM webhook_deliveries WHERE endpoint_id = ?', ep.endpoint.id);
    assert.deepEqual([row().state, row().attempts, row().last_status, row().last_error], ['pending', 1, 500, 'bad_status']);
    await fx.h.hub.publicApi.webhooks.deliverDue();
    assert.equal(rx.got.length, 1, 'not before its backoff');
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      fx.h.clock.advance(BACKOFF_MS[i]);
      await fx.h.hub.publicApi.webhooks.deliverDue();
      assert.equal(rx.got.length, i + 2);
    }
    assert.ok(rx.got.every((g) => g.json.id === rx.got[0].json.id), 'the same event id on every retry');
    assert.deepEqual([row().state, row().attempts], ['failed', MAX_ATTEMPTS]);
    const e = fx.db.get('SELECT * FROM webhook_endpoints WHERE id = ?', ep.endpoint.id);
    assert.equal(e.disabled_reason, 'failing');
    const audit = fx.db.get("SELECT * FROM audit WHERE action = 'webhook.disabled' AND target = ?", ep.endpoint.id);
    assert.equal(audit.actor, 'system');
    assert.equal(audit.org_id, A.team);
    await fx.as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { request_id: rid(), title: 'y' });
    await settle(fx);
    assert.equal(rx.got.length, MAX_ATTEMPTS, 'a disabled endpoint gets nothing');
    const on = await fx.as(users.ua, 'PATCH', `/api/teams/${A.team}/webhooks/${ep.endpoint.id}`, { enabled: true });
    assert.equal(on.body.endpoint.enabled, true);
  } finally { await rx.close(); await fx.h.close(); }
});

test('a receiver that does not answer times out; the log keeps the latest 50; delete removes it', async () => {
  const fx = await tenancy({ config: LOCAL });
  const slow = await receiver(() => ({ hang: true }));
  const rx = await receiver();
  try {
    const { users, A } = fx;
    const w = fx.h.hub.publicApi.webhooks;
    w.timeoutMs = 150;
    const hang = await endpoint(fx, slow.url);
    const t = await fx.as(users.ua, 'POST', `/api/teams/${A.team}/webhooks/${hang.endpoint.id}/test`, {});
    assert.deepEqual([t.body.delivery.state, t.body.delivery.error], ['failed', 'timeout']);

    const ep = await endpoint(fx, rx.url, ['card.created']);
    const now = fx.h.hub.iso();
    for (let i = 0; i < LOG_KEEP + 10; i++) {
      fx.db.insert('webhook_deliveries', { id: rid(), endpoint_id: ep.endpoint.id, event_type: 'card.created', journal_seq: 100_000 + i, payload: '{"x":1}', state: 'pending', attempts: 0, next_at_ms: fx.h.hub.wallMs(), created_at: now, updated_at: now });
    }
    await w.deliverDue();
    assert.equal(rx.got.length, LOG_KEEP + 10);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = ?', ep.endpoint.id).n, LOG_KEEP);
    assert.equal(fx.db.get("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = ? AND payload != '{}'", ep.endpoint.id).n, 0, 'payloads are dropped once delivered');
    const del = await fx.as(users.ua, 'DELETE', `/api/teams/${A.team}/webhooks/${ep.endpoint.id}`, {});
    assert.equal(del.status, 200, del.text);
    assert.equal((await fx.as(users.ua, 'GET', `/api/teams/${A.team}/webhooks/${ep.endpoint.id}/deliveries`)).status, 404);
    assert.deepEqual(fx.db.all("SELECT action FROM audit WHERE target = ? ORDER BY id", ep.endpoint.id).map((a) => a.action), ['webhook.create', 'webhook.delete']);
  } finally { await slow.close(); await rx.close(); await fx.h.close(); }
});

test('journal rows map to the public event types (run.finished, review.requested, moves by a run)', () => {
  const card = { id: 'c1' };
  const of = (row) => Webhooks.prototype.eventsOf.call({ db: { get: () => ({ id: 'r1', end_reason: 'completed' }) } }, row, card).map((e) => [e.type, e.data]);
  assert.deepEqual(of({ kind: 'card.transition', run_id: 'r1', payload: { from: 'running', to: 'in_review', state: { column_name: 'in_review' }, effects: ['run_end', 'lease_release'] } }), [
    ['card.moved', { from_column: 'in_progress', to_column: 'in_review' }],
    ['run.finished', { run: { id: 'r1', outcome: 'in_review', end_reason: 'completed' } }],
  ]);
  assert.deepEqual(of({ kind: 'card.transition', run_id: 'r1', payload: { from: 'running', to: 'quiet', state: { column_name: 'in_progress' }, effects: [] } }), [], 'no column change, no run end');
  assert.deepEqual(of({ kind: 'card_review.request', payload: { review_id: 'v1', status: 'pending' } }), [['review.requested', { review: { id: 'v1' } }]]);
  assert.deepEqual(of({ kind: 'card_review.request', payload: { review_id: 'v1', provider: 'claude' } }), [], 'the second row for the same review is not a new request');
  assert.deepEqual(of({ kind: 'card.update', payload: { fields: { title: ['a', 'b'] } } }), [], 'a title edit is not a move');
});
