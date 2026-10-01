// Board label registry and covers (CONTRACT D91, D93, D96): the role matrix,
// reserved names, card-label validation, the rename/strip rewrite (cap check
// before any write, one transaction, one card.update per card, hashed on an
// integration's card), the per-board rewrite limit and replay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { replay } from '../../shared/journal.js';
import { defineConnector } from '../integrations/connector.js';
import { LABEL_REWRITE_MAX } from '../api.js';
import { startHub } from './helpers.js';

const rid = () => randomUUID();

// The dev seed has alice (owner) and bob (member); add an admin and a viewer.
async function hubWithRoles(opts) {
  const h = await startHub(opts);
  for (const [login, role, gid] of [['carol', 'admin', -3], ['vera', 'viewer', -4]]) {
    h.db.insert('members', { id: randomUUID(), org_id: h.ids.org, github_id: gid, github_login: login, email: `${login}@dev.local`, display_name: login, role, created_at: h.hub.iso() });
  }
  const who = {};
  for (const l of ['alice', 'bob', 'carol', 'vera']) who[l] = await h.login(l);
  const path = (name = '') => `/api/boards/${h.ids.board}/labels${name ? `/${encodeURIComponent(name)}` : ''}`;
  return { h, who, path };
}

const labelsOf = (h, id) => JSON.parse(h.card(id).labels);

test('roles: members create and recolour, only admins and owners rename or delete, viewers only read; the snapshot, CardView and WS carry the registry', async () => {
  const { h, who, path } = await hubWithRoles();
  try {
    const b = await h.browser(who.bob);
    const card = await h.createCard(who.bob, { labels: ['bug', 'later'] });
    const created = await h.api(who.bob, 'POST', path(), { request_id: rid(), name: 'Bug', color: 'red' });
    assert.equal(created.status, 200, created.text);
    assert.deepEqual(Object.keys(created.body.label).sort(), ['color', 'description', 'id', 'name']);
    const frame = await b.next('board.labels');
    assert.deepEqual(frame, { type: 'board.labels', board_id: h.ids.board, labels: [created.body.label], __taken: true });

    // Viewers read, never write.
    assert.deepEqual((await h.api(who.vera, 'GET', path())).body.labels, [created.body.label]);
    for (const [m, p, body] of [['POST', path(), { name: 'x', color: 'red' }], ['PATCH', path('Bug'), { color: 'blue' }], ['DELETE', path('Bug'), {}]]) {
      const r = await h.api(who.vera, m, p, { request_id: rid(), ...body });
      assert.equal(r.status, 403, `${m} ${r.text}`);
    }
    // A member recolours (PATCH or the POST upsert, which keeps the stored spelling) but cannot rename or delete.
    assert.equal((await h.api(who.bob, 'PATCH', path('bug'), { request_id: rid(), color: 'orange' })).body.label.color, 'orange');
    const up = await h.api(who.bob, 'POST', path(), { request_id: rid(), name: 'BUG', color: 'green' });
    assert.deepEqual([up.body.label.id, up.body.label.name, up.body.label.color], [created.body.label.id, 'Bug', 'green']);
    const ren = await h.api(who.bob, 'PATCH', path('Bug'), { request_id: rid(), name: 'Defect' });
    assert.equal(ren.status, 403, ren.text);
    assert.equal((await h.api(who.bob, 'DELETE', path('Bug'), { request_id: rid() })).status, 403);
    assert.equal(h.card(card.id).labels, '["bug","later"]', 'nothing rewritten by a refused rename');

    // The colour reaches the card view by name, ignoring case; unknown labels are neutral.
    const snap = (await h.api(who.vera, 'GET', `/api/boards/${h.ids.board}`)).body;
    assert.deepEqual(snap.board.labels.map((l) => l.name), ['Bug']);
    const view = snap.cards.find((c) => c.id === card.id);
    assert.deepEqual(view.label_colors, ['green', null]);
    assert.equal(view.cover, null);
    assert.equal(view.archived, null);

    // An admin renames; an owner deletes.
    assert.equal((await h.api(who.carol, 'PATCH', path('Bug'), { request_id: rid(), name: 'Defect' })).status, 200);
    assert.deepEqual(labelsOf(h, card.id), ['Defect', 'later']);
    assert.deepEqual(await h.api(who.alice, 'DELETE', path('defect'), { request_id: rid() }).then((r) => r.body), { ok: true, cards_updated: 0 });
    assert.deepEqual(labelsOf(h, card.id), ['Defect', 'later'], 'delete without strip only uncolours');
    assert.equal((await h.api(who.alice, 'PATCH', path('nope'), { request_id: rid(), color: 'red' })).status, 404);
    assert.deepEqual((await h.api(who.bob, 'GET', path())).body, { labels: [] });
  } finally {
    await h.destroy();
  }
});

test('reserved labels (via:*, never_auto, plan-approval) are never coloured, renamed onto or deleted; label names and colours are validated', async () => {
  const { h, who, path } = await hubWithRoles();
  try {
    for (const name of ['via:github', 'VIA:slack', 'never_auto', 'Plan-Approval', ' never_auto ']) {
      const r = await h.api(who.alice, 'POST', path(), { request_id: rid(), name, color: 'red' });
      assert.equal(r.status, 400, name);
      assert.equal(r.body.error.reason, 'RESERVED_LABEL', name);
    }
    await h.api(who.alice, 'POST', path(), { request_id: rid(), name: 'ok', color: 'red' });
    const onto = await h.api(who.alice, 'PATCH', path('ok'), { request_id: rid(), name: 'never_auto' });
    assert.equal(onto.body.error.reason, 'RESERVED_LABEL');
    for (const m of ['PATCH', 'DELETE']) {
      const r = await h.api(who.alice, m, path('never_auto'), { request_id: rid(), color: 'red' });
      assert.equal(r.body.error.reason, 'RESERVED_LABEL', m);
    }
    for (const body of [{ name: '', color: 'red' }, { name: 'x'.repeat(51), color: 'red' }, { name: 'x', color: 'magenta' }, { name: 'x' }, { name: 'x', color: 'red', description: 'd'.repeat(201) }]) {
      assert.equal((await h.api(who.alice, 'POST', path(), { request_id: rid(), ...body })).status, 400, JSON.stringify(body).slice(0, 60));
    }
    await h.api(who.alice, 'POST', path(), { request_id: rid(), name: 'two', color: 'blue' });
    const clash = await h.api(who.alice, 'PATCH', path('ok'), { request_id: rid(), name: 'TWO' });
    assert.equal(clash.status, 409, 'names are unique ignoring case');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM journal WHERE kind LIKE ?', 'label.%').n, 2);
  } finally {
    await h.destroy();
  }
});

test('card labels: at most 20, each 1–50 characters once trimmed, on create and on PATCH; covers are palette tokens or null', async () => {
  const { h, who } = await hubWithRoles();
  try {
    const bad = [Array.from({ length: 21 }, (_, i) => `l${i}`), ['x'.repeat(51)], [''], ['   '], [7], 'bug'];
    for (const labels of bad) {
      const r = await h.api(who.bob, 'POST', `/api/boards/${h.ids.board}/cards`, { request_id: rid(), title: 't', labels });
      assert.equal(r.status, 400, `create ${JSON.stringify(labels).slice(0, 40)}`);
    }
    const card = await h.createCard(who.bob, { labels: Array.from({ length: 20 }, (_, i) => ` l${i} `), cover: 'teal' });
    assert.equal(labelsOf(h, card.id)[0], 'l0', 'trimmed');
    assert.equal(card.cover, 'teal');
    for (const labels of bad) {
      const r = await h.api(who.bob, 'PATCH', `/api/cards/${card.id}`, { request_id: rid(), version: h.card(card.id).version, labels });
      assert.equal(r.status, 400, `patch ${JSON.stringify(labels).slice(0, 40)}`);
    }
    for (const cover of ['magenta', '', 3]) {
      assert.equal((await h.api(who.bob, 'PATCH', `/api/cards/${card.id}`, { request_id: rid(), version: h.card(card.id).version, cover })).status, 400, String(cover));
      assert.equal((await h.api(who.bob, 'POST', `/api/boards/${h.ids.board}/cards`, { request_id: rid(), title: 't', cover })).status, 400, String(cover));
    }
    const p = await h.api(who.bob, 'PATCH', `/api/cards/${card.id}`, { request_id: rid(), version: h.card(card.id).version, cover: 'pink' });
    assert.equal(p.body.card.cover, 'pink');
    const cleared = await h.api(who.bob, 'PATCH', `/api/cards/${card.id}`, { request_id: rid(), version: h.card(card.id).version, cover: null });
    assert.equal(cleared.body.card.cover, null);
    assert.equal((await h.api(who.vera, 'PATCH', `/api/cards/${card.id}`, { request_id: rid(), version: h.card(card.id).version, cover: 'red' })).status, 403);
    const covers = h.db.all("SELECT payload FROM journal WHERE card_id = ? AND kind = 'card.update' ORDER BY seq", card.id).map((r) => JSON.parse(r.payload).fields.cover);
    assert.deepEqual(covers, [['teal', 'pink'], ['pink', null]]);
    assert.equal(replay(h.db.all('SELECT * FROM journal ORDER BY seq')).get(card.id).cover, null);
  } finally {
    await h.destroy();
  }
});

test('rename rewrites every card holding the name (ignoring case) in one transaction: a version bump and one card.update each; replay rebuilds it; strip removes it', async () => {
  const { h, who, path } = await hubWithRoles();
  try {
    const b = await h.browser(who.bob);
    const a = await h.createCard(who.bob, { labels: ['bug', 'ui'] });
    const c = await h.createCard(who.bob, { labels: ['BUG'] });
    const d = await h.createCard(who.bob, { labels: ['Bug', 'bug'] });
    const none = await h.createCard(who.bob, { labels: ['ui'] });
    await h.api(who.bob, 'POST', path(), { request_id: rid(), name: 'bug', color: 'red' });
    const stale = h.card(a.id).version;
    const r = await h.api(who.carol, 'PATCH', path('bug'), { request_id: rid(), name: 'Defect', color: 'purple' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.label.name, r.body.label.color, r.body.cards_updated], ['Defect', 'purple', 3]);
    assert.deepEqual([labelsOf(h, a.id), labelsOf(h, c.id), labelsOf(h, d.id), labelsOf(h, none.id)], [['Defect', 'ui'], ['Defect'], ['Defect'], ['ui']]);
    assert.equal(h.card(a.id).version, stale + 1);
    assert.equal(h.card(none.id).version, none.version, 'a card without the label is untouched');
    const rows = h.db.all("SELECT card_id, payload FROM journal WHERE kind = 'card.update' ORDER BY seq").map((x) => ({ card_id: x.card_id, ...JSON.parse(x.payload) }));
    assert.deepEqual(rows.map((x) => x.card_id).sort(), [a.id, c.id, d.id].sort(), 'one card.update per card');
    for (const x of rows) assert.equal(x.cause, 'label.rename');
    assert.deepEqual(rows.find((x) => x.card_id === a.id).fields.labels, ['["bug","ui"]', '["Defect","ui"]']);
    const lu = JSON.parse(h.db.get("SELECT payload FROM journal WHERE kind = 'label.update'").payload);
    assert.deepEqual(lu.fields, { name: ['bug', 'Defect'], color: ['red', 'purple'] });
    // An editor that loaded the card before the rename has to reload.
    assert.equal((await h.api(who.bob, 'PATCH', `/api/cards/${a.id}`, { request_id: rid(), version: stale, title: 'x' })).status, 409);
    const up = await b.next('card.upsert', (m) => m.card.id === a.id && m.card.labels.includes('Defect'));
    assert.deepEqual(up.card.label_colors, ['purple', null]);

    // Delete with strip goes through the same rewrite.
    const del = await h.api(who.alice, 'DELETE', `${path('defect')}?strip=1`, { request_id: rid() });
    assert.deepEqual(del.body, { ok: true, cards_updated: 3 });
    assert.deepEqual([labelsOf(h, a.id), labelsOf(h, c.id), labelsOf(h, d.id)], [['ui'], [], []]);
    assert.equal(h.db.all("SELECT payload FROM journal WHERE kind = 'card.update'").filter((x) => JSON.parse(x.payload).cause === 'label.delete').length, 3);
    assert.deepEqual(JSON.parse(h.db.get("SELECT payload FROM journal WHERE kind = 'label.delete'").payload).strip, true);

    const rebuilt = replay(h.db.all('SELECT * FROM journal ORDER BY seq'));
    for (const card of h.db.all('SELECT * FROM cards')) {
      assert.equal(rebuilt.get(card.id).labels, card.labels, card.key);
    }
  } finally {
    await h.destroy();
  }
});

test('rename atomicity: more than 2,000 cards is refused before any write, and a failure half way rolls everything back', async () => {
  const { h, who, path } = await hubWithRoles();
  try {
    await h.api(who.alice, 'POST', path(), { request_id: rid(), name: 'bulk', color: 'red' });
    const now = h.hub.iso();
    h.db.tx(() => {
      for (let i = 0; i <= LABEL_REWRITE_MAX; i++) {
        h.db.insert('cards', { id: randomUUID(), board_id: h.ids.board, key: `BULK-${i}`, title: 't', labels: '["bulk"]', created_by: h.ids.alice, created_at: now, updated_at: now, state_since: now });
      }
    });
    const state = () => JSON.stringify([h.db.all('SELECT * FROM board_labels'), h.db.get('SELECT COUNT(*) AS n FROM journal').n, h.db.get('SELECT SUM(version) AS v, GROUP_CONCAT(labels) AS l FROM cards')]);
    const before = state();
    const r = await h.api(who.alice, 'PATCH', path('bulk'), { request_id: rid(), name: 'many' });
    assert.equal(r.status, 409, r.text);
    assert.deepEqual([r.body.error.code, r.body.error.reason], ['CONFLICT', 'TOO_MANY_CARDS']);
    const strip = await h.api(who.alice, 'DELETE', `${path('bulk')}?strip=1`, { request_id: rid() });
    assert.equal(strip.body.error.reason, 'TOO_MANY_CARDS');
    assert.equal(state(), before, 'nothing written');
    assert.equal(h.hub.limiter.buckets.get(`label_rewrite_board|${h.ids.board}`), undefined, 'a refused rewrite spends no rate token');

    // Under the cap, a failure on the second card leaves no trace of the first.
    h.db.run("DELETE FROM cards WHERE key LIKE 'BULK-%' AND key NOT IN ('BULK-0', 'BULK-1', 'BULK-2')");
    const before2 = state();
    const journal = h.hub.journal.bind(h.hub);
    let n = 0;
    h.hub.journal = (row) => {
      if (row.kind === 'card.update' && ++n === 2) throw new Error('disk full');
      return journal(row);
    };
    const failed = await h.api(who.alice, 'PATCH', path('bulk'), { request_id: rid(), name: 'many' });
    assert.equal(failed.status, 500);
    h.hub.journal = journal;
    assert.equal(state(), before2, 'registry, cards and journal all rolled back');
    const ok = await h.api(who.alice, 'PATCH', path('bulk'), { request_id: rid(), name: 'many' });
    assert.equal(ok.body.cards_updated, 3);
  } finally {
    await h.destroy();
  }
});

test('rename and strip are rate limited per board', async () => {
  const { h, who, path } = await hubWithRoles({ config: { rateLimits: { label_rewrite_board: { capacity: 1, per_ms: 3_600_000 } } } });
  try {
    await h.api(who.alice, 'POST', path(), { request_id: rid(), name: 'a', color: 'red' });
    assert.equal((await h.api(who.alice, 'PATCH', path('a'), { request_id: rid(), name: 'b' })).status, 200);
    const r = await h.api(who.alice, 'PATCH', path('b'), { request_id: rid(), name: 'c' });
    assert.equal(r.status, 429, r.text);
    assert.equal((await h.api(who.alice, 'PATCH', path('b'), { request_id: rid(), color: 'blue' })).status, 200, 'a recolour rewrites nothing and is not limited');
    assert.equal((await h.api(who.alice, 'DELETE', `${path('b')}?strip=1`, { request_id: rid() })).status, 429);
  } finally {
    await h.destroy();
  }
});

test('a rename on a card an integration created journals its labels only as keyed hashes', async () => {
  const { h, who, path } = await hubWithRoles();
  try {
    h.hub.setVaultKey(randomBytes(32));
    h.app.integrations.register(defineConnector({
      id: 'tracker', name: 'Tracker', scopes: [], secrets: [], hosts: [],
      connect: { kind: 'token', verifyToken: async () => ({ external_id: 'w1' }) },
      actions: { 'card.create': { default: 'auto' } },
    }));
    const conn = h.app.integrations.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'tracker', external_id: 'w1' });
    const ctx = h.app.integrations.ctxFor(conn.id);
    // Built at runtime: a customer name a provider's label could carry.
    const cust = ['cust', 'Jane', 'Doe'].join('-');
    const { card } = (await ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: 'ext-1', title: 'From the tracker', labels: [cust] }))).result;
    await h.api(who.alice, 'POST', path(), { request_id: rid(), name: cust, color: 'red' });
    const before = h.card(card.id).labels;
    const r = await h.api(who.alice, 'PATCH', path(cust), { request_id: rid(), name: 'vip-customer' });
    assert.equal(r.body.cards_updated, 1);
    const row = h.db.get("SELECT payload FROM journal WHERE kind = 'card.update' AND card_id = ?", card.id);
    const p = JSON.parse(row.payload);
    assert.ok(!row.payload.includes('Jane') && !row.payload.includes('vip-customer'), 'no label text in the clear');
    assert.equal('labels' in p.fields, false);
    assert.deepEqual(p.fields.labels_hmac, [h.hub.refHash(before), h.hub.refHash(h.card(card.id).labels)]);
    assert.equal(p.cause, 'label.rename');
  } finally {
    await h.destroy();
  }
});

test('the free plan allows 50 labels per board', async () => {
  const { h, who, path } = await hubWithRoles();
  try {
    assert.equal(h.db.get('SELECT plan FROM orgs WHERE id = ?', h.ids.org).plan, 'free');
    for (let i = 0; i < 50; i++) assert.equal((await h.api(who.bob, 'POST', path(), { request_id: rid(), name: `l${i}`, color: 'grey' })).status, 200);
    const r = await h.api(who.bob, 'POST', path(), { request_id: rid(), name: 'one-more', color: 'grey' });
    assert.equal(r.status, 403);
    assert.deepEqual([r.body.error.code, r.body.error.resource, r.body.error.limit], ['QUOTA_EXCEEDED', 'labels', 50]);
    assert.equal((await h.api(who.bob, 'POST', path(), { request_id: rid(), name: 'L1', color: 'red' })).status, 200, 'recolouring an existing one still works');
  } finally {
    await h.destroy();
  }
});
