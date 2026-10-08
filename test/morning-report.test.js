'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MR = require('../src/morning-report.js');
const KeepAwake = require('../src/keep-awake.js');
const Home = require('../src/home-main.js');

const NOW = 1_800_000_000_000;
const task = (o) => ({ id: 'tsk_000000000001', title: 'Fix login', state: 'in_review', stateSince: NOW - 3600_000, branch: 'buddy/fix', workInPlace: false, cost: { usd: 0.5 },
  evidence: { commits: 3, diffStat: { files: 4, added: 20, removed: 5 }, costUsd: 1.25, tests: 'pass', summary: 'Done.' }, pr: { url: 'https://example.invalid/pr/1' }, openAsk: null, openApprovals: [], ...o });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));

test('report lists branch, commits, diffstat, cost, PR and open asks for tasks finished since last view', () => {
  const r = MR.build([task({}), task({ id: 'tsk_000000000002', title: 'Old', stateSince: NOW - 10 * 3600_000 }), task({ id: 'tsk_000000000003', title: 'Asks', state: 'blocked', openAsk: { text: 'Which db?' }, evidence: null })], NOW - 2 * 3600_000);
  assert.equal(r.count, 1);
  assert.deepEqual({ ...r.items[0], summary: undefined }, { id: 'tsk_000000000001', title: 'Fix login', state: 'finished', branch: 'buddy/fix', commits: 3, files: 4, added: 20, removed: 5, costUsd: 1.25, tests: 'pass', pr: 'https://example.invalid/pr/1', ask: null, summary: undefined });
  assert.equal(r.costUsd, 1.25);
  assert.deepEqual(r.asks.map((a) => a.ask), ['Which db?']);
});

test('nothing finished and nothing asked gives no card', () => {
  assert.equal(MR.build([task({ stateSince: NOW - 9e6 })], NOW - 1000), null);
});

test('reads the store (last snapshot per task wins) and marks seen', () => {
  const d = dir(), seen = path.join(d, 'seen.json');
  fs.writeFileSync(path.join(d, 'tasks.jsonl'), [JSON.stringify({ task: task({ state: 'running' }) }), 'torn{', JSON.stringify({ task: task({}) })].join('\n'));
  const svc = MR.createMorningReport({ storeDir: d, seenFile: seen, now: () => NOW });
  assert.equal(svc.state().count, 1);
  assert.ok(svc.markSeen());
  assert.equal(svc.state(), null);
});

test('free plan gets no report', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'tasks.jsonl'), JSON.stringify({ task: task({}) }));
  assert.equal(MR.createMorningReport({ storeDir: d, seenFile: path.join(d, 's.json'), now: () => NOW, allowed: () => false }).state(), null);
});

test('queueActive is true while work is queued, running or waiting for a reset, false once drained', () => {
  assert.equal(MR.queueActive({ tasks: [{ state: 'queued' }] }), true);
  assert.equal(MR.queueActive({ tasks: [{ state: 'parked', parkReason: 'limit', reason: 'usage limit · resumes then' }] }), true);
  assert.equal(MR.queueActive({ tasks: [{ state: 'parked', parkReason: 'limit', reason: 'usage limit' }, { state: 'in_review' }, { state: 'done' }] }), false);
  assert.equal(MR.queueActive(null), false);
});

test('keep-awake is held while the queue is non-empty and released after', () => {
  const live = new Set(); let n = 0;
  const psb = { start: () => { live.add(++n); return n; }, stop: (i) => live.delete(i), isStarted: (i) => live.has(i) };
  const ka = KeepAwake.createKeepAwake({ powerSaveBlocker: psb });
  assert.equal(ka.sync([]), false);
  assert.equal(ka.setHold(MR.queueActive({ tasks: [{ state: 'queued' }] })), true);
  assert.equal(ka.sync([]), true, 'a sync with no working session keeps the hold');
  assert.equal(ka.setHold(MR.queueActive({ tasks: [{ state: 'done' }] })), false);
  assert.equal(live.size, 0);
});

test('register reads gate from entitlements and Home exposes the card plus mark-seen', async () => {
  const d = dir();
  fs.mkdirSync(path.join(d, 'tasks', 'store'), { recursive: true });
  fs.writeFileSync(path.join(d, 'tasks', 'store', 'tasks.jsonl'), JSON.stringify({ task: task({ stateSince: Date.now() - 1000 }) }));
  let on = true;
  MR.register({ app: { isPackaged: true, getPath: () => d }, rootDir: d, entitlements: { has: (f) => f === 'queue.morningReport' && on } });
  const handlers = {};
  Home.register({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, allowed: () => true, state: () => ({ sessions: [], inputs: [] }), localSessions: () => [], tools: () => [], myDay: { snapshot: async () => ({ sources: [] }) }, openPage() {}, openAiTools() {} });
  assert.equal((await handlers['home:state']({})).morning.count, 1);
  assert.equal(handlers['home:morning-seen']({}), true);
  assert.equal((await handlers['home:state']({})).morning, null);
  on = false;
  fs.rmSync(path.join(d, 'morning-seen.json'));
  assert.equal((await handlers['home:state']({})).morning, null, 'free plan: no card');
});
