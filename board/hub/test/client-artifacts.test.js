import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { startAccounts } from './accounts-helpers.js';
import { ROOMY } from './tenancy/fixture.js';
import { CLIENT_FILE_MAX, ClientArtifacts } from '../identity/client-artifacts.js';
import { createRequire } from 'node:module';
const { saveClientArtifact, clientArtifactTarget, saveClientExport, clientExportTarget } = createRequire(import.meta.url)('../../../buddy-window/client-download.js');
const hash = (b) => createHash('sha256').update(b).digest('hex');

async function rig(config = {}) {
  const h = await startAccounts({ config: { rateLimits: ROOMY, ...config } }), owner = await h.signIn('alice@dev.local');
  const as = (u, method, path, body, headers) => h.call(method, path, { token: u.body.device_token, body: method === 'DELETE' ? body ?? {} : body, headers });
  const made = await as(owner, 'POST', '/api/client-workspaces', { request_id: 'client-files', name: 'Isolated delivery' });
  assert.equal(made.status, 200, made.text);
  const workspace = made.body.workspace.id, project = made.body.projects[0];
  const card = await as(owner, 'POST', `/api/boards/${project.board_id}/cards`, { title: 'PRIVATE REPO', body: 'Private implementation' });
  const shared = await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, { card_id: card.body.card.id, title: 'Published homepage', summary: 'Shared status', status: 'review' });
  const item = shared.body.item;
  const guest = async (email, scopes = ['status.read', 'artifacts.read', 'approvals.decide']) => {
    const i = await as(owner, 'POST', `/api/teams/${workspace}/client-invites`, { email, grants: [{ project_id: project.id, scopes }] });
    assert.equal(i.status, 200, i.text);
    const u = await h.signIn(email); assert.equal(u.status, 200, u.text);
    assert.equal((await as(u, 'POST', '/api/client-invites/accept', { t: i.body.link.split('#')[1] })).status, 200);
    u.guestId = h.db.get('SELECT id FROM client_guests WHERE user_id = ? AND workspace_id = ?', u.body.user.id, workspace).id; return u;
  };
  const client = await guest('client@files.test'), other = await guest('other@files.test');
  const body = (content = 'Exact published bytes', extra = {}) => ({ request_id: randomUUID(), name: 'delivery.txt', mime: 'text/plain', data_base64: Buffer.from(content).toString('base64'), ...extra });
  const upload = async (input = body()) => { const r = await as(owner, 'POST', `/api/client-items/${item.id}/artifacts`, input); assert.equal(r.status, 200, r.text); return r.body.artifact; };
  const approval = async (v, guest_ids = [client.guestId], request_id = randomUUID()) => { const r = await as(owner, 'POST', `/api/client-items/${item.id}/approvals`, { artifact_version_id: v.id, guest_ids, request_id }); assert.equal(r.status, 200, r.text); return r.body.approval; };
  const decide = (u, a, decision = 'approve', extra = {}) => as(u, 'POST', `/api/client/approvals/${a.id}/decision`, { artifact_version_id: a.artifact_version_id, sha256: a.sha256, decision, ...extra });
  const file = (v) => h.hub.clientArtifacts.file(v.id);
  return { h, owner, as, workspace, project, item, client, other, guest, body, upload, approval, decide, file };
}

test('real stored immutable versions have server hashes, gated exact bytes and safe attachment headers', async () => {
  const r = await rig(); const { h, as, client, item, project, body, upload, file, owner } = r;
  try {
    const input = body(), v = await upload(input), replay = await upload(input);
    assert.equal(replay.id, v.id); assert.equal(v.sha256, hash(Buffer.from('Exact published bytes')));
    assert.equal(readFileSync(file(v), 'utf8'), 'Exact published bytes'); assert.equal(statSync(file(v)).mode & 0o777, 0o600);
    assert.equal(v.version_number, 1); assert.equal(v.current, true);
    assert.throws(() => h.db.run('UPDATE client_artifact_versions SET sha256 = ? WHERE id = ?', 'a'.repeat(64), v.id), /immutable/);
    const download = await fetch(h.base + v.content_url, { headers: { authorization: `Bearer ${client.body.device_token}` } });
    assert.equal(download.status, 200); assert.equal(await download.text(), 'Exact published bytes');
    assert.equal(download.headers.get('content-type'), 'text/plain'); assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.match(download.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await h.call('GET', v.content_url)).status, 401, 'forwarded URL still requires authentication');
    assert.equal((await as(client, 'GET', `/api/client/items/${item.id}/artifacts/${randomUUID()}`)).status, 404);
    const projected = await as(client, 'GET', `/api/client/projects/${project.id}`);
    assert.equal(projected.body.items[0].artifact.sha256, v.sha256);
    for (const hidden of ['PRIVATE REPO', 'Private implementation', 'created_by', 'board_id', 'card_id', owner.body.device_token]) assert.equal(projected.text.includes(hidden), false, hidden);
    assert.equal((await as(client, 'POST', `/api/client-items/${item.id}/artifacts`, body())).status, 404, 'guest never gets staff upload authority');
    assert.equal((await as(owner, 'POST', `/api/client-items/${item.id}/artifacts`, { ...input, data_base64: Buffer.from('changed').toString('base64') })).status, 409);
    const second = await upload(body('Replacement bytes')); assert.equal(second.version_number, 2);
    assert.equal((await as(client, 'GET', `/api/client/items/${item.id}/artifacts/${v.id}`)).body.artifact.current, false);
    assert.equal((await as(client, 'GET', '/api/account/client-export')).body.projects[0].items[0].artifact.id, second.id);
  } finally { await h.close(); }
});

test('upload refuses poison paths/types/fields and enforces finite quota before storing bytes; failed DB writes clean up', async () => {
  const r = await rig({ clientArtifactLimits: { workspaceBytes: 40, itemVersions: 2 } }); const { h, owner, as, item, body, upload } = r;
  try {
    const endpoint = `/api/client-items/${item.id}/artifacts`, dir = h.hub.clientArtifacts.dir;
    for (const input of [body('hello', { name: '../file.txt' }), body('hello', { name: 'bad\nname.txt' }), body('hello', { name: 'bad.exe' }), body('hello', { mime: 'text/html', name: 'page.html' }), body('hello', { mime: 'image/png', name: 'picture.png' }), body('hello', { path: '/tmp/leak' }), body('hello', { sha256: 'forged' }), body('hello', { data_base64: 'aGk' })]) {
      assert.equal((await as(owner, 'POST', endpoint, input)).status, 400);
    }
    assert.equal(existsSync(dir), false);
    const tooLarge = body('x'.repeat(CLIENT_FILE_MAX + 1));
    assert.equal((await as(owner, 'POST', endpoint, tooLarge)).status, 413); assert.equal(existsSync(dir), false);
    assert.equal((await as(owner, 'POST', endpoint, body('x'.repeat(41)))).body.error.code, 'QUOTA_EXCEEDED'); assert.equal(existsSync(dir), false);
    const insert = h.db.insert.bind(h.db);
    h.db.insert = (table, row) => { if (table === 'client_artifact_versions') throw new Error('injected DB failure'); return insert(table, row); };
    const member = h.db.get('SELECT * FROM members WHERE org_id = ? AND user_id = ?', r.workspace, owner.body.user.id);
    await assert.rejects(h.hub.clientArtifacts.upload(member, item.id, body(), { ip: '127.0.0.1' }), /injected/);
    h.db.insert = insert; assert.deepEqual(readdirSync(dir), []); assert.equal(h.db.get('SELECT COUNT(*) n FROM client_artifact_versions').n, 0);
    await upload(body('one')); await upload(body('two'));
    assert.equal((await as(owner, 'POST', endpoint, body('three'))).body.error.code, 'QUOTA_EXCEEDED'); assert.equal(readdirSync(dir).length, 2);
  } finally { await h.close(); }
});

test('directory and first storage parent are synced before metadata; sync failure leaves no file or version', async () => {
  for (const failAt of [1, 2]) {
    const r = await rig(); const { h, owner, item } = r;
    try {
      const service = h.hub.clientArtifacts, synced = [], sync = service.syncDirectory.bind(service);
      service.syncDirectory = (dir) => { synced.push(dir); assert.equal(h.db.get('SELECT COUNT(*) n FROM client_artifact_versions').n, 0); if (synced.length === failAt) throw new Error('injected directory sync failure'); sync(dir); };
      const member = h.db.get('SELECT * FROM members WHERE user_id = ? AND org_id = ?', owner.body.user.id, r.workspace);
      await assert.rejects(service.upload(member, item.id, r.body(), { ip: '127.0.0.1' }), /directory sync failure/);
      assert.deepEqual(synced, [service.dir, h.app.config.dataDir].slice(0, failAt));
      assert.equal(h.db.get('SELECT COUNT(*) n FROM client_artifact_versions').n, 0); assert.deepEqual(readdirSync(service.dir), []);
      service.syncDirectory = sync;
      await r.upload(); assert.equal(h.db.get('SELECT COUNT(*) n FROM client_artifact_versions').n, 1);
    } finally { await h.close(); }
  }
});

test('assigned client approvals bind exact version/hash, repeat idempotently, preserve history and never dispatch', async () => {
  const r = await rig(); const { h, as, owner, client, other, item, upload, approval, decide } = r;
  try {
    const v = await upload(), a = await approval(v);
    assert.equal((await as(other, 'GET', `/api/client/approvals/${a.id}`)).status, 404);
    assert.equal((await decide(other, a)).status, 404, 'same project scope is insufficient without recipient assignment');
    assert.equal((await as(other, 'POST', `/api/client/approvals/${a.id}/decision`, {})).status, 404, 'unassigned recipient cannot infer a live request through validation');
    assert.equal((await decide(client, a, 'approve', { sha256: '0'.repeat(64) })).status, 409);
    assert.equal((await decide(client, a, 'approve', { actor: owner.body.user.id })).status, 400);
    const decisions = await Promise.all([decide(client, a), decide(client, a)]); assert.ok(decisions.every((d) => d.status === 200));
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_approval_decisions').n, 1);
    assert.equal((await decide(client, a, 'reject')).status, 409);
    assert.equal((await as(client, 'GET', `/api/client/approvals/${a.id}`)).body.approval.status, 'approved');
    assert.equal(h.db.get('SELECT column_name FROM cards WHERE id = ?', h.hub.clientArtifacts.item(item.id).card_id).column_name, 'todo');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM runs').n, 0, 'approval never starts any agent or paid work');
    const next = await upload(r.body('Version two'));
    const old = (await as(client, 'GET', `/api/client/approvals/${a.id}`)).body.approval;
    assert.equal(old.status, 'superseded'); assert.equal(old.decisions[0].decision, 'approve'); assert.equal(old.can_decide, false);
    assert.equal((await decide(client, a)).status, 409);
    assert.equal((await as(owner, 'POST', `/api/client-items/${item.id}/approvals`, { request_id: randomUUID(), artifact_version_id: v.id, guest_ids: [client.guestId] })).status, 409);
    const fresh = await approval(next); assert.equal(fresh.status, 'pending');
    assert.equal((await decide(client, fresh, 'reject', { comment: '<script>not executed</script>' })).body.approval.status, 'rejected');
    assert.throws(() => h.db.run('UPDATE client_approval_requests SET content_hash = ? WHERE id = ?', 'a'.repeat(64), fresh.id), /immutable/);
    assert.throws(() => h.db.run("UPDATE client_approval_decisions SET decision = 'approve' WHERE approval_id = ?", fresh.id), /immutable/);
    assert.equal((await as(owner, 'DELETE', `/api/client-approval-requests/${fresh.id}`)).status, 200);
    assert.equal((await decide(client, fresh)).status, 409);
  } finally { await h.close(); }
});

test('live grant/guest/publication revocation removes artifact metadata, content and old approvals', async () => {
  const r = await rig(); const { h, owner, as, client, item, project, upload, approval, decide } = r;
  try {
    const v = await upload(), a = await approval(v);
    const grants = (scopes) => as(owner, 'PATCH', `/api/teams/${r.workspace}/client-guests/${client.guestId}`, { grants: [{ project_id: project.id, scopes }] });
    await grants(['status.read']);
    assert.equal((await as(client, 'GET', v.content_url)).status, 404); assert.equal((await decide(client, a)).status, 404);
    assert.equal((await as(client, 'GET', `/api/client/projects/${project.id}`)).body.items[0].artifact, undefined);
    await grants(['status.read', 'artifacts.read', 'approvals.decide']);
    await as(owner, 'DELETE', `/api/client-items/${item.id}`);
    assert.equal((await as(client, 'GET', v.content_url)).status, 404); assert.equal((await as(client, 'GET', `/api/client/approvals/${a.id}`)).status, 404);
    assert.equal((await as(client, 'GET', `/api/client/projects/${project.id}`)).body.items.length, 0);
    const internal = h.hub.clientArtifacts.item(item.id);
    await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, { card_id: internal.card_id, title: 'Republished', status: 'review' });
    await as(owner, 'DELETE', `/api/teams/${r.workspace}/client-guests/${client.guestId}`);
    assert.equal((await as(client, 'GET', v.content_url)).status, 404);
    assert.equal((await as(client, 'GET', '/api/account/client-export')).text.includes(v.sha256), false);
  } finally { await h.close(); }
});

test('queued uploads and decisions recheck admin, credential, archive, publication and assigned guest authority', async () => {
  const r = await rig(); const { h, owner, as, client, project, item, upload, approval } = r;
  try {
    const v = await upload(), a = await approval(v), service = h.hub.clientArtifacts;
    const member = h.db.get('SELECT * FROM members WHERE org_id = ? AND user_id = ?', r.workspace, owner.body.user.id);
    h.db.insert('members', { ...h.hub.member(h.ids.bob), id: randomUUID(), org_id: r.workspace, role: 'owner' });
    const held = async (fn, revoke) => {
      let release; const block = h.hub.withBoard(project.board_id, () => new Promise((resolve) => { release = resolve; }));
      await new Promise((resolve) => setImmediate(resolve)); let pending;
      try { pending = fn(); revoke(); } finally { release(); await block; }
      return pending;
    };
    await assert.rejects(held(() => service.upload(member, item.id, r.body('forbidden'), { ip: '127.0.0.1' }), () => h.db.run("UPDATE members SET role = 'member' WHERE id = ?", member.id)), (e) => e.code === 'FORBIDDEN');
    h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", member.id);
    await assert.rejects(held(() => service.upload(member, item.id, r.body('archived'), { ip: '127.0.0.1' }), () => h.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', h.hub.iso(), project.board_id)), (e) => e.extra.reason === 'BOARD_ARCHIVED');
    h.db.run('UPDATE boards SET archived_at = NULL WHERE id = ?', project.board_id);
    const decision = () => service.decide(h.hub.accounts.liveUser(client.body.user.id), a.id, { decision: 'approve', artifact_version_id: v.id, sha256: v.sha256 }, { ip: '127.0.0.1' });
    await assert.rejects(held(decision, () => h.db.run('UPDATE client_guests SET revoked_at = ? WHERE id = ?', h.hub.iso(), client.guestId)), (e) => e.code === 'NOT_FOUND');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_approval_decisions').n, 0);
    const ident = h.hub.accounts.authenticate({ headers: { authorization: `Bearer ${owner.body.device_token}` } }, { ip: '127.0.0.1' });
    await assert.rejects(held(() => service.upload(member, item.id, r.body('revoked token'), { ip: '127.0.0.1', cred: ident.cred }), () => h.db.run('UPDATE user_devices SET revoked_at = ? WHERE id = ?', h.hub.iso(), owner.body.device_id)), (e) => e.code === 'UNAUTHENTICATED');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_artifact_versions').n, 1);
  } finally { await h.close(); }
});

test('tampered bytes and symlink replacements cannot serve or approve an asserted hash', async () => {
  const r = await rig(); const { h, as, owner, client, item, upload, file } = r;
  try {
    const v = await upload(); writeFileSync(file(v), 'Tampered bytes');
    assert.equal((await as(client, 'GET', v.content_url)).status, 409);
    assert.equal((await as(owner, 'POST', `/api/client-items/${item.id}/approvals`, { request_id: 'tampered', artifact_version_id: v.id, guest_ids: [client.guestId] })).status, 409);
    unlinkSync(file(v)); const outside = join(h.app.config.dataDir, 'fake-private.txt'); writeFileSync(outside, 'fake private file'); symlinkSync(outside, file(v));
    const res = await as(client, 'GET', v.content_url); assert.equal(res.status, 409); assert.equal(res.text.includes('fake private file'), false);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_approval_requests').n, 0);
  } finally { await h.close(); }
});

test('native gated save uses exact origin/main bearer and user path, and rechecks scope after the dialog', async () => {
  const r = await rig(); const { h, as, owner, client, project, upload } = r;
  try {
    const v = await upload(), target = h.base + v.content_url, saved = [];
    const settings = { url: target, origin: h.base, tokenFor: () => client.body.device_token, current: () => true, write: (path, bytes) => saved.push({ path, bytes: bytes.toString() }) };
    assert.equal(clientArtifactTarget(target, h.base).versionId, v.id);
    for (const bad of [target + '?token=evil', target + '#hash', target.replace(h.base, 'https://foreign.test'), `${h.base}/api/account/client-export`, `${h.base}/api/client/items/../artifacts/${v.id}/content`]) assert.equal(clientArtifactTarget(bad, h.base), null);
    assert.equal((await saveClientArtifact({ ...settings, choose: async (opts) => { assert.equal(opts.defaultPath, 'deliverable-v1.txt'); return { filePath: '/fake-user-selected-path.txt', canceled: false }; } })).ok, true);
    assert.deepEqual(saved, [{ path: '/fake-user-selected-path.txt', bytes: 'Exact published bytes' }]); saved.length = 0;
    const revoked = await saveClientArtifact({ ...settings, choose: async () => {
      await as(owner, 'PATCH', `/api/teams/${r.workspace}/client-guests/${client.guestId}`, { grants: [{ project_id: project.id, scopes: ['status.read'] }] });
      return { filePath: '/must-not-write.txt', canceled: false };
    } });
    assert.equal(revoked.ok, false); assert.deepEqual(saved, []);
    const noPermission = await saveClientArtifact({ ...settings, url: 'https://foreign.test/api/account', choose: () => { throw new Error('must not ask'); } }); assert.equal(noPermission.ok, false);
  } finally { await h.close(); }
});

test('native client export saves the freshly scoped own projection after a real user choice', async () => {
  const r = await rig(); const { h, as, owner, client, project, upload } = r;
  try {
    const v = await upload(), saved = [], target = `${h.base}/api/account/client-export`;
    const settings = { url: target, origin: h.base, tokenFor: () => client.body.device_token, current: () => true, write: (path, bytes) => saved.push({ path, data: JSON.parse(bytes.toString()) }) };
    assert.equal(clientExportTarget(target, h.base), target);
    for (const bad of [target + '?token=evil', target + '#hash', target.replace(h.base, 'https://foreign.test'), `${h.base}/api/account/export`, `${h.base}/api/client/projects/${project.id}`]) assert.equal(clientExportTarget(bad, h.base), null);
    const choose = async (opts) => { assert.equal(opts.defaultPath, 'plexiform-client-data.json'); return { canceled: false, filePath: '/fake-user-selected-export.json' }; };
    assert.equal((await saveClientExport({ ...settings, choose })).ok, true);
    assert.equal(saved[0].path, '/fake-user-selected-export.json'); assert.equal(saved[0].data.projects[0].items[0].artifact.id, v.id);
    for (const hidden of ['PRIVATE REPO', 'Private implementation', owner.body.device_token, client.body.device_token, 'other@files.test']) assert.equal(JSON.stringify(saved[0].data).includes(hidden), false, hidden);
    saved.length = 0;
    assert.equal((await saveClientExport({ ...settings, choose: async (opts) => {
      await as(owner, 'PATCH', `/api/teams/${r.workspace}/client-guests/${client.guestId}`, { grants: [{ project_id: project.id, scopes: ['status.read'] }] });
      return choose(opts);
    } })).ok, true);
    assert.equal(saved[0].data.projects[0].items[0].artifact, undefined, 'grant removed while dialog is open is absent from saved projection'); saved.length = 0;
    for (const args of [{ url: 'https://foreign.test/api/account/client-export' }, { current: () => false }, { tokenFor: () => null }]) {
      assert.equal((await saveClientExport({ ...settings, ...args, choose: () => { throw new Error('must not ask'); } })).ok, false);
    }
    assert.equal((await saveClientExport({ ...settings, choose: async () => ({ canceled: true }) })).ok, false);
    const revoked = await saveClientExport({ ...settings, choose: async (opts) => {
      await as(client, 'DELETE', `/api/account/devices/${client.body.device_id}`); return choose(opts);
    } });
    assert.equal(revoked.ok, false); assert.equal(revoked.signedOut, true); assert.deepEqual(saved, []);
  } finally { await h.close(); }
});

test('upload slots bound body/queue memory and are released on completion and malformed body', async () => {
  const r = await rig(); const { h, owner, as, item, project } = r;
  let release, uploads = [];
  try {
    const block = h.hub.withBoard(project.board_id, () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    uploads = Array.from({ length: 4 }, (_, i) => as(owner, 'POST', `/api/client-items/${item.id}/artifacts`, r.body(`Upload ${i}`)));
    const deadline = Date.now() + 3000;
    while (h.hub.inflight.size < 5 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.hub.inflight.size, 5, 'all four uploads hold slots while queued');
    const full = await as(owner, 'POST', `/api/client-items/${item.id}/artifacts`, r.body('Too many'));
    assert.equal(full.status, 429); assert.equal(full.headers.get('retry-after'), '1');
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_artifact_versions').n, 0);
    release(); release = null; await block;
    assert.ok((await Promise.all(uploads)).every((x) => x.status === 200));
    const malformed = await fetch(`${h.base}/api/client-items/${item.id}/artifacts`, { method: 'POST', headers: { authorization: `Bearer ${owner.body.device_token}`, 'content-type': 'application/json' }, body: 'not JSON' });
    assert.equal(malformed.status, 400); assert.equal((await as(owner, 'POST', `/api/client-items/${item.id}/artifacts`, r.body('Slot released'))).status, 200);
  } finally { release?.(); await Promise.allSettled(uploads); await h.close(); }
});

test('recovery removes only orphan opaque files and PDF content remains attachment-only', async () => {
  const r = await rig(); const { h, as, client, upload, file } = r;
  try {
    const v = await upload(r.body('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF', { name: 'preview.pdf', mime: 'application/pdf' }));
    const response = await as(client, 'GET', v.content_url);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('content-disposition'), /^attachment;/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    const orphan = join(h.hub.clientArtifacts.dir, `${randomUUID()}.bin`); writeFileSync(orphan, 'crash before DB commit');
    const ignored = join(h.hub.clientArtifacts.dir, 'operator-note.txt'); writeFileSync(ignored, 'operator note');
    new ClientArtifacts(h.hub);
    assert.equal(existsSync(orphan), false); assert.equal(existsSync(ignored), true); assert.equal(existsSync(file(v)), true);
    assert.equal((await as(client, 'GET', v.content_url)).status, 200, 'committed immutable version survives recovery');
  } finally { await h.close(); }
});

test('cookie artifact and approval writes require CSRF, own project binding and live archived/deleted account policy', async () => {
  const r = await rig(); const { h, owner, as, client, project, item, upload, approval, decide } = r;
  try {
    const webOwner = await h.webSignIn('alice@dev.local'), endpoint = `/api/client-items/${item.id}/artifacts`;
    assert.equal((await h.call('POST', endpoint, { cookie: webOwner.cookie, body: r.body() })).status, 403);
    assert.equal((await h.call('POST', endpoint, { cookie: webOwner.cookie, body: r.body(), headers: { origin: 'https://foreign.test', 'x-csrf-token': webOwner.csrf } })).status, 403);
    assert.equal((await h.call('POST', endpoint, { cookie: webOwner.cookie, body: r.body(), headers: { origin: h.base, 'x-csrf-token': webOwner.csrf } })).status, 200);
    const v = await upload(), a = await approval(v), webGuest = await h.webSignIn('client@files.test');
    assert.equal((await h.call('POST', `/api/client/approvals/${a.id}/decision`, { cookie: webGuest.cookie, body: { decision: 'approve', artifact_version_id: v.id, sha256: v.sha256 }, headers: { origin: h.base } })).status, 403);
    const card2 = await as(owner, 'POST', `/api/boards/${project.board_id}/cards`, { title: 'Different private card' });
    const item2 = await as(owner, 'POST', `/api/boards/${project.board_id}/client-items`, { card_id: card2.body.card.id, title: 'Second safe projection', status: 'todo' });
    assert.equal((await as(client, 'GET', `/api/client/items/${item2.body.item.id}/artifacts/${v.id}`)).status, 404, 'artifact ID cannot be transplanted onto another permitted item');
    assert.equal((await as(owner, 'POST', `/api/client-items/${item2.body.item.id}/approvals`, { request_id: 'mixed-items', artifact_version_id: v.id, guest_ids: [client.guestId] })).status, 404);
    h.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', h.hub.iso(), project.board_id);
    assert.equal((await as(client, 'GET', v.content_url)).status, 200, 'archived project is readable');
    assert.equal((await as(client, 'GET', `/api/client/approvals/${a.id}`)).body.approval.can_decide, false);
    assert.equal((await decide(client, a)).body.error.reason, 'BOARD_ARCHIVED');
    h.db.run('UPDATE boards SET archived_at = NULL WHERE id = ?', project.board_id);
    const flow_id = await h.stepUp(client.body.device_token, 'client@files.test');
    assert.equal((await as(client, 'DELETE', '/api/account', { flow_id })).status, 200);
    assert.equal((await as(client, 'GET', v.content_url)).status, 401, 'deleted account loses its credential');
    const recreated = await h.signIn('client@files.test'); assert.notEqual(recreated.body.user.id, client.body.user.id);
    assert.equal((await as(recreated, 'GET', v.content_url)).status, 404, 'a new account with the old email has no old grant');
    const teamFlow = await h.stepUp(owner.body.device_token, 'alice@dev.local', 'delete_team');
    assert.equal((await as(owner, 'DELETE', `/api/teams/${r.workspace}`, { flow_id: teamFlow, confirm_slug: h.db.get('SELECT slug FROM orgs WHERE id = ?', r.workspace).slug })).status, 200);
    assert.equal((await as(owner, 'GET', v.content_url)).status, 404, 'deleted team blocks even staff history links');
  } finally { await h.close(); }
});

test('a real replacement queued ahead of a client decision supersedes it before any decision commits', async () => {
  const r = await rig(); const { h, owner, as, client, item, project, upload, approval, decide } = r;
  let release; const pending = [];
  try {
    const v = await upload(), a = await approval(v);
    const block = h.hub.withBoard(project.board_id, () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    const waitSize = async (size) => { const end = Date.now() + 3000; while (h.hub.inflight.size < size && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(h.hub.inflight.size, size); };
    pending.push(as(owner, 'POST', `/api/client-items/${item.id}/artifacts`, r.body('Replacement won the queue'))); await waitSize(2);
    pending.push(decide(client, a)); await waitSize(3);
    release(); release = null; await block;
    const [replacement, decision] = await Promise.all(pending); assert.equal(replacement.status, 200); assert.equal(decision.status, 409);
    assert.equal(h.db.get('SELECT COUNT(*) n FROM client_approval_decisions').n, 0);
    assert.equal((await as(client, 'GET', `/api/client/approvals/${a.id}`)).body.approval.status, 'superseded');
  } finally { release?.(); await Promise.allSettled(pending); await h.close(); }
});
