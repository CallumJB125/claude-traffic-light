'use strict';
// src/agent-bus-main.js: Preferences → the bus context main pushes, the owner
// defaults (caps off, wall clock 20 min on, no PR), the tray's stop/resume, and
// that opening Sessions never starts the Tasks helper.
const test = require('node:test');
const assert = require('node:assert/strict');
const { register, normalize, contextOf } = require('../src/agent-bus-main.js');

test('defaults: on, auto-accept, caps off, 20 minute wall clock; context carries allow_pr false', () => {
  assert.deepEqual(normalize(undefined), { enabled: true, autoAccept: true, repos: [], wallClockMin: 20, caps: { enabled: false, memberUsd: 20, handoffUsd: 5 } });
  const c = contextOf({ repos: [' /a ', '', 7], wallClockMin: 9999, caps: { enabled: true, memberUsd: -1 } }, ['/f']);
  assert.deepEqual(c.repos, ['/a']);
  assert.deepEqual(c.folders, ['/f']);
  assert.equal(c.settings.wall_clock_min, 1440);
  assert.equal(c.settings.allow_pr, false);
  assert.deepEqual(c.settings.caps, { enabled: true, member_usd: 0, handoff_usd: 5 });
});

test('tray: Stop then Resume; Sessions list does not start the helper; only the Sessions page may ask', async () => {
  const handlers = {}, calls = [];
  let started = false, changed = 0;
  const m = register({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, sessionsAllowed: (e) => e === 'ok', started: () => started,
    config: () => ({ agentBus: {} }), onChange: () => changed++,
    tasks: () => ({ bus: async (op) => { calls.push(op); return op === 'halt' ? { ok: true, halted: true } : op === 'resume' ? { ok: true, halted: false } : { events: [], halted: false }; } }) });
  assert.deepEqual(await handlers['bus:list']('ok'), { available: false, reason: 'tasks_helper_unavailable' });
  assert.equal(await handlers['bus:list']('evil'), null);
  assert.deepEqual(calls, [], 'no helper start from opening Sessions');
  assert.deepEqual(m.trayItems(), [], 'the default tray has no bus item until an AI hands off');
  await m.relay('handoff', {}, null);
  assert.equal(changed, 1);
  assert.equal(m.trayItems()[0].label, 'Stop agent bus');
  m.trayItems()[0].click();
  await new Promise((r) => setImmediate(r));
  assert.equal(m.trayItems()[0].label, 'Resume agent bus');
  assert.equal(changed, 2);
  started = true;
  await handlers['bus:list']('ok');
  assert.deepEqual(calls, ['handoff', 'halt', 'list']);
  m.sync();
  assert.equal(calls.at(-1), 'busSetContext');
  assert.deepEqual(register({ ipcMain: { handle() {} }, sessionsAllowed: () => true, tasks: () => ({}), config: () => ({ agentBus: { enabled: false } }) }).trayItems(), []);
});

test('tray after a restart while halted: once the helper is up it reads the state and offers Resume', async () => {
  const calls = [];
  let changed = 0;
  const m = register({ ipcMain: { handle() {} }, sessionsAllowed: () => true, started: () => true, config: () => ({ agentBus: {} }), onChange: () => changed++,
    tasks: () => ({ bus: async (op) => { calls.push(op); return { halted: true, enabled: true, head: 3 }; } }) });
  assert.deepEqual(m.trayItems(), []);
  await m.refresh();
  assert.deepEqual(calls, ['status']);
  assert.equal(changed, 1);
  assert.equal(m.trayItems()[0].label, 'Resume agent bus');
});
