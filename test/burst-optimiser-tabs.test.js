'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Ipc = require('../src/burst-ipc.js');
const { createBurstClient } = require('../src/burst-client.js');
const { createFakeBurst, stateV019 } = require('./fixtures/fake-burst.js');
const { testTempDir } = require('./helpers/tmp');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 20));

function page(t) {
  const dom = new JSDOM(read('optimiser.html'), { runScripts: 'outside-only', url: 'file:///synthetic/optimiser.html' });
  const calls = { act: [] };
  let push;
  dom.window.optimiserApi = {
    onState: (cb) => { push = cb; }, ready: () => {}, refresh: () => {}, openBrowser: async () => {}, openDocs: () => {},
    act: async (k) => { calls.act.push(k); return { ok: true }; },
  };
  dom.window.eval(read('optimiser.js'));
  t.after(() => dom.window.close());
  return { dom, d: dom.window.document, calls, push: (s) => push({ mode: 'ready', chip: { tone: 'green', label: 'Burst on' }, canBrowser: true, ...s }) };
}

test('tabs appear only when Burst is ready; the hub shows on Tools and hides behind the dashboard', async (t) => {
  const p = page(t);
  p.push({ mode: 'empty', headline: 'h', detail: 'd', actions: [], docs: false, canBrowser: false, chip: null });
  assert.equal(p.d.getElementById('tabs').hidden, true);
  assert.equal(p.d.getElementById('hub').hidden, false);
  p.push({ tab: 'dashboard' });
  assert.equal(p.d.getElementById('tabs').hidden, false);
  assert.equal(p.d.getElementById('hub').hidden, true);
  assert.equal(p.d.getElementById('tab-dashboard').getAttribute('aria-selected'), 'true');
  p.d.getElementById('tab-tools').click();
  assert.deepEqual(p.calls.act, ['tab:tools']);
  p.push({ tab: 'tools' });
  await settle();
  assert.equal(p.d.getElementById('hub').hidden, false);
  assert.equal(p.d.getElementById('tab-tools').getAttribute('aria-selected'), 'true');
});

test("Route and Requests are Burst's own dashboard sections now: no native tabs or panes", () => {
  const html = read('optimiser.html');
  for (const id of ['tab-route', 'tab-requests', 'route-pane', 'requests-pane', 'route-reset', 'req-rows']) assert.ok(!html.includes(`id="${id}"`), id);
  assert.deepEqual([...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]), ['dashboard', 'tools']);
  assert.ok(!/api\.view\(|burstAction/.test(read('optimiser.js')));
});

test('end to end consent: cancel on Back to Claude now sends no POST; confirm sends exactly one', async () => {
  for (const [answer, expected] of [[0, 0], [1, 1]]) {
    const fake = await createFakeBurst({ '/api/state': { body: stateV019({ route: 'SECONDARY' }) }, '/api/upgrade-status': { body: {} }, '/api/reset': { body: { ok: true } } });
    const home = testTempDir('burst-optabs-');
    const bin = path.join(home, '.local', 'bin', 'claude-burst');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }));
    const client = createBurstClient({ home, platform: 'darwin', inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => bin } });
    const handlers = {};
    const dialogs = [];
    const api = Ipc.register({
      utilityHandle: (c, allowed, f) => { handlers[c] = (e, ...a) => (allowed(e) ? f(e, ...a) : null); },
      settingsOnly: () => false, sessionsAllowed: () => false, optimiserAllowed: (e) => e.from === 'optimiser',
      isMac: true, client, home, dialog: { showMessageBox: async (o) => { dialogs.push(o); return { response: answer }; } }, shell: {}, scriptDir: '/x',
    });
    await api.refresh(true);
    const r = await handlers['burst-action']({ from: 'optimiser' }, 'reset', { title: 'renderer title' });
    assert.equal(dialogs[0].title, 'Back to Claude now');
    assert.equal(fake.requests.filter((q) => q.method === 'POST').length, expected);
    assert.equal(!!r.cancelled, expected === 0);
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the preload exposes only fixed channels, nothing arbitrary, and no Burst views or actions', () => {
  const src = read('optimiser-preload.js');
  assert.ok(!/burst:view|'burst-action'/.test(src));
  assert.ok(!/ipcRenderer\.(invoke|send)\(\s*[a-z]/.test(src.replace(/ipcRenderer\.on\('optimiser:state'/, '')), 'no renderer-chosen channel names');
});
