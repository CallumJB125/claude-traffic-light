import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { startAccounts, dumpDb } from './accounts-helpers.js';
import { ROOMY } from './tenancy/fixture.js';
import { fakeClients, fakeProviders, s256 } from './fake-oauth.js';
import { fakeClock } from './helpers.js';
import http from 'node:http';

async function rig(config = {}, opts = {}) {
  const h = await startAccounts({ ...opts, config: { rateLimits: ROOMY, ...config } });
  const owner = await h.signIn(config.signupAllow ? 'allowed@example.test' : 'alice@dev.local');
  const as = (u, method, path, body, headers) => h.call(method, path, { token: u.body.device_token, body: method === 'DELETE' ? body ?? {} : body, headers });
  const created = await as(owner, 'POST', '/api/client-workspaces', { request_id: 'workspace-one', name: 'Client One' });
  assert.equal(created.status, 200, created.text);
  const workspace = created.body.workspace.id, project = created.body.projects[0];
  const invite = async (email, projects = [project.id]) => {
    const r = await as(owner, 'POST', `/api/teams/${workspace}/client-invites`, { request_id: randomUUID(), email, grants: projects.map((project_id) => ({ project_id, scopes: ['status.read'] })) });
    assert.equal(r.status, 200, r.text); return r.body;
  };
  const accept = (u, i) => as(u, 'POST', '/api/client-invites/accept', { t: i.link.split('#')[1] });
  return { h, owner, as, workspace, project, invite, accept };
}

function coowner(h, workspace) {
  const bob = h.hub.member(h.ids.bob);
  h.db.insert('members', { ...bob, id: randomUUID(), org_id: workspace, role: 'owner' });
}

test('client workspace creation is atomic, persistent-idempotent and does not inherit agency membership', async () => {
  const r = await rig(); const { h, owner, as, workspace } = r;
  try {
    const calls = await Promise.all([1, 2].map(() => as(owner, 'POST', '/api/client-workspaces', { request_id: 'workspace-one', name: 'Client One' })));
    assert.ok(calls.every((x) => x.status === 200 && x.body.workspace.id === workspace));
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_workspaces').n, 1);
    const insert = h.db.insert.bind(h.db), before = h.db.get('SELECT COUNT(*) n FROM orgs').n;
    h.db.insert = (table, data) => { if (table === 'client_workspaces') throw new Error('injected marking failure'); return insert(table, data); };
    assert.throws(() => h.hub.clients.create({ user: h.hub.accounts.liveUser(owner.body.user.id) }, { request_id: 'fault', name: 'Fault' }, { ip: '127.0.0.1' }), /injected/);
    h.db.insert = insert;
    assert.equal(h.db.get('SELECT COUNT(*) n FROM orgs').n, before, 'ordinary team and its first board roll back with workspace marking');
    const bob = await h.signIn('bob@dev.local');
    assert.equal((await as(bob, 'GET', `/api/client/workspaces/${workspace}/projects`)).status, 404, 'agency teammate has no inherited client access');
    assert.equal((await as(bob, 'POST', '/api/client-workspaces', { request_id: 'foreign', name: 'No', agency_team_id: workspace })).status, 404);
    coowner(h, workspace);
    h.db.run('UPDATE members SET removed_at = ? WHERE org_id = ? AND user_id = ?', h.hub.iso(), workspace, owner.body.user.id);
    assert.equal((await as(owner, 'POST', '/api/client-workspaces', { request_id: 'workspace-one', name: 'Client One' })).status, 404, 'persistent replay does not expose a removed workspace');
  } finally { await h.close(); }
});

test('client invitation admission/setup/acceptance stays separate from membership, including simultaneous first login', async () => {
  const r = await rig({ signup: 'allowlist', signupAllow: 'email:allowed@example.test' }); const { h, owner, as, workspace, invite, accept } = r;
  try {
    const i = await invite('client@example.test'), guest = await h.signIn('client@example.test');
    assert.equal(guest.status, 200, guest.text);
    assert.equal(h.db.get('SELECT signup_via FROM users WHERE id = ?', guest.body.user.id).signup_via, 'invite');
    assert.equal(dumpDb(h.db).includes(i.link.split('#')[1]), false, 'token is stored only as a hash');
    const pending = await as(guest, 'POST', '/api/account/setup', {});
    assert.deepEqual([pending.body.setup, pending.body.teams.length, pending.body.pending_client_invites.length], ['client_invited', 0, 1]);
    const race = await Promise.all([accept(guest, i), accept(guest, i), as(guest, 'POST', '/api/account/setup', {})]);
    assert.ok(race.every((x) => x.status === 200), JSON.stringify(race));
    const after = await as(guest, 'POST', '/api/account/setup', {});
    assert.deepEqual([after.body.setup, after.body.teams.length, after.body.client_workspaces.map((w) => w.id)], ['client', 0, [workspace]]);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM members WHERE user_id = ?', guest.body.user.id).n, 0);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_guests WHERE user_id = ?', guest.body.user.id).n, 1);
    assert.equal((await as(guest, 'POST', '/api/teams', { name: 'Bypass' })).status, 403, 'invite-only admission never gains team creation authority');
    const j = await invite('withdrawn@example.test'), withdrawn = await h.signIn('withdrawn@example.test');
    assert.equal((await as(owner, 'DELETE', `/api/teams/${workspace}/client-invites/${j.invite.id}`)).status, 200);
    assert.equal((await as(withdrawn, 'POST', '/api/account/setup', {})).status, 403);
    assert.equal((await as(withdrawn, 'POST', '/api/client-workspaces', { name: 'Bypass', request_id: 'bypass' })).status, 403);
  } finally { await h.close(); }
});

test('client links are email bound, expire, revoke on resend and issuer removal, and never convey staff roles', async () => {
  const r = await rig(); const { h, owner, as, workspace, invite, accept } = r;
  try {
    const i = await invite('right@example.test'), wrong = await h.signIn('wrong@example.test');
    assert.equal((await accept(wrong, i)).body.error.code, 'WRONG_ACCOUNT');
    const resent = await as(owner, 'POST', `/api/teams/${workspace}/client-invites/${i.invite.id}/resend`, { request_id: randomUUID() });
    assert.equal(resent.status, 200, resent.text);
    const right = await h.signIn('right@example.test');
    assert.equal((await accept(right, i)).body.error.code, 'INVALID_TOKEN');
    assert.equal((await accept(right, resent.body)).status, 200);
    const e = await invite('expire@example.test'); h.clock.advance(7 * 86_400_000 + 1);
    assert.equal((await h.call('POST', '/api/client-invites/preview', { body: { t: e.link.split('#')[1] } })).body.error.code, 'INVALID_TOKEN');
    const d = await invite('demotion@example.test');
    coowner(h, workspace);
    h.db.run("UPDATE members SET role = 'member' WHERE user_id = ? AND org_id = ?", owner.body.user.id, workspace);
    const demoted = await h.signIn('demotion@example.test');
    assert.equal((await accept(demoted, d)).body.error.code, 'INVALID_TOKEN');
    assert.equal((await as(demoted, 'GET', '/api/account')).body.pending_client_invites.length, 0);
    assert.equal((await as(owner, 'GET', `/api/teams/${workspace}/client-workspace`)).status, 403);
  } finally { await h.close(); }
});

test('only published safe status fields reach the permitted project; ordinary APIs, WS, other projects and scope escalation refuse guests', async () => {
  const r = await rig(); const { h, owner, as, workspace, project, invite, accept } = r;
  try {
    const card = await as(owner, 'POST', `/api/boards/${project.board_id}/cards`, { title: 'Internal secret', body: 'Private repository instructions', request_id: randomUUID() });
    assert.equal(card.status, 200, card.text);
    const published = await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, { request_id: randomUUID(), card_id: card.body.card.id, title: 'Launch', summary: 'Design is ready', status: 'review' });
    assert.equal(published.status, 200, published.text);
    const b = await as(owner, 'POST', `/api/teams/${workspace}/boards`, { name: 'Private project' });
    const p = await as(owner, 'POST', `/api/boards/${b.body.board.id}/client-project`, {});
    assert.equal(p.status, 200, p.text);
    const i = await invite('guest@example.test'), guest = await h.signIn('guest@example.test'); await accept(guest, i);
    const status = await as(guest, 'GET', `/api/client/projects/${project.id}`);
    assert.deepEqual(Object.keys(status.body.items[0]).sort(), ['history', 'id', 'status', 'summary', 'title', 'updated_at']);
    assert.deepEqual(Object.keys(status.body.items[0].history[0]).sort(), ['created_at', 'id', 'status', 'summary', 'title']);
    assert.equal(status.text.includes('Internal secret'), false); assert.equal(status.text.includes('Private repository'), false);
    assert.equal((await as(guest, 'GET', `/api/client/projects/${p.body.project.id}`)).status, 404);
    const paths = [['GET', `/api/boards/${project.board_id}`], ['GET', `/api/cards/${card.body.card.id}`], ['GET', `/api/teams/${workspace}`], ['POST', `/api/boards/${project.board_id}/cards`], ['POST', `/api/teams/${workspace}/client-invites`], ['GET', `/api/boards/${project.board_id}/journal`], ['GET', '/api/integrations']];
    for (const [method, path] of paths) assert.ok([403, 404].includes((await as(guest, method, path, method === 'POST' ? { title: 'No' } : undefined, { 'x-board-team': workspace })).status), path);
    const socket = await h.browser({ token: guest.body.device_token });
    socket.send({ type: 'hello', protocol: 1 }); await socket.next('welcome');
    socket.send({ type: 'subscribe', board_id: project.board_id });
    assert.equal((await socket.next('error')).code, 'NOT_FOUND');
    const poison = await as(owner, 'POST', `/api/teams/${workspace}/client-invites`, { email: 'poison@example.test', role: 'admin', grants: [{ project_id: project.id, scopes: ['status.read'] }] });
    assert.equal(poison.status, 400);
    assert.equal((await as(owner, 'POST', `/api/teams/${workspace}/client-invites`, { email: 'scope@example.test', grants: [{ project_id: project.id, scopes: ['status.read', 'board.write'] }] })).status, 400);
    const gid = h.db.get('SELECT id FROM client_guests WHERE user_id = ?', guest.body.user.id).id;
    assert.equal((await as(owner, 'PATCH', `/api/teams/${workspace}/client-guests/${gid}`, { grants: [{ project_id: p.body.project.id, scopes: ['status.read'] }] })).status, 200);
    assert.equal((await as(guest, 'GET', `/api/client/projects/${project.id}`)).status, 404, 'live grant change applies to every request');
    await as(owner, 'DELETE', `/api/teams/${workspace}/client-guests/${gid}`);
    assert.equal((await as(guest, 'GET', `/api/client/projects/${p.body.project.id}`)).status, 404);
    assert.equal((await accept(guest, i)).body.error.code, 'INVALID_TOKEN', 'accepted link cannot undo revocation');
  } finally { await h.close(); }
});

test('client cookie writes require CSRF/origin; finite quotas combine ordinary and guest invitations', async () => {
  const r = await rig(); const { h, owner, as, workspace, project, invite } = r;
  try {
    const web = await h.webSignIn('alice@dev.local');
    const body = { request_id: 'csrf-workspace', name: 'CSRF' };
    assert.equal((await h.call('POST', '/api/client-workspaces', { cookie: web.cookie, body })).status, 403);
    assert.equal((await h.call('POST', '/api/client-workspaces', { cookie: web.cookie, body, headers: { origin: 'https://foreign.test', 'x-csrf-token': web.csrf } })).status, 403);
    assert.equal((await h.call('POST', '/api/client-workspaces', { body })).status, 401);
    assert.equal((await h.call('POST', '/api/client-workspaces', { cookie: web.cookie, body, headers: { origin: h.base, 'x-csrf-token': web.csrf } })).status, 200);
    // Free has 25 seats; the workspace owner and 22 ordinary + 2 guest reservations fill it.
    for (let n = 0; n < 22; n++) {
      assert.equal((await as(owner, 'POST', `/api/teams/${workspace}/invites`, { email: `staff${n}@example.test`, role: 'member' })).status, 200);
      h.clock.advance(86_400_000 / 20);
    }
    await invite('c@example.test'); await invite('d@example.test');
    assert.equal((await as(owner, 'POST', `/api/teams/${workspace}/client-invites`, { email: 'full@example.test', grants: [{ project_id: project.id, scopes: ['status.read'] }] })).body.error.code, 'QUOTA_EXCEEDED');
    assert.equal((await as(owner, 'POST', `/api/teams/${workspace}/invites`, { email: 'full@example.test', role: 'member' })).body.error.code, 'QUOTA_EXCEEDED');
  } finally { await h.close(); }
});

test('queued status publication rechecks live admin authority and board archive; unpublish removes exported status', async () => {
  const r = await rig(); const { h, owner, as, workspace, project } = r;
  try {
    const card = await as(owner, 'POST', `/api/boards/${project.board_id}/cards`, { title: 'Private' });
    const body = { card_id: card.body.card.id, title: 'Public', status: 'todo' };
    coowner(h, workspace);
    let release; const held = h.hub.withBoard(project.board_id, () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    const member = h.db.get('SELECT * FROM members WHERE org_id = ? AND user_id = ?', workspace, owner.body.user.id);
    const queued = h.hub.clients.publish(member, project.board_id, body, { ip: '127.0.0.1' });
    h.db.run("UPDATE members SET role = 'member' WHERE id = ?", member.id); release(); await held;
    await assert.rejects(queued, (e) => e.code === 'FORBIDDEN');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_items').n, 0);
    h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", member.id);
    h.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', h.hub.iso(), project.board_id);
    assert.equal((await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, body)).status, 409);
    h.db.run('UPDATE boards SET archived_at = NULL WHERE id = ?', project.board_id);
    const p = await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, body);
    assert.equal(p.status, 200, p.text);
    await as(owner, 'DELETE', `/api/client-items/${p.body.item.id}`);
    assert.equal((await as(owner, 'GET', `/api/client/projects/${project.id}`)).body.items.length, 0);
  } finally { await h.close(); }
});

test('guest export is self-scoped; account and team deletion scrub client email and revoke reads and links', async () => {
  const r = await rig(); const { h, owner, as, workspace, project, invite, accept } = r;
  try {
    const i = await invite('erase@example.test'), guest = await h.signIn('erase@example.test'); await accept(guest, i);
    const exported = await as(guest, 'GET', '/api/account/client-export');
    assert.equal(exported.status, 200); assert.equal(exported.body.access.length, 1);
    assert.equal(exported.text.includes('alice@dev.local'), false); assert.equal(exported.text.includes('token_hash'), false);
    const flow_id = await h.stepUp(guest.body.device_token, 'erase@example.test');
    assert.equal((await as(guest, 'DELETE', '/api/account', { flow_id })).status, 200);
    assert.equal((await as(guest, 'GET', `/api/client/projects/${project.id}`)).status, 401);
    assert.match(h.db.get('SELECT email FROM client_invites WHERE id = ?', i.invite.id).email, /^deleted:/);
    assert.ok(h.db.get('SELECT revoked_at FROM client_guests WHERE user_id = ?', guest.body.user.id).revoked_at);
    const newGuest = await h.signIn('erase@example.test');
    assert.notEqual(newGuest.body.user.id, guest.body.user.id);
    assert.equal((await as(newGuest, 'GET', `/api/client/projects/${project.id}`)).status, 404);
    assert.equal((await accept(newGuest, i)).body.error.code, 'INVALID_TOKEN');
    const j = await invite('team-erase@example.test'), another = await h.signIn('team-erase@example.test'); await accept(another, j);
    const slug = h.db.get('SELECT slug FROM orgs WHERE id = ?', workspace).slug;
    const teamFlow = await h.stepUp(owner.body.device_token, 'alice@dev.local', 'delete_team');
    assert.equal((await as(owner, 'DELETE', `/api/teams/${workspace}`, { flow_id: teamFlow, confirm_slug: slug })).status, 200);
    assert.equal((await as(another, 'GET', `/api/client/projects/${project.id}`)).status, 404);
    assert.equal((await as(another, 'GET', '/api/client/workspaces')).body.workspaces.length, 0);
  } finally { await h.close(); }
});

test('client invitation signup is rechecked at email verification; Google authority and GitHub verified address rules still apply', async () => {
  const clock = fakeClock(), clients = fakeClients(), provider = fakeProviders({ clock, clients });
  const r = await rig({ ...clients, signup: 'allowlist', signupAllow: 'email:allowed@example.test' }, { clock, fetchImpl: provider.fetch });
  const { h, owner, as, workspace, invite, accept } = r;
  try {
    const revoked = await invite('withdraw-before-verify@example.test');
    const start = await h.start('withdraw-before-verify@example.test'), code = h.codeFor('withdraw-before-verify@example.test');
    await as(owner, 'DELETE', `/api/teams/${workspace}/client-invites/${revoked.invite.id}`);
    const verify = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: start.body.flow_id, code } });
    assert.equal(verify.body.error.code, 'SIGNUP_CLOSED');
    assert.equal(h.db.get('SELECT id FROM users WHERE primary_email = ?', 'withdraw-before-verify@example.test'), null);
    const oauth = async (method, who) => {
      const verifier = randomBytes(32).toString('base64url');
      const s = await h.call('POST', '/api/auth/oauth/start', { body: { provider: method, client: 'buddy_desktop', code_challenge: s256(verifier), redirect_uri: 'http://127.0.0.1:53682/callback' } });
      assert.equal(s.status, 200, s.text);
      const auth = provider.authorize(s.body.url, who);
      return h.call('POST', '/api/auth/oauth/exchange', { body: { flow_id: s.body.flow_id, code: auth.code, state: auth.state, code_verifier: verifier } });
    };
    const goodGoogle = await invite('client@gmail.com');
    const google = await oauth('google', { sub: 'client-google', email: 'client@gmail.com' });
    assert.equal(google.status, 200, google.text); assert.equal((await accept(google, goodGoogle)).status, 200);
    await invite('weak-google@example.test');
    const weak = await oauth('google', { sub: 'weak-google', email: 'weak-google@example.test' });
    assert.equal(weak.body.error.code, 'SIGNUP_CLOSED', 'an invitation cannot make a non-authoritative Google address authoritative');
    const goodGithub = await invite('github@example.test');
    const github = await oauth('github', { id: 80102, login: 'fake-client', email: 'github@example.test' });
    assert.equal(github.status, 200, github.text); assert.equal((await accept(github, goodGithub)).status, 200);
    await invite('unverified-github@example.test');
    const unverified = await oauth('github', { id: 80103, login: 'fake-unverified', emails: [{ email: 'unverified-github@example.test', primary: true, verified: false }] });
    assert.ok(unverified.status >= 400, unverified.text);
  } finally { await h.close(); }
});

test('two client workspaces and an internal agency stay disjoint, including cross-workspace DB guards', async () => {
  const r = await rig(); const { h, owner, as, workspace, project, invite, accept } = r;
  try {
    const second = await as(owner, 'POST', '/api/client-workspaces', { name: 'Client Two', request_id: 'workspace-two', agency_team_id: h.ids.org });
    assert.equal(second.status, 200, second.text);
    const other = second.body.projects[0], i = await invite('scoped@example.test'), guest = await h.signIn('scoped@example.test'); await accept(guest, i);
    assert.equal((await as(guest, 'GET', `/api/client/workspaces/${second.body.workspace.id}/projects`)).status, 404);
    assert.equal((await as(guest, 'GET', `/api/client/projects/${other.id}`)).status, 404);
    assert.equal((await as(guest, 'GET', `/api/boards/${h.ids.board}`)).status, 404);
    const gid = h.db.get('SELECT id FROM client_guests WHERE user_id = ?', guest.body.user.id).id;
    assert.equal((await as(owner, 'PATCH', `/api/teams/${workspace}/client-guests/${gid}`, { grants: [{ project_id: other.id, scopes: ['status.read'] }] })).status, 404);
    assert.throws(() => h.db.run('INSERT INTO client_grants VALUES (?, ?, ?)', gid, other.id, '["status.read"]'), /another workspace/);
    assert.throws(() => h.db.run('UPDATE client_projects SET workspace_id = ? WHERE id = ?', second.body.workspace.id, project.id), /another workspace/);
    assert.throws(() => h.db.run('UPDATE client_guests SET invited_by = ? WHERE id = ?', h.ids.alice, gid), /another workspace/);
    assert.throws(() => h.db.run('UPDATE client_invites SET created_by = ? WHERE id = ?', h.ids.alice, i.invite.id), /another workspace/);
    assert.equal((await as(guest, 'GET', `/api/client/projects/${project.id}`)).status, 200);
    const journal = h.db.all("SELECT payload FROM journal WHERE kind LIKE 'client.%'").map((j) => JSON.parse(j.payload));
    assert.ok(journal.length >= 3); assert.equal(JSON.stringify(journal).includes('scoped@example.test'), false);
  } finally { await h.close(); }
});

test('restore epoch invalidates guest desktop and browser credentials before projections/export; fresh sign-in retains actual grants', async () => {
  const r = await rig(); const { h, as, project, invite, accept } = r;
  try {
    const i = await invite('restored@example.test'), guest = await h.signIn('restored@example.test'); await accept(guest, i);
    const web = await h.webSignIn('restored@example.test');
    h.hub.config.restore = true; h.hub.boot();
    assert.equal((await as(guest, 'GET', `/api/client/projects/${project.id}`)).status, 401);
    assert.equal((await h.call('GET', '/api/account/client-export', { cookie: web.cookie })).status, 401);
    const fresh = await h.signIn('restored@example.test');
    assert.equal((await as(fresh, 'GET', `/api/client/projects/${project.id}`)).status, 200);
  } finally { await h.close(); }
});

test('revoking a credential while a client request body or board queue waits prevents the write', async () => {
  const r = await rig(); const { h, owner, as, workspace, project } = r;
  try {
    const extra = await h.signIn('alice@dev.local'), before = h.db.get('SELECT COUNT(*) n FROM orgs').n;
    const payload = JSON.stringify({ request_id: 'delayed', name: 'Must not commit' });
    let authenticated;
    const ready = new Promise((resolve) => { authenticated = resolve; });
    const auth = h.hub.accounts.authenticate.bind(h.hub.accounts);
    h.hub.accounts.authenticate = (req, opts) => { const ident = auth(req, opts); if (req.url === '/api/client-workspaces') authenticated(); return ident; };
    let request;
    const answer = new Promise((resolve, reject) => {
      request = http.request(`${h.base}/api/client-workspaces`, { method: 'POST', headers: { authorization: `Bearer ${extra.body.device_token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let body = ''; res.on('data', (b) => { body += b; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      request.on('error', reject); request.write(payload.slice(0, 1));
    });
    await ready;
    h.db.run('UPDATE user_devices SET revoked_at = ?, token_hash = NULL WHERE id = ?', h.hub.iso(), extra.body.device_id);
    request.end(payload.slice(1));
    assert.equal((await answer).status, 401); assert.equal(h.db.get('SELECT COUNT(*) n FROM orgs').n, before);
    h.hub.accounts.authenticate = auth;
    const card = await as(owner, 'POST', `/api/boards/${project.board_id}/cards`, { title: 'Private task' });
    const member = h.db.get('SELECT * FROM members WHERE org_id = ? AND user_id = ?', workspace, owner.body.user.id);
    let release;
    const held = h.hub.withBoard(project.board_id, () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    const queued = h.hub.clients.publish(member, project.board_id, { title: 'No share', status: 'todo', card_id: card.body.card.id }, { ip: '127.0.0.1', cred: { kind: 'device', id: owner.body.device_id } });
    h.db.run('UPDATE user_devices SET revoked_at = ?, token_hash = NULL WHERE id = ?', h.hub.iso(), owner.body.device_id);
    release(); await held; await assert.rejects(queued, (e) => e.code === 'UNAUTHENTICATED');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_items').n, 0);
  } finally { await h.close(); }
});
