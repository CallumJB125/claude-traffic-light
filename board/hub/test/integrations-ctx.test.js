// Registry capabilities a code-host connector needs: ctx.cardForBranch (the
// only PR → card mapping), s.linkStatus (a small per-link status for the card
// face) and the App-manifest connect flow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { branchName } from '../../shared/fence.js';
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
