// Pending connections (D97) and the member lifecycle (accounts mode): a
// member removed, demoted below admin or deleted can no longer finish a
// pending row, so it and its sealed secrets go in the same transaction,
// journaled once as integration.prepare_cancel by the system.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startAccounts } from './accounts-helpers.js';
import { ROOMY } from './tenancy/fixture.js';

const pendingRow = (h, id) => h.db.get('SELECT * FROM integration_pending WHERE id = ?', id);
const pendingSecrets = (h, id) => h.db.all('SELECT * FROM integration_pending_secrets WHERE pending_id = ?', id);
const cancels = (h, id) => h.db.all("SELECT * FROM journal WHERE kind = 'integration.prepare_cancel' ORDER BY seq").map((r) => ({ ...r, payload: JSON.parse(r.payload) })).filter((j) => j.payload.pending_id === id);
const seedPending = (h, memberId, provider, orgId = h.ids.org) => {
  const id = randomUUID();
  h.db.run('INSERT INTO integration_pending (id, org_id, provider, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', id, orgId, provider, memberId, h.hub.iso(), new Date(h.hub.wallMs() + 3_600_000).toISOString());
  h.db.run("INSERT INTO integration_pending_secrets (pending_id, kind, key_id, nonce, ciphertext, created_at) VALUES (?, 'client_secret', 'k', x'00', x'00', ?)", id, h.hub.iso());
  return id;
};
const addMember = (h, login, role, orgId = h.ids.org) => {
  const id = randomUUID();
  h.db.insert('members', { id, org_id: orgId, github_id: -Math.floor(Math.random() * 1e6) - 10, github_login: login, email: `${login}@dev.local`, display_name: login, role, created_at: h.hub.iso() });
  return id;
};
const assertPurged = (h, id, provider) => {
  assert.equal(pendingRow(h, id), null);
  assert.equal(pendingSecrets(h, id).length, 0);
  const j = cancels(h, id);
  assert.equal(j.length, 1);
  assert.deepEqual([j[0].actor_kind, j[0].actor_id, j[0].board_id, j[0].payload], ['system', null, null, { pending_id: id, provider }]);
};
const assertKept = (h, id) => {
  assert.ok(pendingRow(h, id));
  assert.equal(pendingSecrets(h, id).length, 1);
  assert.equal(cancels(h, id).length, 0);
};

test('team member removal and leaving purge that member\'s pending rows; other members\' rows stay', async () => {
  const h = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    const alice = h.hub.member(h.ids.alice);
    const carol = addMember(h, 'carol', 'admin');
    const dan = addMember(h, 'dan', 'admin');
    const c = seedPending(h, carol, 'p1');
    const d = seedPending(h, dan, 'p2');
    const a = seedPending(h, h.ids.alice, 'p3');
    h.hub.teams.removeMember(alice, carol, { ip: null });
    assertPurged(h, c, 'p1');
    assertKept(h, d);
    assertKept(h, a);
    h.hub.teams.removeMember(h.hub.member(dan), dan, { ip: null });
    assertPurged(h, d, 'p2');
    assertKept(h, a);
  } finally { await h.close(); }
});

test('a role change below admin purges the member\'s pending rows (owner→member, admin→viewer, admin→member); staying owner/admin keeps them', async () => {
  const h = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    const alice = h.hub.member(h.ids.alice);
    const owner2 = addMember(h, 'frank', 'owner');
    const admin1 = addMember(h, 'erin', 'admin');
    const admin2 = addMember(h, 'gus', 'admin');
    const admin3 = addMember(h, 'hal', 'admin');
    const rows = { owner2: seedPending(h, owner2, 'p1'), admin1: seedPending(h, admin1, 'p2'), admin2: seedPending(h, admin2, 'p3'), admin3: seedPending(h, admin3, 'p4') };
    h.hub.teams.setRole(alice, admin3, { role: 'owner' }, { ip: null });
    h.hub.teams.setRole(alice, owner2, { role: 'admin' }, { ip: null });
    assertKept(h, rows.admin3);
    assertKept(h, rows.owner2);
    h.hub.teams.setRole(alice, owner2, { role: 'owner' }, { ip: null });
    h.hub.teams.setRole(alice, owner2, { role: 'member' }, { ip: null });
    assertPurged(h, rows.owner2, 'p1');
    h.hub.teams.setRole(alice, admin1, { role: 'viewer' }, { ip: null });
    assertPurged(h, rows.admin1, 'p2');
    h.hub.teams.setRole(alice, admin2, { role: 'member' }, { ip: null });
    assertPurged(h, rows.admin2, 'p3');
    assertKept(h, rows.admin3);
  } finally { await h.close(); }
});

test('account deletion purges the user\'s pending rows: a member of a shared team, and the sole member of a team deleted with them (journaled once)', async () => {
  const h = await startAccounts({ config: { rateLimits: ROOMY } });
  try {
    const b = await h.signIn('bob@dev.local');
    assert.equal(b.status, 200, b.text);
    const bobRow = seedPending(h, h.ids.bob, 'p1');
    const aliceRow = seedPending(h, h.ids.alice, 'p2');
    h.hub.accounts.eraseUser(h.db.get('SELECT * FROM users WHERE id = ?', b.body.user.id));
    assertPurged(h, bobRow, 'p1');
    assertKept(h, aliceRow);

    const s = await h.signIn('solo@example.com');
    const t = await h.call('POST', '/api/teams', { token: s.body.device_token, body: { name: 'Solo' }, headers: { origin: h.base } });
    assert.equal(t.status, 200, t.text);
    const soloMember = h.db.get('SELECT id FROM members WHERE org_id = ? AND user_id = ?', t.body.team.id, s.body.user.id).id;
    const soloRow = seedPending(h, soloMember, 'p3', t.body.team.id);
    h.hub.accounts.eraseUser(h.db.get('SELECT * FROM users WHERE id = ?', s.body.user.id));
    assert.ok(h.db.get('SELECT deleted_at FROM orgs WHERE id = ?', t.body.team.id).deleted_at, 'the team went with them');
    assertPurged(h, soloRow, 'p3');
    assertKept(h, aliceRow);
  } finally { await h.close(); }
});
