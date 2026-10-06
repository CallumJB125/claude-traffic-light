'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ipc = require('../src/burst-ipc.js');
const H = require('../src/burst-handover.js');
const Spend = require('../src/burst-spend.js');
const { usageReport, compactionState } = require('./fixtures/fake-burst.js');

const NOTE = '## 2026-10-06 Session\nWorking on parser.\n';
function setup({ state = compactionState([{ session: 's-1', compactions: 1, requests: 3, saved_tokens: 100, saved_usd: 0.5, net_usd: 0.25 }]), live = true } = {}) {
  const handlers = {};
  const sent = [], hub = [], files = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-s3-'));
  const detect = { kind: 'present', state: Spend && require('../src/burst-client.js') && { version: '0.19.0', route: 'SECONDARY', active: true, secondaryReady: true, until: '', claim: '', mode: 'base-url', configError: '', inactiveReason: '', rejected: [], primaryFailures: 0, compaction: Spend.normalizeCompaction(state) }, capabilities: { state: true, usage: true, handoverAudit: true, handoverFile: true, upgradeStatus: false, testConnection: false }, upgrade: null };
  const client = {
    detect: async () => detect, adminUrl: () => null,
    usage: async () => Spend.normalizeUsage(usageReport()),
    handoverAudit: async () => [{ root: '/work/plex' }],
    handoverFile: async (root) => { files.push(root); return NOTE; },
  };
  const api = Ipc.register({
    utilityHandle: (ch, allowed, fn) => { handlers[ch] = (e, ...a) => (allowed(e) ? fn(e, ...a) : null); },
    settingsOnly: () => false, usageAllowed: (e) => e.usage === true, sessionsAllowed: (e) => e.sessions === true,
    stateFile: path.join(dir, 's.json'), hubSend: async (m) => { hub.push(m); }, runner: { live: () => live, send: (m) => sent.push(m) },
    isMac: true, client, home: dir, scriptDir: dir, dialog: {}, shell: {},
  });
  return { handlers, api, sent, hub, files, dir };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

test('usage channel: only the Usage page; returns the Through Burst view model, not raw rows', async () => {
  const t = setup();
  await settle();
  assert.equal(await t.handlers['burst:usage']({ sessions: true }, '7d'), null);
  const r = await t.handlers['burst:usage']({ usage: true }, '7d');
  assert.equal(r.view.secondaryUsd, 1.5);
  assert.ok(!('recent' in r.view) && !('byProvider' in r.view));
});

test('sessions: compaction stats for every session; Burst handover only for observed Claude sessions; nothing shared by default', async () => {
  const t = setup();
  await settle();
  const observed = { sessionId: 's-1', cwd: '/work/plex/src', ownership: 'observed' };
  t.api.enrichSession(observed);
  await settle();
  t.api.enrichSession(observed);
  await settle();
  const b = t.api.enrichSession(observed);
  assert.equal(b.compaction.savedUsd, 0.5);
  assert.match(b.handover.text, /Working on parser/);
  assert.equal(b.handover.shared, false);
  assert.equal(t.hub.length, 0, 'default off: nothing leaves');
  assert.equal(t.api.enrichSession({ ...observed, ownership: 'plexiform-owned' }).handover, undefined);
  assert.equal(t.api.enrichSession({ ...observed, source: 'codex' }).handover, undefined);
  assert.equal(t.api.enrichSession({ sessionId: 'other', cwd: '/elsewhere' }), null);
});

test('opt-in per repo shares once per dated section, persists, and is revocable', async () => {
  const t = setup();
  await settle();
  const row = { sessionId: 's-1', cwd: '/work/plex', ownership: 'observed' };
  t.api.enrichSession(row); await settle();
  t.api.enrichSession(row); await settle();
  assert.deepEqual(await t.handlers['burst:handover-share']({ sessions: false }, H.repoKey('/work/plex'), true), null);
  assert.deepEqual(await t.handlers['burst:handover-share']({ sessions: true }, '../bad', true), { ok: false });
  assert.deepEqual(await t.handlers['burst:handover-share']({ sessions: true }, H.repoKey('/work/plex'), true), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 's.json'), 'utf8')).share[H.repoKey('/work/plex')], true);
  await t.handlers['burst:handover-share']({ sessions: true }, H.repoKey('/work/other'), true);
  await t.handlers['burst:handover-share']({ sessions: true }, H.repoKey('/work/other'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 's.json'), 'utf8')).share[H.repoKey('/work/other')], undefined);
});

test('compaction note and force-off follow Burst compaction state', async () => {
  const on = setup(); await settle();
  assert.equal(on.api.compactionActive(), true);
  assert.equal(on.api.compactionNote(), 'Burst is compacting Claude sessions');
  const off = setup({ state: compactionState([], false) }); await settle();
  assert.equal(off.api.compactionActive(), false);
  assert.equal(off.api.compactionNote(), '');
});

test('board facts: pushed to the runner only while it is running cards', async () => {
  const live = setup(); await settle();
  await live.api.pushBoardFacts();
  assert.deepEqual(live.sent.at(-1), { active: true, route: 'SECONDARY', secondaryReady: true, sessions: { 's-1': 1.5 } });
  const idle = setup({ live: false }); await settle();
  await idle.api.pushBoardFacts();
  assert.equal(idle.sent.length, 0);
});

test('after opt-in the scrubbed note reaches the hub sender as a system salvage note', async () => {
  const t = setup(); await settle();
  await t.handlers['burst:handover-share']({ sessions: true }, H.repoKey('/work/plex'), true);
  const row = { sessionId: 's-1', cwd: '/work/plex', ownership: 'observed' };
  t.api.enrichSession(row); await settle();
  t.api.enrichSession(row); await settle();
  assert.equal(t.hub.length, 1);
  assert.equal(t.hub[0].written_by, 'system');
  assert.equal(t.hub[0].section, 'salvage');
  assert.equal(t.api.enrichSession(row).handover.shared, true);
});
