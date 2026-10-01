const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createBroker } = require('../native-board/broker');
const { request, readGrant } = require('../native-board/client');
const { callTool } = require('../native-board/tools');
const Install = require('../native-board/install');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-board-test-'));
  const dir = path.join(root, 'grants');
  const key = crypto.randomBytes(32);
  const seal = (s) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(s), c.final(), c.getAuthTag()]); };
  const unseal = (b) => { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(-16)); return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString(); };
  const writes = [];
  let userId = 'user-one';
  let delay = null;
  const client = {
    user: () => userId ? { id: userId } : null,
    me: async () => ({ ok: true, teams: [{ id: 'team-one', role: 'owner', boards: [{ id: 'board-one', name: 'Selected' }, { id: 'board-two', name: 'Private' }] }] }),
    nativeBoard: async (op, params, body) => {
      if (delay) await delay;
      if (op === 'card') return { ok: true, card: { id: params.card, board_id: params.card === 'card-two' ? 'board-two' : 'board-one', version: 2 }, body: 'task data', handover: { markdown: 'handover' } };
      if (op === 'snapshot') return { ok: true, board: { id: params.board, name: 'Selected' }, cards: [{ id: 'card-one', key: 'ONE-1', title: 'Fix the bug' }] };
      writes.push({ op, params, body }); return { ok: true };
    },
  };
  const resolveWorkspace = (id) => id === 'workspace-one' && userId ? { userId, workspace: { teamId: 'team-one' }, client } : null;
  const opts = { dir, seal, unseal, resolveWorkspace };
  const broker = createBroker(opts);
  t.after(async () => { await broker.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const input = { target: 'codex', workspaceId: 'workspace-one', boardIds: ['board-one'], mode: 'read' };
  return { root, opts, broker, input, writes, changeUser: (id) => { userId = id; }, delay: (p) => { delay = p; } };
}

test('native board grant selects boards, binds account identity, and never exports the account credential', async (t) => {
  const f = fixture(t); await f.broker.start(); await f.broker.connect(f.input);
  const file = f.broker.grantPath('codex');
  const r = await request(file, 'plexiform_list_boards', {});
  assert.deepEqual(r.boards.map((b) => b.id), ['board-one']);
  assert.equal((await request(file, 'plexiform_get_card', { card_id: 'card-two' })).code, 'NOT_FOUND');
  assert.equal((await request(file, 'plexiform_list_cards', { board_id: 'board-two' })).code, 'NOT_FOUND');
  assert.equal((await request(file, 'plexiform_get_card', { card_id: 'card-one' })).body, 'task data');
  f.changeUser('different-user');
  assert.equal((await request(file, 'plexiform_get_card', { card_id: 'card-one' })).code, 'UNAUTHENTICATED');
  assert.deepEqual(Object.keys(f.broker.status()[0]).sort(), ['boardIds', 'mode', 'target', 'workspaceId']);
  const sealed = fs.readFileSync(path.join(f.opts.dir, 'connections.bin'));
  assert.ok(!sealed.includes(Buffer.from('board-one')));
});

test('read-only connection cannot write; collaborate tools pin team and reject arbitrary fields and routes', async (t) => {
  const f = fixture(t); await f.broker.start(); await f.broker.connect(f.input);
  const file = f.broker.grantPath('codex');
  assert.equal((await request(file, 'plexiform_add_comment', { card_id: 'card-one', body: 'Progress' })).code, 'FORBIDDEN');
  assert.equal(f.writes.length, 0);
  await f.broker.connect({ ...f.input, mode: 'collaborate' });
  assert.ok((await request(file, 'plexiform_add_comment', { card_id: 'card-one', body: 'Progress' })).ok);
  assert.deepEqual(f.writes[0], { op: 'comment', params: { team: 'team-one', card: 'card-one' }, body: { body: 'Progress', for_agent: false } });
  assert.equal((await request(file, 'plexiform_update_card', { card_id: 'card-one', version: 2, column: 'done' })).code, 'VALIDATION');
  assert.equal((await request(file, 'plexiform_create_card', { board_id: 'board-one', title: 'Task', team: 'other-team' })).code, 'VALIDATION');
  assert.equal((await request(file, 'anything', {})).code, 'VALIDATION');
  assert.equal(f.writes.length, 1);
});

test('Undo revokes old capability immediately, including a read already in flight', async (t) => {
  const f = fixture(t); await f.broker.start(); await f.broker.connect(f.input);
  const token = readGrant(f.broker.grantPath('codex')).token;
  let resume; f.delay(new Promise((r) => { resume = r; }));
  const reading = f.broker.dispatch(token, { name: 'plexiform_get_card', args: { card_id: 'card-one' } });
  await new Promise((r) => setImmediate(r));
  f.broker.revoke('codex'); resume();
  assert.equal((await reading).code, 'UNAUTHENTICATED');
  assert.equal((await f.broker.dispatch(token, { name: 'plexiform_list_boards' })).code, 'UNAUTHENTICATED');
  assert.ok(!fs.existsSync(f.broker.grantPath('codex')));
});

test('pending card preflight cannot start a write after Undo, a narrower replacement or account change', async (t) => {
  for (const change of ['undo', 'downgrade', 'reconnect', 'account']) {
    const f = fixture(t); await f.broker.connect({ ...f.input, mode: 'collaborate' });
    const token = readGrant(f.broker.grantPath('codex')).token;
    let resume; f.delay(new Promise((r) => { resume = r; }));
    const pending = f.broker.dispatch(token, { name: change === 'account' ? 'plexiform_add_comment' : 'plexiform_update_card', args: change === 'account' ? { card_id: 'card-one', body: 'Late comment' } : { card_id: 'card-one', version: 2, body: 'Late edit' } });
    await new Promise((r) => setImmediate(r));
    if (change === 'undo') f.broker.revoke('codex');
    else if (change === 'account') f.changeUser('different-user');
    else await f.broker.connect({ ...f.input, mode: change === 'downgrade' ? 'read' : 'collaborate', boardIds: ['board-two'] });
    resume();
    assert.equal((await pending).code, 'UNAUTHENTICATED', change);
    assert.equal(f.writes.length, 0, change);
  }
});

test('a pending initial workspace lookup cannot create a card after authority withdrawal', async (t) => {
  for (const change of ['undo', 'account']) {
    const f = fixture(t); let hold = false, resume;
    const pause = new Promise((r) => { resume = r; });
    const broker = createBroker({ ...f.opts, dir: path.join(f.root, `pending-${change}`), resolveWorkspace: async (id) => { const ctx = f.opts.resolveWorkspace(id); if (hold) await pause; return ctx; } });
    t.after(() => broker.stop()); await broker.connect({ ...f.input, mode: 'collaborate' });
    const token = readGrant(broker.grantPath('codex')).token; hold = true;
    const pending = broker.dispatch(token, { name: 'plexiform_create_card', args: { board_id: 'board-one', title: 'Late task' } });
    await new Promise((r) => setImmediate(r));
    if (change === 'undo') broker.revoke('codex'); else f.changeUser('different-user');
    resume();
    assert.equal((await pending).code, 'UNAUTHENTICATED', change);
    assert.equal(f.writes.length, 0, change);
  }
});

test('saved scoped permissions survive restart but the old local token does not', async (t) => {
  const f = fixture(t); await f.broker.start(); await f.broker.connect(f.input);
  const old = readGrant(f.broker.grantPath('codex')).token;
  await f.broker.stop();
  const restarted = createBroker(f.opts); t.after(() => restarted.stop()); await restarted.start();
  assert.equal((await restarted.dispatch(old, { name: 'plexiform_list_boards' })).code, 'UNAUTHENTICATED');
  assert.ok((await request(restarted.grantPath('codex'), 'plexiform_list_boards', {})).ok);
  assert.deepEqual(restarted.status()[0].boardIds, ['board-one']);
});

test('enrolment refuses foreign boards, missing identity and unsupported targets without granting anything', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.broker.connect({ ...f.input, boardIds: ['board-foreign'] }));
  await assert.rejects(f.broker.connect({ ...f.input, target: '../other' }));
  f.changeUser(null); await assert.rejects(f.broker.connect(f.input));
  assert.deepEqual(f.broker.status(), []);
});

test('grant reader refuses symlinks and public capability files', async (t) => {
  const f = fixture(t); await f.broker.connect(f.input);
  const file = f.broker.grantPath('codex');
  const link = path.join(f.root, 'link.json'); fs.symlinkSync(file, link);
  assert.throws(() => readGrant(link));
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o644); assert.throws(() => readGrant(file)); }
});

test('card updates carry the supplied version and cannot certify an outcome or approve a prompt', async () => {
  const calls = [];
  const ctx = { grant: { mode: 'collaborate', boardIds: ['b'] }, workspace: { teamId: 't' }, client: { nativeBoard: async (op, params, body) => { calls.push({ op, params, body }); return op === 'card' ? { ok: true, card: { board_id: 'b' } } : { ok: false, code: 'VERSION_CONFLICT' }; } } };
  assert.equal((await callTool(ctx, 'plexiform_update_card', { card_id: 'c', version: 3, body: 'new' })).code, 'VERSION_CONFLICT');
  assert.equal(calls[1].body.version, 3);
  await assert.rejects(callTool(ctx, 'approve_done', {}));
});

test('JSON app setup and Undo preserve foreign MCP servers and refuse a name collision', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-mcp-config-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = Install.configPath('claude-code', home);
  const foreign = { command: 'foreign-tool', env: { PRIVATE_TEST_SENTINEL: 'preserve' } };
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', mcpServers: { foreign } }, null, 4) + '\n');
  const opts = { target: 'claude-code', home, grantPath: '/private/grant.json', entry: Install.launch({ execPath: '/app/exe', appPath: '/app/resources', grantPath: '/private/grant.json' }) };
  await Install.install(opts); await Install.uninstall(opts);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { theme: 'dark', mcpServers: { foreign } });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { [Install.NAME]: foreign } }));
  const before = fs.readFileSync(file);
  await assert.rejects(Install.install(opts), /already exists/);
  assert.ok(fs.readFileSync(file).equals(before));
  await Install.uninstall(opts); assert.ok(fs.readFileSync(file).equals(before));
});

test('malformed JSON configuration remains byte-for-byte unchanged', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-mcp-config-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = Install.configPath('claude-code', home); fs.writeFileSync(file, '{invalid');
  await assert.rejects(Install.install({ target: 'claude-code', home, grantPath: '/p' }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
});

test('real stdio MCP exposes scoped tools and performs an authenticated board round trip', async (t) => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const f = fixture(t); await f.broker.start(); await f.broker.connect(f.input);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'native-board', 'server.js')], env: { PLEXIFORM_BOARD_GRANT: f.broker.grantPath('codex') }, stderr: 'pipe' });
  const client = new Client({ name: 'protocol-test', version: '1' }); t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.some((x) => x.name === 'plexiform_create_card'), false);
  const r = await client.callTool({ name: 'plexiform_get_card', arguments: { card_id: 'card-one' } });
  assert.equal(JSON.parse(r.content[0].text).body, 'task data');
  await f.broker.connect({ ...f.input, mode: 'collaborate' });
  assert.equal((await client.listTools()).tools.some((x) => x.name === 'plexiform_create_card'), true);
  await client.callTool({ name: 'plexiform_create_card', arguments: { board_id: 'board-one', title: 'Real protocol task' } });
  assert.equal(f.writes.at(-1).body.title, 'Real protocol task');
  f.broker.revoke('codex');
  assert.equal((await client.callTool({ name: 'plexiform_get_card', arguments: { card_id: 'card-one' } })).isError, true);
});

test('real Codex configuration commands preserve other settings and Undo removes only the owned server', { skip: !Install.findCodex() && 'Codex CLI is not installed' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-codex-config-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.codex'));
  const file = Install.configPath('codex', home);
  fs.writeFileSync(file, 'model = "gpt-6.1-sol"\n[mcp_servers.foreign]\ncommand = "foreign-tool"\n');
  const grantPath = path.join(home, 'grant.json');
  const opts = { target: 'codex', home, codexPath: Install.findCodex(), grantPath, entry: Install.launch({ execPath: process.execPath, appPath: path.join(__dirname, '..'), grantPath }) };
  await Install.install(opts); assert.ok((await Install.status(opts)).installed);
  await Install.uninstall(opts); assert.equal((await Install.status(opts)).installed, false);
  const text = fs.readFileSync(file, 'utf8'); assert.match(text, /foreign-tool/); assert.match(text, /model = "gpt-6.1-sol"/); assert.doesNotMatch(text, /plexiform-board/);
  const freshHome = path.join(home, 'fresh-home');
  const fresh = { ...opts, home: freshHome, grantPath: path.join(freshHome, 'grant.json') };
  fresh.entry = Install.launch({ execPath: process.execPath, appPath: path.join(__dirname, '..'), grantPath: fresh.grantPath });
  assert.equal((await Install.status(fresh)).installed, false);
  assert.equal(fs.existsSync(freshHome), false);
  await Install.install(fresh); assert.equal((await Install.status(fresh)).installed, true);
  await Install.uninstall(fresh); assert.equal((await Install.status(fresh)).installed, false);
});

test('real accounts hub enforces selected boards, role changes, version conflicts and device revocation through the broker', async (t) => {
  const { startAccounts } = await import('../board/hub/test/accounts-helpers.js');
  const { createAccountClient } = require('../buddy-window/accounts');
  const h = await startAccounts(); t.after(() => h.close());
  const signed = await h.signIn('alice@dev.local'); assert.equal(signed.status, 200);
  const saved = { hub: h.base, token: signed.body.device_token, user: signed.body.user };
  let storage = saved;
  const client = createAccountClient({ origin: h.base, store: { load: () => storage, clear: () => { storage = null; } } });
  const f = fixture(t);
  const broker = createBroker({ ...f.opts, dir: path.join(f.root, 'real-grants'), resolveWorkspace: (id) => id === 'real-workspace' && client.signedIn() ? { workspace: { teamId: h.ids.org }, userId: client.user().id, client } : null });
  t.after(() => broker.stop()); await broker.start();
  await broker.connect({ target: 'claude-code', workspaceId: 'real-workspace', boardIds: [h.ids.board], mode: 'collaborate' });
  const file = broker.grantPath('claude-code');
  const created = await request(file, 'plexiform_create_card', { board_id: h.ids.board, title: 'From a native app', body: 'Real hub task' }); assert.ok(created.ok);
  const card_id = created.card.id;
  const detail = await request(file, 'plexiform_get_card', { card_id }); assert.equal(detail.body, 'Real hub task');
  assert.ok((await request(file, 'plexiform_update_card', { card_id, version: detail.card.version, title: 'Updated' })).ok);
  assert.equal((await request(file, 'plexiform_update_card', { card_id, version: detail.card.version, title: 'Stale edit' })).code, 'VERSION_CONFLICT');
  const second = await h.call('POST', `/api/teams/${h.ids.org}/boards`, { token: saved.token, body: { name: 'Other board', key_prefix: 'OTHER' } }); assert.equal(second.status, 200);
  const otherCard = await h.call('POST', `/api/boards/${second.body.board.id}/cards`, { token: saved.token, headers: { 'X-Board-Team': h.ids.org }, body: { title: 'Not selected' } }); assert.equal(otherCard.status, 200);
  assert.equal((await request(file, 'plexiform_get_card', { card_id: otherCard.body.card.id })).code, 'NOT_FOUND');
  assert.equal((await h.call('PATCH', `/api/teams/${h.ids.org}/members/${h.ids.bob}`, { token: saved.token, body: { role: 'owner' } })).status, 200);
  assert.equal((await h.call('PATCH', `/api/teams/${h.ids.org}/members/${h.ids.alice}`, { token: saved.token, body: { role: 'viewer' } })).status, 200);
  assert.equal((await request(file, 'plexiform_add_comment', { card_id, body: 'Should be denied' })).code, 'FORBIDDEN');
  assert.ok((await request(file, 'plexiform_get_card', { card_id })).ok);
  await h.call('POST', '/api/auth/signout', { token: saved.token, body: {} });
  assert.equal((await request(file, 'plexiform_get_card', { card_id })).code, 'UNAUTHENTICATED');
});
