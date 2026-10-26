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

async function open(url = 'file:///app/settings.html', config = {}, voice = { hotkeys: [], available: false, reason: 'x' }) {
  const dom = new JSDOM(html.replace(/<script src[^>]*><\/script>/g, ''), { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const saves = [];
  const none = async () => null;
  w.Element.prototype.scrollIntoView = () => {};
  w.IntersectionObserver = class { observe() {} };
  w.settingsApi = new Proxy({
    getConfig: async () => config,
    saveConfig: async (c) => { saves.push(c); return c; },
    voiceStatus: async () => voice,
    compactionStats: none, spend: none, remoteDevices: none, interactionHostStatus: none, mcpStatus: async () => ({ installed: false }),
    signalEndpoint: async () => ({ port: 1, emit: 'e', token: 't' }), gitStatus: none, privacyText: none, busyStatus: async () => ({ calendar: {}, focus: {}, ics: {} }),
    onShowSection(cb) { w.__show = cb; },
  }, { get: (t, k) => (k in t ? t[k] : async () => null) });
  w.eval(script);
  await tick();
  return { w, doc: w.document, saves };
}
const visible = (doc) => [...doc.querySelectorAll('.pane')].filter((p) => !p.hidden).map((p) => p.dataset.section);

test('six sections, General first, the first screen is at most eight controls', async () => {
  const { doc } = await open();
  assert.deepEqual([...doc.querySelectorAll('#section-nav button')].map((b) => b.dataset.go), ['general', 'notifications', 'spend', 'widget', 'privacy', 'advanced']);
  assert.deepEqual([...doc.querySelectorAll('#section-nav button')].map((b) => b.textContent), ['General', 'Notifications', 'Spend and limits', 'Widget', 'Privacy and data', 'Advanced']);
  assert.deepEqual(visible(doc), ['general']);
  const controls = doc.querySelectorAll('#pane-general input, #pane-general select, #pane-general textarea');
  assert.ok(controls.length <= 8, `${controls.length} controls on the first screen`);
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
  assert.equal(d.querySelectorAll('#askFromWidget').length, 1, 'one toggle, on the Widget pane');
  assert.equal(d.querySelector('#askFromWidget').closest('.pane').dataset.section, 'widget');
  assert.equal(d.querySelector('#askFromWidget-moved').closest('.pane').dataset.section, 'notifications', 'a pointer is left where it used to be');
});

test('every config key the old page saved is still saved', async () => {
  const { doc, saves } = await open();
  doc.getElementById('sounds').dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await tick(); await tick();
  const keys = Object.keys(saves[0]);
  for (const k of ['workingStaleMinutes', 'stuckMinutes', 'waitingStaleHours', 'sounds', 'quietHours', 'mutedProjects', 'notifyOnStates', 'notifyStates', 'showWidget', 'menuBarMode', 'lowPower', 'seasonal', 'askFromWidget', 'oneKeyApprove', 'showTasks', 'showAgents', 'agentRoster', 'agentKinds', 'agentChipSize', 'roam', 'randomEvents', 'gitSignals', 'gitRepos', 'gitDeployWorkflows', 'spend', 'busyHold', 'busyCalendar', 'busyCalendarTitles', 'busyFocus', 'busyIcsUrl', 'busyFocusShortcut', 'remoteTailscale', 'teamSessionSharing', 'remoteInteractionHost', 'codexDaemonMessaging']) assert.ok(keys.includes(k), k);
});

const OLD_IDS = ['section-nav', 'pane-general', 'workingStaleMinutes', 'hint-working', 'stuckMinutes', 'hint-stuck', 'waitingStaleHours', 'hint-waiting', 'spend-mode', 'hint-spend-mode', 'spend-now', 'budget-label', 'spend-daily', 'spend-weekly', 'spend-warn', 'hint-budget', 'voice-hotkey', 'voice-hint', 'voice-longPress', 'voice-askClaude', 'pane-notifications', 'sounds', 'notifyOnStates', 'notify-kinds', 'notify-permission-ask', 'notify-turn-failed', 'notify-offline', 'quietEnabled', 'quietStart', 'quietEnd', 'quiet-days', 'mutedProjects', 'hint-muted', 'askFromWidget', 'oneKeyApprove', 'runaway-label', 'spend-runaway-dollars', 'spend-runaway-tokens', 'spend-runaway-minutes', 'spend-notify-runaway', 'spend-notify-budget-warning', 'spend-notify-budget-exceeded', 'busyHold', 'busy-sources', 'busyCalendar', 'busy-calendar-state', 'busyCalendarTitles', 'busyFocus', 'busy-focus-state', 'busyIcsUrl', 'busy-ics-state', 'hint-ics', 'busyFocusShortcut', 'hint-focus', 'pane-widget', 'showWidget', 'menuBarMode', 'lowPower', 'seasonal', 'showTasks', 'roam', 'randomEvents', 'showAgents', 'agentRoster', 'which-agents', 'kind-subagent', 'kind-teammate', 'kind-ralph', 'agentChipSize', 'pane-privacy', 'privacy', 'leaves-machine', 'privacy-export-stats', 'privacy-export-setup', 'privacy-folder', 'privacy-status', 'privacy-notice', 'privacy-body', 'crash-reports', 'crash-opt-in', 'crash-view', 'crash-payload', 'crash-export', 'crash-status', 'pane-advanced', 'native-board-app', 'native-board-workspace', 'native-board-choices', 'native-board-mode', 'native-board-connect', 'native-board-disconnect', 'native-board-hint', 'gitSignals', 'git-status', 'gitRepos', 'hint-git-repos', 'gitDeployWorkflows', 'hint-git-deploy', 'compact-enabled', 'hint-compact', 'compact-providers-label', 'compact-codex', 'compact-threshold', 'compact-threshold-value', 'hint-compact-threshold', 'compact-saved', 'compact-last', 'compact-burst-learned', 'remote-devices', 'remote-name', 'remote-pair', 'remote-pair-status', 'remote-code', 'remote-code-name', 'remote-code-host', 'remote-code-where', 'remote-code-text', 'remote-copy', 'remote-done', 'remote-list', 'remote-listener', 'remoteTailscale', 'remote-tailnet', 'teamSessionSharing', 'teamBrief', 'team-brief-hint', 'remoteInteractionHost', 'interaction-host-status', 'codexDaemonMessaging', 'codex-daemon-hint', 'connect-hint', 'emit-path', 'endpoint', 'token-path', 'backups', 'backups-title', 'backups-body', 'backups-summary', 'backups-now', 'backups-recheck', 'backups-folder', 'backups-status', 'backups-list', 'backups-more', 'health', 'health-title', 'health-summary', 'health-checks', 'health-fine', 'health-fine-count', 'health-fine-checks', 'health-recheck', 'health-copy', 'health-copy-hint', 'feedback-open', 'status'];

test('every id the one-page Settings had is still there exactly once', () => {
  const d = new JSDOM(html).window.document;
  for (const id of OLD_IDS) assert.equal(d.querySelectorAll(`[id="${id}"]`).length, 1, id);
  assert.equal(d.querySelectorAll('#quiet-days input[data-day]').length, 7);
});

test('each old section moved to its sub-page, and no heading says just Agents', () => {
  const d = new JSDOM(html).window.document;
  const home = (id) => d.getElementById(id).closest('.pane').dataset.section;
  const where = {
    general: ['workingStaleMinutes', 'stuckMinutes', 'waitingStaleHours', 'voice-hotkey', 'voice-longPress', 'voice-askClaude'],
    notifications: ['sounds', 'notifyOnStates', 'quietEnabled', 'mutedProjects', 'oneKeyApprove', 'busyHold', 'busyIcsUrl', 'busyFocusShortcut'],
    spend: ['spend-mode', 'spend-daily', 'spend-weekly', 'spend-warn', 'spend-runaway-dollars', 'spend-notify-runaway', 'spend-notify-budget-exceeded'],
    widget: ['showWidget', 'menuBarMode', 'lowPower', 'askFromWidget', 'showAgents', 'kind-ralph', 'agentChipSize'],
    privacy: ['privacy', 'crash-reports', 'crash-opt-in', 'backups', 'teamSessionSharing', 'teamBrief', 'remoteInteractionHost', 'codexDaemonMessaging'],
    advanced: ['native-board-app', 'gitSignals', 'compact-enabled', 'remote-devices', 'remote-name', 'remoteTailscale', 'connect-hint', 'health'],
  };
  for (const [section, ids] of Object.entries(where)) for (const id of ids) assert.equal(home(id), section, id);
  assert.ok(![...d.querySelectorAll('h2')].some((h) => /^agents$/i.test(h.textContent.trim())));
  assert.equal(d.querySelector('#which-agents').textContent, 'Which Claude Code helpers');
  assert.match(d.getElementById('remote-devices').textContent, /Phone in the sidebar/);
  assert.match(d.getElementById('sharing').textContent, /Phone approvals in the sidebar/);
});

test('controls with their own save also say Saved', async () => {
  for (const id of ['busyCalendar', 'compact-enabled']) {
    const { doc, saves } = await open('file:///app/settings.html', { compaction: {} });
    doc.getElementById(id).dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
    assert.ok(saves.length >= 1, id);
    assert.equal(doc.getElementById('status').textContent, 'Saved', id);
  }
});

test('a failed save says so instead of Saved', async () => {
  const { w, doc } = await open();
  w.settingsApi.saveConfig = async () => { throw new Error('disk full'); };
  doc.getElementById('sounds').dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick(); await tick();
  assert.equal(doc.getElementById('status').textContent, 'Save failed — disk full');
  assert.equal(doc.getElementById('status').className, 'err');
});

test('settings has sub-page navigation, no Save button, and a first screen of at most 10 controls', () => {
  const doc = new JSDOM(html).window.document;
  const sections = [...doc.querySelectorAll('#section-nav button[data-go]')].map((b) => b.dataset.go);
  assert.ok(sections.length >= 3);
  for (const id of sections) assert.ok(doc.querySelector(`.pane[data-section="${id}"]`), `${id} has a pane`);
  assert.equal(doc.querySelector('.pane:not([hidden])').dataset.section, sections[0], 'the first pane is the one shown');
  const buttons = [...doc.querySelectorAll('button, input[type=submit]')].filter((b) => !b.closest('#section-nav'));
  assert.ok(!buttons.some((b) => /^\s*save\b/i.test(b.textContent || b.value || '')), 'changes save as they are made');
  const first = doc.querySelector('.pane:not([hidden])');
  const controls = first.querySelectorAll('input:not([type=hidden]), select, textarea').length;
  assert.ok(controls <= 10, `${controls} controls on the first screen`);
});

test('Q9: no voice helper, so no "Hold … to talk" call to action; the reason stays', async () => {
  const { doc } = await open();
  assert.equal(doc.getElementById('voice-preset').hidden, true);
  assert.equal(doc.getElementById('voice-hint').textContent, 'x');
});

test('Q9: the call to action starts hidden and shows only once voice-status says the helper is built', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  assert.match(html, /<button type="button" id="voice-preset" hidden /);
  const preset = (await open('file:///app/settings.html', {}, { hotkeys: [], available: true, reason: null })).doc.getElementById('voice-preset');
  assert.equal(preset.hidden, false);
  assert.equal(preset.textContent, 'Hold Control + Option + Space to talk');
});
