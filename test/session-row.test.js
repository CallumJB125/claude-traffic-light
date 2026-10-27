'use strict';
// PR 0s: the one row view model matches the Sessions & agents page for fixture
// sessions (plan-agent-terminal §R2.13 PR 0s tests; plan-pr0s §3.2, §6 ruling 1),
// and the chat-first sidebar's payload is frozen for R2's projection (§8 Q5).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { service, TASKS } = require('./fixtures/session-rows');
const { sessionRow, KEYS } = require('../src/session-row');
const { sidebarRows } = require('../src/overview-sidebar-rows');

const GOLDEN = path.join(__dirname, 'fixtures/sidebar-rows-golden.json');

async function built() {
  // One instance: overview ids are salted per service instance.
  const svc = service();
  const out = await svc.passiveRows(() => true);
  const page = await svc.snapshot();
  const taskOf = (dto) => (dto.label === 'Managed task' ? TASKS.find((t) => t.title === dto.task?.title) ?? null : null);
  const vms = out.rows.map((dto) => sessionRow(dto, { origin: out.origins.get(dto.id) ?? null, task: taskOf(dto) }));
  return { out, page, vms };
}

test('the row model matches the Sessions & agents page for fixture sessions', async () => {
  const { page, vms } = await built();
  assert.equal(page.sessions.length, 12);
  assert.equal(vms.length, page.sessions.length);
  for (const vm of vms) {
    const dto = page.sessions.find((r) => r.id === vm.id);
    assert.ok(dto, `the page has row ${vm.id}`);
    assert.equal(vm.bucket, dto.bucket, `${dto.task?.title}: bucket`);
    assert.equal(vm.status, dto.status, `${dto.task?.title}: status`);
    assert.equal(vm.age_ms, dto.age_ms === null ? null : Math.round(dto.age_ms));
    assert.equal(vm.team, dto.board?.kind === 'team');
  }
  // Every bucket the page uses appears here, so the parity is not vacuous.
  assert.deepEqual([...new Set(vms.map((v) => v.bucket))].sort(), ['check', 'idle', 'needs', 'working']);
});

test('the row model\'s title, project and host agree with the chat-first sidebar for the same rows', async () => {
  const { out, vms } = await built();
  const side = sidebarRows(out).sessions;
  assert.equal(side.length, vms.length);
  for (const s of side) {
    const vm = vms.find((v) => v.id === s.id);
    assert.equal(vm.title, s.title);
    assert.equal(vm.project, s.project);
    assert.equal(vm.hostApp, s.origin);
    assert.equal(vm.bucket, s.bucket);
  }
});

test('managed rows carry cost, branch, chatState and openInTerminal; others carry none', async () => {
  const { vms } = await built();
  const by = (title) => vms.find((v) => v.title === title);
  assert.deepEqual(by('Add a cache').cost, { usd: 0.42, budgetUsd: null });
  assert.equal(by('Add a cache').branch, 'plexiform/aaaaaaaa-0000-4000-8000-000000000001');
  assert.equal(by('Add a cache').chatState, 'working');
  assert.deepEqual(by('Add a cache').openInTerminal, { available: true, code: null, reason: null });
  assert.equal(by('Review me').chatState, 'review', 'no diff count: today\'s behaviour');
  assert.equal(by('Review me').bucket, 'check', 'the bucket is the page\'s (ruling 1)');
  assert.equal(by('Needs an answer').chatState, 'needs-you');
  assert.equal(by('In my terminal').chatState, 'in-terminal');
  assert.deepEqual(by('Budgeted').openInTerminal, { available: false, code: 'CANT_OPEN', reason: 'budgeted' });
  const reported = by('Fix the login page');
  assert.equal(reported.chatState, null);
  assert.equal(reported.cost, null);
  assert.equal(reported.branch, null);
  assert.equal(reported.hostApp, 'iTerm');
  assert.equal(reported.openInTerminal.reason, 'no-task');
  for (const vm of vms) {
    assert.deepEqual(Object.keys(vm), [...KEYS]);
    assert.ok(Object.isFrozen(vm));
    assert.doesNotMatch(JSON.stringify(vm), /\/Users\/|private\/|s-iterm|cwd/, 'no paths or native ids');
  }
});

test('sessionRow: the diff count, approvals and a SessionRef, when main supplies them', async () => {
  const { out } = await built();
  const dto = out.rows.find((r) => r.task?.title === 'Review me');
  const task = TASKS.find((t) => t.title === 'Review me');
  assert.equal(sessionRow(dto, { task, diffFiles: 0 }).chatState, 'your-turn');
  assert.equal(sessionRow(dto, { task, diffFiles: 0 }).bucket, 'check', 'chatState never moves a row between buckets in PR 0s');
  assert.deepEqual(sessionRow(dto, { approvals: { count: 2, kind: 'permission' } }).approvals, { count: 2, kind: 'permission' });
  for (const bad of [{ count: 0, kind: 'permission' }, { count: 1, kind: 'plan' }, 'x']) assert.equal(sessionRow(dto, { approvals: bad }).approvals, null);
  const vm = sessionRow(dto, { task, ref: { provider: 'claude', sessionId: 's-1', taskId: 'tsk_0123456789ab', origin: 'chat', driver: 'chat' } });
  assert.equal(vm.ref.driver, 'chat');
  assert.throws(() => sessionRow(dto, { ref: { provider: 'claude', sessionId: 's-1', origin: 'external', driver: 'chat' } }), { code: 'VALIDATION' });
  assert.equal(sessionRow({ id: 'nope' }), null);
});

test('frozen sidebar payload (generated from main before PR 0s): R2\'s projection must keep it', async () => {
  const { out } = await built();
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const now = sidebarRows(out);
  // Ids are salted per overview-service instance, so the golden holds a placeholder.
  assert.ok(now.sessions.every((s) => /^[0-9a-f]{64}$/.test(s.id)));
  assert.deepEqual({ ...now, sessions: now.sessions.map((s) => ({ ...s, id: '<per-instance id>' })) }, golden);
  const titles = golden.sessions.map((s) => s.title);
  assert.ok(golden.sessions.some((s) => s.team === true), 'a team row');
  assert.ok(golden.sessions.some((s) => s.title === 'Remote work' && s.terminal === false && s.origin === null), 'a paired-device row');
  assert.ok(titles.includes('Codex session'), 'a NO_PROJECT row');
  assert.ok(golden.sessions.some((s) => s.project === 'delta' && s.title !== '/Users/someone/private/delta/notes.md'), 'a path-like title is not shown');
});
