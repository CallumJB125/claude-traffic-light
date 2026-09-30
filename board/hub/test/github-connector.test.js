// GitHub connector behaviour against a stub ctx (ctx.cardForBranch and
// s.linkStatus are builder-5's feat/integrations-ctx; stubbed here until it lands).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import github, { apply, manifest } from '../integrations/github/index.js';
import { factsOf } from '../integrations/github/webhook.js';

const repo = { id: 501, full_name: 'acme/app', default_branch: 'main' };
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
const suite = (conclusion, sha = 'a'.repeat(40)) => ({ action: 'completed', repository: repo,
  check_suite: { id: 1, head_sha: sha, conclusion, pull_requests: [{ id: 991, number: 42, head: { ref: 'board/BDL-12-r3', sha, repo: { id: 501 } }, base: { ref: 'main', repo: { id: 501 } } }] } });
const review = (state, id = 5, action = 'submitted') => ({ action, review: { id, state, user: { login: 'tonde' }, author_association: 'MEMBER' }, pull_request: pr(), repository: repo });
const statuses = (ctx) => ctx.calls.filter((c) => c[0] === 'status').map((c) => c[3]);

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

test('H1: a merge or close the board never saw open links nothing and moves nothing', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'closed', pull_request: pr({ merged: true, merged_by: { login: 'tonde' } }), repository: repo });
  await run(ctx, 'pull_request', { action: 'closed', pull_request: pr(), repository: repo, sender: { login: 'callum' } });
  assert.deepEqual(ctx.calls, []);
});

test('closing a linked PR unmerged raises pr_closed', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  await run(ctx, 'pull_request', { action: 'closed', pull_request: pr(), repository: repo, sender: { login: 'callum' } });
  assert.deepEqual(ctx.calls.at(-1), ['system', 'pr_closed', '991', 42, 'callum']);
});

test('H1 T1: a second PR from the board branch into another base, merged, does not move the card', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  const decoy = pr({ id: 1100, number: 11, base: { ref: 'scratch', repo } });
  await run(ctx, 'pull_request', { action: 'opened', pull_request: decoy, repository: repo });
  await run(ctx, 'pull_request', { action: 'closed', pull_request: { ...decoy, merged: true, merged_by: { login: 'mallory' } }, repository: repo });
  assert.equal(ctx.linked('pr', '1100'), null);
  assert.ok(!ctx.calls.some((c) => c[0] === 'system'));
});

test('H1 T1b: a decoy PR into a junk base, closed unmerged, does not send the card back', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  const decoy = pr({ id: 2100, number: 21, base: { ref: 'junk', repo } });
  await run(ctx, 'pull_request', { action: 'opened', pull_request: decoy, repository: repo });
  await run(ctx, 'pull_request', { action: 'closed', pull_request: decoy, repository: repo, sender: { login: 'mallory' } });
  assert.ok(!ctx.calls.some((c) => c[0] === 'system' || c[2] === '2100'));
});

test('H1: a linked PR whose base was edited away from the default branch raises nothing when it closes', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  const moved = pr({ base: { ref: 'scratch', repo } });
  await run(ctx, 'pull_request', { action: 'edited', changes: { base: { ref: { from: 'main' }, sha: { from: 'f'.repeat(40) } } }, pull_request: moved, repository: repo });
  await run(ctx, 'pull_request', { action: 'closed', pull_request: { ...moved, merged: true, merged_by: { login: 'mallory' } }, repository: repo });
  assert.ok(!ctx.calls.some((c) => c[0] === 'system'));
  assert.deepEqual(statuses(ctx).at(-1), { state: 'merged' }, 'the card face still shows what happened to the PR');
  // Edited back to main before merging: it counts again.
  await run(ctx, 'pull_request', { action: 'closed', pull_request: pr({ id: 991, merged: true, merged_by: { login: 'tonde' } }), repository: repo });
  assert.deepEqual(ctx.calls.at(-1), ['system', 'pr_merged', '991', 42, 'tonde']);
});

test('H1: a PR opened into another base first, then retargeted to the default branch, links then', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr({ base: { ref: 'scratch', repo } }), repository: repo });
  assert.deepEqual(ctx.calls, []);
  await run(ctx, 'pull_request', { action: 'edited', pull_request: pr(), repository: repo });
  assert.equal(ctx.linked('pr', '991'), 'card-12');
});

test('H1 forward-compatible: cardForBranch → {card_id, base_ref} picks the base; linkedByCard allows one PR per card', async () => {
  const ctx = stubCtx();
  ctx.cardForBranch = (r, b) => (b === 'board/BDL-12-r3' ? { card_id: 'card-12', base_ref: 'release' } : null);
  ctx.linkedByCard = (card, kind) => [...ctx.links].filter(([k, c]) => c === card && k.startsWith(`${kind}:`)).map(([k]) => k.slice(kind.length + 1));
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  assert.equal(ctx.linked('pr', '991'), null, 'main is the default branch, but not the run\'s base');
  const intoRelease = pr({ base: { ref: 'release', repo } });
  await run(ctx, 'pull_request', { action: 'opened', pull_request: intoRelease, repository: repo });
  assert.equal(ctx.linked('pr', '991'), 'card-12');
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr({ id: 992, number: 43, base: { ref: 'release', repo } }), repository: repo });
  assert.equal(ctx.linked('pr', '992'), null, 'a second PR for the same card');
  await run(ctx, 'pull_request', { action: 'closed', pull_request: { ...intoRelease, merged: true, merged_by: { login: 'tonde' } }, repository: repo });
  assert.deepEqual(ctx.calls.at(-1), ['system', 'pr_merged', '991', 42, 'tonde']);
});

test('nothing happens for a PR the board did not create, a fork, or free text naming a card', async () => {
  for (const p of [
    pr({ head: { ref: 'feature/login', sha: 'b'.repeat(40), repo } }),
    pr({ head: { ref: 'board/BDL-12-r3', sha: 'c'.repeat(40), repo: { id: 777, full_name: 'mallory/app' } } }),
    pr({ head: { ref: 'fix', sha: 'd'.repeat(40), repo }, title: 'Fixes BDL-12', body: 'board/BDL-12-r3' }),
  ]) {
    const ctx = stubCtx();
    await run(ctx, 'pull_request', { action: 'closed', pull_request: { ...p, merged: true }, repository: repo });
    assert.deepEqual(ctx.calls, [], JSON.stringify(p.head));
  }
});

test('reviews and checks update a linked PR only', async () => {
  const ctx = stubCtx();
  await run(ctx, 'check_suite', suite('failure'));
  await run(ctx, 'pull_request_review', review('approved'));
  assert.deepEqual(ctx.calls, [], 'not linked yet');
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  ctx.calls.length = 0;
  await run(ctx, 'check_suite', suite('failure'));
  await run(ctx, 'pull_request_review', review('approved'));
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'status').map((c) => c[3]), [{ checks: 'failing' }, { review: 'approved' }]);
});

test('M1: a dismissed review clears the review; a push resets checks and leaves the review alone', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  ctx.calls.length = 0;
  await run(ctx, 'pull_request_review', review('approved'));
  await run(ctx, 'pull_request', { action: 'synchronize', pull_request: pr({ requested_reviewers: [{ login: 'other' }] }), repository: repo });
  await run(ctx, 'pull_request', { action: 'edited', pull_request: pr({ requested_reviewers: [{ login: 'other' }] }), repository: repo });
  await run(ctx, 'pull_request_review', review('dismissed', 5, 'dismissed'));
  assert.deepEqual(statuses(ctx), [{ review: 'approved' }, { state: 'open', checks: 'pending' }, { state: 'open' }, { review: 'none' }]);
  ctx.calls.length = 0;
  await run(ctx, 'pull_request', { action: 'review_requested', pull_request: pr({ requested_reviewers: [{ login: 'other' }] }), repository: repo });
  assert.deepEqual(statuses(ctx), [{ state: 'open', review: 'requested' }]);
});

test('M2: neutral, skipped and stale suites leave checks alone; cancelled fails; a rerun is pending', async () => {
  const ctx = stubCtx();
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr(), repository: repo });
  ctx.calls.length = 0;
  await run(ctx, 'check_suite', suite('success'));
  for (const c of ['neutral', 'skipped', 'stale']) await run(ctx, 'check_suite', suite(c));
  await run(ctx, 'check_suite', { ...suite('success'), check_suite: { ...suite('success').check_suite, head_sha: 'b'.repeat(40) } });
  await run(ctx, 'check_suite', { ...suite(null), action: 'rerequested' });
  await run(ctx, 'check_suite', suite('cancelled'));
  assert.deepEqual(statuses(ctx), [{ checks: 'passing' }, { checks: 'pending' }, { checks: 'failing' }]);
});

test('L1: a signed event outside the handled set is ignored by handleWebhook', async () => {
  const ctx = stubCtx();
  await github.handleWebhook({ headers: { 'x-github-event': 'installation' }, payload: { action: 'created', repository: repo, pull_request: pr() }, ctx });
  assert.deepEqual(ctx.calls, []);
});

test('every status the connector writes is allowed by the registry', async () => {
  const { cleanLinkStatus } = await import('../integrations/connector.js');
  const ctx = stubCtx();
  const statuses = [];
  const orig = ctx.act;
  ctx.act = async (a, m, run) => orig(a, m, async (s) => run({ ...s, linkStatus: (c, k, i, st) => { statuses.push(st); s.linkStatus(c, k, i, st); } }));
  await run(ctx, 'pull_request', { action: 'opened', pull_request: pr({ draft: true }), repository: repo });
  await run(ctx, 'pull_request', { action: 'review_requested', pull_request: pr({ requested_reviewers: [{ login: 'x' }] }), repository: repo });
  await run(ctx, 'check_suite', suite('success'));
  await run(ctx, 'pull_request_review', review('changes_requested'));
  await run(ctx, 'pull_request_review', review('dismissed', 6, 'dismissed'));
  await run(ctx, 'pull_request', { action: 'synchronize', pull_request: pr(), repository: repo });
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

// Assembled at run time: no key- or secret-shaped literal in the source.
const PEM_LINE = (w) => ['-----' + w, 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const pem = () => `${PEM_LINE('BEGIN')}\n${'M'.repeat(64)}\n${'Q'.repeat(40)}==\n${PEM_LINE('END')}\n`;
const hookSecret = () => randomBytes(20).toString('hex');
const conversion = (over = {}) => ({ id: 77, slug: 'plexiform-acme-x1y2', name: 'Plexiform-acme-x1y2', owner: { id: 5, login: 'acme', type: 'Organization' }, pem: pem(), webhook_secret: hookSecret(),
  permissions: { pull_requests: 'read', checks: 'read', metadata: 'read' }, events: ['pull_request', 'pull_request_review', 'check_suite'], ...over });
const exchangeWith = (body, config = {}) => github.connect.exchange({ query: { code: 'abc123' }, config, fetch: async () => ({ ok: true, json: async () => body }) });

test('the manifest exchange seals the key and webhook secret and points at the install step', async () => {
  const fetch = async (url, init) => {
    assert.equal(url, 'https://api.github.com/app-manifests/abc123/conversions');
    assert.equal(init.method, 'POST');
    return { ok: true, json: async () => conversion() };
  };
  const r = await github.connect.exchange({ query: { code: 'abc123' }, fetch, config: {} });
  assert.deepEqual(Object.keys(r.secrets).sort(), ['app_private_key', 'webhook_secret']);
  assert.equal(r.next_url, 'https://github.com/apps/plexiform-acme-x1y2/installations/new');
  await assert.rejects(github.connect.exchange({ query: { code: '../x' }, fetch }), /bad manifest code/);
});

test('M3: a malformed or over-permissioned manifest conversion is refused', async () => {
  const cases = {
    'pem object': { pem: { a: 1 } },
    'pem not a key': { pem: 'nope' },
    'pem too long': { pem: `${PEM_LINE('BEGIN')}\n${'M'.repeat(8200)}\n${PEM_LINE('END')}\n` },
    'pem with trailing text': { pem: `${pem()}<script>` },
    'short webhook secret': { webhook_secret: 'abc' },
    'long webhook secret': { webhook_secret: 'a'.repeat(257) },
    'webhook secret object': { webhook_secret: { x: 1 } },
    'string id': { id: 'x' },
    'float id': { id: 7.5 },
    'zero id': { id: 0 },
    'owner id object': { owner: { id: { x: 1 }, login: 'acme' } },
    'owner login markup': { owner: { id: 5, login: ['<b>'] } },
    'owner login bad': { owner: { id: 5, login: '-acme' } },
    'no owner': { owner: null },
    'bad slug': { slug: 'Plexiform Acme' },
    'long slug': { slug: 'a'.repeat(35) },
    'write permission': { permissions: { pull_requests: 'write', checks: 'read', metadata: 'read' } },
    'extra permission': { permissions: { pull_requests: 'read', checks: 'read', metadata: 'read', contents: 'write' } },
    'missing permission': { permissions: { pull_requests: 'read', metadata: 'read' } },
    'no permissions': { permissions: undefined },
    'extra event': { events: ['pull_request', 'push'] },
    'no events': { events: undefined },
  };
  for (const [name, over] of Object.entries(cases)) await assert.rejects(exchangeWith(conversion(over)), /manifest conversion returned/, name);
  await assert.rejects(exchangeWith(null), /manifest conversion returned/);
  await assert.rejects(exchangeWith([conversion()]), /manifest conversion returned/);
});

test('M4: each app is its own connection, shown under its owner, and a validated org is kept', async () => {
  const a = await exchangeWith(conversion());
  const b = await exchangeWith(conversion({ id: 78, slug: 'plexiform-acme-z9w8' }));
  assert.deepEqual([a.external_id, b.external_id], ['77', '78']);
  assert.deepEqual([a.display_name, b.display_name], ['acme', 'acme']);
  assert.deepEqual(a.settings, { app_id: 77, app_slug: 'plexiform-acme-x1y2', login: 'acme', org: 'acme' });
  const user = await exchangeWith(conversion({ owner: { id: 9, login: 'callum', type: 'User' } }));
  assert.equal(user.settings.org, undefined);
  assert.equal((await exchangeWith(conversion({ owner: { id: 9, login: 'callum', type: 'User' } }), { org: 'plexi-team' })).settings.org, 'plexi-team');
  assert.equal((await exchangeWith(conversion({ owner: { id: 9, login: 'callum', type: 'User' } }), { org: '../evil' })).settings.org, undefined);
});

test('M4: the default app name is unique per connect and fits GitHub\'s 34 characters', () => {
  const nameOf = (config) => JSON.parse(github.connect.manifestForm({ state: 's', redirectUri: 'https://x/cb', webhookUrl: 'https://x/wh', config }).fields.manifest).name;
  const names = new Set();
  for (let i = 0; i < 50; i++) {
    const n = nameOf({ org: 'acme' });
    assert.match(n, /^Plexiform-acme-[a-z0-9]{4}$/);
    names.add(n);
  }
  assert.ok(names.size > 40);
  assert.match(nameOf({ login: 'callum' }), /^Plexiform-callum-[a-z0-9]{4}$/);
  assert.match(nameOf({}), /^Plexiform-[a-z0-9]{4}$/);
  const long = nameOf({ org: 'a'.repeat(39) });
  assert.ok(long.length <= 34, long);
  assert.match(long, /^Plexiform-a{19}-[a-z0-9]{4}$/);
  assert.match(nameOf({ org: '<script>', appName: 'Plexiform' }), /^Plexiform-[a-z0-9]{4}$/);
});
