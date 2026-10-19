'use strict';

// A3 wiring: burst-ipc feeds statusView the last good detection and the console
// result, so gateway_stale and console_down really show, and console_down's
// action is one that can land while the console is down (Terminal repair).
const test = require('node:test');
const assert = require('node:assert/strict');
const Ipc = require('../src/burst-ipc.js');

const caps = (over = {}) => ({ state: true, usage: true, upgradeStatus: true, handoverAudit: true, handoverFile: true, testConnection: true, looseEnds: false, keepAwake: false, mods: false, finder: false, handoffTaken: false, consoleRepair: false, intelligentCompaction: false, codex: false, ...over });
const state = (over = {}) => ({ version: '0.20.36', mode: 'base-url', active: true, route: 'PRIMARY', rejected: [], primaryFailures: 0, compaction: { pauseless: { enabled: false, mode: 'fixed' }, sessions: [], active: false }, contextFill: [], secondaryReady: true, caTrusted: true, hostsEntry: true, ...over });
const present = (over = {}) => ({ kind: 'present', installed: true, pid: 1, upgrade: null, capabilities: caps(over.capabilities), state: state(over.state) });

function harness({ detects, console: con = () => ({ kind: 'present' }) }) {
  const handlers = {};
  const consoleCalls = [];
  const client = { detect: async () => (detects.length > 1 ? detects.shift() : detects[0]), adminUrl: () => 'http://127.0.0.1:7788', consoleDetect: async () => { consoleCalls.push(1); return con(); }, requests: async () => [] };
  const api = Ipc.register({ utilityHandle: (c, a, f) => { handlers[c] = (e, ...x) => (a(e) ? f(e, ...x) : null); }, settingsOnly: () => true, optimiserAllowed: () => true, isMac: true, client, dialog: {}, shell: {}, scriptDir: '/x', log: () => {} });
  return { api, handlers, consoleCalls };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('gateway_stale: after a present detection, an unreachable one shows the last known state dimmed, with Repair', async () => {
  const h = harness({ detects: [present({ state: { mode: 'transparent', version: '0.20.36' } }), { kind: 'unreachable', installed: true }] });
  await h.api.refresh(true);
  assert.equal(h.api.status().kind, 'on');
  await h.api.refresh(true);
  const v = h.api.status();
  assert.equal(v.kind, 'gateway_stale');
  assert.equal(v.dimmed, true);
  assert.equal(v.version, '0.20.36'); assert.equal(v.mode, 'transparent'); assert.equal(v.active, true);
  assert.match(v.detail, /last known state from \d+ s ago: on, transparent mode, version 0\.20\.36/);
  assert.deepEqual(v.action, { kind: 'repair', label: 'Repair' });
  const s = await h.handlers['burst:status']({});
  assert.equal(s.ok, true); assert.equal(s.kind, 'gateway_stale');
});

test('without a good detection first, unreachable stays the plain "Not responding" copy (nothing to dim)', async () => {
  const h = harness({ detects: [{ kind: 'unreachable', installed: true }] });
  await h.api.refresh(true);
  assert.equal(h.api.status().kind, 'off');
  assert.equal(h.api.status().dimmed, false);
});

test('console_down: a 0.20 Burst whose console is unreachable shows it, with Terminal repair as the one action that can land', async () => {
  const h = harness({ detects: [present({ capabilities: { consoleRepair: true } })], console: () => ({ kind: 'unreachable' }) });
  await h.api.refresh(true);
  assert.equal(h.api.status().kind, 'on', 'the console is read in the background; the first view is from the gateway alone');
  await tick();
  await h.api.refresh(true);
  const v = h.api.status();
  assert.equal(v.kind, 'console_down');
  assert.deepEqual(v.action, { kind: 'repair', label: 'Start console' });
  assert.ok(!v.actions.some((a) => a.kind === 'console-restart'), 'the console POST cannot land while the console is down');
  assert.deepEqual(v.actions.find((a) => a.kind === 'repair'), { kind: 'repair', label: 'Start console', primary: true });
  assert.equal(h.consoleCalls.length, 1, 'one console read, cached, not one per refresh');
  // Health reads the same cache.
  assert.deepEqual(h.api.healthFacts().console, { kind: 'unreachable' });
});

test('a 0.19 Burst (no console repair capability) is never shown console_down, and its console is never read for the card', async () => {
  const h = harness({ detects: [present({ capabilities: { consoleRepair: false }, state: { version: '0.19.0' } })], console: () => ({ kind: 'unreachable' }) });
  await h.api.refresh(true);
  await tick();
  await h.api.refresh(true);
  assert.equal(h.api.status().kind, 'on');
  assert.equal(h.consoleCalls.length, 0);
});

test('console answering, or switched off in config, leaves the card on', async () => {
  for (const kind of ['present', 'off']) {
    const h = harness({ detects: [present({ capabilities: { consoleRepair: true } })], console: () => ({ kind }) });
    await h.api.refresh(true); await tick(); await h.api.refresh(true);
    assert.equal(h.api.status().kind, 'on', kind);
  }
});
