// Registry capabilities a code-host connector needs: ctx.cardForBranch (the
// only PR → card mapping), s.linkStatus (a small per-link status for the card
// face) and the App-manifest connect flow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { branchName } from '../../shared/fence.js';
import { cardView } from '../views.js';
import fake from '../integrations/fake/index.js';
import { startHub } from './helpers.js';

async function setup() {
  const h = await startHub();
  h.hub.setVaultKey(randomBytes(32));
  const reg = h.app.integrations;
  const v = await fake.connect.verifyToken({ token: 'fake_abcdef123456' });
  const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'fake', ...v });
  return { h, reg, conn };
}

// A card with one recorded run: the rows a real dispatch + claim leave behind.
function addRun(h, { boardId = h.ids.board, repoId = h.ids.repo, member = h.ids.alice, fence = 1, branch = null, key = null } = {}) {
  const t = h.hub.iso();
  const cardId = randomUUID();
  const cardKey = key ?? `BDL-${Math.floor(Math.random() * 1e6)}`;
  h.db.run("INSERT INTO cards (id, board_id, key, title, repo_id, created_by, created_at, updated_at) VALUES (?, ?, ?, 'T', ?, ?, ?, ?)", cardId, boardId, cardKey, repoId, member, t, t);
  const rid = randomUUID();
  h.db.run("INSERT INTO dispatches (request_id, card_id, dispatched_by, state, created_at) VALUES (?, ?, ?, 'claimed', ?)", rid, cardId, member, t);
  h.db.run("INSERT INTO runs (id, card_id, fence, on_behalf_of, dispatched_by, dispatch_request_id, backend, repo_id, base_ref, branch, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, 'claude_cli', ?, 'main', ?, ?, ?)",
    randomUUID(), cardId, fence, member, member, rid, repoId, branch ?? branchName(cardKey, fence), t, t);
  return { cardId, key: cardKey, branch: branch ?? branchName(cardKey, fence) };
}

function addOrg(h) {
  const org = randomUUID();
  const board = randomUUID();
  const admin = randomUUID();
  const repo = randomUUID();
  const t = h.hub.iso();
  h.db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', org, 'Other', t);
  h.db.run("INSERT INTO boards (id, org_id, name, key_prefix) VALUES (?, ?, 'O', 'OTH')", board, org);
  h.db.run("INSERT INTO members (id, org_id, github_id, github_login, display_name, role, created_at) VALUES (?, ?, -99, 'carol', 'Carol', 'owner', ?)", admin, org, t);
  // The same GitHub repo, registered by another team.
  h.db.run("INSERT INTO repos (id, org_id, canonical_url, short_name) VALUES (?, ?, 'github.com/acme/app', 'app')", repo, org);
  h.db.run('INSERT INTO board_repos (board_id, repo_id) VALUES (?, ?)', board, repo);
  return { org, board, admin, repo };
}

test('cardForBranch: a recorded run branch of this org, in the named repo, maps to its card (repo case-insensitive)', async () => {
  const { h, reg, conn } = await setup();
  try {
    const ctx = reg.ctxFor(conn.id);
    const r = addRun(h, { key: 'BDL-41', fence: 3 });
    assert.equal(r.branch, 'board/BDL-41-r3');
    assert.equal(ctx.cardForBranch('acme/app', 'board/BDL-41-r3'), r.cardId);
    assert.equal(ctx.cardForBranch('Acme/App', 'board/BDL-41-r3'), r.cardId);
    assert.equal(ctx.cardForBranch('github.com/ACME/app', 'board/BDL-41-r3'), r.cardId);
  } finally { await h.close(); }
});

test('cardForBranch: forged lookalike branches are null (unknown fence, case, suffix, traversal, control chars, too long)', async () => {
  const { h, reg, conn } = await setup();
  try {
    const ctx = reg.ctxFor(conn.id);
    addRun(h, { key: 'BDL-1', fence: 2 });
    for (const b of ['board/BDL-1-r9', 'board/bdl-1-r2', 'BOARD/BDL-1-r2', 'board/BDL-1-r2x', 'board/BDL-1-r2/../x', '../board/BDL-1-r2', 'board/BDL-1-r2 ', ' board/BDL-1-r2', 'board/BDL-1-r2\n', 'board/BDL-1-r2\0', 'refs/heads/board/BDL-1-r2', '', null, 42, `board/BDL-1-r2${'x'.repeat(300)}`]) {
      assert.equal(ctx.cardForBranch('acme/app', b), null, JSON.stringify(b));
    }
    // A recorded branch with whitespace in it still never matches (a forged run row can't be reached either).
    addRun(h, { key: 'BDL-7', branch: 'board/BDL-7 r1' });
    assert.equal(ctx.cardForBranch('acme/app', 'board/BDL-7 r1'), null);
    const long = `board/${'L'.repeat(260)}`;
    addRun(h, { key: 'BDL-8', branch: long });
    assert.equal(ctx.cardForBranch('acme/app', long), null);
  } finally { await h.close(); }
});

test('cardForBranch: the right branch in the wrong repo, or a repo on no board of this org, is null', async () => {
  const { h, reg, conn } = await setup();
  try {
    const ctx = reg.ctxFor(conn.id);
    const r = addRun(h, { key: 'BDL-2', fence: 1 });
    assert.equal(ctx.cardForBranch('acme/other', r.branch), null);
    assert.equal(ctx.cardForBranch('evil/app', r.branch), null);
    for (const bad of ['', 'acme', 'acme/app/../x', '../acme/app', 'acme/app?x', null, {}]) assert.equal(ctx.cardForBranch(bad, r.branch), null, JSON.stringify(bad));
    // A second repo of the org, on no board: its runs never match.
    const lone = randomUUID();
    h.db.run("INSERT INTO repos (id, org_id, canonical_url, short_name) VALUES (?, ?, 'github.com/acme/lone', 'lone')", lone, h.ids.org);
    const l = addRun(h, { key: 'BDL-3', repoId: lone });
    assert.equal(ctx.cardForBranch('acme/lone', l.branch), null);
    h.db.run('INSERT INTO board_repos (board_id, repo_id) VALUES (?, ?)', h.ids.board, lone);
    assert.equal(ctx.cardForBranch('acme/lone', l.branch), l.cardId);
    // The run's repo decides, not the card's: a run in acme/app is not found under acme/lone.
    assert.equal(ctx.cardForBranch('acme/lone', r.branch), null);
  } finally { await h.close(); }
});

test('cardForBranch: another org\'s card on the same repo and branch is null; duplicates are null', async () => {
  const { h, reg, conn } = await setup();
  try {
    const ctx = reg.ctxFor(conn.id);
    const o = addOrg(h);
    const theirs = addRun(h, { boardId: o.board, repoId: o.repo, member: o.admin, key: 'OTH-1', fence: 1 });
    assert.equal(ctx.cardForBranch('acme/app', theirs.branch), null);
    // Their card's run recorded in OUR repo row (never legitimately possible) still isn't ours.
    const cross = addRun(h, { boardId: o.board, repoId: h.ids.repo, member: o.admin, key: 'OTH-2', fence: 1 });
    assert.equal(ctx.cardForBranch('acme/app', cross.branch), null);
    const a = addRun(h, { key: 'BDL-5', fence: 1 });
    assert.equal(ctx.cardForBranch('acme/app', a.branch), a.cardId);
    addRun(h, { key: 'BDL-6', branch: a.branch });
    assert.equal(ctx.cardForBranch('acme/app', a.branch), null, 'two cards recorded the same branch: ambiguous');
  } finally { await h.close(); }
});

test('cardForBranch: consults cards.self_driven_branch only when that column exists (extension point)', async () => {
  const { h, reg, conn } = await setup();
  try {
    const ctx = reg.ctxFor(conn.id);
    const r = addRun(h, { key: 'BDL-9', fence: 1 });
    const t = h.hub.iso();
    const selfDriven = randomUUID();
    h.db.run("INSERT INTO cards (id, board_id, key, title, repo_id, created_by, created_at, updated_at) VALUES (?, ?, 'BDL-10', 'S', ?, ?, ?, ?)", selfDriven, h.ids.board, h.ids.repo, h.ids.alice, t, t);
    assert.equal(ctx.cardForBranch('acme/app', 'feature/login'), null);
    h.db.exec('ALTER TABLE cards ADD COLUMN self_driven_branch TEXT');
    h.db.run("UPDATE cards SET self_driven_branch = 'feature/login' WHERE id = ?", selfDriven);
    assert.equal(ctx.cardForBranch('acme/app', 'feature/login'), selfDriven);
    assert.equal(ctx.cardForBranch('acme/other', 'feature/login'), null);
    assert.equal(ctx.cardForBranch('acme/app', 'Feature/login'), null);
    h.db.run('UPDATE cards SET self_driven_branch = ? WHERE id = ?', r.branch, selfDriven);
    assert.equal(ctx.cardForBranch('acme/app', r.branch), null, 'a run branch also claimed by a self-driven card is ambiguous');
  } finally { await h.close(); }
});

const statusOf = (h, conn, id) => JSON.parse(h.db.get("SELECT status FROM external_links WHERE connection_id = ? AND kind = 'pr' AND external_id = ?", conn.id, id).status ?? 'null');

test('linkStatus: partials merge into the link\'s status (allowlisted keys and values only), inside act() only', async () => {
  const { h, reg, conn } = await setup();
  try {
    const ctx = reg.ctxFor(conn.id);
    const r = addRun(h, { key: 'BDL-20', fence: 1 });
    await ctx.act('card.create', { card_id: r.cardId, external_ref: 'PR-5' }, async (s) => { s.link(r.cardId, 'pr', 'PR-5', 'https://fake.example/pr/5'); });
    await ctx.act('card.create', { card_id: r.cardId }, async (s) => s.linkStatus(r.cardId, 'pr', 'PR-5', { state: 'open' }));
    await ctx.act('card.create', { card_id: r.cardId }, async (s) => s.linkStatus(r.cardId, 'pr', 'PR-5', { checks: 'pending' }));
    await ctx.act('card.create', { card_id: r.cardId }, async (s) => s.linkStatus(r.cardId, 'pr', 'PR-5', { review: 'requested' }));
    assert.deepEqual(statusOf(h, conn, 'PR-5'), { state: 'open', checks: 'pending', review: 'requested' });
    // An invalid value or unknown key is dropped without clobbering the stored one.
    await ctx.act('card.create', { card_id: r.cardId }, async (s) => s.linkStatus(r.cardId, 'pr', 'PR-5', { checks: 'passing', state: 'exploded', review: 7, title: 'x'.repeat(30), nested: { a: 1 } }));
    assert.deepEqual(statusOf(h, conn, 'PR-5'), { state: 'open', checks: 'passing', review: 'requested' });
    // Nothing valid → refused (audited failed), nothing changed.
    await assert.rejects(ctx.act('card.create', { card_id: r.cardId }, async (s) => s.linkStatus(r.cardId, 'pr', 'PR-5', { state: 'nope', url: 'https://x' })), (e) => e.code === 'VALIDATION');
    await assert.rejects(ctx.act('card.create', {}, async (s) => s.linkStatus(r.cardId, 'pr', 'PR-5', 'open')), (e) => e.code === 'VALIDATION');
    assert.deepEqual(statusOf(h, conn, 'PR-5'), { state: 'open', checks: 'passing', review: 'requested' });
    const audit = reg.audit(conn.id);
    assert.deepEqual(audit.slice(0, 2).map((a) => [a.decision, a.error]), [['failed', 'validation'], ['failed', 'validation']]);
    assert.ok(audit.slice(2).every((a) => a.decision === 'auto'));
    // Outside a scope: there is no ctx.linkStatus, and a stashed scope is dead.
    assert.equal(ctx.linkStatus, undefined);
    let kept;
    await ctx.act('card.create', {}, async (s) => { kept = s; });
    assert.throws(() => kept.linkStatus(r.cardId, 'pr', 'PR-5', { state: 'merged' }), /scope has ended/);
    assert.equal(statusOf(h, conn, 'PR-5').state, 'open');
  } finally { await h.close(); }
});

test('linkStatus: the link must exist for this connection and card; the merged blob is capped at 512 bytes', async () => {
  const { h, reg, conn } = await setup();
  try {
    const ctx = reg.ctxFor(conn.id);
    const r = addRun(h, { key: 'BDL-21', fence: 1 });
    const other = addRun(h, { key: 'BDL-22', fence: 1 });
    await ctx.act('card.create', {}, async (s) => s.link(r.cardId, 'pr', 'PR-6'));
    const set = (cardId, kind, id, st) => ctx.act('card.create', {}, async (s) => s.linkStatus(cardId, kind, id, st));
    await assert.rejects(set(r.cardId, 'pr', 'PR-404', { state: 'open' }), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(set(other.cardId, 'pr', 'PR-6', { state: 'open' }), (e) => e.code === 'NOT_FOUND', 'the link is to another card');
    await assert.rejects(set(r.cardId, 'issue', 'PR-6', { state: 'open' }), (e) => e.code === 'NOT_FOUND');
    // Another connection's link to the same card is not ours to annotate.
    const second = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'fake', external_id: 'fake-workspace-2', secrets: {} });
    await assert.rejects(reg.ctxFor(second.id).act('card.create', {}, async (s) => s.linkStatus(r.cardId, 'pr', 'PR-6', { state: 'open' })), (e) => e.code === 'NOT_FOUND');
    // A stored blob over the cap (written by something older or broken) is not grown.
    h.db.run("UPDATE external_links SET status = ? WHERE external_id = 'PR-6'", JSON.stringify({ state: 'open', junk: 'x'.repeat(600) }));
    await set(r.cardId, 'pr', 'PR-6', { checks: 'failing' });
    const st = statusOf(h, conn, 'PR-6');
    assert.deepEqual(st, { state: 'open', checks: 'failing' }, 'only allowlisted keys survive a merge');
    assert.ok(Buffer.byteLength(JSON.stringify(st)) <= 512);
  } finally { await h.close(); }
});

test('cardView: pr_link_status is the newest pr link\'s status (additive; pr is unchanged)', async () => {
  const { h, reg, conn } = await setup();
  try {
    const ctx = reg.ctxFor(conn.id);
    const r = addRun(h, { key: 'BDL-23', fence: 1 });
    const view = () => cardView(h.hub, h.hub.card(r.cardId), h.ids.alice);
    assert.equal(view().pr_link_status, null);
    assert.equal(view().pr, null);
    await ctx.act('card.create', {}, async (s) => { s.link(r.cardId, 'pr', 'PR-7'); s.linkStatus(r.cardId, 'pr', 'PR-7', { state: 'draft', checks: 'none' }); });
    assert.deepEqual(view().pr_link_status, { state: 'draft', checks: 'none', review: null });
    h.clock.advance(1000);
    await ctx.act('card.create', {}, async (s) => s.link(r.cardId, 'pr', 'PR-8'));
    assert.equal(view().pr_link_status, null, 'the newest pr link has no status yet');
    await ctx.act('card.create', {}, async (s) => s.linkStatus(r.cardId, 'pr', 'PR-8', { review: 'approved' }));
    assert.deepEqual(view().pr_link_status, { state: null, checks: null, review: 'approved' });
    // A revoked connection's links stop speaking for the card.
    reg.revokeConnection(conn.id, h.ids.alice);
    assert.equal(view().pr_link_status, null);
  } finally { await h.close(); }
});
