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

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 20));

function page(t) {
  const dom = new JSDOM(read('optimiser.html'), { runScripts: 'outside-only', url: 'file:///synthetic/optimiser.html' });
  const calls = { act: [], view: [], burst: [] };
  const views = {
    route: { route: 'SECONDARY', overflow: false, reason: 'Claude hit its limit', claim: 'five_hour', until: 'x', untilInMs: 90 * 60 * 1000, rejected: [{ model: 'claude-opus-5', until: 'x', fallsBackTo: 'claude-sonnet-5', resetInMs: 300000 }], chain: { 'claude-opus-5': ['claude-sonnet-5', 'claude-haiku-5'] }, primaryFailures: 2, primary: { provider: 'anthropic', model: '' }, secondary: { provider: 'together', model: 'glm-5', ready: true }, meteredFailover: null },
    requests: { rows: [
      { time: '2026-10-07T09:00:00Z', session: 'abcdef123456', agent: '', slot: 'secondary', route: 'SECONDARY', host: 'h', model: 'glm-5', status: 200, latencyMs: 10, tokensIn: 5, tokensOut: 6, usd: 0.5, note: '<b>x</b>' },
      { time: '2026-10-07T09:30:00Z', session: 's3', agent: '', slot: 'primary', route: 'PRIMARY', host: 'h', model: '', status: 200, latencyMs: 5, tokensIn: 0, tokensOut: 0, usd: 0, note: '' },
      { time: '2026-10-07T08:00:00Z', session: 's2', agent: '', slot: 'primary', route: 'PRIMARY', host: 'h', model: 'claude-opus-5', status: 529, latencyMs: 20, tokensIn: 7, tokensOut: 8, usd: 0, note: '' },
    ] },
    history: { days: [{ day: '2026-10-06', primaryUsd: 1, secondaryUsd: 0.5, requests: 3 }], repos: [] },
  };
  let push;
  let answer = { ok: true };
  dom.window.optimiserApi = {
    onState: (cb) => { push = cb; }, ready: () => {}, refresh: () => {}, openBrowser: async () => {}, openDocs: () => {},
    act: async (k) => { calls.act.push(k); return { ok: true }; },
    view: async (n, a) => { calls.view.push([n, a]); return { view: views[n] }; },
    burstAction: async (id) => { calls.burst.push(id); return answer; },
  };
  dom.window.eval(read('optimiser.js'));
  t.after(() => dom.window.close());
  return { dom, d: dom.window.document, calls, push: (s) => push({ mode: 'ready', chip: { tone: 'green', label: 'Burst on' }, canBrowser: true, ...s }), setAnswer: (a) => { answer = a; } };
}

test('tabs appear only when Burst is ready; Route and Requests panes follow the tab main reports', async (t) => {
  const p = page(t);
  p.push({ mode: 'empty', headline: 'h', detail: 'd', actions: [], docs: false, canBrowser: false, chip: null });
  assert.equal(p.d.getElementById('tabs').hidden, true);
  p.push({ tab: 'dashboard' });
  assert.equal(p.d.getElementById('tabs').hidden, false);
  assert.equal(p.d.getElementById('route-pane').hidden, true);
  assert.equal(p.d.getElementById('tab-dashboard').getAttribute('aria-selected'), 'true');
  p.d.getElementById('tab-route').click();
  assert.deepEqual(p.calls.act, ['tab:route']);
  p.push({ tab: 'route' });
  await settle();
  assert.equal(p.d.getElementById('route-pane').hidden, false);
  assert.equal(p.d.getElementById('requests-pane').hidden, true);
  assert.equal(p.d.getElementById('tab-route').getAttribute('aria-selected'), 'true');
  p.push({ tab: 'dashboard' });
  assert.equal(p.d.getElementById('route-pane').hidden, true);
});

test('Route tab: countdown, rejected rows, chain, secondary label; Back to Claude is offered only on the secondary', async (t) => {
  const p = page(t);
  p.push({ tab: 'route' });
  await settle();
  const d = p.d;
  assert.equal(d.getElementById('route-head').textContent, 'Using your backup provider');
  assert.match(d.getElementById('route-reason').textContent, /Claude hit its limit.*five_hour.*1h 30m/);
  assert.match(d.getElementById('route-kv').textContent, /together \/ glm-5/);
  assert.match(d.getElementById('route-rejected').textContent, /claude-opus-5.*5m 0s.*claude-sonnet-5/);
  assert.match(d.getElementById('route-chain').textContent, /claude-sonnet-5 then claude-haiku-5/);
  assert.equal(d.getElementById('route-reset').hidden, false);
  assert.ok(!/base_url|key_|keychain/.test(d.body.textContent));
});

test('Back to Claude now goes through the burst-action bridge as `reset`; cancel is reported and changes nothing', async (t) => {
  const p = page(t);
  p.push({ tab: 'route' });
  await settle();
  p.setAnswer({ ok: false, cancelled: true });
  p.d.getElementById('route-reset').click();
  await settle();
  assert.deepEqual(p.calls.burst, ['reset']);
  assert.match(p.d.getElementById('route-note').textContent, /Cancelled/);
  const routeLoads = p.calls.view.filter(([n]) => n === 'route').length;
  p.setAnswer({ ok: true });
  p.d.getElementById('route-reset').click();
  await settle();
  assert.deepEqual(p.calls.burst, ['reset', 'reset']);
  assert.ok(p.calls.view.filter(([n]) => n === 'route').length > routeLoads, 'the route is re-read after a confirmed reset');
});

test('Requests tab: rows, filters, history chart; text only', async (t) => {
  const p = page(t);
  p.push({ tab: 'requests' });
  await settle();
  const d = p.d;
  assert.deepEqual(p.calls.view.map(([n]) => n).sort(), ['history', 'requests']);
  assert.equal(d.querySelectorAll('#req-rows tr').length, 2);
  assert.equal(d.querySelector('#req-rows td.note').children.length, 0, 'notes are never parsed as HTML');
  assert.equal(d.querySelectorAll('#hist-chart .bar-col').length, 1);
  assert.equal(d.querySelector('#hist-chart .day').textContent, '10-06');
  assert.match(d.querySelector('#hist-chart .bar-col').title, /Your plan \$1\.00, Backup \$0\.50/);
  assert.equal(d.querySelectorAll('.legend .swatch').length, 2);
  d.getElementById('f-pings').checked = true;
  d.getElementById('f-pings').dispatchEvent(new p.dom.window.Event('change'));
  assert.equal(d.querySelectorAll('#req-rows tr').length, 3, 'pings show on request');
  assert.match(d.querySelectorAll('#req-rows tr')[1].textContent, /\u2014/);
  assert.ok(!/\$0\.00/.test(d.querySelectorAll('#req-rows tr')[1].textContent));
  d.getElementById('f-pings').checked = false;
  d.getElementById('f-pings').dispatchEvent(new p.dom.window.Event('change'));
  d.getElementById('f-slot').value = 'primary';
  d.getElementById('f-slot').dispatchEvent(new p.dom.window.Event('change'));
  assert.equal(d.querySelectorAll('#req-rows tr').length, 1);
  d.getElementById('f-slot').value = '';
  d.getElementById('f-status').value = 'err';
  d.getElementById('f-status').dispatchEvent(new p.dom.window.Event('change'));
  assert.equal(d.querySelectorAll('#req-rows tr').length, 1);
  assert.match(d.getElementById('req-rows').textContent, /529/);
});

test('end to end consent: cancel on Back to Claude now sends no POST; confirm sends exactly one', async () => {
  for (const [answer, expected] of [[0, 0], [1, 1]]) {
    const fake = await createFakeBurst({ '/api/state': { body: stateV019({ route: 'SECONDARY' }) }, '/api/upgrade-status': { body: {} }, '/api/reset': { body: { ok: true } } });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-optabs-'));
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

test('the preload exposes only fixed channels: burst:view and burst-action, nothing arbitrary', () => {
  const src = read('optimiser-preload.js');
  assert.match(src, /invoke\('burst:view'/);
  assert.match(src, /invoke\('burst-action', String\(id\), \{\}\)/);
  assert.ok(!/ipcRenderer\.(invoke|send)\(\s*[a-z]/.test(src.replace(/ipcRenderer\.on\('optimiser:state'/, '')), 'no renderer-chosen channel names');
});
