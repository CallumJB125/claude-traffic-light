// GitHub connector behaviour against a stub ctx (ctx.cardForBranch and
// s.linkStatus are builder-5's feat/integrations-ctx; stubbed here until it lands).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import github, { apply, manifest } from '../integrations/github/index.js';
import { factsOf } from '../integrations/github/webhook.js';

const repo = { full_name: 'acme/app' };
const pr = (over = {}) => ({ id: 991, number: 42, html_url: 'https://github.com/acme/app/pull/42', draft: false, merged: false,
  head: { ref: 'board/BDL-12-r3', sha: 'a'.repeat(40), repo }, base: { ref: 'main', repo }, requested_reviewers: [], ...over });

function stubCtx({ branches = { 'acme/app board/BDL-12-r3': 'card-12' } } = {}) {
  const links = new Map();
  const calls = [];
  const ctx = {
    calls, links,
    linked: (kind, id) => links.get(`${kind}:${id}`) ?? null,
    cardForBranch: (r, b) => branches[`${r.toLowerCase()} ${b}`] ?? null,
    async act(action, meta, run) {
      calls.push(['act', action, meta.external_ref]);
      await run({
        link: (card, kind, id, url) => { links.set(`${kind}:${id}`, card); calls.push(['link', card, id, url]); },
        linkStatus: (card, kind, id, status) => calls.push(['status', card, id, status]),
      });
    },
    system: { event: async (type, ev) => calls.push(['system', type, ev.external_id, ev.pr, ev.by]) },
  };
  return ctx;
}
const run = (ctx, event, payload) => apply(ctx, factsOf(event, payload));

test('a PR from a board branch is linked to its card and gets a status', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr({ draft: true }), repository: repo });
  assert.deepEqual(ctx.calls, [['act', 'pr.link', '991'], ['link', 'card-12', '991', 'https://github.com/acme/app/pull/42'], ['status', 'card-12', '991', { state: 'draft' }]]);
});

test('merging a linked PR raises pr_merged for its card (the state machine moves it to Done)', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  ctx.calls.length = 0;
  await run(ctx, 'pull_request', { action: 'closed', pull_request: pr({ merged: true, merged_by: { login: 'tonde' } }), repository: repo });
  assert.deepEqual(ctx.calls.at(-1), ['system', 'pr_merged', '991', 42, 'tonde']);
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'status'), ['status', 'card-12', '991', { state: 'merged' }]);
});

test('a merge that arrives before any open event still links through the board branch', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'closed', pull_request: pr({ merged: true, merged_by: { login: 'tonde' } }), repository: repo });
  assert.deepEqual(ctx.calls.map((c) => c[0]), ['act', 'link', 'status', 'system']);
});

test('closing unmerged raises pr_closed', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'closed', pull_request: pr(), repository: repo, sender: { login: 'callum' } });
  assert.deepEqual(ctx.calls.at(-1), ['system', 'pr_closed', '991', 42, 'callum']);
});

test('nothing happens for a PR the board did not create, a fork, or free text naming a card', async () => {
  for (const p of [
    pr({ head: { ref: 'feature/login', sha: 'b'.repeat(40), repo } }),
    pr({ head: { ref: 'board/BDL-12-r3', sha: 'c'.repeat(40), repo: { full_name: 'mallory/app' } } }),
    pr({ head: { ref: 'fix', sha: 'd'.repeat(40), repo }, title: 'Fixes BDL-12', body: 'board/BDL-12-r3' }),
  ]) {
    const ctx = stubCtx();
    await run(ctx, 'pull_request', { action: 'closed', pull_request: { ...p, merged: true }, repository: repo });
    assert.deepEqual(ctx.calls, [], JSON.stringify(p.head));
  }
});

test('reviews and checks update a linked PR only', async () => {
  const ctx = stubCtx();
  await run(ctx, 'check_suite', { action: 'completed', check_suite: { id: 1, head_sha: 'a'.repeat(40), conclusion: 'failure', pull_requests: [{ id: 991, number: 42 }] }, repository: repo });
  assert.deepEqual(ctx.calls, [], 'not linked yet');
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  ctx.calls.length = 0;
  await run(ctx, 'check_suite', { action: 'completed', check_suite: { id: 1, head_sha: 'a'.repeat(40), conclusion: 'failure', pull_requests: [{ id: 991, number: 42 }] }, repository: repo });
  await run(ctx, 'pull_request_review', { action: 'submitted', review: { id: 5, state: 'approved', user: { login: 'tonde' } }, pull_request: pr(), repository: repo });
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'status').map((c) => c[3]), [{ checks: 'failing' }, { review: 'approved' }]);
});

test('every status the connector writes is allowed by the registry', async () => {
  const { cleanLinkStatus } = await import('../integrations/connector.js');
  const ctx = stubCtx();
  const statuses = [];
  const orig = ctx.act;
  ctx.act = async (a, m, run) => orig(a, m, async (s) => run({ ...s, linkStatus: (c, k, i, st) => { statuses.push(st); s.linkStatus(c, k, i, st); } }));
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr({ draft: true }), repository: repo });
  await run(ctx, 'pull_request', { action: 'review_requested', pull_request: pr({ requested_reviewers: [{ login: 'x' }] }), repository: repo });
  await run(ctx, 'check_suite', { action: 'completed', check_suite: { id: 1, head_sha: 'a'.repeat(40), conclusion: 'success', pull_requests: [{ id: 991, number: 42 }] }, repository: repo });
  await run(ctx, 'pull_request_review', { action: 'submitted', review: { id: 5, state: 'changes_requested', user: { login: 'tonde' } }, pull_request: pr(), repository: repo });
  await run(ctx, 'pull_request', { action: 'closed', pull_request: pr({ merged: true }), repository: repo });
  assert.ok(statuses.length >= 5);
  for (const st of statuses) assert.deepEqual(cleanLinkStatus(st), st, JSON.stringify(st));
});

test('the connector declares only facts, all automatic, and reads GitHub only', () => {
  assert.deepEqual(github.systemEvents, ['pr_merged', 'pr_closed']);
  assert.ok(Object.values(github.actions).every((a) => a.default === 'auto'));
  assert.deepEqual(github.scopes, ['pull_requests:read', 'checks:read', 'metadata:read']);
  const m = manifest({ redirectUri: 'https://app.plexiform.dev/integrations/github/callback', webhookUrl: 'https://app.plexiform.dev/integrations/c1/webhook', name: 'Plexiform' });
  assert.deepEqual(m.default_permissions, { pull_requests: 'read', checks: 'read', metadata: 'read' });
  assert.equal(m.public, false);
});

test('the manifest form posts to github.com with the state, and never auto-submits', () => {
  const f = github.connect.manifestForm({ state: 'st/1', redirectUri: 'https://app.plexiform.dev/cb', webhookUrl: 'https://app.plexiform.dev/integrations/c1/webhook', config: { org: 'acme' } });
  assert.equal(github.connect.formHost, 'github.com');
  assert.equal(new URL(f.action).host, github.connect.formHost);
  assert.equal(f.action, 'https://github.com/organizations/acme/settings/apps/new?state=st%2F1');
  assert.equal(JSON.parse(f.fields.manifest).hook_attributes.url, 'https://app.plexiform.dev/integrations/c1/webhook');
  assert.equal(github.connect.manifestForm({ state: 's', redirectUri: 'r', config: { org: '../evil' } }).action, 'https://github.com/settings/apps/new?state=s');
});

test('the manifest exchange seals the key and webhook secret and points at the install step', async () => {
  const fetch = async (url, init) => {
    assert.equal(url, 'https://api.github.com/app-manifests/abc123/conversions');
    assert.equal(init.method, 'POST');
    return { ok: true, json: async () => ({ id: 77, slug: 'plexiform-acme', name: 'Plexiform', owner: { id: 5, login: 'acme' }, pem: '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----', webhook_secret: 'whsec_0123456789abcdef' }) };
  };
  const r = await github.connect.exchange({ query: { code: 'abc123' }, fetch });
  assert.deepEqual(Object.keys(r.secrets).sort(), ['app_private_key', 'webhook_secret']);
  assert.equal(r.next_url, 'https://github.com/apps/plexiform-acme/installations/new');
  await assert.rejects(github.connect.exchange({ query: { code: '../x' }, fetch }), /bad manifest code/);
});
