import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startAccounts } from './accounts-helpers.js';
import { ROOMY } from './tenancy/fixture.js';
import { emailOnlyIdentity } from '../views.js';
import { insertCardRecord } from '../card-record.js';
import { ClientFeedback } from '../identity/client-feedback.js';

async function rig(config = {}) {
  const h = await startAccounts({ config: { rateLimits: ROOMY, ...config } }), owner = await h.signIn('alice@dev.local');
  const as = (u, method, path, body) => h.call(method, path, { token: u.body.device_token, body: method === 'DELETE' ? body ?? {} : body });
  const w = await as(owner, 'POST', '/api/client-workspaces', { request_id: 'feedback-workspace', name: 'Client feedback boundary' });
  assert.equal(w.status, 200, w.text); const workspace = w.body.workspace.id, project = w.body.projects[0];
  const internal = await as(owner, 'POST', `/api/boards/${project.board_id}/cards`, { title: 'PRIVATE TASK TITLE', body: 'PRIVATE REPOSITORY DETAILS' });
  const pub = await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, { card_id: internal.body.card.id, title: 'Published homepage', summary: 'Ready for your review', status: 'review' });
  assert.equal(pub.status, 200, pub.text); const item = pub.body.item;
  const guest = async (email, scopes = ['status.read', 'feedback.create']) => {
    const i = await as(owner, 'POST', `/api/teams/${workspace}/client-invites`, { email, grants: [{ project_id: project.id, scopes }] }); assert.equal(i.status, 200, i.text);
    const u = await h.signIn(email); assert.equal(u.status, 200, u.text);
    assert.equal((await as(u, 'POST', '/api/client-invites/accept', { t: i.body.link.split('#')[1] })).status, 200);
    u.body.user.display_name = 'Synthetic Client ' + email; h.db.run('UPDATE users SET display_name = ? WHERE id = ?', u.body.user.display_name, u.body.user.id);
    u.guestId = h.db.get('SELECT id FROM client_guests WHERE user_id = ? AND workspace_id = ?', u.body.user.id, workspace).id; return u;
  };
  const client = await guest('client@feedback.test'), other = await guest('other@feedback.test');
  const member = h.db.get('SELECT * FROM members WHERE user_id = ? AND org_id = ?', owner.body.user.id, workspace);
  const addStaff = async (role) => {
    const u = await h.signIn(`${role}@staff.test`); assert.equal(u.status, 200, u.text); u.memberId = randomUUID();
    h.db.insert('members', { id: u.memberId, org_id: workspace, user_id: u.body.user.id, display_name: `${role} staff`, email: `${role}@staff.test`, role, ...emailOnlyIdentity(`${role}@staff.test`), joined_via: 'fixture', created_at: h.hub.iso() }); return u;
  };
  const configPath = `/api/boards/${project.board_id}/client-feedback-intake`, feedbackPath = `/api/client/items/${item.id}/feedback`;
  const enable = async () => { const r = await as(owner, 'PATCH', configPath, { enabled: true }); assert.equal(r.status, 200, r.text); return r.body.intake; };
  const send = (u = client, body = { request_id: randomUUID(), message: 'Please change the homepage colour.' }) => as(u, 'POST', feedbackPath, body);
  return { h, owner, member, as, workspace, project, item, internal, client, other, guest, addStaff, configPath, feedbackPath, enable, send };
}

test('intake is disabled by default; explicit admin opt-in derives its own delegate and preserves role ceilings', async () => {
  const r = await rig(); const { h, as, owner, client, configPath, send, addStaff } = r;
  try {
    assert.deepEqual((await as(owner, 'GET', configPath)).body.intake, { enabled: false, active: false, delegate: null });
    assert.equal((await send()).body.error.reason, 'CLIENT_INTAKE_PAUSED');
    const before = h.db.get('SELECT next_key FROM boards WHERE id = ?', r.project.board_id).next_key;
    const viewer = await addStaff('viewer'), writer = await addStaff('member'), admin = await addStaff('admin');
    assert.equal((await as(viewer, 'GET', configPath)).status, 200);
    for (const u of [viewer, writer]) assert.equal((await as(u, 'PATCH', configPath, { enabled: true })).status, 403);
    assert.equal((await as(client, 'PATCH', configPath, { enabled: true })).status, 404);
    for (const body of [{ enabled: true, delegate_member_id: r.member.id }, { enabled: true, board_id: 'foreign' }, { enabled: 'true' }]) assert.equal((await as(admin, 'PATCH', configPath, body)).status, 400);
    const enabled = await as(admin, 'PATCH', configPath, { enabled: true }); assert.equal(enabled.status, 200); assert.equal(enabled.body.intake.delegate.member_id, admin.memberId);
    h.db.run("UPDATE members SET role = 'member' WHERE id = ?", admin.memberId);
    assert.equal((await as(owner, 'GET', configPath)).body.intake.active, true, 'explicit card.write delegation survives admin→writer change');
    const accepted = await send(); assert.equal(accepted.status, 200, accepted.text);
    assert.equal(h.db.get('SELECT created_by FROM cards WHERE id = (SELECT card_id FROM client_feedback WHERE id = ?)', accepted.body.feedback.id).created_by, admin.memberId);
    assert.equal(h.db.get('SELECT next_key FROM boards WHERE id = ?', r.project.board_id).next_key, before + 1);
  } finally { await h.close(); }
});

test('concurrent durable scoped feedback creates exactly one real To do task with truthful immutable provenance and no dispatch', async () => {
  const r = await rig(); const { h, as, owner, client, other, send, enable, item, project } = r;
  try {
    await enable(); const body = { request_id: 'one-feedback', message: 'CLIENT INPUT <script>plain text</script>' };
    const count = h.db.get('SELECT COUNT(*) n FROM members').n, responses = await Promise.all([send(client, body), send(client, body)]);
    assert.ok(responses.every((x) => x.status === 200)); assert.equal(responses[0].body.feedback.id, responses[1].body.feedback.id);
    h.hub.clientFeedback = new ClientFeedback(h.hub); assert.equal((await send(client, body)).body.feedback.id, responses[0].body.feedback.id, 'durable retry survives a new service instance');
    const row = h.db.get('SELECT * FROM client_feedback'), card = h.hub.card(row.card_id);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_feedback').n, 1); assert.equal(h.db.get('SELECT COUNT(*) n FROM members').n, count);
    assert.equal(card.board_id, project.board_id); assert.equal(card.created_by, r.member.id); assert.equal(card.column_name, 'todo'); assert.equal(card.run_state, null);
    for (const field of ['repo_id', 'base_ref', 'active_run_id', 'budget_cents']) assert.equal(card[field], null, field);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM card_assignees WHERE card_id = ?', card.id).n, 0); assert.equal(h.db.get('SELECT COUNT(*) n FROM dispatches').n, 0); assert.equal(h.db.get('SELECT COUNT(*) n FROM runs').n, 0);
    assert.equal((await send(client, { ...body, message: 'different' })).status, 409);
    assert.throws(() => h.db.run("UPDATE client_feedback SET message = 'forged' WHERE id = ?", row.id), /immutable/);
    const guestView = await as(client, 'GET', r.feedbackPath); assert.equal(guestView.body.feedback[0].message, body.message);
    assert.equal((await as(other, 'GET', r.feedbackPath)).body.feedback.length, 0); assert.equal((await as(other, 'GET', '/api/account/client-export')).text.includes(body.message), false);
    for (const hidden of ['card_id', 'board_id', 'workspace_id', 'member_id', 'PRIVATE TASK TITLE', 'PRIVATE REPOSITORY DETAILS', owner.body.device_token]) assert.equal(JSON.stringify(guestView.body.feedback).includes(hidden), false, hidden);
    const staff = (await as(owner, 'GET', r.feedbackPath)).body.feedback[0]; assert.equal(staff.task.card_id, card.id); assert.equal(staff.intake.member_id, r.member.id); assert.equal(staff.guest_id, client.guestId);
    const detail = await as(owner, 'GET', `/api/cards/${card.id}`); assert.equal(detail.body.card.client_feedback.source_name, client.body.user.display_name); assert.match(detail.body.feed[0].text, /Feedback from .*intake authorized by/); assert.equal(detail.body.feed[0].actor_name, null);
    const journal = h.db.all('SELECT * FROM journal WHERE card_id = ? OR kind LIKE ?', card.id, 'client.feedback.%');
    const create = journal.find((j) => j.kind === 'card.create'); assert.equal(create.actor_kind, 'system'); assert.equal(create.actor_id, null);
    const p = JSON.parse(create.payload); assert.equal(p.client_user_id, client.body.user.id); assert.equal(p.intake_delegate_member_id, r.member.id);
    for (const secret of [body.message, client.body.user.display_name, 'client@feedback.test']) assert.equal(JSON.stringify(journal).includes(secret), false, secret);
    assert.equal((await as(client, 'GET', `/api/cards/${card.id}`)).status, 404);
    const statusOnly = await r.guest('status@feedback.test', ['status.read']); assert.equal((await as(statusOnly, 'GET', r.feedbackPath)).status, 404);
    assert.equal((await as(statusOnly, 'GET', `/api/client/projects/${project.id}`)).body.items[0].feedback, undefined);
    assert.equal((await send(statusOnly)).status, 404);
  } finally { await h.close(); }
});

test('guest fields, foreign projects, invalid text, forged actors and unknown destinations cannot broaden intake', async () => {
  const r = await rig(); const { h, as, owner, client, send } = r;
  try {
    await r.enable(); const base = { request_id: 'strict', message: 'Feedback' };
    for (const key of ['actor', 'guest_id', 'delegate_member_id', 'card_id', 'board_id', 'project_id', 'repo_id', 'agent', 'budget_usd', 'labels', 'dispatch']) assert.equal((await send(client, { ...base, [key]: 'forged' })).status, 400, key);
    for (const body of [{ ...base, message: '' }, { ...base, message: 'x'.repeat(4001) }, { ...base, message: 'bad\u0000text' }, { message: 'no retry id' }]) assert.equal((await send(client, body)).status, 400);
    const foreign = await as(owner, 'POST', '/api/client-workspaces', { request_id: 'other-boundary', name: 'Other client boundary' }); assert.equal(foreign.status, 200);
    const p = foreign.body.projects[0], c = await as(owner, 'POST', `/api/boards/${p.board_id}/cards`, { title: 'OTHER PRIVATE' });
    const i = await as(owner, 'POST', `/api/boards/${p.board_id}/client-items`, { card_id: c.body.card.id, title: 'Other safe', status: 'todo' });
    assert.equal((await as(client, 'POST', `/api/client/items/${i.body.item.id}/feedback`, base)).status, 404);
    assert.equal((await as(client, 'GET', `/api/client/items/${i.body.item.id}/feedback`)).status, 404);
    assert.equal((await as(client, 'POST', `/api/client/items/${randomUUID()}/feedback`, base)).status, 404);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_feedback').n, 0);
    assert.throws(() => h.db.insert('client_feedback_intake', { project_id: p.id, delegate_member_id: r.member.id, enabled: 1, configured_at: h.hub.iso() }), /another workspace/);
    assert.throws(() => insertCardRecord(h.hub, r.project.board_id, r.member.id, { title: 'unsafe' }, { id: randomUUID(), now: h.hub.iso() }), /board transaction/);
  } finally { await h.close(); }
});

test('queued intake rechecks the exact live delegate with no replacement, grants, publication, archive and credential', async () => {
  const r = await rig(); const { h, client, project, item, enable } = r;
  try {
    await enable(); await r.addStaff('owner');
    const service = h.hub.clientFeedback, user = h.hub.accounts.liveUser(client.body.user.id), before = h.db.get('SELECT next_key FROM boards WHERE id = ?', project.board_id).next_key;
    const held = async (revoke, restore, expected, cred = null) => {
      let release; const block = h.hub.withBoard(project.board_id, () => new Promise((resolve) => { release = resolve; })); await new Promise((resolve) => setImmediate(resolve));
      let pending;
      try { pending = service.create(user, item.id, { request_id: randomUUID(), message: 'Should not create' }, { ip: '127.0.0.1', cred }); revoke(); } finally { release(); await block; }
      await assert.rejects(pending, (e) => e.code === expected); restore();
    };
    await held(() => h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", r.member.id), () => h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", r.member.id), 'CONFLICT');
    await held(() => h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), r.member.id), () => h.db.run('UPDATE members SET removed_at = NULL WHERE id = ?', r.member.id), 'CONFLICT');
    await held(() => h.db.run('UPDATE client_feedback_intake SET enabled = 0 WHERE project_id = ?', project.id), () => h.db.run('UPDATE client_feedback_intake SET enabled = 1 WHERE project_id = ?', project.id), 'CONFLICT');
    await held(() => h.db.run('UPDATE users SET deleted_at = ? WHERE id = ?', h.hub.iso(), r.owner.body.user.id), () => h.db.run('UPDATE users SET deleted_at = NULL WHERE id = ?', r.owner.body.user.id), 'CONFLICT');
    await held(() => h.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', h.hub.iso(), project.board_id), () => h.db.run('UPDATE boards SET archived_at = NULL WHERE id = ?', project.board_id), 'CONFLICT');
    await held(() => h.db.run('UPDATE client_items SET unpublished_at = ? WHERE id = ?', h.hub.iso(), item.id), () => h.db.run('UPDATE client_items SET unpublished_at = NULL WHERE id = ?', item.id), 'NOT_FOUND');
    await held(() => h.db.run('UPDATE client_guests SET revoked_at = ? WHERE id = ?', h.hub.iso(), client.guestId), () => h.db.run('UPDATE client_guests SET revoked_at = NULL WHERE id = ?', client.guestId), 'NOT_FOUND');
    await held(() => h.db.run('UPDATE client_grants SET scopes = ? WHERE guest_id = ?', '["status.read"]', client.guestId), () => h.db.run('UPDATE client_grants SET scopes = ? WHERE guest_id = ?', '["status.read","feedback.create"]', client.guestId), 'NOT_FOUND');
    const cred = h.hub.accounts.authenticate({ headers: { authorization: `Bearer ${client.body.device_token}` } }, { ip: '127.0.0.1' }).cred;
    await held(() => h.db.run('UPDATE user_devices SET revoked_at = ? WHERE id = ?', h.hub.iso(), client.body.device_id), () => {}, 'UNAUTHENTICATED', cred);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_feedback').n, 0); assert.equal(h.db.get('SELECT next_key FROM boards WHERE id = ?', project.board_id).next_key, before);
  } finally { await h.close(); }
});

test('rollback removes the new task and key allocation; quota and per-guest rate are finite before task creation', async () => {
  const r = await rig({ clientFeedbackLimit: 1 }); const { h, client, send } = r;
  try {
    await r.enable(); const before = h.db.get('SELECT next_key FROM boards WHERE id = ?', r.project.board_id).next_key, insert = h.db.insert.bind(h.db), broadcasts = [];
    h.hub.broadcastCard = (id) => broadcasts.push(id); h.db.insert = (table, row) => { if (table === 'client_feedback') throw new Error('injected provenance failure'); return insert(table, row); };
    await assert.rejects(h.hub.clientFeedback.create(h.hub.accounts.liveUser(client.body.user.id), r.item.id, { request_id: 'failed', message: 'rollback' }, { ip: '127.0.0.1' }), /provenance failure/);
    h.db.insert = insert; assert.equal(h.db.get('SELECT COUNT(*) n FROM cards').n, 1); assert.equal(h.db.get('SELECT next_key FROM boards WHERE id = ?', r.project.board_id).next_key, before); assert.deepEqual(broadcasts, []);
    const body = { request_id: 'one', message: 'Accepted' }; assert.equal((await send(client, body)).status, 200); assert.equal((await send(client, body)).status, 200);
    assert.equal((await send()).body.error.code, 'QUOTA_EXCEEDED'); assert.equal(h.db.get('SELECT COUNT(*) n FROM client_feedback').n, 1);
  } finally { await h.close(); }
  const rate = await rig({ rateLimits: { ...ROOMY, client_feedback_guest: { capacity: 1, per_ms: 3600000 } } });
  try {
    await rate.enable(); const body = { request_id: 'rate-one', message: 'Accepted once' }; assert.equal((await rate.send(rate.client, body)).status, 200); assert.equal((await rate.send(rate.client, body)).status, 200);
    const denied = await rate.send(); assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get('retry-after')) > 0); assert.equal(rate.h.db.get('SELECT COUNT(*) n FROM client_feedback').n, 1);
  } finally { await rate.h.close(); }
});

test('private triage changes do not publish; explicit safe delivery updates link to own feedback with bounded history', async () => {
  const r = await rig(); const { h, as, owner, client, other, project } = r;
  try {
    await r.enable(); const received = await r.send(), row = h.db.get('SELECT * FROM client_feedback WHERE id = ?', received.body.feedback.id);
    let card = h.hub.card(row.card_id);
    assert.equal((await as(owner, 'PATCH', `/api/cards/${card.id}`, { version: card.version, body: 'PRIVATE TRIAGE CHANGE', column: 'in_progress' })).status, 200);
    assert.equal((await as(client, 'GET', r.feedbackPath)).body.feedback[0].update, undefined);
    const published = await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, { card_id: card.id, title: 'Homepage feedback follow-up', summary: 'We are adjusting the colours.', status: 'in_progress' }); assert.equal(published.status, 200, published.text);
    assert.equal((await as(client, 'GET', r.feedbackPath)).body.feedback[0].update.status, 'in_progress');
    await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, { card_id: card.id, title: 'Homepage feedback follow-up', summary: 'Your requested colours are ready.', status: 'done' });
    const status = await as(client, 'GET', `/api/client/projects/${project.id}`), feedback = status.body.items.find((i) => i.id === r.item.id).feedback[0];
    assert.equal(feedback.update.status, 'done'); assert.deepEqual(feedback.update.history.map((x) => x.status), ['in_progress', 'done']);
    const exported = await as(client, 'GET', '/api/account/client-export'); assert.equal(exported.body.projects[0].items.find((i) => i.id === r.item.id).feedback[0].id, row.id);
    for (const secret of ['PRIVATE TRIAGE CHANGE', 'PRIVATE REPOSITORY DETAILS', 'card_id', 'board_id', 'delegate_member_id']) assert.equal(exported.text.includes(secret), false, secret);
    assert.equal((await as(other, 'GET', '/api/account/client-export')).text.includes(row.message), false);
    const journal = h.db.all('SELECT payload FROM journal WHERE card_id = ?', row.card_id); assert.equal(JSON.stringify(journal).includes('PRIVATE TRIAGE CHANGE'), false, 'later staff edits hash external client card body');
    for (let n = 0; n < 52; n++) await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, { card_id: card.id, title: 'Homepage feedback follow-up', summary: `Safe revision ${n}`, status: 'done' });
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_delivery_updates WHERE item_id = ?', published.body.item.id).n, 50);
    await as(owner, 'DELETE', `/api/client-items/${published.body.item.id}`);
    assert.equal((await as(client, 'GET', r.feedbackPath)).body.feedback[0].update, undefined, 'unpublished delivery history cannot be followed through old feedback');
  } finally { await h.close(); }
});

test('revocation, original unpublication, archive and account deletion remove live feedback access and never resurrect retry writes', async () => {
  const r = await rig(); const { h, as, owner, client, project, item } = r;
  try {
    await r.enable(); await r.addStaff('owner'); const body = { request_id: 'historic', message: 'Old client feedback' }; assert.equal((await r.send(client, body)).status, 200);
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", r.member.id); assert.equal((await r.send(client, body)).body.error.reason, 'CLIENT_INTAKE_PAUSED'); h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", r.member.id);
    h.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', h.hub.iso(), project.board_id);
    assert.equal((await as(client, 'GET', r.feedbackPath)).status, 200); assert.equal((await as(client, 'GET', r.feedbackPath)).body.feedback_available, false); assert.equal((await r.send(client, body)).status, 409); h.db.run('UPDATE boards SET archived_at = NULL WHERE id = ?', project.board_id);
    await as(owner, 'DELETE', `/api/client-items/${item.id}`); assert.equal((await as(client, 'GET', r.feedbackPath)).status, 404); assert.equal((await as(client, 'GET', '/api/account/client-export')).text.includes(body.message), false);
    await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, { card_id: r.internal.body.card.id, title: 'Republished clean title', status: 'review' });
    await as(owner, 'PATCH', `/api/teams/${r.workspace}/client-guests/${client.guestId}`, { grants: [{ project_id: project.id, scopes: ['status.read'] }] });
    assert.equal((await as(client, 'GET', r.feedbackPath)).status, 404); assert.equal((await as(client, 'GET', '/api/account/client-export')).text.includes(body.message), false);
    await as(owner, 'PATCH', `/api/teams/${r.workspace}/client-guests/${client.guestId}`, { grants: [{ project_id: project.id, scopes: ['status.read', 'feedback.create'] }] });
    const flow = await h.stepUp(client.body.device_token, 'client@feedback.test'); assert.equal((await as(client, 'DELETE', '/api/account', { flow_id: flow })).status, 200);
    assert.equal((await as(client, 'GET', r.feedbackPath)).status, 401);
    const staff = (await as(owner, 'GET', r.feedbackPath)).body.feedback[0]; assert.equal(staff.source_name, 'Deleted user'); assert.equal(h.db.get('SELECT COUNT(*) n FROM client_feedback').n, 1);
    const recreated = await h.signIn('client@feedback.test'); assert.equal((await as(recreated, 'GET', r.feedbackPath)).status, 404);
    const teamFlow = await h.stepUp(owner.body.device_token, 'alice@dev.local', 'delete_team');
    assert.equal((await as(owner, 'DELETE', `/api/teams/${r.workspace}`, { flow_id: teamFlow, confirm_slug: h.db.get('SELECT slug FROM orgs WHERE id = ?', r.workspace).slug })).status, 200);
    assert.equal((await as(owner, 'GET', r.feedbackPath)).status, 404);
  } finally { await h.close(); }
});

test('explicit queued reconfiguration uses the new consenting delegate; cookies require CSRF and restore signs old clients out', async () => {
  const r = await rig(); const { h, as, client, project, owner } = r;
  let release;
  try {
    await r.enable(); const admin = await r.addStaff('admin'), adminMember = h.hub.activeMember(admin.memberId);
    const staffWeb = await h.webSignIn('admin@staff.test'), clientWeb = await h.webSignIn('client@feedback.test');
    assert.equal((await h.call('PATCH', r.configPath, { cookie: staffWeb.cookie, body: { enabled: true }, headers: { origin: h.base } })).status, 403);
    assert.equal((await h.call('POST', r.feedbackPath, { cookie: clientWeb.cookie, body: { request_id: 'cookie', message: 'Cookie feedback' }, headers: { origin: h.base } })).status, 403);
    assert.equal((await h.call('POST', r.feedbackPath, { cookie: clientWeb.cookie, body: { request_id: 'cookie', message: 'Cookie feedback' }, headers: { origin: h.base, 'x-csrf-token': clientWeb.body.csrf_token } })).status, 200);
    const block = h.hub.withBoard(project.board_id, () => new Promise((resolve) => { release = resolve; })); await new Promise((resolve) => setImmediate(resolve));
    const configured = h.hub.clientFeedback.configure(adminMember, project.board_id, { enabled: true }, { ip: '127.0.0.1' });
    const feedback = h.hub.clientFeedback.create(h.hub.accounts.liveUser(client.body.user.id), r.item.id, { request_id: 'new-delegate', message: 'After deliberate reconfiguration' }, { ip: '127.0.0.1' });
    release(); release = null; await block; await configured;
    const received = await feedback, row = h.db.get('SELECT * FROM client_feedback WHERE id = ?', received.feedback.id);
    assert.equal(row.delegate_member_id, admin.memberId); assert.equal(h.hub.card(row.card_id).created_by, admin.memberId);
    await as(owner, 'DELETE', `/api/teams/${r.workspace}/members/${admin.memberId}`);
    assert.equal((await r.send()).body.error.reason, 'CLIENT_INTAKE_PAUSED', 'an owner remains but no fallback actor is selected');
    assert.equal((await as(owner, 'GET', r.configPath)).body.intake.delegate.member_id, admin.memberId);
    assert.equal((await as(owner, 'GET', r.configPath)).body.intake.active, false);
    h.hub.config.restore = true; h.hub.boot();
    assert.equal((await as(client, 'GET', r.feedbackPath)).status, 401); assert.equal((await r.send()).status, 401);
    assert.equal((await h.call('GET', '/api/account/client-export', { cookie: clientWeb.cookie })).status, 401);
    const fresh = await h.signIn('client@feedback.test'); assert.equal((await as(fresh, 'GET', r.feedbackPath)).body.feedback.length, 2);
    assert.equal((await r.send(fresh)).body.error.reason, 'CLIENT_INTAKE_PAUSED', 'restoring credentials does not repair a removed delegate');
  } finally { release?.(); await h.close(); }
});
