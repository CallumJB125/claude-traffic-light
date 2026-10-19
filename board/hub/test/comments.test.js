// Comments on moments and @mentions (team depth lane A; plan
// .omc/plans/team-depth-2026-10-19.md acceptance A1, A2, B1): moments live in
// their table and the settings mirror with the same ids; a moment takes
// comments through its own routes (403 viewer, 404 other board/org); mentions
// are parsed against the org's members and stored as ids; every mentioned
// member but the author gets one inbox row, pushed to their own sockets; the
// board hears `moment.comment` and `card.comment`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub, settle } from './helpers.js';

const rid = () => randomUUID();

async function hubWithRoles() {
  const h = await startHub();
  for (const [login, role, gid] of [['carol', 'admin', -3], ['vera', 'viewer', -4]]) {
    h.db.insert('members', { id: randomUUID(), org_id: h.ids.org, github_id: gid, github_login: login, email: `${login}@dev.local`, display_name: login, role, created_at: h.hub.iso() });
  }
  const other = randomUUID();
  h.db.insert('orgs', { id: other, name: 'other', created_at: h.hub.iso() });
  const otherBoard = randomUUID();
  h.db.insert('boards', { id: otherBoard, org_id: other, name: 'Other', key_prefix: 'OTH', next_key: 1 });
  h.db.insert('members', { id: randomUUID(), org_id: other, github_id: -9, github_login: 'zed', email: 'zed@other.local', display_name: 'zed', role: 'owner', created_at: h.hub.iso() });
  const who = {};
  for (const l of ['alice', 'bob', 'carol', 'vera', 'zed']) who[l] = await h.login(l);
  const ids = Object.fromEntries(h.db.all('SELECT id, github_login FROM members').map((m) => [m.github_login, m.id]));
  return { h, who, ids, otherBoard };
}

const inboxOf = (h, memberId) => h.db.all('SELECT kind, ref_json FROM inbox WHERE member_id = ? ORDER BY created_at, rowid', memberId).map((r) => ({ kind: r.kind, ref: JSON.parse(r.ref_json) }));

test('A1: a moment is a row and a mirror entry; admins and members comment on it, viewers and other orgs cannot', async () => {
  const { h, who, ids, otherBoard } = await hubWithRoles();
  try {
    const bob = await h.browser(who.bob);
    const marked = await h.api(who.bob, 'POST', `/api/boards/${h.ids.board}/moments`, { request_id: rid(), moment: { kind: 'ship', label: 'Checkout live', note: 'to 10%' } });
    assert.equal(marked.status, 200, marked.text);
    const m = marked.body.moments[0];
    const row = h.db.get('SELECT * FROM moments WHERE id = ?', m.id);
    assert.deepEqual([row.board_id, row.kind, row.label, row.note, row.author_member_id], [h.ids.board, 'ship', 'Checkout live', 'to 10%', ids.bob], 'the table row carries the mirror id');
    await bob.next('board.moments');

    const path = `/api/boards/${h.ids.board}/moments/${m.id}/comments`;
    const posted = await h.api(who.carol, 'POST', path, { request_id: rid(), body: 'Nice one' });
    assert.equal(posted.status, 200, posted.text);
    assert.deepEqual(Object.keys(posted.body.comment).sort(), ['author_member_id', 'author_name', 'body', 'created_age_ms', 'created_at', 'for_agent', 'id', 'mentions', 'moment_id', 'reply_to', 'source', 'trusted']);
    assert.deepEqual([posted.body.comment.moment_id, posted.body.comment.author_name, posted.body.comment.mentions], [m.id, 'carol', []]);
    const frame = await bob.next('moment.comment');
    assert.deepEqual([frame.board_id, frame.moment_id, frame.comment.id, frame.mentions], [h.ids.board, m.id, posted.body.comment.id, []]);

    const listed = await h.api(who.vera, 'GET', path);
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.body.comments.map((c) => c.body), ['Nice one'], 'a viewer reads the thread');
    assert.equal((await h.api(who.vera, 'POST', path, { request_id: rid(), body: 'no' })).status, 403, 'a viewer cannot comment');
    assert.equal((await h.api(who.bob, 'POST', path, { request_id: rid(), body: '' })).status, 400, 'an empty body is refused');
    assert.equal((await h.api(who.zed, 'GET', path)).status, 404, 'another org sees no board');
    assert.equal((await h.api(who.zed, 'POST', path, { request_id: rid(), body: 'pwned' })).status, 404);
    assert.equal((await h.api(who.bob, 'GET', `/api/boards/${otherBoard}/moments/${m.id}/comments`)).status, 404);
    assert.equal((await h.api(who.bob, 'GET', `/api/boards/${h.ids.board}/moments/nope/comments`)).status, 404, 'an unknown moment');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM comments WHERE moment_id = ?', m.id).n, 1);

    // Removing the moment removes its row, its comments and the mirror entry.
    assert.equal((await h.api(who.bob, 'DELETE', `/api/boards/${h.ids.board}/moments/${m.id}`, { request_id: rid() })).status, 200);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM moments WHERE id = ?', m.id).n, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM comments WHERE moment_id = ?', m.id).n, 0);
    assert.equal((await h.api(who.bob, 'GET', path)).status, 404);
  } finally {
    await h.close();
  }
});

test('a moment marked before migration 076 (mirror only) still takes comments: its row is written on first use', async () => {
  const { h, who } = await hubWithRoles();
  try {
    const settings = JSON.stringify({ moments: [{ id: 'legacy-1', kind: 'decision', label: 'Postgres', note: '', by: 'Ana', at: '2026-01-02T03:04:05.000Z' }] });
    h.db.run('UPDATE boards SET settings = ? WHERE id = ?', settings, h.ids.board);
    const r = await h.api(who.bob, 'POST', `/api/boards/${h.ids.board}/moments/legacy-1/comments`, { request_id: rid(), body: 'still here' });
    assert.equal(r.status, 200, r.text);
    const row = h.db.get('SELECT * FROM moments WHERE id = ?', 'legacy-1');
    assert.deepEqual([row.kind, row.label, row.author_member_id, row.created_at], ['decision', 'Postgres', null, '2026-01-02T03:04:05.000Z']);
  } finally {
    await h.close();
  }
});

test('A2 + B1: mentions are parsed against org members, stored as ids, capped at ten; each mentioned member but the author gets one inbox row and a push', async () => {
  const { h, who, ids } = await hubWithRoles();
  try {
    const aliceSocket = await h.browser(who.alice);
    const card = await h.createCard(who.bob);
    const post = (body, extra = {}) => h.api(who.bob, 'POST', `/api/cards/${card.id}/comments`, { request_id: rid(), body, ...extra });

    const one = await post('@alice look');
    assert.equal(one.status, 200, one.text);
    assert.deepEqual(one.body.comment.mentions, [ids.alice]);
    assert.equal(h.db.get('SELECT mentions_json FROM comments WHERE id = ?', one.body.comment.id).mentions_json, JSON.stringify([ids.alice]));
    const frame = await aliceSocket.next('card.comment');
    assert.deepEqual([frame.board_id, frame.card_id, frame.comment.body, frame.mentions], [h.ids.board, card.id, '@alice look', [ids.alice]]);
    const item = await aliceSocket.next('inbox.item');
    assert.deepEqual([item.item.kind, item.item.ref, item.item.read_at], ['mention', { board_id: h.ids.board, card_id: card.id, comment_id: one.body.comment.id, by: ids.bob }, null]);
    assert.deepEqual(inboxOf(h, ids.alice), [{ kind: 'mention', ref: { board_id: h.ids.board, card_id: card.id, comment_id: one.body.comment.id, by: ids.bob } }]);
    assert.deepEqual(inboxOf(h, ids.bob), [], 'the author gets no row');

    const none = await post('@nobody and @bob (me)');
    assert.deepEqual(none.body.comment.mentions, [ids.bob], 'self is stored but not notified');
    assert.deepEqual(inboxOf(h, ids.bob), []);
    assert.deepEqual((await post('@nobody here')).body.comment.mentions, []);

    // The email local part and case both match; a member is stored once.
    const byMail = await post('@CAROL and @carol@dev.local, @Vera');
    assert.deepEqual(byMail.body.comment.mentions, [ids.carol, ids.vera]);
    assert.deepEqual(inboxOf(h, ids.carol).map((i) => i.kind), ['mention']);

    // Eleven members mentioned: ten stored, ten notified.
    const extra = [];
    for (let i = 0; i < 9; i++) {
      const id = randomUUID();
      h.db.insert('members', { id, org_id: h.ids.org, github_id: -(100 + i), github_login: `user${i}`, email: `user${i}@dev.local`, display_name: `user${i}`, role: 'member', created_at: h.hub.iso() });
      extra.push(`@user${i}`);
    }
    const eleven = await post(`@alice @carol ${extra.join(' ')}`);
    assert.equal(eleven.body.comment.mentions.length, 10);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM inbox WHERE ref_json LIKE ?', `%${eleven.body.comment.id}%`).n, 10);

    // The card detail carries mentions too.
    const det = await h.api(who.alice, 'GET', `/api/cards/${card.id}`);
    assert.deepEqual(det.body.comments[0].mentions, [ids.alice]);

    // A reply to another member's comment writes `reply` for that author; a mention of the same person is not doubled.
    const reply = await h.api(who.alice, 'POST', `/api/cards/${card.id}/comments`, { request_id: rid(), body: 'thanks', reply_to: one.body.comment.id });
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(inboxOf(h, ids.bob), [{ kind: 'reply', ref: { board_id: h.ids.board, card_id: card.id, comment_id: reply.body.comment.id, by: ids.alice } }]);
    const both = await h.api(who.alice, 'POST', `/api/cards/${card.id}/comments`, { request_id: rid(), body: '@bob again', reply_to: one.body.comment.id });
    assert.deepEqual(inboxOf(h, ids.bob).map((i) => i.kind), ['reply', 'mention']);
    assert.deepEqual(inboxOf(h, ids.bob)[1].ref.comment_id, both.body.comment.id);
    await settle();
  } finally {
    await h.close();
  }
});

test('B1 on a moment: a mention in a moment comment writes the inbox row with the moment ref, and a reply there reaches the parent author', async () => {
  const { h, who, ids } = await hubWithRoles();
  try {
    const marked = await h.api(who.bob, 'POST', `/api/boards/${h.ids.board}/moments`, { request_id: rid(), moment: { kind: 'demo', label: 'Showed the board' } });
    const m = marked.body.moments[0];
    const path = `/api/boards/${h.ids.board}/moments/${m.id}/comments`;
    const first = await h.api(who.bob, 'POST', path, { request_id: rid(), body: '@carol thoughts?' });
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(inboxOf(h, ids.carol), [{ kind: 'mention', ref: { board_id: h.ids.board, moment_id: m.id, comment_id: first.body.comment.id, by: ids.bob } }]);
    const second = await h.api(who.carol, 'POST', path, { request_id: rid(), body: 'looks good', reply_to: first.body.comment.id });
    assert.equal(second.body.comment.reply_to, first.body.comment.id);
    assert.deepEqual(inboxOf(h, ids.bob).map((i) => [i.kind, i.ref.moment_id]), [['reply', m.id]]);
    const list = await h.api(who.alice, 'GET', path);
    assert.deepEqual(list.body.comments.map((c) => [c.body, c.mentions, c.reply_to]), [['@carol thoughts?', [ids.carol], null], ['looks good', [], first.body.comment.id]]);
    // A reply_to from another thread is dropped, never linked across moments or cards.
    const card = await h.createCard(who.bob);
    const cross = await h.api(who.bob, 'POST', `/api/cards/${card.id}/comments`, { request_id: rid(), body: 'x', reply_to: first.body.comment.id });
    assert.equal(cross.body.comment.reply_to, null);
  } finally {
    await h.close();
  }
});
