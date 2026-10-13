// The hub's own GitHub App (step 4) against a fake GitHub: app JWT and
// installation tokens (cache, expiry, 401), the install flow (the browser's
// installation id counts only once GitHub confirms it for the signed-in
// user), the one app webhook (signature, replay, unknown installation,
// unlinked repo, lifecycle), events mapped to cards, tenancy, and the
// member-started card actions (Open PR, Comment status).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, randomBytes, randomUUID, verify as rsaVerify } from 'node:crypto';
import { branchName } from '../../shared/fence.js';
import { appJwt, createGitHubApp, githubAppConfig } from '../integrations/github/app.js';
import { prText } from '../integrations/github/cards.js';
import { sign, EVENTS } from '../integrations/github/webhook.js';
import { APP_SCOPES } from '../integrations/github/index.js';
import { startHub } from './helpers.js';
import { createLogger } from '../log.js';

const FIXTURES = new URL('./fixtures/github/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES)).toString('utf8'));
const APP_ID = 4242;
const INST = 55000111;
const REPO_ID = 700100200;
const KEY = 'BDL-9001';
const HEAD = '3f1c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

function appConfig() {
  return githubAppConfig({
    GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github-app.pem', GITHUB_APP_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
    GITHUB_APP_CLIENT_ID: 'Iv1.testclient', GITHUB_APP_CLIENT_SECRET: randomBytes(20).toString('hex'),
  }, { readFile: () => PEM });
}
// The secret the hub verifies with: tests sign with it, read back once from the frozen config.
const secretOf = (cfg) => Object.getOwnPropertyDescriptor(cfg, 'webhookSecret').value;

function jwtOk(auth) {
  const t = /^Bearer (.+)$/.exec(auth ?? '')?.[1];
  const [h, b, s] = (t ?? '').split('.');
  if (!s) return false;
  const body = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  return rsaVerify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url')) && body.iss === String(APP_ID) && body.exp - body.iat <= 600;
}

/** A GitHub that answers the calls the app makes, and records them. */
function fakeGitHub(now) {
  const gh = {
    calls: [], minted: [], ttlMs: 3_600_000, userInstalls: [INST], code: 'goodcode',
    repos: [{ id: REPO_ID, full_name: 'acme/app', private: true }, { id: 700100201, full_name: 'acme/other', private: false }],
    pulls: [], comments: [], refuseNext: 0,
  };
  const reply = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const tokenOk = (auth) => gh.minted.some((m) => `Bearer ${m.token}` === auth && m.expires > now());
  gh.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const auth = init.headers?.authorization;
    const body = init.body ? JSON.parse(init.body) : null;
    gh.calls.push(`${method} ${u.host}${u.pathname}`);
    if (u.host === 'api.github.com' && u.pathname === '/app') return jwtOk(auth) ? reply(200, { id: APP_ID, slug: 'plexiform-test' }) : reply(401, {});
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(u.pathname);
    if (mint && method === 'POST') {
      if (!jwtOk(auth) || Number(mint[1]) !== INST) return reply(jwtOk(auth) ? 404 : 401, {});
      const token = `ghs_${randomBytes(12).toString('hex')}`;
      gh.minted.push({ token, expires: now() + gh.ttlMs });
      return reply(201, { token, expires_at: new Date(now() + gh.ttlMs).toISOString() });
    }
    if (u.host === 'github.com' && u.pathname === '/login/oauth/access_token') return reply(200, body?.code === gh.code && body?.client_id === 'Iv1.testclient' ? { access_token: 'ghu_user', token_type: 'bearer' } : { error: 'bad_verification_code' });
    if (u.pathname === '/user/installations') {
      if (auth !== 'Bearer ghu_user') return reply(401, {});
      return reply(200, { total_count: gh.userInstalls.length, installations: gh.userInstalls.map((id) => ({ id, app_id: APP_ID, account: { login: 'acme', type: 'Organization' }, repository_selection: 'selected' })) });
    }
    if (/^\/applications\/[^/]+\/token$/.test(u.pathname) && method === 'DELETE') return reply(204, null);
    if (gh.refuseNext > 0) { gh.refuseNext -= 1; return reply(401, {}); }
    if (!tokenOk(auth)) return reply(401, {});
    if (u.pathname === '/installation/repositories') return reply(200, { total_count: gh.repos.length, repositories: gh.repos });
    if (u.pathname === '/repos/acme/app/pulls' && method === 'POST') {
      if (gh.pulls.some((p) => p.head.ref === body.head && p.state === 'open')) return reply(422, { message: 'A pull request already exists' });
      const number = 12 + gh.pulls.length;
      const p = {
        id: 2100000000 + number, number, state: 'open', draft: false, html_url: `https://github.com/acme/app/pull/${number}`, title: body.title, body: body.body,
        head: { ref: body.head, sha: HEAD, repo: { id: REPO_ID } }, base: { ref: body.base, repo: { id: REPO_ID } },
      };
      gh.pulls.push(p);
      return reply(201, p);
    }
    if (u.pathname === '/repos/acme/app/pulls' && method === 'GET') return reply(200, gh.pulls.filter((p) => `acme:${p.head.ref}` === u.searchParams.get('head')));
    const cm = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(u.pathname);
    if (cm && method === 'POST') {
      const c = { id: 9000 + gh.comments.length, body: body.body, html_url: `https://github.com/acme/app/pull/${cm[1]}#issuecomment-${9000 + gh.comments.length}` };
      gh.comments.push({ number: Number(cm[1]), ...c });
      return reply(201, c);
    }
    return reply(404, { message: 'Not Found' });
  };
  return gh;
}

async function setup() {
  const cfg = appConfig();
  let h;
  const gh = fakeGitHub(() => h.clock.wall());
  const logs = [];
  h = await startHub({ config: { githubApp: cfg }, fetchImpl: gh.fetch, log: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) });
  h.hub.setVaultKey(randomBytes(32));
  const secret = secretOf(cfg);
  const alice = await h.login('alice');
  const bob = await h.login('bob');
  // A card in review whose run pushed board/BDL-9001-r1 from main.
  const card = (orgBoard = h.ids.board, repoId = h.ids.repo, by = h.ids.alice, key = KEY) => {
    const t = h.hub.iso();
    const id = randomUUID();
    const rid = randomUUID();
    h.db.run("INSERT INTO cards (id, board_id, key, title, body, acceptance, repo_id, created_by, created_at, updated_at) VALUES (?, ?, ?, 'Fix the login loop', 'Users bounce between /login and /home. token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'No loop on a fresh session', ?, ?, ?, ?)", id, orgBoard, key, repoId, by, t, t);
    h.db.run("INSERT INTO dispatches (request_id, card_id, dispatched_by, state, created_at) VALUES (?, ?, ?, 'claimed', ?)", rid, id, by, t);
    h.db.run("INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, branch, status_summary, started_at, ended_at) VALUES (?, ?, 1, ?, ?, ?, 'claude_cli', ?, 'main', ?, 'Fixed the redirect guard', ?, ?)",
      randomUUID(), id, by, by, rid, repoId, branchName(key, 1), t, t);
    h.db.run("UPDATE cards SET run_state = 'in_review', column_name = 'in_review' WHERE id = ?", id);
    return id;
  };
  const send = async (event, payload, { sig = null, raw = null } = {}) => {
    const body = raw ?? Buffer.from(JSON.stringify(payload));
    const res = await fetch(`${h.base}/api/integrations/github/webhook`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': randomUUID(), 'x-hub-signature-256': sig ?? sign(secret, body) },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  // Install through the real routes: /install, then GitHub's redirect to the callback.
  const install = async (cookie = alice, { code = gh.code, installationId = INST } = {}) => {
    const r = await h.api(cookie, 'POST', '/api/integrations/github/install', { request_id: randomUUID() });
    if (r.status !== 200) return { start: r };
    const state = new URL(r.body.url).searchParams.get('state');
    const cb = await fetch(`${h.base}/integrations/github/callback?code=${code}&installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`, { headers: { cookie: `board_int_github=${r.body.bind}` } });
    return { start: r, status: cb.status, html: await cb.text() };
  };
  const connection = () => h.db.get("SELECT * FROM connections WHERE provider = 'github' AND external_id = ? AND status = 'active'", `inst:${INST}`);
  const linkRepo = (cookie = alice, repoId = REPO_ID) => h.api(cookie, 'POST', `/api/integrations/${connection().id}/repos`, { request_id: randomUUID(), repo_id: repoId });
  const withPr = (name, over = {}, top = {}) => {
    const p = fixture(name);
    return { ...p, ...top, installation: { id: INST }, pull_request: { ...p.pull_request, ...over } };
  };
  const links = (cardId) => h.db.all('SELECT external_id, url, status FROM external_links WHERE card_id = ? ORDER BY created_at', cardId).map((l) => ({ ...l, status: JSON.parse(l.status ?? 'null') }));
  // No token, sign-in code exchange answer or secret ever reaches a log line, an audit row or the journal.
  const nothingLeaked = () => {
    const kept = [logs.join('\n'), JSON.stringify(h.db.all('SELECT * FROM integration_audit')), JSON.stringify(h.db.all('SELECT * FROM journal')), JSON.stringify(h.db.all('SELECT * FROM connections'))].join('\n');
    for (const s of [...gh.minted.map((m) => m.token), 'ghu_user', secret, Object.getOwnPropertyDescriptor(cfg, 'clientSecret').value]) assert.ok(!kept.includes(s), 'a secret was kept or logged');
    assert.ok(logs.length > 0);
  };
  return { h, gh, cfg, secret, alice, bob, card, send, install, connection, linkRepo, withPr, links, nothingLeaked };
}

test('app auth: an RS256 JWT for the app id; installation tokens cached until 5 min before expiry, minted again after, forgotten on a 401', async () => {
  let t = Date.parse('2026-10-08T10:00:00Z');
  const gh = fakeGitHub(() => t);
  const app = createGitHubApp(appConfig(), { fetchImpl: gh.fetch, now: () => t });
  assert.ok(jwtOk(`Bearer ${app.jwt()}`));
  const claims = JSON.parse(Buffer.from(appJwt({ appId: APP_ID, privateKey, nowS: 1000 }).split('.')[1], 'base64url'));
  assert.deepEqual(claims, { iat: 940, exp: 1540, iss: String(APP_ID) });

  const [a, b] = await Promise.all([app.token(INST), app.token(INST)]);
  assert.equal(a, b, 'concurrent callers share one mint');
  assert.equal(gh.minted.length, 1);
  t += 54 * 60_000;
  assert.equal(await app.token(INST), a, 'still more than 5 minutes left');
  t += 2 * 60_000;
  const c = await app.token(INST);
  assert.notEqual(c, a, 'inside the margin: a new token');
  assert.equal(gh.minted.length, 2);
  // GitHub stops taking the cached token: forgotten, minted again, retried once.
  gh.refuseNext = 1;
  const r = await app.request(INST, 'GET', '/installation/repositories');
  assert.equal(r.status, 200);
  assert.equal(gh.minted.length, 3);
  assert.equal(app.cached(), 1);
  await assert.rejects(app.token('../app'), (e) => e.code === 'validation');
  // A token that comes back already inside the margin is used once, never cached.
  gh.ttlMs = 60_000;
  app.forget(INST);
  await app.token(INST);
  assert.equal(app.cached(), 0);
});

test('app config: unset is no app; a half-set app names the missing variable, never a value; secrets are not enumerable', () => {
  assert.equal(githubAppConfig({}, { readFile: () => PEM }), null);
  assert.throws(() => githubAppConfig({ GITHUB_APP_ID: '12' }, { readFile: () => PEM }), /GITHUB_APP_PRIVATE_KEY_FILE/);
  assert.throws(() => githubAppConfig({ GITHUB_APP_ID: 'x', GITHUB_APP_PRIVATE_KEY_FILE: 'k', GITHUB_APP_WEBHOOK_SECRET: 's'.repeat(20) }, { readFile: () => PEM }), /GITHUB_APP_ID/);
  assert.throws(() => githubAppConfig({ GITHUB_APP_ID: '12', GITHUB_APP_PRIVATE_KEY_FILE: 'k', GITHUB_APP_WEBHOOK_SECRET: 's'.repeat(20) }, { readFile: () => 'not a key' }), /not a PEM private key/);
  assert.throws(() => githubAppConfig({ GITHUB_APP_ID: '12', GITHUB_APP_PRIVATE_KEY_FILE: 'k', GITHUB_APP_WEBHOOK_SECRET: 's'.repeat(20) }, { readFile: () => PEM }), /GITHUB_APP_CLIENT_ID/);
  const cfg = appConfig();
  const dump = JSON.stringify(cfg);
  assert.deepEqual(Object.keys(cfg).sort(), ['appId', 'clientId']);
  assert.ok(!dump.includes('PRIVATE KEY') && !dump.includes(secretOf(cfg)));
});

test('install: the install page carries the signed state; GitHub must confirm the installation for the signed-in user; one installation is one team\'s', async () => {
  const { h, gh, install, connection, bob, nothingLeaked } = await setup();
  try {
    const { start } = await install(bob);
    assert.equal(start.status, 403, 'a member cannot install');

    gh.userInstalls = [INST + 1];
    const forged = await install();
    assert.equal(forged.status, 400);
    assert.match(forged.html, /did not confirm that installation/);
    assert.equal(connection(), null, 'an installation id the user cannot see connects nothing');
    gh.userInstalls = [INST];
    assert.equal((await install(undefined, { code: 'stolen' })).status, 400, 'a bad sign-in code connects nothing');

    const ok = await install();
    assert.equal(ok.status, 200, ok.html);
    assert.match(ok.start.body.url, /^https:\/\/github\.com\/apps\/plexiform-test\/installations\/new\?state=/);
    const c = connection();
    assert.equal(c.org_id, h.ids.org);
    const provider = JSON.parse(c.settings).provider;
    assert.deepEqual({ mode: provider.mode, installation_id: provider.installation_id, login: provider.login }, { mode: 'app', installation_id: INST, login: 'acme' });
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM connection_secrets WHERE connection_id = ?', c.id).n, 0, 'nothing is sealed: tokens are minted from the hub\'s key');
    assert.ok(gh.calls.includes('DELETE api.github.com/applications/Iv1.testclient/token'), 'the user\'s token is revoked after the check');
    // Adding repositories on GitHub comes back through the same callback: the same connection.
    assert.equal((await install()).status, 200);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM connections WHERE provider = 'github' AND status = 'active'").n, 1);

    // Another team installing the same installation: the generic CONFLICT, nothing written.
    const t = h.hub.iso();
    const other = randomUUID();
    const olga = randomUUID();
    h.db.insert('orgs', { id: other, name: 'other', created_at: t });
    h.db.insert('members', { id: olga, org_id: other, github_id: -9, github_login: 'olga', email: 'olga@dev.local', display_name: 'Olga', role: 'owner', created_at: t });
    const theirs = await install(await h.login('olga'));
    assert.equal(theirs.status, 400);
    assert.match(theirs.html, /already connected/);
    assert.ok(!theirs.html.includes(h.ids.org));
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM connections WHERE org_id = ? AND provider = 'github'", other).n, 0);
    nothingLeaked();
  } finally { await h.close(); }
});

test('webhook: a forged signature is 401 and runs nothing; a replay is a duplicate; an unlinked repo or unknown installation does nothing; too large is 413', async () => {
  const { h, card, send, install, linkRepo, withPr, links, connection } = await setup();
  try {
    await install();
    const cardId = card();
    const opened = withPr('pull_request.opened.json');
    assert.equal((await send('pull_request', opened, { sig: sign('x'.repeat(32), Buffer.from(JSON.stringify(opened))) })).status, 401);
    assert.equal((await send('pull_request', opened)).body.ignored, true, 'the repo is not linked yet');
    assert.deepEqual(links(cardId), []);

    assert.equal((await linkRepo()).status, 200);
    assert.equal((await send('pull_request', { ...opened, installation: { id: INST + 7 } })).body.ignored, true, 'another installation');
    const first = await send('pull_request', opened);
    assert.equal(first.status, 200);
    assert.equal(links(cardId).length, 1);
    assert.equal((await send('pull_request', opened)).body.duplicate, true, 'the same signed body again');
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM integration_audit WHERE connection_id = ? AND action = 'pr.link'", connection().id).n, 1);

    const huge = Buffer.alloc(1024 * 1024 + 10, 0x20);
    assert.equal((await send('pull_request', null, { raw: huge })).status, 413);
    // A delivery for a repo the installation has but this team did not link.
    assert.equal((await send('pull_request', { ...opened, repository: { ...opened.repository, id: 700100201 } })).body.ignored, true);
  } finally { await h.close(); }
});

test('events → card: opened links, review requested and a failing check run show (and alert), the merge of the PR it opened moves the card to Done', async () => {
  const { h, card, send, install, linkRepo, withPr, links, alice, nothingLeaked } = await setup();
  try {
    await install();
    await linkRepo();
    const cardId = card();
    // Open PR from the card: the hub makes it, links it and records hub-verified evidence.
    const r = await h.api(alice, 'POST', `/api/cards/${cardId}/github/pr`, { request_id: randomUUID() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.pr.url, 'https://github.com/acme/app/pull/12');
    const prId = links(cardId)[0].external_id;

    await send('pull_request', withPr('pull_request.opened.json', { id: Number(prId), requested_reviewers: [{ login: 'bob' }] }, { action: 'review_requested' }));
    assert.equal(links(cardId)[0].status.review, 'requested');
    const alerts = await h.api(alice, 'GET', `/api/boards/${h.ids.board}/alerts`);
    assert.ok(alerts.body.alerts.items.some((a) => a.kind === 'review' && a.card_id === cardId), JSON.stringify(alerts.body));

    const suite = fixture('check_suite.completed.json');
    const run = {
      action: 'completed', installation: { id: INST }, repository: suite.repository, sender: suite.sender,
      check_run: { id: 77001, name: 'test', status: 'completed', conclusion: 'failure', head_sha: HEAD, completed_at: '2026-10-08T10:01:00Z', pull_requests: suite.check_suite.pull_requests.map((p) => ({ ...p, id: Number(prId) })) },
    };
    assert.equal((await send('check_run', run)).status, 200);
    assert.equal(links(cardId)[0].status.checks, 'failing');
    const after = await h.api(alice, 'GET', `/api/boards/${h.ids.board}/alerts`);
    assert.ok(after.body.alerts.items.some((a) => a.kind === 'checks' && a.card_id === cardId));

    const merged = withPr('pull_request.closed.json', { id: Number(prId) });
    assert.equal((await send('pull_request', merged)).status, 200);
    assert.equal(h.card(cardId).column_name, 'done');
    assert.equal(links(cardId)[0].status.state, 'merged');
    nothingLeaked();
  } finally { await h.close(); }
});

test('tenancy: team A\'s installation never reaches team B\'s card on the same repo and branch; B cannot read or link A\'s repositories', async () => {
  const { h, card, send, install, linkRepo, withPr, links, connection } = await setup();
  try {
    await install();
    await linkRepo();
    const t = h.hub.iso();
    const other = randomUUID();
    const olga = randomUUID();
    const board = randomUUID();
    const repo = randomUUID();
    h.db.insert('orgs', { id: other, name: 'other', created_at: t });
    h.db.insert('members', { id: olga, org_id: other, github_id: -9, github_login: 'olga', email: 'olga@dev.local', display_name: 'Olga', role: 'owner', created_at: t });
    h.db.insert('boards', { id: board, org_id: other, name: 'B', key_prefix: 'BDL' });
    h.db.insert('repos', { id: repo, org_id: other, canonical_url: 'github.com/acme/app', short_name: 'app' });
    h.db.run('INSERT INTO board_repos (board_id, repo_id) VALUES (?, ?)', board, repo);
    const theirs = card(board, repo, olga);
    const ours = card();
    await send('pull_request', withPr('pull_request.opened.json'));
    assert.equal(links(ours).length, 1);
    assert.deepEqual(links(theirs), []);

    const o = await h.login('olga');
    assert.equal((await h.api(o, 'GET', `/api/integrations/${connection().id}/repos`)).status, 404);
    assert.equal((await h.api(o, 'POST', `/api/integrations/${connection().id}/repos`, { request_id: randomUUID(), repo_id: REPO_ID })).status, 404);
    assert.equal((await h.api(o, 'POST', `/api/cards/${theirs}/github/pr`, { request_id: randomUUID() })).status, 403, 'B has no installation linking this repo');
    assert.throws(() => h.db.run('INSERT INTO integration_app_repos (connection_id, external_repo_id, full_name, linked_by, linked_at) VALUES (?, 1, ?, ?, ?)', connection().id, 'acme/x', olga, t), /cross-team reference/);
  } finally { await h.close(); }
});

test('Open PR: the description comes from the card with secrets redacted; a second click returns it; viewers, a switched-off action and a burst are refused', async () => {
  const { h, gh, card, install, linkRepo, alice, bob, connection } = await setup();
  try {
    await install();
    const listed = await h.api(alice, 'GET', `/api/integrations/${connection().id}/repos`);
    assert.deepEqual(listed.body.repos.map((x) => [x.full_name, x.linked]), [['acme/app', false], ['acme/other', false]]);
    assert.equal((await h.api(alice, 'POST', `/api/integrations/${connection().id}/repos`, { request_id: randomUUID(), repo_id: 1 })).status, 404, 'not in the installation');
    await linkRepo();
    const cardId = card();
    const view = await h.api(bob, 'GET', `/api/cards/${cardId}`);
    assert.deepEqual(view.body.card.github, { open_pr: true, comment: false });

    const r = await h.api(bob, 'POST', `/api/cards/${cardId}/github/pr`, { request_id: randomUUID() });
    assert.equal(r.status, 200, r.text);
    const p = gh.pulls[0];
    assert.deepEqual([p.head.ref, p.base.ref, p.title], [branchName(KEY, 1), 'main', `${KEY}: Fix the login loop`]);
    assert.match(p.body, /## Status\n\nFixed the redirect guard/);
    assert.match(p.body, /## Done means\n\nNo loop on a fresh session/);
    assert.ok(!p.body.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'a token in the card body never reaches GitHub');
    assert.equal(h.db.get("SELECT verification FROM evidence WHERE card_id = ? AND kind = 'pr'", cardId).verification, 'hub_verified');
    assert.equal((await h.api(bob, 'POST', `/api/cards/${cardId}/github/pr`, { request_id: randomUUID() })).body.existing, true);
    assert.equal(gh.pulls.length, 1);

    const comment = await h.api(bob, 'POST', `/api/cards/${cardId}/github/comment`, { request_id: randomUUID() });
    assert.equal(comment.status, 200, comment.text);
    assert.equal(comment.body.comment.url, 'https://github.com/acme/app/pull/12#issuecomment-9000');
    assert.match(gh.comments[0].body, /Plexiform status · BDL-9001[\s\S]*Column: In review/);
    assert.equal(h.db.get("SELECT decision FROM integration_audit WHERE action = 'pr.comment'").decision, 'auto');

    const t = h.hub.iso();
    const vera = randomUUID();
    h.db.insert('members', { id: vera, org_id: h.ids.org, github_id: -3, github_login: 'vera', email: 'vera@dev.local', display_name: 'Vera', role: 'viewer', created_at: t });
    assert.equal((await h.api(await h.login('vera'), 'POST', `/api/cards/${cardId}/github/comment`, { request_id: randomUUID() })).status, 403);

    assert.equal((await h.api(alice, 'PATCH', `/api/integrations/${connection().id}`, { request_id: randomUUID(), autonomy: { 'pr.comment': 'off' } })).status, 200);
    h.clock.advance(61_000);
    const off = await h.api(bob, 'POST', `/api/cards/${cardId}/github/comment`, { request_id: randomUUID() });
    assert.equal(off.status, 403);
    assert.match(off.body.error.message, /switched off/);
    assert.equal(gh.comments.length, 1);

    const second = card(undefined, undefined, undefined, 'BDL-9002');
    const burst = [];
    for (let i = 0; i < 4; i += 1) burst.push((await h.api(bob, 'POST', `/api/cards/${second}/github/comment`, { request_id: randomUUID() })).status);
    assert.equal(burst.at(-1), 429, burst.join());
  } finally { await h.close(); }
});

test('push and issue_comment: a push to the card\'s branch sets checks pending; a member\'s PR comment notes who and where on the card, never the text', async () => {
  const { h, card, send, install, linkRepo, withPr, links } = await setup();
  try {
    await install();
    await linkRepo();
    const cardId = card();
    await send('pull_request', withPr('pull_request.opened.json'));
    const opened = fixture('pull_request.opened.json');
    const after = 'c'.repeat(40);
    assert.equal((await send('push', { ref: `refs/heads/${branchName(KEY, 1)}`, before: HEAD, after, deleted: false, installation: { id: INST }, repository: opened.repository, sender: opened.sender })).status, 200);
    assert.deepEqual(links(cardId)[0].status, { state: 'open', head_sha: after, checks: 'pending' });

    const comment = (id, user, association = 'MEMBER') => ({
      action: 'created', installation: { id: INST }, repository: opened.repository, sender: user,
      issue: { number: 12, pull_request: { html_url: 'https://github.com/acme/app/pull/12' } },
      comment: { id, body: 'please also fix the logout page', html_url: `https://github.com/acme/app/pull/12#issuecomment-${id}`, author_association: association, user },
    });
    assert.equal((await send('issue_comment', comment(501, { login: 'tonde', type: 'User' }))).status, 200);
    assert.equal((await send('issue_comment', comment(502, { login: 'plexiform-test[bot]', type: 'Bot' }))).status, 200);
    assert.equal((await send('issue_comment', comment(503, { login: 'drive-by', type: 'User' }, 'NONE'))).status, 200);
    const notes = h.db.all("SELECT body, source FROM comments WHERE card_id = ? ORDER BY created_at", cardId);
    assert.deepEqual(notes.map((n) => n.body), ['tonde commented on pull request #12: https://github.com/acme/app/pull/12#issuecomment-501']);
    assert.equal(notes[0].source, 'integration');
  } finally { await h.close(); }
});

test('lifecycle: removing a repository from the installation unlinks it; deleting the installation revokes the connection; both once per delivery', async () => {
  const { h, send, install, linkRepo, connection } = await setup();
  try {
    await install();
    await linkRepo();
    const id = connection().id;
    const removed = { action: 'removed', installation: { id: INST }, repositories_removed: [{ id: REPO_ID, full_name: 'acme/app' }], repository_selection: 'selected' };
    assert.equal((await send('installation_repositories', removed)).status, 200);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM integration_app_repos WHERE connection_id = ?', id).n, 0);
    assert.equal((await send('installation_repositories', removed)).body.duplicate, true);
    assert.equal((await send('installation', { action: 'suspend', installation: { id: INST } })).status, 200);
    assert.equal(JSON.parse(h.db.get('SELECT health FROM connections WHERE id = ?', id).health).last_error, 'suspended');
    assert.equal((await send('installation', { action: 'deleted', installation: { id: INST } })).status, 200);
    assert.equal(h.db.get('SELECT status FROM connections WHERE id = ?', id).status, 'revoked');
  } finally { await h.close(); }
});

test('PR text: title from the key and title, sections only when the card has them, no member names or comments', () => {
  const t = prText({ card: { key: 'K-1', title: 'T', body: '', acceptance: null }, status: null });
  assert.equal(t.title, 'K-1: T');
  assert.equal(t.body, '---\n\nOpened from Plexiform card K-1.');
  assert.match(prText({ card: { key: 'K-1', title: 'T', body: 'G' }, status: 'S', cardUrl: 'https://app.plexiform.dev/?card=c' }).body, /## Status\n\nS\n\n## Goal\n\nG\n\n---\n\nOpened from Plexiform card \[K-1\]\(https:\/\/app\.plexiform\.dev\/\?card=c\)\./);
});

test('docs/github-app-manifest.json: exactly the permissions the connector declares, events it handles, and the hub\'s webhook and callback paths', () => {
  const m = JSON.parse(readFileSync(new URL('../../../docs/github-app-manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.entries(m.default_permissions).map(([k, v]) => `${k}:${v}`).sort(), [...APP_SCOPES].sort());
  assert.ok(m.default_events.every((e) => EVENTS.includes(e)), m.default_events.join());
  assert.equal(new URL(m.hook_attributes.url).pathname, '/api/integrations/github/webhook');
  assert.deepEqual(m.callback_urls.map((u) => new URL(u).pathname), ['/integrations/github/callback']);
  assert.equal(m.request_oauth_on_install, true, 'the install callback needs the user\'s code to check the installation');
  assert.equal(m.public, true);
});
