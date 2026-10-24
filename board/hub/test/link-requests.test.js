// Organised views PR 7: "Ask an admin". A team member whose repository is on no team board asks the team's owners and
// admins to link it. The hub stores only an inbox row per admin: who asked (their team display name, folded and
// labelled) and the repo's short name. One open request per (person, repo) and 5 per hour per member.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAccounts } from './accounts-helpers.js';
import { INBOX_KINDS } from '../api.js';
import { DEFAULT_LIMITS } from '../ratelimit.js';
import { DatabaseSync } from 'node:sqlite';
import { migrate, loadMigrations } from '../../shared/migrate.js';

const rows = (h, id) => h.db.all("SELECT kind, ref_json, read_at FROM inbox WHERE member_id = ? AND kind = 'board_link_request' ORDER BY created_at, id", id)
  .map((r) => ({ ...r, ref: JSON.parse(r.ref_json) }));

test('board_link_request: a member asks, every owner and admin but the asker gets one row with only the listed fields', async () => {
  const h = await startAccounts();
  try {
    assert.ok(INBOX_KINDS.has('board_link_request'));
    assert.deepEqual(DEFAULT_LIMITS.link_request_member, { capacity: 5, per_ms: 3_600_000 });
    const bob = await h.signIn('bob@dev.local');
    h.db.run("UPDATE members SET display_name = ? WHERE id = ?", 'Bob‮ [admin] <b>Smith</b>', h.ids.bob);
    const r = await h.call('POST', '/api/link-requests', { token: bob.body.device_token, body: { request_id: 'req-link-0001', repo_short: 'claude-traffic-light' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { ok: true, sent: 1 });
    const [row, ...more] = rows(h, h.ids.alice);
    assert.equal(more.length, 0);
    assert.deepEqual(Object.keys(row.ref).sort(), ['by', 'repo_short', 'requester_name', 'team_id'], 'no request_id, URL or path is kept');
    assert.equal(row.ref.repo_short, 'claude-traffic-light');
    assert.equal(row.ref.team_id, h.ids.org);
    assert.equal(row.ref.by, h.ids.bob);
    assert.equal(row.ref.requester_name, 'Bob admin b Smith /b', 'folded (no direction mark) and labelled (no brackets or angle brackets)');
    assert.deepEqual(rows(h, h.ids.bob), [], 'the asker gets nothing');
    // The same ask while it is unread is not sent again; a different repo is.
    const again = await h.call('POST', '/api/link-requests', { token: bob.body.device_token, body: { repo_short: 'claude-traffic-light' } });
    assert.deepEqual(again.body, { ok: true, sent: 0, duplicate: true });
    assert.equal(rows(h, h.ids.alice).length, 1);
    assert.equal((await h.call('POST', '/api/link-requests', { token: bob.body.device_token, body: { repo_short: 'website' } })).body.sent, 1);
    // Once read, the same ask can be made again.
    h.db.run("UPDATE inbox SET read_at = created_at WHERE member_id = ? AND kind = 'board_link_request'", h.ids.alice);
    assert.equal((await h.call('POST', '/api/link-requests', { token: bob.body.device_token, body: { repo_short: 'claude-traffic-light' } })).body.sent, 1);
    // The web inbox and the desktop list it like any other row.
    const alice = await h.signIn('alice@dev.local');
    const listed = await h.call('GET', '/api/account/inbox', { token: alice.body.device_token });
    assert.ok(listed.body.items.some((i) => i.kind === 'board_link_request' && i.ref.repo_short === 'claude-traffic-light' && !i.read_at));
  } finally { await h.destroy(); }
});

test('board_link_request: the body is the repo short name and nothing else; owners, admins and viewers are refused', async () => {
  const h = await startAccounts();
  try {
    const bob = await h.signIn('bob@dev.local');
    const ask = (body, token = bob.body.device_token) => h.call('POST', '/api/link-requests', { token, body });
    for (const body of [{}, { repo_short: '' }, { repo_short: 'a'.repeat(81) }, { repo_short: 'org/app' }, { repo_short: '../x' }, { repo_short: 'app name' }, { repo_short: 7 },
      { repo_short: 'app', canonical_url: 'github.com/org/app' }, { repo_short: 'app', requester_name: 'Mallory' }, { repo_short: 'app', team_id: 'other' }]) {
      h.clock.advance(3_600_000); // a refused ask still spends the hourly allowance, like any limited route
      const r = await ask(body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.text}`);
    }
    assert.deepEqual(rows(h, h.ids.alice), [], 'nothing was sent');
    const alice = await h.signIn('alice@dev.local');
    const own = await ask({ repo_short: 'app' }, alice.body.device_token);
    assert.equal(own.status, 400, 'an owner can link it themselves');
    assert.match(own.body.error.message, /link it yourself/i);
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.bob);
    assert.equal((await ask({ repo_short: 'app' })).status, 403, 'a viewer cannot ask');
    assert.equal((await h.call('POST', '/api/link-requests', { body: { repo_short: 'app' } })).status, 401);
  } finally { await h.destroy(); }
});

test('board_link_request: 5 asks an hour per member, then 429 with Retry-After', async () => {
  const h = await startAccounts();
  try {
    const bob = await h.signIn('bob@dev.local');
    for (let i = 0; i < 5; i++) assert.equal((await h.call('POST', '/api/link-requests', { token: bob.body.device_token, body: { repo_short: `app-${i}` } })).status, 200);
    const over = await h.call('POST', '/api/link-requests', { token: bob.body.device_token, body: { repo_short: 'app-6' } });
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get('retry-after')) > 0);
    assert.equal(rows(h, h.ids.alice).length, 5);
  } finally { await h.destroy(); }
});

test('migration 080 keeps every inbox row and the cross-team guard, and accepts the new kind', () => {
  const db = new DatabaseSync(':memory:');
  const all = loadMigrations();
  migrate(db, { migrations: all.filter((m) => m.version <= 79) });
  const NOW = '2026-10-24T10:00:00.000Z';
  db.exec(`
    INSERT INTO orgs (id, name, created_at) VALUES ('o1','Acme','${NOW}'), ('o2','Other','${NOW}');
    INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at) VALUES ('m1','o1',1,'a','a@x.io','A','owner','${NOW}'), ('m2','o2',2,'b','b@x.io','B','member','${NOW}');
    INSERT INTO inbox (id, org_id, member_id, kind, ref_json, created_at, read_at) VALUES ('i1','o1','m1','mention','{"card_id":"c1"}','${NOW}',NULL), ('i2','o1','m1','reply','{}','${NOW}','${NOW}');
  `);
  assert.throws(() => db.exec(`INSERT INTO inbox VALUES ('x','o1','m1','board_link_request','{}','${NOW}',NULL)`), /CHECK constraint/);
  assert.deepEqual(migrate(db, { migrations: all }), [80]);
  assert.deepEqual(db.prepare('SELECT id, kind, ref_json, read_at FROM inbox ORDER BY id').all().map((r) => ({ ...r })), [
    { id: 'i1', kind: 'mention', ref_json: '{"card_id":"c1"}', read_at: null }, { id: 'i2', kind: 'reply', ref_json: '{}', read_at: NOW }]);
  db.exec(`INSERT INTO inbox VALUES ('i3','o1','m1','board_link_request','{"repo_short":"app"}','${NOW}',NULL)`);
  assert.throws(() => db.exec(`INSERT INTO inbox VALUES ('i4','o1','m2','mention','{}','${NOW}',NULL)`), /cross-team reference/);
  assert.throws(() => db.exec(`INSERT INTO inbox VALUES ('i5','o1','m1','other','{}','${NOW}',NULL)`), /CHECK constraint/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'inbox_by_member_read'").get());
});
