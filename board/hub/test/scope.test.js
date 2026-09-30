// Repo scoping on the hub side: a runner can only advertise board repos, its
// outbox/RPC writes must carry the run's repo_id, and it can't reach cards in
// another org.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub, runMsg } from './helpers.js';

test('repo-scope rejection: advertise, outbox and rpc with a foreign repo are refused', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const other = await h.api(alice, 'POST', '/api/repos', { request_id: randomUUID(), url: 'https://github.com/acme/secret.git' });
    assert.equal(other.status, 200);
    assert.equal(other.body.repo.canonical_url, 'github.com/acme/secret');
    const dup = await h.api(alice, 'POST', '/api/repos', { request_id: randomUUID(), url: 'git@github.com:ACME/secret' });
    assert.equal(dup.status, 409);
    const bad = await h.api(alice, 'POST', '/api/repos', { request_id: randomUUID(), url: '/Users/me/code/secret' });
    assert.equal(bad.body.error.code, 'VALIDATION');

    const dev = await h.enroll(alice);
    const r = await h.runner(dev, { advertise: false });
    assert.deepEqual(r.welcome.allowlist.map((x) => x.repo_id), [h.ids.repo], 'allowlist = board repos only');
    await r.advertise([{ repo_id: h.ids.repo }, { repo_id: other.body.repo.id }, { repo_id: 'made-up' }]);
    const adv = h.db.all('SELECT repo_id FROM runner_repos WHERE device_id = ?', dev.device_id).map((x) => x.repo_id);
    assert.deepEqual(adv, [h.ids.repo], 'never beyond the board allowlist (D14)');

    const run = await h.startRun(alice, r);
    const before = h.db.get('SELECT count(*) AS n FROM events WHERE card_id = ?', run.card_id).n;
    await r.out({ kind: 'progress.append', ...runMsg(run), repo_id: other.body.repo.id, text: 'leak' });
    const err = await r.next('error', (m) => m.code === 'FORBIDDEN');
    assert.match(err.message, /rejected/);
    assert.equal(h.db.get('SELECT count(*) AS n FROM events WHERE card_id = ?', run.card_id).n, before, 'nothing applied');
    assert.equal(h.db.get("SELECT count(*) AS n FROM audit WHERE action = 'outbox.rejected'").n, 1);

    const rpc = await r.rpc(run, 'board_list_cards', {}, { repo_id: other.body.repo.id });
    assert.deepEqual([rpc.ok, rpc.error.code], [false, 'FORBIDDEN']);
    const listed = await r.rpc(run, 'board_list_cards', {});
    assert.ok(listed.result.cards.every((c) => c.key.startsWith('DEV-')));

    // A card whose repo the device didn't advertise can't be claimed.
    await h.api(alice, 'POST', `/api/boards/${h.ids.board}/repos`, { request_id: randomUUID(), repo_id: other.body.repo.id });
    const card = await h.createCard(alice, { repo_id: other.body.repo.id });
    await h.action(alice, card.id, 'dispatch');
    const d = h.db.get("SELECT * FROM dispatches WHERE card_id = ? AND state = 'pending'", card.id);
    const res = await r.claim({ card_id: card.id, request_id: d.request_id, fence: 0 });
    assert.deepEqual([res.ok, res.error.code], [false, 'REPO_NOT_ADVERTISED']);
    assert.equal(r.all('offer', (o) => o.card_id === card.id).length, 0, 'never offered');
  } finally {
    await h.destroy();
  }
});

test('a device of another org cannot see or claim cards; a tampered run token is refused', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);

    const now = new Date().toISOString();
    h.db.insert('orgs', { id: 'o2', name: 'other', created_at: now });
    h.db.insert('members', { id: 'm-eve', org_id: 'o2', github_id: 99, github_login: 'eve', email: 'eve@x.io', display_name: 'Eve', role: 'owner', created_at: now });
    const eve = await h.login('eve');
    const eveDev = await h.enroll(eve);
    const re = await h.runner(eveDev, { advertise: false });
    assert.deepEqual(re.welcome.allowlist, []);
    const claim = await re.claim({ card_id: run.card_id, request_id: 'x', fence: run.fence });
    assert.equal(claim.error.code, 'CLAIM_LOST');
    const view = await h.api(eve, 'GET', `/api/cards/${run.card_id}`);
    assert.equal(view.status, 404);

    const [p, payload, sig] = run.run_token.split('.');
    const forged = Buffer.from(JSON.stringify({ c: run.card_id, r: run.run_id, f: run.fence + 5, e: 'x' })).toString('base64url');
    const bad = await r.rpc({ ...run, run_token: `${p}.${forged}.${sig}` }, 'board_get_card');
    assert.equal(bad.error.code, 'UNAUTHENTICATED');
    assert.ok(payload);
    const good = await r.rpc(run, 'board_get_card');
    assert.equal(good.ok, true);
    assert.equal(good.result.card.key, run.key);
  } finally {
    await h.destroy();
  }
});

test('METHOD_SCOPES: every runner RPC (runner-only ones too) has a declared scope that matches its board-mcp tool', async () => {
  const { METHOD_SCOPES } = await import('../rpc.js');
  const { RPC_METHODS, RUNNER_ONLY_RPC, TOOL_SCOPES, MCP_TOOL_SCOPES } = await import('../../shared/protocol.js');
  assert.deepEqual(Object.keys(METHOD_SCOPES).sort(), [...RPC_METHODS].sort());
  for (const m of RUNNER_ONLY_RPC) assert.ok(METHOD_SCOPES[m], m);
  for (const [m, s] of Object.entries(METHOD_SCOPES)) {
    assert.ok(TOOL_SCOPES[s], `${m}: ${s} is a known scope`);
    if (MCP_TOOL_SCOPES[m]) assert.equal(s, MCP_TOOL_SCOPES[m], m);
  }
  assert.ok(Object.isFrozen(METHOD_SCOPES));
});

test('board_recall (repo:read) returns only this board\'s notes, not another board\'s on the same repo', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    const now = new Date().toISOString();
    const orgId = h.db.get('SELECT org_id FROM boards WHERE id = ?', h.ids.board).org_id;
    h.db.insert('boards', { id: 'b-side', org_id: orgId, name: 'Side', key_prefix: 'SIDE', next_key: 2 });
    h.db.insert('board_repos', { board_id: 'b-side', repo_id: run.repo_id });
    h.db.insert('cards', { id: 'c-side', board_id: 'b-side', key: 'SIDE-1', title: 'side', body: '', repo_id: run.repo_id, created_by: h.ids.alice, created_at: now, updated_at: now });
    const mem = (id, cardId, body) => h.db.insert('memories', { id, org_id: orgId, repo_id: run.repo_id, kind: 'handoff', body, card_id: cardId, author_run_id: run.run_id, created_at: now, updated_at: now });
    mem('m-ours', run.card_id, 'our handoff');
    mem('m-side', 'c-side', 'side board handoff');
    const rec = await r.rpc(run, 'board_recall', {});
    assert.deepEqual(rec.result.memories.map((m) => m.id), ['m-ours']);
  } finally {
    await h.destroy();
  }
});
