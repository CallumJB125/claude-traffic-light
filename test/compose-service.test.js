'use strict';
// Home's task box against the real mock supervisor over a real socket (board/tasks-api/mock-server.js and its real
// router): routing that changes between the line and Run is refused with 0 tasks, and a tie runs exactly the pick.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createTasksService } = require('../src/tasks-service.js');

const mockUrl = pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'mock-server.js')).href;
const tmp = () => fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pc-'));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

let srv, dir, svc, opts, folder, direct;
const window = { resetsAt: Date.now() + 3600e3, status: 'allowed' };
test.before(async () => {
  const { startMockServer } = await import(mockUrl);
  dir = tmp();
  opts = { dir, speed: 40, hbMs: 200 };
  srv = await startMockServer(opts);
  svc = createTasksService({ boardHome: dir, homeDir: '/Users/demo', copy: () => {}, isDir: async () => true, confirmDialog: async () => false });
  svc.start();
  await until(() => svc.snapshot().conn.status === 'connected');
  folder = svc.registerFolder('/Users/demo/Development/acme-web').handle;
  direct = await (await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'client.js')).href)).connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
});
test.after(async () => { direct?.close(); svc?.stop(); await srv?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// Counted straight from the supervisor, never from the service's cache.
const count = async () => (await direct.listTasks({})).length;
const req = (text, ai = 'auto') => ({ text, folder, ai, permissionLevel: 'auto-edits' });

test('route: read-only, and names the AI and the reason', async () => {
  const before = await count();
  const r = await svc.route(req('refactor the parser'));
  assert.equal(r.ok, true);
  assert.equal(r.route.decision, 'run');
  assert.equal(r.route.ai, 'claude');
  assert.equal(typeof r.route.reason, 'string');
  assert.equal(await count(), before, 'routing creates nothing');
  assert.equal((await svc.route({ ...req('x'), cwd: '/etc' })).code, 'VALIDATION', 'no extra keys, no paths');
});

test('routing changed between the line and Run: CONFLICT and no task', async () => {
  const shown = await svc.route(req('refactor the parser'));
  assert.equal(shown.route.ai, 'claude');
  opts.routeRules = [{ ai: 'codex', keywords: ['refactor'] }];
  const before = await count();
  const r = await svc.create({ ...req('refactor the parser'), expectAi: shown.route.ai, surface: 'background', when: 'now', requestId: 'compose-conflict-1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFLICT');
  assert.equal(await count(), before);
  opts.routeRules = [];
});

test('a tie: Run without a pick is refused; the pick runs exactly one task on that AI', async () => {
  opts.defaultAi = null;
  opts.routeUsage = { claude: { utilization: 0.4, ...window }, codex: { utilization: 0.4, ...window } };
  const shown = await svc.route(req('tidy the readme'));
  assert.equal(shown.route.decision, 'ask');
  assert.deepEqual(shown.route.alternatives.slice(0, 2).map((a) => a.ai).sort(), ['claude', 'codex']);
  const before = await count();
  const none = await svc.create({ ...req('tidy the readme'), surface: 'background', when: 'now', requestId: 'compose-tie-none' });
  assert.equal(none.code, 'CONFIRM_REQUIRED');
  assert.equal(await count(), before);
  const r = await svc.create({ ...req('tidy the readme'), expectAi: 'codex', surface: 'background', when: 'now', requestId: 'compose-tie-codex' });
  assert.equal(r.ok, true);
  const tasks = await direct.listTasks({});
  assert.equal(tasks.length, before + 1, 'exactly one task');
  assert.equal(tasks.find((t) => t.id === r.id).ai.id, 'codex');
  opts.defaultAi = undefined; opts.routeUsage = undefined;
});
