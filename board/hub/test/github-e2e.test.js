// The GitHub connector end to end through the real registry: signed
// deliveries into reg.webhook, the real ctx.cardForBranch, s.link /
// s.linkStatus, ctx.system.event and the card state machine. Payloads are
// recorded-shape fixtures (test/fixtures/github/); the webhook secret, app
// key and conversion secrets are assembled at run time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { branchName } from '../../shared/fence.js';
import github from '../integrations/github/index.js';
import { sign } from '../integrations/github/webhook.js';
import { startHub } from './helpers.js';

const FIXTURES = new URL('./fixtures/github/', import.meta.url);
const raw = (name) => readFileSync(new URL(name, FIXTURES));
const fixture = (name) => JSON.parse(raw(name).toString('utf8'));
const KEY = 'BDL-9001';
const HEAD = '3f1c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a';
const PR_URL = 'https://github.com/acme/app/pull/12';

async function setup() {
  const h = await startHub();
  h.hub.setVaultKey(randomBytes(32));
  const reg = h.app.integrations;
  const secret = randomBytes(24).toString('hex');
  const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'github', external_id: '77', display_name: 'acme', scopes: [],
    secrets: { app_private_key: randomBytes(32).toString('base64'), webhook_secret: secret } });
  // A card in review whose run pushed board/BDL-9001-r1 from main.
  const t = h.hub.iso();
  const cardId = randomUUID();
  const rid = randomUUID();
  h.db.run("INSERT INTO cards (id, board_id, key, title, repo_id, created_by, created_at, updated_at) VALUES (?, ?, ?, 'T', ?, ?, ?, ?)", cardId, h.ids.board, KEY, h.ids.repo, h.ids.alice, t, t);
  h.db.run("INSERT INTO dispatches (request_id, card_id, dispatched_by, state, created_at) VALUES (?, ?, ?, 'claimed', ?)", rid, cardId, h.ids.alice, t);
  h.db.run("INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, branch, started_at, ended_at) VALUES (?, ?, 1, ?, ?, ?, 'claude_cli', ?, 'main', ?, ?, ?)",
    randomUUID(), cardId, h.ids.alice, h.ids.alice, rid, h.ids.repo, branchName(KEY, 1), t, t);
  h.db.run("UPDATE cards SET run_state = 'in_review', column_name = 'in_review' WHERE id = ?", cardId);

  const send = async (event, body) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return reg.webhook(conn.id, { headers: { 'x-hub-signature-256': sign(secret, rawBody), 'x-github-event': event, 'x-github-delivery': randomUUID() }, rawBody });
  };
  const verify = (ref = PR_URL) => {
    h.clock.advance(1000);
    const at = h.hub.iso();
    h.db.run("INSERT INTO evidence (id, card_id, kind, ref, verification, verified_at, created_at) VALUES (?, ?, 'pr', ?, 'hub_verified', ?, ?)", randomUUID(), cardId, ref, at, at);
  };
  const column = () => h.db.get('SELECT column_name FROM cards WHERE id = ?', cardId).column_name;
  const links = () => h.db.all('SELECT card_id, external_id, status FROM external_links WHERE connection_id = ? ORDER BY created_at', conn.id)
    .map((l) => ({ ...l, status: JSON.parse(l.status ?? 'null') }));
  // Registries with hub-verified PR binding (builder-5, feat/integrations-ctx) expose ctx.verifiedPr.
  const gated = typeof reg.ctxFor(conn.id).verifiedPr === 'function';
  return { h, reg, conn, cardId, send, verify, column, links, gated };
}

// A copy of a fixture PR event with some pull_request fields changed.
function variant(name, over, top = {}) {
  const p = fixture(name);
  return { ...p, ...top, pull_request: { ...p.pull_request, ...over } };
}
const decoy = (name, number, baseRef, over = {}) => {
  const p = fixture(name).pull_request;
  return variant(name, { id: 2100000000 + number, number, html_url: `https://github.com/acme/app/pull/${number}`, base: { ...p.base, ref: baseRef }, ...over }, { number });
};

test('e2e: the board PR links on open, carries review and checks, and merging it moves the card to Done', async () => {
  const { h, cardId, send, verify, column, links } = await setup();
  try {
    verify();
    const opened = await send('pull_request', raw('pull_request.opened.json'));
    assert.equal(opened.status, 200);
    assert.deepEqual(links(), [{ card_id: cardId, external_id: '2100000012', status: { state: 'open', head_sha: HEAD } }]);
    assert.equal(column(), 'in_review');
    assert.equal((await send('pull_request', raw('pull_request.opened.json'))).body.duplicate, true, 'a redelivery is a duplicate');

    assert.equal((await send('pull_request_review', raw('pull_request_review.submitted.json'))).status, 200);
    assert.equal((await send('check_suite', raw('check_suite.completed.json'))).status, 200);
    assert.deepEqual(links()[0].status, { state: 'open', head_sha: HEAD, review: 'approved', checks: 'passing' });

    const merged = await send('pull_request', raw('pull_request.closed.json'));
    assert.equal(merged.status, 200);
    assert.equal(column(), 'done');
    assert.equal(links()[0].status.state, 'merged');
  } finally { await h.close(); }
});

test('e2e: a review by someone without write access does not change the card', async () => {
  const { h, send, links } = await setup();
  try {
    await send('pull_request', raw('pull_request.opened.json'));
    const p = fixture('pull_request_review.submitted.json');
    await send('pull_request_review', { ...p, review: { ...p.review, id: 3300000002, author_association: 'NONE', user: { ...p.review.user, login: 'drive-by' } } });
    assert.deepEqual(links()[0].status, { state: 'open', head_sha: HEAD });
  } finally { await h.close(); }
});

test('e2e T1: a decoy PR from the board branch into another base, merged, does nothing', async () => {
  const { h, cardId, send, verify, column, links } = await setup();
  try {
    verify();
    await send('pull_request', raw('pull_request.opened.json'));
    assert.equal((await send('pull_request', decoy('pull_request.opened.json', 11, 'scratch'))).status, 200);
    const r = await send('pull_request', decoy('pull_request.closed.json', 11, 'scratch', { merged_by: { login: 'mallory', id: 9100066 } }));
    assert.equal(r.status, 200);
    assert.equal(column(), 'in_review');
    assert.deepEqual(links().map((l) => [l.card_id, l.external_id]), [[cardId, '2100000012']]);
  } finally { await h.close(); }
});

test('e2e T1b: a decoy PR into a junk base, closed unmerged, does not send the card back', async () => {
  const { h, send, verify, column, links } = await setup();
  try {
    verify();
    await send('pull_request', raw('pull_request.opened.json'));
    await send('pull_request', decoy('pull_request.opened.json', 21, 'junk'));
    const closed = decoy('pull_request.closed.json', 21, 'junk', { merged: false, merged_by: null, merged_at: null, merge_commit_sha: null });
    assert.equal((await send('pull_request', { ...closed, sender: { login: 'mallory', id: 9100066 } })).status, 200);
    assert.equal(column(), 'in_review');
    assert.equal(links().length, 1);
  } finally { await h.close(); }
});

test('e2e: a merge the board never saw open, or of a PR retargeted to another base, moves nothing', async () => {
  const { h, send, verify, column, links } = await setup();
  try {
    verify();
    assert.equal((await send('pull_request', raw('pull_request.closed.json'))).status, 200);
    assert.equal(column(), 'in_review');
    assert.deepEqual(links(), []);

    await send('pull_request', raw('pull_request.opened.json'));
    const base = fixture('pull_request.opened.json').pull_request.base;
    const edited = variant('pull_request.opened.json', { base: { ...base, ref: 'scratch' }, updated_at: '2026-10-01T11:30:00Z' }, { action: 'edited', changes: { base: { ref: { from: 'main' }, sha: { from: base.sha } } } });
    assert.equal((await send('pull_request', edited)).status, 200);
    const closed = fixture('pull_request.closed.json');
    assert.equal((await send('pull_request', { ...closed, pull_request: { ...closed.pull_request, base: { ...closed.pull_request.base, ref: 'scratch' } } })).status, 200);
    assert.equal(column(), 'in_review');
  } finally { await h.close(); }
});

test('e2e: a PR from a fork, on a branch named like the board\'s, does nothing', async () => {
  const { h, send, verify, column, links } = await setup();
  try {
    verify('https://github.com/acme/app/pull/13');
    const fork = fixture('pull_request.opened.fork.json');
    fork.pull_request.head.ref = branchName(KEY, 1);
    assert.equal((await send('pull_request', fork)).status, 200);
    assert.equal((await send('pull_request', { ...fork, action: 'closed', pull_request: { ...fork.pull_request, state: 'closed', merged: true, merged_by: { login: 'acme-admin', id: 9100004 } } })).status, 200);
    assert.deepEqual(links(), []);
    assert.equal(column(), 'in_review');
  } finally { await h.close(); }
});

test('e2e: a card with no hub-verified PR evidence is not moved by a merge', async (t) => {
  const { h, reg, conn, send, column, links, gated } = await setup();
  try {
    if (!gated) return t.skip('this registry has no hub-verified PR binding (builder-5, feat/integrations-ctx)');
    await send('pull_request', raw('pull_request.opened.json'));
    assert.equal(links().length, 1);
    assert.equal((await send('pull_request', raw('pull_request.closed.json'))).status, 200, 'a refusal is an answer, not a retry');
    assert.equal(column(), 'in_review');
    const a = reg.audit(conn.id).find((x) => x.action === 'system.pr_merged');
    assert.deepEqual([a.decision, a.error], ['failed', 'no_verified_pr']);
  } finally { await h.close(); }
});

test('e2e L1: a signed installation event is answered 200 and ignored', async () => {
  const { h, reg, conn, send, links } = await setup();
  try {
    const r = await send('installation', raw('installation.created.json'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(links(), []);
    assert.deepEqual(reg.audit(conn.id), []);
    const forged = await reg.webhook(conn.id, { headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}`, 'x-github-event': 'installation' }, rawBody: raw('installation.created.json') });
    assert.equal(forged.status, 401);
  } finally { await h.close(); }
});

test('e2e M4: reconnecting makes a second app and a second connection, not a CONFLICT', async () => {
  const { h, reg } = await setup();
  try {
    const pemLine = (w) => ['-----' + w, 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
    const conversion = (id, slug) => ({ id, slug, name: slug, owner: { id: 9100001, login: 'acme', type: 'Organization' },
      pem: `${pemLine('BEGIN')}\n${randomBytes(48).toString('base64')}\n${pemLine('END')}\n`, webhook_secret: randomBytes(20).toString('hex'),
      permissions: { pull_requests: 'read', checks: 'read', metadata: 'read' }, events: ['pull_request', 'pull_request_review', 'check_suite'] });
    const exchange = (body) => github.connect.exchange({ query: { code: 'abc' }, config: {}, fetch: async () => ({ ok: true, json: async () => body }) });
    const create = (v) => reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'github', ...v });
    const a = create(await exchange(conversion(801, 'plexiform-acme-aaaa')));
    const b = create(await exchange(conversion(802, 'plexiform-acme-bbbb')));
    assert.notEqual(a.id, b.id);
    assert.throws(() => create({ external_id: '802', display_name: 'acme', scopes: [], secrets: { app_private_key: 'x', webhook_secret: randomBytes(20).toString('hex') } }), (e) => e.code === 'CONFLICT', 'the same app twice is still one connection');
  } finally { await h.close(); }
});

const unmerged = { merged: false, merged_by: null, merged_at: null, merge_commit_sha: null, state: 'closed' };
const kinds = (h, conn) => h.db.all('SELECT kind, external_id FROM external_links WHERE connection_id = ? ORDER BY created_at, rowid', conn.id).map((l) => `${l.kind}:${l.external_id}`);

test('e2e N1: #12 closed unmerged, then #13 opened, verified and merged: #13 takes the card\'s PR slot and moves the card', async () => {
  const { h, conn, send, verify, column } = await setup();
  try {
    await send('pull_request', raw('pull_request.opened.json'));
    verify();
    assert.equal((await send('pull_request', variant('pull_request.closed.json', unmerged))).status, 200);
    h.db.run("UPDATE cards SET run_state = 'in_review', column_name = 'in_review' WHERE key = ?", KEY);
    assert.equal((await send('pull_request', decoy('pull_request.opened.json', 13, 'main'))).status, 200);
    assert.deepEqual(kinds(h, conn), ['pr_superseded:2100000012', 'pr:2100000013']);
    verify('https://github.com/acme/app/pull/13');
    assert.equal((await send('pull_request', decoy('pull_request.closed.json', 13, 'main'))).status, 200);
    assert.equal(column(), 'done');
  } finally { await h.close(); }
});

test('e2e N1: a squatter PR #11 linked first; the real #12, verified, relinks and its merge moves the card', async () => {
  const { h, conn, send, verify, column } = await setup();
  try {
    await send('pull_request', decoy('pull_request.opened.json', 11, 'main', { user: { login: 'mallory', id: 9100066 } }));
    assert.deepEqual(kinds(h, conn), ['pr:2100000011']);
    verify();
    assert.equal((await send('pull_request', raw('pull_request.opened.json'))).status, 200);
    assert.deepEqual(kinds(h, conn), ['pr_superseded:2100000011', 'pr:2100000012']);
    assert.equal((await send('pull_request', raw('pull_request.closed.json'))).status, 200);
    assert.equal(column(), 'done');
  } finally { await h.close(); }
});

test('e2e N1: a second PR that is not the verified one, while the first is open, is not linked and moves nothing', async () => {
  const { h, reg, conn, send, verify, column } = await setup();
  try {
    await send('pull_request', raw('pull_request.opened.json'));
    verify();
    assert.equal((await send('pull_request', decoy('pull_request.opened.json', 14, 'main'))).status, 200);
    assert.equal((await send('pull_request', decoy('pull_request.closed.json', 14, 'main'))).status, 200);
    assert.deepEqual(kinds(h, conn), ['pr:2100000012']);
    assert.equal(column(), 'in_review');
    assert.ok(!reg.audit(conn.id).some((a) => a.external_ref === '2100000014'), 'not even tried');
  } finally { await h.close(); }
});

test('e2e N3: with bare #12 evidence, PR #12 in a repo alias (a mirror) never moves the card', async () => {
  const { h, reg, conn, send, verify, column } = await setup();
  try {
    h.db.run('UPDATE repos SET aliases = ? WHERE id = ?', JSON.stringify(['github.com/acme/app-mirror']), h.ids.repo);
    verify('#12');
    const o = fixture('pull_request.opened.json');
    const mirror = { ...o.repository, id: 424242, full_name: 'acme/app-mirror', name: 'app-mirror' };
    const onMirror = (p) => ({ ...p, repository: mirror, pull_request: { ...p.pull_request, id: 777, html_url: 'https://github.com/acme/app-mirror/pull/12', head: { ...p.pull_request.head, repo: mirror }, base: { ...p.pull_request.base, repo: mirror } } });
    assert.equal((await send('pull_request', onMirror(fixture('pull_request.opened.json')))).status, 200);
    assert.equal((await send('pull_request', onMirror(fixture('pull_request.closed.json')))).status, 200);
    assert.equal(column(), 'in_review');
    const a = reg.audit(conn.id).find((x) => x.action === 'system.pr_merged');
    assert.deepEqual([a.decision, a.error], ['failed', 'not_the_verified_pr'], 'the event names the mirror, and bare #12 is the card\'s own repo');
  } finally { await h.close(); }
});

test('e2e N3: with bare #12 evidence, a mirror\'s #12 cannot relink the card away from its own open #12', async () => {
  const { h, conn, send, verify, column } = await setup();
  try {
    h.db.run('UPDATE repos SET aliases = ? WHERE id = ?', JSON.stringify(['github.com/acme/app-mirror']), h.ids.repo);
    verify('#12');
    await send('pull_request', raw('pull_request.opened.json'));
    const o = fixture('pull_request.opened.json');
    const mirror = { ...o.repository, id: 424242, full_name: 'acme/app-mirror', name: 'app-mirror' };
    const onMirror = (p) => ({ ...p, repository: mirror, pull_request: { ...p.pull_request, id: 777, html_url: 'https://github.com/acme/app-mirror/pull/12', head: { ...p.pull_request.head, repo: mirror }, base: { ...p.pull_request.base, repo: mirror } } });
    assert.equal((await send('pull_request', onMirror(fixture('pull_request.opened.json')))).status, 200, 'the registry\'s CONFLICT is an answer');
    assert.equal((await send('pull_request', onMirror(fixture('pull_request.closed.json')))).status, 200);
    assert.deepEqual(kinds(h, conn), ['pr:2100000012']);
    assert.equal(column(), 'in_review');
  } finally { await h.close(); }
});

test('e2e N4: a suite that finishes for the old head after a push is dropped; checks stay pending', async () => {
  const { h, send, links } = await setup();
  try {
    await send('pull_request', raw('pull_request.opened.json'));
    const next = 'e'.repeat(40);
    const head = fixture('pull_request.opened.json').pull_request.head;
    assert.equal((await send('pull_request', variant('pull_request.opened.json', { head: { ...head, sha: next }, updated_at: '2026-10-01T12:05:00Z' }, { action: 'synchronize' }))).status, 200);
    assert.deepEqual(links()[0].status, { state: 'open', head_sha: next, checks: 'pending' });
    assert.equal((await send('check_suite', raw('check_suite.completed.json'))).status, 200);
    assert.deepEqual(links()[0].status, { state: 'open', head_sha: next, checks: 'pending' });
    const cs = fixture('check_suite.completed.json');
    const fresh = { ...cs.check_suite, id: cs.check_suite.id + 1, head_sha: next, pull_requests: cs.check_suite.pull_requests.map((x) => ({ ...x, head: { ...x.head, sha: next } })) };
    assert.equal((await send('check_suite', { ...cs, check_suite: fresh })).status, 200);
    assert.equal(links()[0].status.checks, 'passing');
  } finally { await h.close(); }
});
