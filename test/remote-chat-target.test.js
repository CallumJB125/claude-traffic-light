'use strict';
// T4c-1 (plan-t4c Rev 1): a Plexiform chat as a shared-session target (src/remote-chat-target.js), served through the
// unchanged remote host. Inert until T4c-2: nothing calls register(), so no chat is ever a shared target.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRemoteChatTargets, ACTOR } = require('../src/remote-chat-target');
const { createRemoteInteractionHost } = require('../src/remote-interaction');

const ROOT = path.join(__dirname, '..');
const PROVIDER_SESSION = '7b0c3f2e-4a1d-4c55-9e0f-1234567890ab';
let SESSION = '7b0c3f2e-4a1d-4c55-9e0f-0000000000ab'; // replaced by each register(): the share id main mints
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function fakeTasks(over = {}) {
  const row = { id: 'tsk_1', state: 'in_review', ai: { id: 'claude' }, permissionLevel: 'auto-edits', workInPlace: false, lastSeq: 40, title: 'SECRET TITLE', where: '~/secret-repo', branch: 'secret-branch' };
  const t = {
    row, sends: [], watchers: [], stopped: 0, answer: null,
    tasks: {
      row: (id) => (id === row.id ? row : null),
      detail: async (id) => (id === row.id ? { sessionId: PROVIDER_SESSION, workInPlace: row.workInPlace, lastSeq: row.lastSeq, ...over.detail } : null),
      watch: async (id, fromSeq, onEvent, onReset) => { t.watchers.push({ id, fromSeq, onEvent, onReset }); return { stop: () => { t.stopped++; } }; },
      shareMessage: async (id, body, share, requestId) => { t.sends.push({ id, body, share, requestId }); return t.answer ?? { ok: true, messageId: `msg-${t.sends.length}` }; },
    },
    emit: (e) => t.watchers.at(-1).onEvent(e),
  };
  return t;
}
const KEYS = ['activeTurn', 'activity', 'board', 'capabilities', 'deliveries', 'generation', 'input_needed', 'provider', 'reporting', 'session', 'status', 'task_title'];
const sendOpts = { by: 'Alex', byId: 'u-alex', share: 'shr-1', frame: 'frm-1' };

test('inert: no chat is a target until register(); no code outside the module and tests calls register', async () => {
  const f = fakeTasks();
  const c = createRemoteChatTargets({ tasks: f.tasks });
  assert.equal(c.target(SESSION), null);
  assert.equal(c.hub.state({ session: SESSION }, ACTOR), null);
  assert.equal((await c.hub.send({ session: SESSION, generation: 1, board: null, text: 'hi' }, ACTOR, sendOpts)).status, 'stale');
  assert.equal(f.sends.length, 0);
  const callers = [];
  const scan = (dir) => { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (fs.statSync(p).isDirectory()) scan(p); else if (/\.(js|cjs|mjs|html)$/.test(n) && p !== path.join(ROOT, 'src', 'remote-chat-target.js') && /ChatTargets\.register\(|chatTargets\.register\(|\.register\(\s*task/.test(fs.readFileSync(p, 'utf8'))) callers.push(p); } };
  scan(path.join(ROOT, 'src'));
  if (/ChatTargets\.register\(/.test(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'))) callers.push('main.js');
  assert.deepEqual(callers, [], 'T4c-2 adds the only caller, at a confirmed Share');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /sharedTarget:session=>InteractionMain\.sharedTarget\(session\)\?\?ChatTargets\?\.target\(session\)\?\?null/);
  // Chat-first preview only: created inside main's one `if (CHAT_PREVIEW) {` block, null otherwise.
  assert.equal((main.match(/ChatTargets = require\('\.\/src\/remote-chat-target'\)/g) || []).length, 1);
  const block = main.slice(main.indexOf('\nif (CHAT_PREVIEW) {\n'));
  assert.ok(block.indexOf('ChatTargets = require(') > 0 && block.indexOf('ChatTargets = require(') < block.indexOf('\n}\n'), 'inside the preview block');
  assert.match(main, /\nlet ChatTargets=null;\n/);
});

test('register: refuses work in place and a bad session; disabled means nothing resolves', async () => {
  for (const detail of [{ workInPlace: true }, { lastSeq: null }]) {
    const f = fakeTasks({ detail });
    const c = createRemoteChatTargets({ tasks: f.tasks });
    assert.equal((await c.register('tsk_1')).ok, false, JSON.stringify(detail));
    assert.equal(c.target(SESSION), null);
  }
  let on = true;
  const f = fakeTasks();
  const c = createRemoteChatTargets({ tasks: f.tasks, enabled: () => on });
  const r = await c.register('tsk_1');
  assert.equal(r.ok, true); SESSION = r.session;
  assert.deepEqual(c.target(SESSION), { hub: c.hub, actor: ACTOR });
  on = false;
  assert.equal(c.target(SESSION), null);
  assert.equal(c.hub.state({ session: SESSION }, ACTOR), null);
  on = true;
  assert.equal(c.hub.state({ session: SESSION }, 'overview:1:1'), null, 'only its own actor');
  c.unregister(SESSION);
  assert.equal(c.target(SESSION), null);
  assert.equal(f.stopped, 1);
});

test('state: closed keys, no title/folder/branch; only events strictly after the share; responses join their message', async () => {
  const f = fakeTasks();
  const c = createRemoteChatTargets({ tasks: f.tasks, now: () => 5000 });
  SESSION = (await c.register('tsk_1')).session;
  assert.equal(f.watchers[0].fromSeq, 41, 'subscribes after the task\'s lastSeq at register');
  f.emit({ type: 'message', seq: 40, id: 'm-old', direction: 'in', from: { kind: 'human' }, body: 'BEFORE SHARE', createdAt: 1 });
  f.emit({ type: 'message', seq: 41, id: 'm-1', direction: 'in', from: { kind: 'human' }, body: 'owner asks', createdAt: 4000 });
  f.emit({ type: 'message', seq: 42, id: 'm-agent', direction: 'in', from: { kind: 'task', id: 'x' }, body: 'AGENT RELAY', createdAt: 4001 });
  f.emit({ type: 'transcript', seq: 43, role: 'assistant', text: 'Working on it. ', turn: 3 });
  f.emit({ type: 'transcript', seq: 44, role: 'assistant', text: 'Done.', turn: 3 });
  f.emit({ type: 'state', seq: 45, state: 'in_review' });
  const st = c.hub.state({ session: SESSION }, ACTOR);
  assert.deepEqual(Object.keys(st).sort(), KEYS);
  assert.deepEqual(st.capabilities, { send: true, steer: false, interrupt: false });
  assert.equal(st.board, null); assert.equal(st.task_title, null); assert.equal(st.status, 'ready');
  const text = JSON.stringify(st);
  for (const leak of ['SECRET', 'secret-repo', 'secret-branch', 'BEFORE SHARE', 'AGENT RELAY', 'tsk_1']) assert.ok(!text.includes(leak), leak);
  assert.equal(st.deliveries.length, 1);
  assert.deepEqual({ ...st.deliveries[0] }, { id: 'm-1', text: 'owner asks', by: null, mode: 'new-turn', stoppedBy: null, state: 'completed', recorded: true, turn: '3', response: 'Working on it. Done.', error: null, notices: [], sentAt: 4000, finishedAt: 5000 });
});

test('send: the engine decides; the teammate rides only the share fields; no steer, no stop', async () => {
  const f = fakeTasks();
  const c = createRemoteChatTargets({ tasks: f.tasks, now: () => 9000 });
  SESSION = (await c.register('tsk_1')).session;
  const base = { session: SESSION, generation: 1, board: null };
  const ok = await c.hub.send({ ...base, text: '  please add tests  ' }, ACTOR, sendOpts);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(f.sends[0], { id: 'tsk_1', body: 'please add tests', share: { key: 'shr-1', by: { memberId: 'u-alex', name: 'Alex' }, expect: { permissionLevel: 'auto-edits', ai: 'claude' } }, requestId: 'share:shr-1:frm-1' });
  assert.equal(ok.delivery.by, 'Alex');
  // Its own message event (a member) arriving later shows once, with the name from the send.
  f.emit({ type: 'message', seq: 50, id: 'msg-1', direction: 'in', from: { kind: 'member', id: 'u-alex', label: 'Alex (teammate)' }, body: 'please add tests', createdAt: 9000 });
  f.emit({ type: 'transcript', seq: 51, role: 'assistant', text: 'Added.', turn: 4 });
  const d = c.hub.state(base, ACTOR).deliveries;
  assert.equal(d.length, 1); assert.equal(d[0].response, 'Added.'); assert.equal(d[0].by, 'Alex');
  // A member message no send of this share made is never shown.
  f.emit({ type: 'message', seq: 52, id: 'msg-other', direction: 'in', from: { kind: 'member', id: 'u-phone', label: 'phone relay' }, body: 'OTHER RELAY', createdAt: 9001 });
  assert.ok(!JSON.stringify(c.hub.state(base, ACTOR)).includes('OTHER RELAY'));
  for (const [code, status] of [['SESSION_BUSY', 'busy'], ['CONFLICT', 'stale'], ['POLICY_DENIED', 'forbidden'], ['INTERNAL', 'unavailable']]) {
    f.answer = { ok: false, code };
    assert.equal((await c.hub.send({ ...base, text: 'x' }, ACTOR, { ...sendOpts, frame: `f-${code}` })).status, status, code);
  }
  f.answer = null;
  const n = f.sends.length;
  assert.equal((await c.hub.send({ ...base, text: 'x', expectedTurn: 'a' }, ACTOR, sendOpts)).status, 'stale', 'no steer');
  assert.equal((await c.hub.send({ ...base, text: 'x' }, ACTOR, { ...sendOpts, byId: null })).status, 'invalid', 'the host names the teammate');
  assert.equal((await c.hub.send({ ...base, text: 'x', extra: 1 }, ACTOR, sendOpts)).status, 'invalid');
  assert.equal((await c.hub.send({ ...base, text: 'x' }, ACTOR, { ...sendOpts, fresh: () => false })).status, 'stale');
  assert.equal((await c.hub.interrupt({ ...base, turn: 'x' }, ACTOR, { by: 'Alex' })).status, 'unsupported');
  // A changed mode or AI is a new generation: the old composer is stale.
  f.row.permissionLevel = 'auto';
  assert.equal((await c.hub.send({ ...base, text: 'x' }, ACTOR, sendOpts)).status, 'stale');
  assert.equal(c.hub.state(base, ACTOR).generation, 2);
  f.row.workInPlace = true;
  assert.equal((await c.hub.send({ ...base, generation: 3, text: 'x' }, ACTOR, sendOpts)).status, 'forbidden', 'work in place never takes a teammate message');
  assert.equal(f.sends.length, n, 'nothing above reached the engine');
});

test('relay: a teammate\'s send through the unchanged host carries the host\'s own record of who sent it', async () => {
  const f = fakeTasks();
  const chats = createRemoteChatTargets({ tasks: f.tasks });
  SESSION = (await chats.register('tsk_1')).session;
  const USER = 'u-owner', shares = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    let body = {};
    if (u.pathname === '/api/interaction/v1/shares' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      const s = { id: crypto.randomUUID(), session: b.session, team: { id: b.team, name: 'Design' }, scope: b.scope, owner: { name: 'Owner' }, members: [{ id: 'u-alex', name: 'Alex', role: 'member' }] };
      shares.push(s); body = { share: s };
    } else if (u.pathname === '/api/interaction/v1/shares') body = { teams: [{ id: 'team-1', name: 'Design' }], shares };
    else body = { ok: true };
    return { status: 200, ok: true, json: async () => body };
  };
  class WS extends EventEmitter { constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'relay.welcome', user: USER, device: 'd-1', resume: 'r-1' })), false)); } send() {} close() {} }
  const host = createRemoteInteractionHost({ userId: USER, adapters: {}, boardCurrent: (b) => b === null, sharedTarget: (s) => chats.target(s) });
  try {
    await host.enable({ baseUrl: 'https://hub.example', token: 'tok', WebSocket: WS, fetch });
    await flush();
    const made = await host.shareSession({ session: SESSION, team: 'team-1', scope: 'interact' });
    assert.equal(made.ok, true, JSON.stringify(made));
    const id = crypto.randomUUID();
    const out = await host.handle({ type: 'relay.request', id, rid: crypto.randomUUID(), user: USER, from: 'hub', op: 'send', args: { session: SESSION, generation: 1, text: 'hello from Alex' },
      share: { id: made.share.id, team: 'team-1', user: 'u-alex', name: 'Mallory', scope: 'interact' } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(f.sends[0].share.by, { memberId: 'u-alex', name: 'Alex' }, 'the name is the host\'s record, never the frame\'s');
    assert.equal(f.sends[0].requestId, `share:${made.share.id}:${id}`);
    const stop = await host.handle({ type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: USER, from: 'hub', op: 'interrupt', args: { session: SESSION, generation: 1, turn: crypto.randomUUID() },
      share: { id: made.share.id, team: 'team-1', user: 'u-alex', name: 'Alex', scope: 'interact' } });
    assert.equal(stop.ok, false);
  } finally { host.close(); }
});

test('two teammates are told apart: each send names its own member id and name', async () => {
  const f = fakeTasks();
  const c = createRemoteChatTargets({ tasks: f.tasks });
  SESSION = (await c.register('tsk_1')).session;
  const base = { session: SESSION, generation: 1, board: null };
  await c.hub.send({ ...base, text: 'from alex' }, ACTOR, sendOpts);
  await c.hub.send({ ...base, text: 'from sam' }, ACTOR, { by: 'Sam', byId: 'u-sam', share: 'shr-1', frame: 'frm-2' });
  assert.deepEqual(f.sends.map((s) => s.share.by), [{ memberId: 'u-alex', name: 'Alex' }, { memberId: 'u-sam', name: 'Sam' }]);
  assert.deepEqual(c.hub.state(base, ACTOR).deliveries.map((d) => d.by), ['Alex', 'Sam']);
});

test('S7: the automatic-share reconciler never shares, or stops, a chat (Q4: chats are shared only by hand)', async () => {
  const { createTeamSessionSharing } = require('../src/team-session-sharing');
  const f = fakeTasks();
  const chats = createRemoteChatTargets({ tasks: f.tasks });
  SESSION = (await chats.register('tsk_1')).session;
  const calls = [];
  const manual = { id: 'shr-manual', session: SESSION, team: { id: 'team-1' } };
  const host = { connected: () => true, listShares: async () => ({ ok: true, teams: [{ id: 'team-1' }] }), shared: () => [manual],
    shareSessionAutomatic: async (a) => { calls.push(['share', a]); return { ok: false }; }, stopSharing: (id) => { calls.push(['stop', id]); } };
  const r = createTeamSessionSharing({ host: () => host, origin: () => 'https://hub.example', sessions: () => [], association: () => ({ origin: 'https://hub.example', team: 'team-1' }) });
  await r.sync();
  assert.deepEqual(calls, []);
  assert.equal(r.isAutomatic('shr-manual'), false);
  // In main the reconciler reads only the interaction hub's own sessions, never the chat registry.
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const block = main.slice(main.indexOf("createTeamSessionSharing({"), main.indexOf('let manualShareRefresh'));
  assert.match(block, /sessions:\(\)=>InteractionMain\.listOwned\(\),/);
  assert.ok(!/ChatTargets|tsk_/.test(block));
});

test('tasks-service: the chat reads and the share send, against the mock supervisor', async () => {
  const os = require('node:os');
  const { pathToFileURL } = require('node:url');
  const { createTasksService } = require('../src/tasks-service.js');
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
  const { startMockServer } = await import(pathToFileURL(path.join(ROOT, 'board', 'tasks-api', 'mock-server.js')).href);
  const dir = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pct-'));
  const srv = await startMockServer({ dir, speed: 40, hbMs: 200 });
  const svc = createTasksService({ boardHome: dir, homeDir: path.resolve('/Users/demo'), copy: () => {}, isDir: () => true });
  try {
    assert.equal(await svc.chatDetail('tsk_none'), null, 'offline: nothing');
    assert.deepEqual(await svc.shareMessage('tsk_none', 'x', {}, 'share:a:b'), { ok: false, code: 'SUPERVISOR_UNREACHABLE' });
    svc.start();
    await until(() => svc.snapshot().conn.status === 'connected');
    const c = await (await import(pathToFileURL(path.join(ROOT, 'board', 'tasks-api', 'client.js')).href)).connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
    const { id } = await c.createTask({ text: 'Shared chat', cwd: '/Users/demo/Development/acme-web', ai: 'claude' });
    c.close();
    const row = await until(() => svc.chatRow(id));
    assert.equal(row.id, id);
    assert.equal(svc.chatRow('tsk_none'), null);
    const d = await svc.chatDetail(id);
    assert.deepEqual(Object.keys(d).sort(), ['lastSeq', 'workInPlace']);
    const seen = [];
    const w = await svc.watchChat(id, 1, (e) => seen.push(e), () => {});
    await until(() => seen.some((e) => e.type === 'state'));
    assert.ok(seen.filter((e) => e.type === 'state').every((e) => Object.keys(e).sort().join() === 'seq,state,type' && typeof e.state === 'string'), 'a state event is only its state');
    w.stop();
    const r = await svc.shareMessage(id, 'hello', { key: 'shr-1', by: { memberId: 'u-alex', name: 'Alex' }, expect: { permissionLevel: row.permissionLevel, ai: 'claude' } }, 'share:shr-1:frm-1');
    assert.ok(r.ok === true ? typeof r.messageId === 'string' : typeof r.code === 'string', JSON.stringify(r));
  } finally { svc.stop(); await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('§0: the hub\'s share id is a fresh UUID per chat, stable for this process, never the provider session id', async () => {
  const f = fakeTasks();
  const c = createRemoteChatTargets({ tasks: f.tasks });
  assert.equal(c.sessionOf('tsk_1'), null, 'a lookup never registers');
  const a = await c.register('tsk_1');
  assert.equal(a.ok, true);
  assert.match(a.session, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a.session, PROVIDER_SESSION);
  assert.ok(!a.session.includes(PROVIDER_SESSION.slice(0, 8)));
  assert.equal((await c.register('tsk_1')).session, a.session, 're-sharing reuses it');
  assert.equal(c.sessionOf('tsk_1'), a.session);
  assert.equal(c.taskOf(a.session), 'tsk_1');
  assert.equal(c.target(PROVIDER_SESSION), null, 'the provider id reaches nothing');
  c.unregister(a.session);
  assert.equal(c.sessionOf('tsk_1'), null);
  const g = { ...f.row, id: 'tsk_2' };
  const c2 = createRemoteChatTargets({ tasks: { ...f.tasks, row: (id) => (id === 'tsk_1' ? f.row : id === 'tsk_2' ? g : null), detail: async () => ({ workInPlace: false, lastSeq: 3 }) } });
  const x = await c2.register('tsk_1'), y = await c2.register('tsk_2');
  assert.notEqual(x.session, y.session);
});
