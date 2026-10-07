'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Ipc = require('../src/burst-ipc.js');
const View = require('../src/burst-view.js');
const Spend = require('../src/burst-spend.js');
const { compactionState } = require('./fixtures/fake-burst.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 30));

function ipc({ opener = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-opt-'));
  const opened = [];
  const detect = { kind: 'present', state: { version: '0.19.0', route: 'PRIMARY', active: true, secondaryReady: true, until: '', claim: '', mode: 'base-url', configError: '', inactiveReason: '', rejected: [], primaryFailures: 0, compaction: Spend.normalizeCompaction(compactionState()) }, capabilities: { state: true, usage: true, handoverAudit: false, handoverFile: false, upgradeStatus: false, testConnection: false }, upgrade: null, pid: 7 };
  const api = Ipc.register({
    utilityHandle: () => {}, settingsOnly: () => false, isMac: true, home: dir, scriptDir: dir, dialog: {},
    shell: { openExternal: async (u) => { opened.push(u); } },
    client: { detect: async () => detect, adminUrl: () => 'http://127.0.0.1:7788/' },
  });
  if (opener) api.setOpener(opener);
  return { api, opened };
}

test('Open dashboard opens the Usage optimiser page; Open in browser is the secondary way and still reaches localhost', async () => {
  let pages = 0;
  const t = ipc({ opener: () => { pages++; } });
  await settle();
  assert.deepEqual(await t.api.act('open-dashboard'), { ok: true });
  assert.equal(pages, 1);
  assert.deepEqual(t.opened, []);
  assert.deepEqual(await t.api.act('open-browser'), { ok: true });
  assert.deepEqual(t.opened, ['http://127.0.0.1:7788/']);
});

test('without the page wired (older callers) Open dashboard still opens the browser', async () => {
  const t = ipc();
  await settle();
  await t.api.act('open-dashboard');
  assert.deepEqual(t.opened, ['http://127.0.0.1:7788/']);
});

test('the card offers both, the page one first; snapshot hands the optimiser the handshake result and trusted address', async () => {
  const t = ipc();
  await settle();
  const kinds = View.statusView(t.api.snapshot().d, { platform: 'darwin' }).actions.map((a) => a.kind);
  assert.ok(kinds.indexOf('open-dashboard') >= 0 && kinds.indexOf('open-browser') === kinds.indexOf('open-dashboard') + 1);
  const s = t.api.snapshot();
  assert.equal(s.d.kind, 'present');
  assert.equal(s.d.pid, 7);
  assert.equal(s.url, 'http://127.0.0.1:7788/');
});

test('main.js gets two additive lines and nothing else of the Burst wiring changed', () => {
  const main = read('main.js');
  assert.match(main, /^ *buddyWin\.attachBurst\?\.\(\(\) => BurstIpc\);$/m);
  assert.match(main, /^BurstIpc\.setOpener\(\(\) => openBuddy\('optimiser'\)\);$/m);
});

test('native page: the empty state renders from the view model with textContent only, and its actions go through the bridge', async () => {
  const dom = new JSDOM(read('optimiser.html'), { runScripts: 'outside-only', url: 'file:///synthetic/optimiser.html' });
  const acted = [];
  let push;
  dom.window.optimiserApi = { onState: (cb) => { push = cb; }, ready: () => { dom.window.readyCalled = true; }, act: async (k) => { acted.push(k); return { ok: false, cancelled: true }; }, refresh: () => acted.push('refresh'), openBrowser: async () => acted.push('browser'), openDocs: () => acted.push('docs') };
  dom.window.eval(read('optimiser.js'));
  const d = dom.window.document;
  assert.equal(dom.window.readyCalled, true);
  assert.equal(d.querySelector('h1').textContent, 'Usage optimiser');
  push({ mode: 'empty', reason: 'down', headline: "Burst isn't answering", detail: '<img src=x onerror=alert(1)>', chip: { tone: 'red', label: 'Burst off' }, actions: [{ kind: 'repair', label: 'Repair', primary: true }], docs: true, canBrowser: false });
  assert.equal(d.getElementById('empty').hidden, false);
  assert.equal(d.getElementById('headline').textContent, "Burst isn't answering");
  assert.equal(d.getElementById('detail').children.length, 0, 'no HTML from main is ever parsed');
  assert.equal(d.getElementById('chip').dataset.tone, 'red');
  assert.equal(d.getElementById('browser').hidden, true);
  d.querySelector('#actions button').click();
  await settle();
  assert.deepEqual(acted, ['repair']);
  assert.equal(d.getElementById('note').textContent, 'Cancelled. Nothing changed.');
  push({ mode: 'ready', headline: 'Usage optimiser', detail: '', chip: { tone: 'green', label: 'Primary' }, actions: [], docs: false, canBrowser: true });
  assert.equal(d.getElementById('empty').hidden, true);
  assert.equal(d.getElementById('browser').hidden, false);
  d.getElementById('browser').click();
  d.getElementById('refresh').click();
  assert.deepEqual(acted.slice(1), ['browser', 'refresh']);
  dom.window.close();
});

test('page and preload are locked down: strict CSP, a closed bridge, packaged', () => {
  const html = read('optimiser.html');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  const bridge = read('optimiser-preload.js');
  assert.match(bridge, /exposeInMainWorld\('optimiserApi'/);
  const channels = [...bridge.matchAll(/ipcRenderer\.\w+\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.length >= 5 && channels.every((c) => c.startsWith('optimiser:') || ['burst:view', 'burst-action', 'burst:tools', 'burst:set-compaction', 'cost-guard:report'].includes(c)), channels.join());
  const files = JSON.parse(read('package.json')).build.files;
  for (const f of ['optimiser.html', 'optimiser.js', 'optimiser-preload.js']) assert.ok(files.includes(f), f);
});

test('sidebar: the optimiser\'s sections unfold under its entry only while it is open and click through to main by id', () => {
  const dom = new JSDOM(read('buddy-window/sidebar.html').replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, ''), { runScripts: 'outside-only', url: 'file:///synthetic/sidebar.html' });
  const clicks = [];
  let onState;
  const { PAGES, SECTIONS, GROUPS, FOOTER } = require('../buddy-window/pages.js');
  dom.window.buddy = { onState: (cb) => { onState = cb; }, pages: async () => ({ pages: PAGES, groups: GROUPS, sections: SECTIONS, footer: FOOTER, brand: { name: 'Plexiform', hubText: {} } }), select: () => {}, optimiserSection: (id) => clicks.push(id), workspace: () => {}, signOut: () => {}, retry: () => {} };
  dom.window.eval(read('buddy-window/sidebar.js'));
  return settle().then(() => {
    const d = dom.window.document;
    onState({ selected: 'optimiser', optimiser: { nav: [{ id: 'cards', label: 'Burst: Overview' }, { id: 'sec-models', label: 'Spend' }], active: 'cards' } });
    const leaves = [...d.querySelectorAll('.nav-leaf')];
    assert.deepEqual(leaves.map((b) => b.textContent), ['Burst: Overview', 'Spend']);
    assert.equal(leaves[0].getAttribute('aria-current'), 'location');
    assert.equal(d.querySelector('[data-page="optimiser"]').getAttribute('aria-current'), 'page');
    leaves[1].click();
    assert.deepEqual(clicks, ['sec-models']);
    onState({ selected: 'usage', optimiser: null });
    assert.equal(d.querySelectorAll('.nav-leaf').length, 0);
    const li = d.querySelector('[data-page="optimiser"]').parentElement;
    assert.equal(li.hidden, false, 'listed without Burst too: the tool hub is for everyone');
    onState({ selected: 'usage', burst: true });
    assert.equal(li.hidden, false);
    dom.window.close();
  });
});
