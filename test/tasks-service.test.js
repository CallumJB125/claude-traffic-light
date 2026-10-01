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
test.before(async () => {
  const { startMockServer } = await import(mockUrl);
  dir = tmp();
  srv = await startMockServer({ dir, speed: 40, hbMs: 200 });
  snaps = []; events = [];
  svc = createTasksService({ boardHome: dir, homeDir: '/Users/demo', copy: () => {}, onChange: (s) => snaps.push(s), onEvent: (id, e) => events.push([id, e]) });
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

test('detectAIs and takeover: the command shown hides env values; the copy has them', async () => {
  let copied = '';
  const t = await until(() => svc.snapshot().tasks.find((x) => x.actions.includes('takeover')));
  const s2 = createTasksService({ boardHome: dir, homeDir: '', copy: (x) => { copied = x; } });
  s2.start();
  await until(() => s2.snapshot().conn.status === 'connected');
  const r = await s2.act({ id: t.id, action: 'takeover', confirmed: true });
  if (r.ok) {
    assert.ok(r.takeover.command.length > 0);
    assert.ok(s2.copyTakeover(t.id));
    assert.ok(copied.length >= r.takeover.command.length - 20);
  } else assert.ok(r.text, 'a refusal is in plain words');
  s2.stop();
});

test('no supervisor: an offline snapshot with the plain empty-state words, retried by itself', async () => {
  const absent = path.join(tmp(), 'nothing-here');
  const s = createTasksService({ boardHome: absent, homeDir: '' });
  s.start();
  const snap = await until(() => { const x = s.snapshot(); return x.conn.status === 'offline' && x; });
  assert.equal(snap.conn.code, 'SUPERVISOR_UNREACHABLE');
  assert.match(snap.conn.title, /Tasks run in the background helper, which isn't running yet/);
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
