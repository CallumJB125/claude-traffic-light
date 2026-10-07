'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const T = require('../src/optimiser-tools.js');
const Ipc = require('../src/burst-ipc.js');
const { createBurstClient } = require('../src/burst-client.js');
const { createFakeBurst, pauselessRoutes } = require('./fixtures/fake-burst.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 20));
const tools = (v) => Object.fromEntries(v.groups.flatMap((g) => g.tools).map((t) => [t.id, t]));
const ON = { kind: 'on', detected: 'present', version: '0.19.0', route: 'PRIMARY', updateAvailable: false, secondaryReady: true, compaction: { available: true, enabled: false, mode: 'fixed', thresholdLabel: 'Static, from 150k tokens', savedUsd: 12.34, compactions: 9, tokensNotResent: 3700000 }, band: { supported: true, installed: true, current: true, toasts: false } };

test('every tool is listed with Andrew Baker or Plexiform as its maker, in two groups', () => {
  const v = T.toolsView({ burst: ON });
  assert.deepEqual(v.groups.map((g) => g.id), ['burst', 'plexiform']);
  assert.deepEqual(v.groups[0].tools.map((t) => t.id), ['burst', 'routing', 'compaction', 'band', 'panel']);
  assert.ok(v.groups[0].tools.every((t) => t.by === 'Andrew Baker'));
  assert.deepEqual(v.groups[1].tools.map((t) => t.id), ['router', 'waste']);
  for (const t of v.groups.flatMap((g) => g.tools)) assert.ok(t.name && t.what && t.status && typeof t.status.label === 'string' && Array.isArray(t.actions), t.id);
});

test('off macOS every Burst tool says macOS only and offers nothing; Plexiform\'s own tools still work', () => {
  const t = tools(T.toolsView({ burst: { kind: 'unsupported' } }));
  for (const id of ['burst', 'routing', 'compaction', 'band', 'panel']) {
    assert.match(t[id].status.label, /macOS only/, id);
    assert.equal(t[id].available, false, id);
    assert.deepEqual(t[id].actions, [], id);
  }
  assert.equal(t.router.status.label, 'On');
  assert.deepEqual(tools(T.toolsView()).burst.status.label, t.burst.status.label, 'no facts reads as unsupported, never as on');
});

test('Burst states map to honest statuses and only allow-listed one-click actions', () => {
  const kinds = (b) => tools(T.toolsView({ burst: b })).burst.actions.map((a) => a.kind);
  assert.deepEqual(kinds({ kind: 'not_installed' }), ['burst:install']);
  assert.deepEqual(kinds({ kind: 'off', detected: 'present' }), ['burst:enable']);
  assert.deepEqual(kinds({ kind: 'off', detected: 'unreachable' }), ['burst:repair', 'burst:enable', 'burst:off']);
  assert.deepEqual(kinds({ ...ON, updateAvailable: true }), ['tab:dashboard', 'burst:update', 'burst:off']);
  assert.deepEqual(kinds({ kind: 'untrusted' }), ['burst:off']);
  const all = [{ kind: 'not_installed' }, { kind: 'off' }, ON, { kind: 'broken' }, { kind: 'untrusted' }].flatMap((b) => T.toolsView({ burst: b }).groups.flatMap((g) => g.tools).flatMap((t) => t.actions.map((a) => a.kind)));
  const Embed = require('../src/burst-embed.js');
  for (const k of all) {
    const [verb, arg] = k.split(':');
    assert.ok((verb === 'burst' && Embed.PAGE_ACTIONS.includes(arg)) || (verb === 'tab' && ['dashboard', 'route'].includes(arg)) || (verb === 'compaction' && ['on', 'off'].includes(arg)) || (verb === 'open' && T.PAGES.includes(arg)), k);
  }
});

test('savings are only figures the tool reported: Burst compaction stats and the waste finder totals', () => {
  const t = tools(T.toolsView({ burst: ON, waste: { days: 7, files: 12, totals: { reread: 2, failloop: 1, overkill: { turns: 30, low: 1.2, high: 3.45 } } } }));
  assert.equal(t.compaction.saves.text, 'Saved about $12.34 over 9 compactions, 3.7M tokens not resent.');
  assert.match(t.compaction.saves.source, /Claude Burst/);
  assert.equal(t.waste.saves.text, 'Last 7 days: $1.20 to $3.45 of Opus turns could have run on Sonnet (30 routine turns); 2 repeated file reads; 1 failing loop.');
  assert.match(t.waste.saves.source, /12 transcripts/);
  for (const id of ['burst', 'routing', 'band', 'panel', 'router']) assert.equal(t[id].saves, null, `${id} reports no savings, so none is shown`);
  const none = tools(T.toolsView({ burst: { ...ON, compaction: { ...ON.compaction, compactions: 0 } }, waste: { days: 7, files: 3, totals: { reread: 0, failloop: 0, overkill: { turns: 0, low: 0, high: 0 } } } }));
  assert.equal(none.compaction.saves, null);
  assert.equal(none.waste.saves, null);
  assert.equal(none.waste.status.label, 'On, nothing found');
  assert.equal(tools(T.toolsView({ burst: ON })).waste.status.label, 'Plexiform Plus', 'no report: the plan gate, not a zero');
});

test('compaction and routing follow Burst: on/off switch, backup route, missing backup, band versions', () => {
  const t = tools(T.toolsView({ burst: ON }));
  assert.deepEqual(t.compaction.actions.map((a) => a.kind), ['compaction:on']);
  assert.deepEqual(tools(T.toolsView({ burst: { ...ON, compaction: { ...ON.compaction, enabled: true } } })).compaction.actions.map((a) => a.kind), ['compaction:off']);
  assert.equal(tools(T.toolsView({ burst: { ...ON, compaction: null } })).compaction.status.label, 'Not offered by this Burst');
  assert.equal(tools(T.toolsView({ burst: { ...ON, route: 'SECONDARY' } })).routing.status.label, 'Using your backup now');
  assert.equal(tools(T.toolsView({ burst: { ...ON, secondaryReady: false } })).routing.status.label, 'On, no backup provider');
  assert.equal(tools(T.toolsView({ burst: { kind: 'not_installed' } })).routing.status.label, 'Needs Claude Burst');
  assert.equal(t.band.status.label, 'On');
  assert.equal(tools(T.toolsView({ burst: { ...ON, band: { supported: true, installed: true, current: false } } })).band.status.label, 'Installed, out of date');
  assert.equal(tools(T.toolsView({ burst: { ...ON, band: { supported: false } } })).band.status.label, 'Needs a newer Claude Code');
  assert.deepEqual(T.bandStatus({ installed: true, current: true, supported: true, toasts: true, last: { secret: 1 } }), { supported: true, installed: true, current: true, toasts: true });
  assert.equal(T.bandStatus([]), null);
});

test('Learn more links are a fixed map of https GitHub pages', () => {
  for (const u of Object.values(T.LINKS)) assert.match(u, /^https:\/\/github\.com\/andrewbakercloudscale\//);
  const Embed = require('../src/burst-embed.js');
  for (const u of Object.values(T.LINKS)) assert.equal(Embed.navDecision(u, 'http://127.0.0.1:7788'), 'external', u);
});

function page(t, { facts = ON, report = null } = {}) {
  const dom = new JSDOM(read('optimiser.html'), { runScripts: 'outside-only', url: 'file:///synthetic/optimiser.html' });
  const calls = [];
  let push;
  dom.window.optimiserApi = {
    onState: (cb) => { push = cb; }, ready: () => {}, refresh: () => {}, openBrowser: async () => {}, openDocs: () => {},
    act: async (k) => { calls.push(['act', k]); return { ok: false, cancelled: true }; },
    view: async () => ({ view: null }), burstAction: async () => ({ ok: true }),
    tools: async () => { calls.push(['tools']); return facts; },
    waste: async () => report,
    setCompaction: async (r) => { calls.push(['compaction', JSON.parse(JSON.stringify(r))]); return r.confirmed ? { ok: true, note: 'Plexiform\'s own compactor is off while Burst compacts.' } : { ok: false, needsConfirm: true, text: 'Burst uses your Claude subscription tokens to write summaries.' }; },
    openLink: (id) => calls.push(['link', id]), openPage: (id) => calls.push(['page', id]),
  };
  dom.window.eval(read('src/optimiser-tools.js'));
  dom.window.eval(read('optimiser.js'));
  t.after(() => dom.window.close());
  return { d: dom.window.document, calls, push: (s) => push(s) };
}

test('page: without Burst the hub still lists every tool, with the Burst card from main\'s native state on top', async (t) => {
  const p = page(t, { facts: { kind: 'unsupported' } });
  p.push({ mode: 'empty', reason: 'unsupported', headline: 'Not available on this computer', detail: 'Burst runs on macOS only.', chip: null, actions: [], docs: true, canBrowser: false });
  await settle();
  const d = p.d;
  assert.equal(d.getElementById('hub').hidden, false);
  assert.equal(d.getElementById('empty').hidden, false);
  assert.equal(d.querySelector('[data-tool="burst"]'), null, 'Burst is the native card, not listed twice');
  assert.deepEqual([...d.querySelectorAll('[data-tool]')].map((n) => n.dataset.tool), ['routing', 'compaction', 'band', 'panel', 'router', 'waste']);
  assert.match(d.querySelector('[data-tool="routing"]').textContent, /macOS only/);
  assert.equal(d.querySelector('[data-tool="routing"]').dataset.available, 'false');
  assert.ok(!d.querySelector('[data-tool="routing"] .actions button:not(.link)'), 'nothing to click where it cannot work');
});

test('page: on the Tools tab with Burst ready, compaction asks inline before turning on, and links go by id', async (t) => {
  const p = page(t, { report: { waste: { days: 7, files: 2, totals: { reread: 1, failloop: 0, overkill: { turns: 0, low: 0, high: 0 } } } } });
  p.push({ mode: 'ready', tab: 'tools', chip: { tone: 'green', label: 'Burst on' }, canBrowser: true });
  await settle();
  const d = p.d;
  assert.equal(d.getElementById('hub').hidden, false);
  assert.equal(d.getElementById('empty').hidden, true);
  assert.equal(d.getElementById('tab-tools').getAttribute('aria-selected'), 'true');
  assert.ok(d.querySelector('[data-tool="burst"]'));
  assert.match(d.querySelector('[data-tool="compaction"] .saves').textContent, /\$12\.34/);
  assert.match(d.querySelector('[data-tool="waste"] .saves').textContent, /1 repeated file read/);
  [...d.querySelectorAll('[data-tool="compaction"] button')].find((b) => b.textContent === 'Turn on').click();
  await settle();
  assert.deepEqual(p.calls.filter((c) => c[0] === 'compaction').map((c) => c[1]), [{ enabled: true, confirmed: false }]);
  const box = d.querySelector('[data-tool="compaction"] .confirm');
  assert.match(box.textContent, /subscription tokens/);
  box.querySelector('button.primary').click();
  await settle();
  assert.deepEqual(p.calls.filter((c) => c[0] === 'compaction').at(-1)[1], { enabled: true, confirmed: true });
  assert.match(d.querySelector('[data-tool="compaction"] .note[role="status"]').textContent, /own compactor is off/);
  [...d.querySelectorAll('[data-tool="panel"] button')].find((b) => b.textContent === 'Learn more').click();
  [...d.querySelectorAll('[data-tool="router"] button')].find((b) => b.textContent === 'Open Overview').click();
  assert.deepEqual(p.calls.filter((c) => c[0] === 'link' || c[0] === 'page'), [['link', 'panel'], ['page', 'overview']]);
  p.push({ mode: 'ready', tab: 'dashboard', chip: null, canBrowser: true });
  assert.equal(d.getElementById('hub').hidden, true, 'the dashboard tab shows Burst\'s own page instead');
});

test('page: a Burst action from a tool card goes through main\'s consent flow by its allow-listed name', async (t) => {
  const p = page(t, { facts: { kind: 'not_installed' } });
  p.push({ mode: 'empty', reason: 'not_installed', headline: 'Not installed', detail: 'd', chip: null, actions: [{ kind: 'install', label: 'Turn on Burst…', primary: true }], docs: true, canBrowser: false });
  await settle();
  assert.match(p.d.querySelector('[data-tool="compaction"]').textContent, /Needs Claude Burst/);
  p.d.querySelector('#actions button').click();
  await settle();
  assert.deepEqual(p.calls.filter((c) => c[0] === 'act'), [['act', 'install']]);
});

test('burst:tools answers only the optimiser page, with status facts and the band, and nothing on other platforms', async () => {
  const off = {};
  Ipc.register({ utilityHandle: (c, allowed, f) => { off[c] = (e, ...a) => (allowed(e) ? f(e, ...a) : null); }, settingsOnly: () => false, optimiserAllowed: (e) => e.from === 'optimiser', isMac: false, dialog: {}, shell: {}, scriptDir: '/x' });
  assert.deepEqual(await off['burst:tools']({ from: 'optimiser' }), { kind: 'unsupported' });
  assert.equal(await off['burst:tools']({ from: 'usage' }), null);

  const h = pauselessRoutes();
  const fake = await createFakeBurst({ ...h.routes, '/api/upgrade-status': { body: {} }, '/api/mod-status': { body: { claude: '2.1.300', supported: true, installed: true, current: true, toasts: true, last: { x: 1 } } } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-tools-'));
  const bin = path.join(home, '.local', 'bin', 'claude-burst');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }));
  const client = createBurstClient({ home, platform: 'darwin', inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => bin } });
  const on = {};
  const api = Ipc.register({ utilityHandle: (c, allowed, f) => { on[c] = (e, ...a) => (allowed(e) ? f(e, ...a) : null); }, settingsOnly: () => false, optimiserAllowed: (e) => e.from === 'optimiser', isMac: true, client, home, dialog: {}, shell: {}, scriptDir: '/x' });
  await api.refresh(true);
  const f = await on['burst:tools']({ from: 'optimiser' });
  assert.equal(f.kind, 'on');
  assert.equal(f.detected, 'present');
  assert.equal(f.secondaryReady, true);
  assert.equal(f.compaction.savedUsd, 12.34);
  assert.deepEqual(f.band, { supported: true, installed: true, current: true, toasts: true });
  assert.ok(!('actions' in f) && !('state' in f), 'facts only');
  const r = await on['burst:set-compaction']({ from: 'optimiser' }, { enabled: true });
  assert.equal(r.needsConfirm, true, 'turning it on from the optimiser asks first too');
  assert.equal(h.posts.length, 0);
  await fake.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('the optimiser page loads the tool list script, and both are packaged', () => {
  assert.match(read('optimiser.html'), /<script src="src\/optimiser-tools\.js"><\/script>\s*<script src="optimiser\.js">/);
  const files = JSON.parse(read('package.json')).build.files;
  assert.ok(files.includes('src/**/*'));
});
