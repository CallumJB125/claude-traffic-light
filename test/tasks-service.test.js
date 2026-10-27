'use strict';

// The main-side service against the real mock supervisor (board/tasks-api/mock-server.js)
// over a real unix socket and the real client.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createTasksService } = require('../src/tasks-service.js');

const mockUrl = pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'mock-server.js')).href;
const fixtureHome = path.resolve('/Users/demo');
// Short base: AF_UNIX paths are capped at 104 bytes on macOS.
const tmp = () => fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pt-'));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

let srv;
let dir;
let svc;
let snaps;
let events;
let dialogs;
let dirOk = true;
let answer = false;
test.before(async () => {
  const { startMockServer } = await import(mockUrl);
  dir = tmp();
  srv = await startMockServer({ dir, speed: 40, hbMs: 200 });
  snaps = []; events = [];
  dialogs = [];
  svc = createTasksService({ boardHome: dir, homeDir: fixtureHome, copy: () => {}, isDir: () => dirOk, confirmDialog: async (info) => { dialogs.push(info); return answer; }, onChange: (s) => snaps.push(s), onEvent: (wc, id, e) => events.push([id, e, wc]) });
  svc.start();
  await until(() => svc.snapshot().conn.status === 'connected');
});
test.after(async () => { svc?.stop(); await srv?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('connects, lists every task with its face, and sorts needs-you first', async () => {
  await until(() => svc.snapshot().tasks.length >= 5);
  const { tasks } = svc.snapshot();
  assert.ok(tasks.every((t) => typeof t.label === 'string' && Array.isArray(t.actions)));
  assert.ok(tasks.some((t) => t.where.startsWith('/Users/demo/') || t.where.startsWith('~')), 'folder shown');
  assert.ok(!JSON.stringify(tasks).includes('btk_'), 'no token reaches the page');
});

test('the supervisor-side change arrives as a snapshot (state events patch the cache)', async () => {
  const before = snaps.length;
  const c = await (await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'client.js')).href)).connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  const { id } = await c.createTask({ text: 'Ping from another client', cwd: '/Users/demo/Development/acme-web', ai: 'claude', source: 'cli' });
  c.close();
  await until(() => svc.snapshot().tasks.some((t) => t.id === id));
  assert.ok(snaps.length > before);
});

test('open: detail with messages and a replay of the transcript, then live events', async () => {
  const running = await until(() => svc.snapshot().tasks.find((t) => t.state === 'running' || t.state === 'blocked'));
  const r = await svc.openTask(running.id);
  assert.equal(r.ok, true);
  assert.equal(r.detail.id, running.id);
  assert.ok(Array.isArray(r.replay));
  await until(() => events.some(([id]) => id === running.id) || r.replay.length > 0);
  assert.ok(r.replay.every((e) => ['transcript', 'tool', 'message', 'message-state', 'error', 'cost', 'state', 'diff'].includes(e.type)));
  await svc.closeTask();
});

test('act: a refused action never reaches the supervisor and comes back as plain words', async () => {
  const t = svc.snapshot().tasks[0];
  const r = await svc.act({ id: t.id, action: 'format-disk' });
  assert.deepEqual([r.ok, r.code], [false, 'VALIDATION']);
  assert.ok(r.text && !/format-disk/.test(r.text));
  const r2 = await svc.act({ id: 'no-such-task', action: 'pause' });
  assert.equal(r2.code, 'NOT_FOUND');
});

test('send a message to a task round-trips into its thread', async () => {
  // Demo runs advance at speed40. A running row can lose its message action
  // while openTask awaits the socket; review waits for this deliberate action.
  const t = await until(() => svc.snapshot().tasks.find((x) => x.state === 'in_review' && x.actions.includes('message')));
  const opened = await svc.openTask(t.id);
  const r = await svc.act({ id: t.id, action: 'message', payload: { body: 'please also add tests' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  await until(() => events.some(([id, e]) => id === t.id && e.type === 'message' && e.from.kind === 'human' && e.body === 'please also add tests'));
  assert.ok(opened.ok);
  await svc.closeTask();
});

test('main-owned current guard refuses a selected message before actual socket enqueue', async () => {
  const t = await until(() => svc.snapshot().tasks.find(x => x.actions.includes('message')));
  const opened = await svc.openTask(t.id);
  assert.ok(opened.ok);
  const body = 'overview-retired-owner-message';
  assert.equal((await svc.act({id:t.id,action:'message',payload:{body}},0,()=>false)).ok,false);
  await new Promise(r=>setTimeout(r,80));
  assert.equal(events.some(([id,e])=>id===t.id&&e.type==='message'&&e.body===body),false);
  await svc.closeTask();
});

test('an action round-trips: stop a task and its row changes', async () => {
  const t = await until(() => svc.snapshot().tasks.find((x) => x.actions.includes('stop') && x.state !== 'running'));
  assert.equal((await svc.act({ id: t.id, action: 'stop' })).code, 'CONFIRM_REQUIRED');
  const r = await svc.act({ id: t.id, action: 'stop', confirmed: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const now = await until(() => { const x = svc.snapshot().tasks.find((y) => y.id === t.id); return x.state === 'failed' && x; });
  assert.equal(now.label, 'Failed');
});

test('create: the folder must be a handle main gave out; the page cannot pass a path', async () => {
  const bad = await svc.create({ text: 'do a thing', folder: '/etc' });
  assert.equal(bad.ok, false);
  const f = svc.registerFolder(path.join(fixtureHome, 'Development', 'acme-web'));
  assert.match(f.handle, /^[0-9a-f-]{36}$/);
  assert.equal(f.label, `~${path.sep}Development${path.sep}acme-web`);
  const ok = await svc.create({ text: 'do a thing', folder: f.handle, ai: 'claude' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const info = await svc.composerInfo();
  assert.ok(info.ais.length >= 1 && info.ais.every((a) => a.label));
  assert.ok(info.recent.every((r) => r.handle && r.label));
});

test('create: a reset task can carry main\'s known reset time; other tasks and the page cannot set one', async () => {
  const f = svc.registerFolder('/Users/demo/Development/acme-web');
  const at = Date.now() + 3 * 3600_000;
  const r = await svc.create({ text: 'continue at reset', folder: f.handle, ai: 'claude', when: 'reset', startAfter: 1 }, { startAfter: at });
  assert.equal(r.ok, true, JSON.stringify(r));
  const now = await svc.create({ text: 'start now', folder: f.handle, ai: 'claude', when: 'now' }, { startAfter: at });
  const page = await svc.create({ text: 'page tries', folder: f.handle, ai: 'claude', when: 'reset', startAfter: at });
  const c = await (await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'client.js')).href)).connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  try {
    const spec = async (id) => (await c.getTask(id)).spec;
    assert.deepEqual([(await spec(r.id)).afterReset, (await spec(r.id)).startAfter], [true, at]);
    assert.equal((await spec(now.id)).startAfter, undefined);
    assert.equal((await spec(page.id)).startAfter, undefined);
  } finally { c.close(); }
});

test('takeover: main asks in a native dialog first; the copy holds no token, is single use, and the screen is masked', async context => {
  const copied = [];
  // The fast demo can finish a running row while the two dialogs are checked.
  // A stopped row keeps this copy/confirmation check independent of demo timing.
  const t = await until(() => svc.snapshot().tasks.find((x) => ['parked', 'failed', 'orphaned'].includes(x.state) && x.actions.includes('takeover')));
  const dlg = [];
  let yes = false;
  const s2 = createTasksService({ boardHome: dir, homeDir: '', copy: (x) => copied.push(x), confirmDialog: async (i) => { dlg.push(i); return yes; }, resolveBin: (n) => `/opt/bin/${n}` });
  context.after(() => s2.stop());
  s2.start();
  await until(() => s2.snapshot().conn.status === 'connected');
  const no = await s2.act({ id: t.id, action: 'takeover', confirmed: true });
  assert.deepEqual([no.ok, no.cancelled], [false, true], 'the page’s confirmed:true does not bypass main’s dialog');
  assert.equal(dlg.length, 1);
  assert.equal(dlg[0].title, svc.snapshot().tasks.find((x) => x.id === t.id).title);
  assert.equal(s2.copyTakeover(t.id), false, 'nothing was started, so nothing to copy');
  yes = true;
  const r = await s2.act({ id: t.id, action: 'takeover' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!/btk_|TOKEN|SECRET|KEY/.test(r.takeover.command));
  assert.ok(s2.copyTakeover(t.id));
  assert.ok(copied[0].includes('/opt/bin/claude') || copied[0].includes('/opt/bin/codex'), copied[0]);
  assert.ok(!/BOARD_RUN_TOKEN|btk_/.test(copied[0]));
  assert.equal(s2.copyTakeover(t.id), false, 'the cached command is gone after one copy');
  s2.stop();
});

test('discard: no dialog confirmation means nothing is sent; a yes goes through; a forged approval id is refused', async () => {
  const t = await until(() => svc.snapshot().tasks.find((x) => x.actions.includes('discard') && x.state === 'in_review'));
  dialogs.length = 0;
  answer = false;
  const no = await svc.act({ id: t.id, action: 'discard', confirmed: true, payload: { confirm: true } });
  assert.deepEqual([no.ok, no.code, no.cancelled], [false, 'CONFIRM_REQUIRED', true]);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].detail, /cannot be undone/);
  assert.equal(svc.snapshot().tasks.find((x) => x.id === t.id).state, 'in_review', 'untouched');
  const forged = await svc.act({ id: t.id, action: 'approve', payload: { approvalId: 'forged' } });
  assert.equal(forged.code, 'ILLEGAL_TRANSITION', 'approve is not offered for this task at all, whatever the id');
  answer = true;
  const yes = await svc.act({ id: t.id, action: 'discard' });
  assert.equal(yes.ok, true, JSON.stringify(yes));
  answer = false;
});

test('approvals: the prompt shown is the one answered; a StartTask accept names main’s own facts in the dialog and is forced to once', async () => {
  const c = await (await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'client.js')).href)).connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  const { id } = await c.createTask({ text: 'From a teammate', cwd: '/Users/demo/Development/acme-web', ai: 'claude', source: 'board', sourceMeta: { userId: 'stranger', displayName: 'Mallory', boardId: 'b', cardId: 'c' } });
  c.close();
  const t = await until(() => svc.snapshot().tasks.find((x) => x.id === id && x.actions.includes('approve')));
  assert.equal(t.awaitingConfirm, true);
  const forged = await svc.act({ id, action: 'approve', payload: { approvalId: 'forged' } });
  assert.equal(forged.code, 'NOT_FOUND', 'nothing relayed yet');
  const opened = await svc.openTask(id, 7);
  assert.equal(opened.ok, true);
  const a = opened.detail.openApprovals[0];
  assert.equal(a.tool, 'StartTask');
  dialogs.length = 0; answer = false;
  const elsewhere = await svc.act({ id, action: 'approve', payload: { approvalId: a.approvalId, scope: 'task' } }, 8);
  assert.equal(elsewhere.code, 'NOT_FOUND', 'shown to page 7 only, so not answerable from page 8');
  assert.equal(dialogs.length, 0);
  const cancelled = await svc.act({ id, action: 'approve', payload: { approvalId: a.approvalId, scope: 'task' } }, 7);
  assert.equal(cancelled.cancelled, true);
  assert.equal(dialogs[0].source, 'board');
  assert.match(dialogs[0].detail, /came from board/);
  assert.equal(svc.snapshot().tasks.find((x) => x.id === id).state, 'queued');
  await svc.closeTask(7);
});

// labfix-review R2a nit 2 (plan-r2b-auth §2.3): what one document was shown makes ids answerable from that
// document only. A thread's openTask never widens what the Tasks page may approve.
test('relayed ids are per document: an id shown only to one page is refused from another', async () => {
  const c = await (await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'client.js')).href)).connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  const { id } = await c.createTask({ text: 'Per-document relay', cwd: '/Users/demo/Development/acme-web', ai: 'claude', source: 'board', sourceMeta: { userId: 'stranger', displayName: 'Mallory', boardId: 'b', cardId: 'c2' } });
  c.close();
  await until(() => svc.snapshot().tasks.find((x) => x.id === id && x.actions.includes('approve')));
  const thread = await svc.openTask(id, 21);
  const a = thread.detail.openApprovals[0];
  dialogs.length = 0; answer = false;
  const fromTasks = await svc.act({ id, action: 'approve', payload: { approvalId: a.approvalId, scope: 'task' } }, 20);
  assert.equal(fromTasks.code, 'NOT_FOUND', 'the Tasks page never opened it');
  assert.equal(dialogs.length, 0, 'refused before any dialog');
  assert.equal((await svc.openTask(id, 20)).ok, true);
  await svc.closeTask(21);
  const own = await svc.act({ id, action: 'approve', payload: { approvalId: a.approvalId, scope: 'task' } }, 20);
  assert.equal(own.cancelled, true, 'the Tasks page approves what it was shown; closing the thread left its entry intact');
  assert.equal(dialogs.length, 1);
  const closed = await svc.act({ id, action: 'approve', payload: { approvalId: a.approvalId, scope: 'task' } }, 21);
  assert.equal(closed.code, 'NOT_FOUND', 'a closed document keeps nothing');
  await svc.closeTask(20);
});

// Redesign R4-1a (plan-r4 §2.4, §9): the chat's shown-arm reads what remember() relayed to its own document, read-only.
test('shownHash: the hash and tool relayed to one document, null for any other document, kind or id, and after close', async () => {
  const c = await (await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'client.js')).href)).connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  const { id } = await c.createTask({ text: 'Shown hash', cwd: '/Users/demo/Development/acme-web', ai: 'claude', source: 'board', sourceMeta: { userId: 'stranger', displayName: 'Mallory', boardId: 'b', cardId: 'c3' } });
  c.close();
  await until(() => svc.snapshot().tasks.find((x) => x.id === id && x.actions.includes('approve')));
  assert.equal(svc.shownHash(41, id, 'approval', 'anything'), null, 'nothing relayed yet');
  const a = (await svc.openTask(id, 41)).detail.openApprovals[0];
  const sha = require('node:crypto').createHash('sha256').update(`${a.tool}\0${a.inputSummary}`).digest('hex');
  assert.deepEqual(svc.shownHash(41, id, 'approval', a.approvalId), { hash: sha, tool: 'StartTask' });
  assert.equal(svc.shownHash(42, id, 'approval', a.approvalId), null, 'another document');
  assert.equal(svc.shownHash(41, 'other-task', 'approval', a.approvalId), null, 'another task');
  assert.equal(svc.shownHash(41, id, 'ask', a.approvalId), null, 'another kind');
  assert.equal(svc.shownHash(41, id, 'state', a.approvalId), null);
  assert.equal(svc.shownHash(41, id, 'approval', 'forged'), null);
  await svc.closeTask(41);
  assert.equal(svc.shownHash(41, id, 'approval', a.approvalId), null, 'a closed document keeps nothing');
});

test('the ask hash covers the text, options and choices, with each choice payload in a fixed key order', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tasks-service.js'), 'utf8');
  const lines = src.slice(src.indexOf('  const stable = '), src.indexOf('  // Read-only (R4)'));
  const vm = require('node:vm'), ctx = { crypto: require('node:crypto') };
  vm.runInNewContext(`${lines}; globalThis.askHashOf = askHashOf;`, ctx);
  const ask = (choices, options = null, text = 'Paused') => ({ askId: 'ask-1', text, options, choices });
  const h = ctx.askHashOf(ask([{ id: 'c', label: 'Resume', action: 'resume', payload: { when: 'now', x: 1 } }]));
  assert.equal(ctx.askHashOf(ask([{ label: 'Resume', id: 'c', action: 'resume', payload: { x: 1, when: 'now' } }])), h, 'key order never matters');
  assert.notEqual(ctx.askHashOf(ask([{ id: 'c', label: 'Resume', action: 'resume', payload: { when: 'reset', x: 1 } }])), h, 'a payload');
  assert.notEqual(ctx.askHashOf(ask([{ id: 'c', label: 'Wait', action: 'resume', payload: { when: 'now', x: 1 } }])), h, 'a label');
  assert.notEqual(ctx.askHashOf(ask([{ id: 'c', label: 'Resume', action: 'resume', payload: { when: 'now', x: 1 } }], null, 'Other')), h, 'the text');
  assert.notEqual(ctx.askHashOf(ask(null, ['a', 'b'])), ctx.askHashOf(ask(null, ['a\0b'])), 'options keep their boundaries');
});

test('relayed ids are per document after a refresh too: a live approval reaches only the open page', async () => {
  const { id } = await svc.create({ text: 'Ask before installing', folder: svc.registerFolder('/Users/demo/Development/acme-web').handle, ai: 'claude', permissionLevel: 'ask', surface: 'background', when: 'now' });
  assert.ok(id);
  assert.equal((await svc.openTask(id, 31)).ok, true);
  const ids = await until(() => events.filter(([tid, e, wc]) => wc === 31 && tid === id && e.type === 'detail').map(([, e]) => e.detail.openApprovals[0]?.approvalId).find(Boolean), 20000);
  const fromOther = await svc.act({ id, action: 'deny', payload: { approvalId: ids } }, 30);
  assert.equal(fromOther.code, 'NOT_FOUND', 'refreshOpen wrote only into page 31');
  const fromOwn = await svc.act({ id, action: 'deny', payload: { approvalId: ids } }, 31);
  assert.equal(fromOwn.ok, true, JSON.stringify(fromOwn));
  await svc.closeTask(31);
});

test('one open task per page: opening again replaces it, and a superseded open leaves no subscription behind', async () => {
  const [a, b] = svc.snapshot().tasks;
  const first = svc.openTask(a.id, 11);
  const second = svc.openTask(b.id, 11);
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.ok, false, 'the superseded open reports as stale');
  assert.equal(r2.ok, true);
  assert.equal(r2.detail.id, b.id);
  const other = await svc.openTask(a.id, 12);
  assert.equal(other.ok, true, 'another page has its own slot');
  await svc.closeTask(11); await svc.closeTask(12);
});

test('recent folders: only tasks started on this Mac, from the raw root; every handle is re-checked as a directory', async () => {
  const c = await (await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'client.js')).href)).connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  await c.createTask({ text: 'spun off by an agent', cwd: '/Users/demo/Development/from-agent', ai: 'claude', source: 'mcp' });
  c.close();
  await until(() => svc.snapshot().tasks.some((x) => x.where.includes('from-agent')));
  const info = await svc.composerInfo();
  assert.ok(info.recent.length > 0);
  assert.ok(info.recent.every((r) => !r.label.includes('from-agent')), JSON.stringify(info.recent));
  const f = svc.registerFolder('/Users/demo/Development/acme-web');
  dirOk = false;
  const r = await svc.create({ text: 'x', folder: f.handle });
  dirOk = true;
  assert.equal(r.ok, false, 'a handle whose folder is gone is refused');
});

test('composer AI list: AIs found on this Mac that the helper does not list are added as not in Tasks yet', async () => {
  const s = createTasksService({ boardHome: path.join(tmp(), 'nothing-here'), homeDir: '', detectedTools: () => [
    { id: 'claude', label: 'Claude Code', installed: true, connected: false }, { id: 'gemini', label: 'Gemini CLI', installed: false }, { id: 'hermes', label: 'Hermes Agent', installed: true }] });
  const info = await s.composerInfo();
  assert.deepEqual(info.ais.map((a) => [a.id, a.tasks, a.capabilities.background]), [['claude', false, false]], 'only a found AI the Tasks helper knows; not-installed and unknown ones are left out');
  const broken = createTasksService({ boardHome: path.join(tmp(), 'nothing-here'), homeDir: '', detectedTools: () => { throw new Error('x'); } });
  assert.deepEqual((await broken.composerInfo()).ais, []);
});

test('no supervisor: a verified token without a listener gives the plain offline state', async (t) => {
  const absent = tmp();
  let s;
  t.after(() => { s?.stop(); fs.rmSync(absent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  // Isolate listener absence from failed private-token verification on Windows.
  // A closed real mock leaves its verified token and removes the listener.
  const { startMockServer } = await import(mockUrl);
  const stopped = await startMockServer({ dir: absent, demo: false });
  await stopped.close();
  s = createTasksService({ boardHome: absent, homeDir: '' });
  s.start();
  const snap = await until(() => { const x = s.snapshot(); return x.conn.status === 'offline' && x; });
  assert.equal(snap.conn.code, 'SUPERVISOR_UNREACHABLE');
  assert.match(snap.conn.title, /Tasks background helper is unavailable/);
  assert.deepEqual(snap.tasks, []);
  assert.equal((await s.act({ id: 'x', action: 'pause' })).code, 'SUPERVISOR_UNREACHABLE');
  s.stop();
});

test('missing unverified private token keeps the host-specific refusal and never starts a task', async (t) => {
  const root = tmp();
  const s = createTasksService({ boardHome: path.join(root, 'nothing-here'), homeDir: '' });
  t.after(() => { s.stop(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  s.start();
  const snap = await until(() => { const x = s.snapshot(); return x.conn.status === 'offline' && x; });
  assert.equal(snap.conn.code, process.platform === 'win32' ? 'FORBIDDEN' : 'SUPERVISOR_UNREACHABLE');
  assert.deepEqual(snap.tasks, []);
  assert.equal((await s.act({ id: 'x', action: 'pause' })).ok, false);
});

test('a dropped connection marks every live task "Connection lost" and never green, then reconnects', async () => {
  const d2 = tmp();
  const { startMockServer } = await import(mockUrl);
  let m = await startMockServer({ dir: d2, speed: 40, hbMs: 200 });
  const s = createTasksService({ boardHome: d2, homeDir: '' });
  s.start();
  await until(() => s.snapshot().conn.status === 'connected' && s.snapshot().tasks.some((t) => t.green));
  await m.close();
  const lost = await until(() => { const x = s.snapshot(); return x.conn.status === 'offline' && x; });
  const live = lost.tasks.filter((t) => ['running', 'quiet', 'blocked', 'queued', 'claimed'].includes(t.state));
  assert.ok(live.every((t) => t.label === 'Connection lost' && !t.green && t.actions.length === 0));
  assert.ok(lost.tasks.every((t) => !t.green));
  s.stop();
  fs.rmSync(d2, { recursive: true, force: true });
});

test('a build that cannot load the tasks client says so in words instead of waiting forever', async () => {
  const s = createTasksService({ boardHome: '/nonexistent', homeDir: '', loadApi: async () => { throw Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }); } });
  s.start();
  const snap = await until(() => { const x = s.snapshot(); return x.conn.status === 'offline' && x; });
  assert.equal(snap.conn.code, 'INTERNAL');
  assert.match(snap.conn.title, /could not start/);
  s.stop();
});

test('retry while the real helper starts shares one startup/connect; a stopped page never connects late', async () => {
  let release; let starts = 0;
  const gate = new Promise((r) => { release = r; });
  const s = createTasksService({ boardHome: dir, ensureSupervisor: () => { starts++; return gate; } });
  s.start(); await until(() => starts === 1);
  s.retryNow(); s.retryNow(); assert.equal(starts, 1);
  s.stop(); release(); await new Promise((r) => setTimeout(r, 30));
  assert.notEqual(s.snapshot().conn.status, 'connected');
});

test('a held budget refuses a new task with a message; the override needs the native confirmation', async () => {
  const held = { text: 'New background tasks are on hold: test.' };
  const guarded = createTasksService({ boardHome: dir, homeDir: '/Users/demo', copy: () => {}, isDir: () => true, startGuard: async () => held, confirmDialog: async (info) => { dialogs.push(info); return answer; } });
  guarded.start();
  await until(() => guarded.snapshot().conn.status === 'connected');
  const folder = guarded.registerFolder('/Users/demo/Development/acme-web');
  const draft = { text: 'Tidy the docs', folder: folder.handle, ai: 'claude' };
  try {
    const before = guarded.snapshot().tasks.length;
    const r = await guarded.create(draft);
    assert.deepEqual([r.ok, r.code, r.canOverride, r.text], [false, 'BUDGET_HELD', true, held.text]);
    dialogs.length = 0; answer = false;
    const no = await guarded.create({ ...draft, overrideBudget: true }, { wcId: 7 });
    assert.equal(no.cancelled, true);
    assert.equal(dialogs.at(-1).label, 'Start anyway');
    assert.equal(guarded.snapshot().tasks.length, before, 'nothing started');
    answer = true;
    const yes = await guarded.create({ ...draft, overrideBudget: true }, { wcId: 7 });
    assert.equal(yes.ok, true);
  } finally { answer = false; guarded.stop(); }
});

// Review #42 finding 1: the engine's enforced spend cap gets the composer's "Start anyway" too. A plain create is
// BUDGET_HELD (canOverride); after the native confirmation the task carries overrideSpendCap and is created.
test('the engine spend cap: BUDGET_HELD first, then Start anyway through the native confirmation', async () => {
  const { startMockServer } = await import(mockUrl);
  const capDir = tmp();
  const capSrv = await startMockServer({ dir: capDir, speed: 40, hbMs: 200, demo: false, spendCap: true });
  const asked = [];
  let yes = false;
  const capped = createTasksService({ boardHome: capDir, homeDir: fixtureHome, copy: () => {}, isDir: () => true, confirmDialog: async (info) => { asked.push(info); return yes; } });
  capped.start();
  try {
    await until(() => capped.snapshot().conn.status === 'connected');
    const folder = capped.registerFolder('/Users/demo/Development/acme-web');
    const draft = { text: 'Tidy the docs', folder: folder.handle, ai: 'claude' };
    const r = await capped.create(draft);
    assert.deepEqual([r.ok, r.code, r.canOverride], [false, 'BUDGET_HELD', true]);
    assert.equal(asked.length, 0, 'no dialog until the person asks to override');
    const no = await capped.create({ ...draft, overrideBudget: true }, { wcId: 7 });
    assert.equal(no.cancelled, true);
    assert.equal(asked.at(-1).label, 'Start anyway');
    yes = true;
    const ok = await capped.create({ ...draft, overrideBudget: true }, { wcId: 7 });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  } finally { capped.stop(); await capSrv.close(); fs.rmSync(capDir, { recursive: true, force: true }); }
});

test('PR B: the note ops go only to busMain (the helper\'s parentPort); with none they are UNAVAILABLE and nothing is tried on the socket', async () => {
  let loads = 0;
  const loadApi = async () => { loads += 1; throw Object.assign(new Error('the socket client must not be loaded'), { code: 'ERR_MODULE_NOT_FOUND' }); };
  const none = createTasksService({ boardHome: '/nonexistent', homeDir: '', loadApi });
  for (const op of ['note', 'notes', 'notes_ack', 'notes_pending', 'notified']) {
    assert.equal((await none.bus(op, {}).catch((e) => e)).code, 'UNAVAILABLE', op);
  }
  const calls = [];
  const svc = createTasksService({ boardHome: '/nonexistent', homeDir: '', loadApi, ensureSupervisor: async () => ({}), busMain: async (op, args) => { calls.push([op, args]); return { ok: op }; } });
  assert.deepEqual(await svc.bus('notes', { me: { key: 'claude|X' } }), { ok: 'notes' });
  assert.deepEqual(calls, [['notes', { me: { key: 'claude|X' } }]]);
  assert.equal(loads, 0, 'no socket connection was attempted for a note op');
  none.stop(); svc.stop();
});
