'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'settings.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 5));

async function open(url = 'file:///app/settings.html', config = {}) {
  const dom = new JSDOM(html.replace(/<script src[^>]*><\/script>/g, ''), { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const saves = [];
  const none = async () => null;
  w.Element.prototype.scrollIntoView = () => {};
  w.IntersectionObserver = class { observe() {} };
  w.settingsApi = new Proxy({
    getConfig: async () => config,
    saveConfig: async (c) => { saves.push(c); return c; },
    voiceStatus: async () => ({ hotkeys: [], available: false, reason: 'x' }),
    compactionStats: none, spend: none, remoteDevices: none, interactionHostStatus: none, mcpStatus: async () => ({ installed: false }),
    signalEndpoint: async () => ({ port: 1, emit: 'e', token: 't' }), gitStatus: none, privacyText: none, busyStatus: async () => ({ calendar: {}, focus: {}, ics: {} }),
    onShowSection(cb) { w.__show = cb; },
  }, { get: (t, k) => (k in t ? t[k] : async () => null) });
  w.eval(script);
  await tick();
  return { w, doc: w.document, saves };
}
const visible = (doc) => [...doc.querySelectorAll('.pane')].filter((p) => !p.hidden).map((p) => p.dataset.section);

test('five sections, General first, the first screen is at most ten controls', async () => {
  const { doc } = await open();
  assert.deepEqual([...doc.querySelectorAll('#section-nav button')].map((b) => b.dataset.go), ['general', 'notifications', 'widget', 'privacy', 'advanced']);
  assert.deepEqual(visible(doc), ['general']);
  const controls = doc.querySelectorAll('#pane-general input, #pane-general select, #pane-general textarea');
  assert.ok(controls.length <= 10, `${controls.length} controls on the first screen`);
});

test('?section= and the nav pick a section; unknown names fall back to General', async () => {
  const a = await open('file:///app/settings.html?embedded=1&section=advanced');
  assert.deepEqual(visible(a.doc), ['advanced']);
  assert.equal(a.doc.querySelector('#section-nav [aria-current="page"]').dataset.go, 'advanced');
  a.doc.querySelector('[data-go="widget"]').click();
  assert.deepEqual(visible(a.doc), ['widget']);
  assert.match(a.w.location.search, /embedded=1/);
  assert.equal((await open('file:///app/settings.html?section=nope')).doc.querySelector('#pane-general').hidden, false);
});

test('the tray Health item switches to Advanced', async () => {
  const { w, doc } = await open();
  w.__show('health');
  assert.deepEqual(visible(doc), ['advanced']);
});

test('there is no Save button: a change saves at once and says Saved', async () => {
  const { doc, saves } = await open();
  assert.equal(doc.getElementById('save'), null);
  const sounds = doc.getElementById('sounds');
  sounds.checked = false;
  sounds.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await tick(); await tick();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].sounds, false);
  assert.equal(doc.getElementById('status').textContent, 'Saved');
});

test('controls with their own save do not also trigger the shared one', async () => {
  const { doc, saves } = await open();
  for (const id of ['voice-hotkey', 'compact-enabled', 'native-board-app', 'busyCalendar']) {
    const el = doc.getElementById(id);
    el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  }
  await tick(); await tick();
  assert.equal(saves.filter((s) => 'sounds' in s).length, 0);
});

test('each setting has one home: no Burst card, connect buttons, or Account section here; every id is unique', () => {
  const dom = new JSDOM(html);
  const d = dom.window.document;
  for (const sel of ['#burst-card', '.pauseless', '[data-agent]', '#account-section', '#save']) assert.equal(d.querySelector(sel), null, sel);
  const ids = [...d.querySelectorAll('[id]')].map((e) => e.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  assert.equal(d.querySelector('#askFromWidget').closest('.field').querySelector('#oneKeyApprove'), null, 'askFromWidget field is closed before oneKeyApprove');
});

test('every config key the old page saved is still saved', async () => {
  const { doc, saves } = await open();
  doc.getElementById('sounds').dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await tick(); await tick();
  const keys = Object.keys(saves[0]);
  for (const k of ['workingStaleMinutes', 'stuckMinutes', 'waitingStaleHours', 'sounds', 'quietHours', 'mutedProjects', 'notifyOnStates', 'notifyStates', 'showWidget', 'menuBarMode', 'lowPower', 'seasonal', 'askFromWidget', 'oneKeyApprove', 'showTasks', 'showAgents', 'agentRoster', 'agentKinds', 'agentChipSize', 'roam', 'randomEvents', 'gitSignals', 'gitRepos', 'gitDeployWorkflows', 'spend', 'busyHold', 'busyCalendar', 'busyCalendarTitles', 'busyFocus', 'busyIcsUrl', 'busyFocusShortcut', 'remoteTailscale', 'teamSessionSharing', 'remoteInteractionHost', 'codexDaemonMessaging']) assert.ok(keys.includes(k), k);
});
