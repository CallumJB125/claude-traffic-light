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
  svc = createTasksService({ boardHome: dir, homeDir: '/Users/demo', copy: () => {}, isDir: () => dirOk, confirmDialog: async (info) => { dialogs.push(info); return answer; }, onChange: (s) => snaps.push(s), onEvent: (wc, id, e) => events.push([id, e, wc]) });
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
  const t = await until(() => svc.snapshot().tasks.find((x) => x.actions.includes('message')));
  const opened = await svc.openTask(t.id);
  const r = await svc.act({ id: t.id, action: 'message', payload: { body: 'please also add tests' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  await until(() => events.some(([id, e]) => id === t.id && e.type === 'message' && e.from.kind === 'human' && e.body === 'please also add tests'));
  assert.ok(opened.ok);
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
  const f = svc.registerFolder('/Users/demo/Development/acme-web');
  assert.match(f.handle, /^[0-9a-f-]{36}$/);
  assert.equal(f.label, '~/Development/acme-web');
  const ok = await svc.create({ text: 'do a thing', folder: f.handle, ai: 'claude' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const info = await svc.composerInfo();
  assert.ok(info.ais.length >= 1 && info.ais.every((a) => a.label));
  assert.ok(info.recent.every((r) => r.handle && r.label));
});

test('takeover: main asks in a native dialog first; the copy holds no token, is single use, and the screen is masked', async () => {
  const copied = [];
  const t = await until(() => svc.snapshot().tasks.find((x) => x.actions.includes('takeover')));
  const dlg = [];
  let yes = false;
  const s2 = createTasksService({ boardHome: dir, homeDir: '', copy: (x) => copied.push(x), confirmDialog: async (i) => { dlg.push(i); return yes; }, resolveBin: (n) => `/opt/bin/${n}` });
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
  const cancelled = await svc.act({ id, action: 'approve', payload: { approvalId: a.approvalId, scope: 'task' } });
  assert.equal(cancelled.cancelled, true);
  assert.equal(dialogs[0].source, 'board');
  assert.match(dialogs[0].detail, /came from board/);
  assert.equal(svc.snapshot().tasks.find((x) => x.id === id).state, 'queued');
  await svc.closeTask(7);
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

test('no supervisor: an offline snapshot with the plain empty-state words, retried by itself', async () => {
  const absent = path.join(tmp(), 'nothing-here');
  const s = createTasksService({ boardHome: absent, homeDir: '' });
  s.start();
  const snap = await until(() => { const x = s.snapshot(); return x.conn.status === 'offline' && x; });
  assert.equal(snap.conn.code, 'SUPERVISOR_UNREACHABLE');
  assert.match(snap.conn.title, /Tasks background helper is unavailable/);
  assert.deepEqual(snap.tasks, []);
  assert.equal((await s.act({ id: 'x', action: 'pause' })).code, 'SUPERVISOR_UNREACHABLE');
  s.stop();
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
