// GET /api/runner/v1/repo-token (hosted-repo-tokens.js) against a fake
// GitHub: a hosted runner of the team that owns the repo, with work on it
// (an offer it is eligible for, or its run, live or just ended), gets an
// installation token GitHub narrowed to that one repository with contents +
// pull requests write; everything else is 404 (another team's repo, an idle
// runner, a person's sign-in, a desktop runner), the honest reason when the
// repo has no installation, rate limited, audited, and the token is in no
// log line, audit row or table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { githubAppConfig } from '../integrations/github/app.js';
import { REPO_TOKEN_PERMISSIONS, FINAL_PUSH_MS } from '../hosted-repo-tokens.js';
import { createLogger } from '../log.js';
import { tenancy } from './tenancy/fixture.js';
import { FakeRunner, settle } from './helpers.js';

const APP_ID = 4243;
const INST_A = 66000111;
const INST_B = 66000222;
const GH_REPO_A = 800100200;
const GH_REPO_B = 800100300;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const rid = () => randomUUID();

function appConfig() {
  return githubAppConfig({
    GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github-app.pem', GITHUB_APP_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
    GITHUB_APP_CLIENT_ID: 'Iv1.testclient', GITHUB_APP_CLIENT_SECRET: randomBytes(20).toString('hex'),
  }, { readFile: () => PEM });
}

/** GitHub's create-installation-token: records each ask; `mode` bends the answer. */
function fakeGitHub(now) {
  const gh = { asks: [], minted: [], mode: 'ok', ttlMs: 3_600_000 };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  gh.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(u.pathname);
    if (u.host !== 'api.github.com' || !m || init.method !== 'POST') return reply(404, { message: 'Not Found' });
    const body = init.body ? JSON.parse(init.body) : {};
    gh.asks.push({ installation: Number(m[1]), body });
    if (gh.mode === '422') return reply(422, { message: 'The permissions requested are not granted to this installation.' });
    const token = `ghs_${randomBytes(16).toString('hex')}`;
    gh.minted.push(token);
    const permissions = gh.mode === 'wider' ? { ...body.permissions, metadata: 'read', administration: 'write' } : { ...body.permissions, metadata: 'read' };
    const repositories = gh.mode === 'all_repos' ? [{ id: body.repository_ids[0] }, { id: 1 }] : body.repository_ids.map((id) => ({ id, full_name: 'shared/app' }));
    const expires = gh.mode === 'expired' ? now() - 1000 : now() + gh.ttlMs;
    return reply(201, { token, expires_at: new Date(expires).toISOString(), permissions, repository_selection: 'selected', repositories });
  };
  return gh;
}

async function rig({ rateLimits = {} } = {}) {
  let fx;
  const gh = fakeGitHub(() => fx.h.clock.wall());
  const logs = [];
  fx = await tenancy({ config: { githubApp: appConfig(), rateLimits }, fetchImpl: gh.fetch, log: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) });
  const { users, A, B } = fx;
  // Each team's own installation, with the team's repo (same URL in both) linked on it.
  const install = (T, owner, inst, ghRepo) => {
    const id = randomUUID();
    const t = fx.h.hub.iso();
    fx.db.run("INSERT INTO connections (id, org_id, provider, external_id, display_name, scopes, settings, created_by, created_at) VALUES (?, ?, 'github', ?, 'shared', '[]', ?, ?, ?)",
      id, T.team, `inst:${inst}`, JSON.stringify({ provider: { mode: 'app', installation_id: inst, login: 'shared', account_type: 'Organization', repository_selection: 'selected' } }), owner, t);
    fx.db.run('INSERT INTO integration_app_repos (connection_id, external_repo_id, full_name, linked_by, linked_at) VALUES (?, ?, ?, ?, ?)', id, ghRepo, 'shared/app', owner, t);
    return id;
  };
  A.connection = install(A, A.owner, INST_A, GH_REPO_A);
  B.githubConnection = install(B, B.owner, INST_B, GH_REPO_B);
  const cloud = await fx.as(users.ua, 'POST', `/api/teams/${A.team}/hosted-runners`, { name: 'pi' });
  assert.equal(cloud.status, 200, cloud.text);
  const runner = new FakeRunner(fx.h.base, { device_id: '', device_token: cloud.body.runner_token, team: A.team });
  await runner.open();
  await runner.hello();
  await runner.advertise([{ repo_id: A.repo, approvals_from: [], auto_accept_from: [] }]);
  const ask = async (repoId, { token = cloud.body.runner_token, team = A.team } = {}) => {
    const res = await fetch(`${fx.h.base}/api/runner/v1/repo-token?repo_id=${encodeURIComponent(repoId)}`, { headers: { authorization: `Bearer ${token}`, ...(team ? { 'board-team': team } : {}), accept: 'application/json' } });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const cloudCard = async (title = 'cloud work') => {
    const c = await fx.as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { request_id: rid(), title, repo_id: A.repo });
    assert.equal(c.status, 200, c.text);
    const d = await fx.as(users.ua, 'POST', `/api/cards/${c.body.card.id}/actions/dispatch`, { request_id: rid(), placement: 'hosted', confirm: true });
    assert.equal(d.status, 200, d.text);
    const offer = await runner.next('offer', (m) => m.card_id === c.body.card.id);
    return { cardId: c.body.card.id, offer };
  };
  const close = async () => { runner.terminate(); await fx.h.close(); };
  return { fx, gh, logs, cloud, runner, ask, cloudCard, close };
}

test('repo token: only with work on the repo; GitHub narrows it to that repository with contents + pull requests write; never cached', async () => {
  const r = await rig();
  try {
    const { fx, gh, ask } = r;
    // Idle: an enrolled, online hosted runner with nothing to do gets nothing, and GitHub is not asked.
    const idle = await ask(fx.A.repo);
    assert.equal(idle.status, 404, idle.text);
    assert.equal(gh.asks.length, 0);
    // An offer it is eligible for.
    const { cardId, offer } = await r.cloudCard();
    const got = await ask(fx.A.repo);
    assert.equal(got.status, 200, got.text);
    assert.deepEqual(Object.keys(got.body).sort(), ['expires_at', 'token']);
    assert.equal(got.body.token, gh.minted[0]);
    assert.equal(got.headers.get('cache-control'), 'no-store');
    assert.deepEqual(gh.asks[0], { installation: INST_A, body: { repository_ids: [GH_REPO_A], permissions: { contents: 'write', pull_requests: 'write' } } });
    assert.deepEqual(REPO_TOKEN_PERMISSIONS, { contents: 'write', pull_requests: 'write' });
    // Expiry is GitHub's, passed through.
    assert.equal(got.body.expires_at, new Date(fx.h.clock.wall() + gh.ttlMs).toISOString());
    // Asked again: a new token from GitHub, never a cached one.
    const again = await ask(fx.A.repo);
    assert.equal(again.status, 200);
    assert.equal(gh.asks.length, 2);
    assert.notEqual(again.body.token, got.body.token);
    // Claimed: the run carries it; ended within the final-push window, still; after it, never.
    const claim = await r.runner.claim(offer);
    assert.equal(claim.ok, true, JSON.stringify(claim));
    assert.equal((await ask(fx.A.repo)).status, 200, 'a live run');
    fx.db.run('UPDATE runs SET ended_at = ?, end_reason = ? WHERE id = ?', new Date(fx.h.hub.wallMs() - FINAL_PUSH_MS + 60_000).toISOString(), 'done', claim.run_id);
    assert.equal((await ask(fx.A.repo)).status, 200, 'the push after the run reports its end');
    fx.db.run('UPDATE runs SET ended_at = ? WHERE id = ?', new Date(fx.h.hub.wallMs() - FINAL_PUSH_MS - 60_000).toISOString(), claim.run_id);
    assert.equal((await ask(fx.A.repo)).status, 404, 'long ended: idle again');
    assert.equal(fx.db.get('SELECT card_id FROM runs WHERE id = ?', claim.run_id).card_id, cardId);
  } finally { await r.close(); }
});

test('repo token: out of tenancy is the same 404 (another team\'s repo, a person\'s sign-in, a desktop runner); a bad runner token is 401', async () => {
  const r = await rig();
  try {
    const { fx, gh, ask, cloud } = r;
    await r.cloudCard();
    // B's repo has the same URL, its own installation and a card on it.
    const bCard = await fx.as(fx.users.ub, 'POST', `/api/boards/${fx.B.board}/cards`, { request_id: rid(), title: 'b cloud', repo_id: fx.B.repo });
    assert.equal(bCard.status, 200, bCard.text);
    const idle404 = (await ask(randomUUID())).body;
    const cross = await ask(fx.B.repo);
    assert.equal(cross.status, 404, cross.text);
    assert.deepEqual(cross.body, idle404, 'B\'s repo is indistinguishable from a made-up id');
    assert.ok(!cross.text.includes(fx.B.team) && !cross.text.includes(fx.B.repo));
    // The runner's token for team A, sent as team B: the socket's answer (T-RUN-2).
    assert.equal((await ask(fx.A.repo, { team: fx.B.team })).status, 401);
    assert.equal((await ask(fx.A.repo, { team: null })).status, 401);
    assert.equal((await ask(fx.A.repo, { token: `brt_${randomBytes(32).toString('base64url')}` })).status, 401);
    // A person's own sign-in never counts, even the runner's owner's.
    for (const u of [fx.users.ua, fx.users.ub, fx.users.n]) assert.equal((await ask(fx.A.repo, { token: u.token })).status, 404);
    // A desktop (non-hosted) enrolment of the same member.
    const laptop = await fx.as(fx.users.ua, 'POST', `/api/teams/${fx.A.team}/enrol`, { request_id: rid(), device_name: 'laptop' });
    assert.equal(laptop.status, 200, laptop.text);
    assert.equal((await ask(fx.A.repo, { token: laptop.body.runner_token })).status, 404);
    // Revoked: the token is dead at once.
    assert.equal((await fx.as(fx.users.ua, 'DELETE', `/api/teams/${fx.A.team}/enrolments/${cloud.body.enrollment_id}`, { request_id: rid() })).status, 200);
    assert.equal((await ask(fx.A.repo)).status, 401);
    assert.equal(gh.asks.length, 0, 'GitHub was never asked for any of these');
  } finally { await r.close(); }
});

test('repo token: no installation link is an honest 404; GitHub granting less, more or other repositories is refused and the token dropped', async () => {
  const r = await rig();
  try {
    const { fx, gh, ask } = r;
    await r.cloudCard();
    gh.mode = '422';
    const denied = await ask(fx.A.repo);
    assert.equal(denied.status, 403, denied.text);
    assert.equal(denied.body.error.reason, 'not_granted');
    for (const mode of ['wider', 'all_repos']) {
      gh.mode = mode;
      const n = gh.minted.length;
      const res = await ask(fx.A.repo);
      assert.equal(res.status, 403, `${mode}: ${res.text}`);
      assert.ok(!res.text.includes(gh.minted[n]), `${mode}: the token GitHub made is not returned`);
    }
    gh.mode = 'expired';
    const expired = await ask(fx.A.repo);
    assert.equal(expired.status, 502, expired.text);
    assert.ok(!expired.text.includes('ghs_'));
    gh.mode = 'ok';
    fx.db.run('DELETE FROM integration_app_repos WHERE connection_id = ?', fx.A.connection);
    const asks = gh.asks.length;
    const none = await ask(fx.A.repo);
    assert.equal(none.status, 404, none.text);
    assert.equal(none.body.error.reason, 'no_installation');
    assert.match(none.body.error.message, /not linked to the team's GitHub App installation/);
    assert.equal(gh.asks.length, asks);
  } finally { await r.close(); }
});

test('repo token: rate limited per runner; audited with who, runner, repo and when; the token is in no log line, audit row or table', async () => {
  const r = await rig({ rateLimits: { runner_repo_token_runner: { capacity: 3, per_ms: 600_000 } } });
  try {
    const { fx, gh, ask, logs, cloud } = r;
    const { cardId } = await r.cloudCard();
    const ok = await ask(fx.A.repo);
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await ask(fx.A.repo)).status, 200);
    assert.equal((await ask(randomUUID())).status, 404, 'refusals spend it too');
    const limited = await ask(fx.A.repo);
    assert.equal(limited.status, 429, limited.text);
    assert.equal(gh.asks.length, 2);
    const audit = fx.db.all("SELECT * FROM audit WHERE action = 'runner.repo_token' ORDER BY id");
    assert.equal(audit.length, 2);
    const e = fx.db.get('SELECT * FROM runner_enrollments WHERE id = ?', cloud.body.enrollment_id);
    assert.equal(audit[0].actor_user_id, fx.users.ua.id);
    assert.equal(audit[0].org_id, fx.A.team);
    assert.equal(audit[0].target, fx.A.repo);
    assert.ok(audit[0].at);
    const detail = JSON.parse(audit[0].detail);
    assert.deepEqual([detail.enrollment_id, detail.device_id, detail.card_id, detail.installation_id], [e.id, e.device_id, cardId, INST_A]);
    await settle(20);
    const everything = [logs.join('\n'), ...fx.db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(({ name }) => JSON.stringify(fx.db.all(`SELECT * FROM "${name}"`)))].join('\n');
    assert.ok(logs.some((l) => l.includes('repo token minted')), 'the mint is logged, without the token');
    for (const t of gh.minted) assert.ok(!everything.includes(t), 'no minted token in any log line or table');
    assert.ok(!everything.includes(cloud.body.runner_token), 'nor the runner token');
  } finally { await r.close(); }
});
