'use strict';
// Redesign R8-2b: the widget rules editor in the Settings sheet (settings:widget-rules, dev chat preview only).
// lights.html in view=rules, with lights-preload.js. Its guard (rulesEditor) is bound only at the rules-editor channels;
// every Usage / Stats / spend channel of the same preload stays uncallable from it; it has its own key list and one
// deliberate cross-write (a template's prefs). Fake data only; no real CLI, no real home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const SP = require('../src/settings-panes.js');
const Pages = require('../buddy-window/pages.js');
const Rules = require('../rules.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const mainSrc = read('main.js');
const preloadSrc = read('lights-preload.js');
const winSrc = read('buddy-window/index.js');
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };
const RULES = 'settings:widget-rules';

// What the rules editor may call, and what it may not. Every lights-preload channel must be in exactly one list.
const RULES_CHANNELS = [
  'get-config', 'save-config', 'hatch:open', 'hatch:remove', 'get-aggregate-status', 'preview-sound', 'choose-sound-file', 'export-rules', 'import-rules',
  'preview-on-widget', 'check-auto-rule', 'rule-notify:status', 'cameos-list', 'cameos-choose-file', 'cameos-add', 'cameos-remove', 'characters:list',
  'gallery-publish:begin', 'gallery-publish:draft', 'gallery-publish:open', 'gallery-publish:copy',
];
const REFUSED_CHANNELS = [
  'reset-rules', 'setup-export', 'setup-import-pick', 'setup-import-apply', 'tour:action', 'open-preferences', 'connect-agent', 'signal-endpoint',
  'burst:chip', 'burst:usage', 'usage:limits', 'spend-safety:get', 'spend-safety:set', 'get-stats', 'export-stats', 'get-costs', 'save-spend-limits',
  'usage:open-ai-tools', 'usage:open-optimiser', 'usage:open-auto-answer', 'model-mix', 'usage-bundle', 'work-cost', 'work-cost-export', 'cost-rollup',
  'cost-guard:report', 'cost-guard:set', 'cost-guard:resume',
];

// ── the table ──────────────────────────────────────────────────────────────

test('the rules pane owns exactly its five keys; crossWrites equals the union of every template\'s prefs and each belongs to another pane', () => {
  assert.deepEqual(SP.ownedKeys(SP.RULES_PANE).sort(), ['autoAnswer', 'character', 'presets', 'rules', 'template']);
  assert.deepEqual(SP.WIDGET_RULES.control, ['__backupReason', '__prefsFrom']);
  const union = new Set();
  for (const t of Rules.templates()) for (const k of Object.keys(t.prefs)) union.add(k);
  assert.deepEqual([...union].sort(), Object.keys(SP.WIDGET_RULES.crossWrites).sort(), 'a new template pref needs a reviewed crossWrites row');
  for (const [k, why] of Object.entries(SP.WIDGET_RULES.crossWrites)) {
    assert.ok(SP.isPane(SP.KEY_OWNER[k]), `${k} belongs to another pane`);
    assert.ok(typeof why === 'string' && why.length > 20, `${k} has a reason`);
  }
  assert.deepEqual(SP.readKeys(SP.RULES_PANE).sort(), ['autoAnswer', 'character', 'notifyStates', 'presets', 'rules', 'simpleMode', 'spend', 'template']);
  assert.equal(SP.isPane(SP.RULES_PANE), false, 'it is not one of settings.html\'s sections');
  assert.equal(SP.isOwner(SP.RULES_PANE), true);
  assert.ok(SP.NAV.includes(SP.RULES_PANE));
  // No settings.html pane writes the keys the rules pane owns.
  for (const k of SP.ownedKeys(SP.RULES_PANE)) assert.equal(SP.KEY_OWNER[k], SP.RULES_PANE);
  const saved = read('settings.js');
  const saveAll = saved.slice(saved.indexOf('async function saveAll()'), saved.indexOf('\n    }\n', saved.indexOf('async function saveAll()')));
  for (const k of SP.ownedKeys(SP.RULES_PANE)) assert.doesNotMatch(saveAll, new RegExp(`^        ${k}:`, 'm'), `${k} is not in the page-wide save`);
});

test('every lights-preload channel is classified: rules editor or refused, never both, never neither', () => {
  const channels = new Set([...preloadSrc.matchAll(/(?:invoke|send)\('([a-z:-]+)'/g)].map((m) => m[1]).filter((c) => c !== 'settings:go-pane'));
  assert.ok(channels.size > 40);
  for (const c of channels) assert.equal(Number(RULES_CHANNELS.includes(c)) + Number(REFUSED_CHANNELS.includes(c)), 1, `${c} needs one classification`);
  for (const c of [...RULES_CHANNELS, ...REFUSED_CHANNELS]) assert.ok(channels.has(c), `${c} is in the preload`);
});

// ── the guard ──────────────────────────────────────────────────────────────

const from = (pageId, main = true) => ({ pageId, main });
function guards({ preview, lights = false }) {
  const code = between(mainSrc, 'const rulesPane = ', '/** A push the Lights window gets');
  const ctx = {
    SettingsPanes: SP, CHAT_PREVIEW: preview, widgetConfigSender: (e) => lights && e?.pageId === 'lights-window' && e.main === true,
    fromUtilityPage: (e, id) => e?.pageId === id && e.main === true,
  };
  vm.runInNewContext(`${code}\nglobalThis.out = { rulesPane, rulesEditor };`, ctx);
  return ctx.out;
}

test('rulesEditor: the Lights window and the rules pane (top frame, preview only); nothing else', () => {
  const g = guards({ preview: true, lights: true });
  assert.equal(g.rulesEditor(from('lights-window')), true, 'the Lights window is unchanged');
  assert.equal(g.rulesEditor(from(RULES)), true);
  assert.equal(g.rulesEditor(from(RULES, false)), false, 'subframe');
  for (const id of ['usage', 'stats', 'lights', 'settings', 'settings:widget', 'settings:privacy', 'settings:*', 'settings:projects', 'home', 'hatch', undefined]) assert.equal(g.rulesEditor(from(id)), false, String(id));
  const off = guards({ preview: false, lights: true });
  assert.equal(off.rulesEditor(from(RULES)), false, 'gate off: the page is no sender');
  assert.equal(off.rulesEditor(from('lights-window')), true);
});

test('main.js: rulesEditor sits only on the rules-editor channels; every refused channel keeps its own guard; no other module sees it', () => {
  assert.doesNotMatch(mainSrc, /\bsettingsOnly\(/);
  const lines = mainSrc.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\brulesEditor\b/.test(l) && !/^const rulesEditor =/.test(l) && !l.trim().startsWith('//'));
  const known = [...RULES_CHANNELS.filter((c) => !['get-config', 'save-config'].includes(c)), 'configReader', 'Publish.register', 'rule-notify-main'];
  for (const [n, l] of lines) assert.ok(known.some((c) => l.includes(c)) || /^const configReader/.test(l) || /^  if \(!rulesEditor\(e\)\) return false;$/.test(l), `main.js:${n} binds rulesEditor to something not in the list: ${l.slice(0, 100)}`);
  // each rules channel is wired to rulesEditor (directly or through its injected predicate)
  for (const c of RULES_CHANNELS.filter((c) => !['get-config', 'save-config', 'rule-notify:status', 'hatch:remove'].includes(c) && !c.startsWith('gallery-publish:'))) {
    assert.match(mainSrc, new RegExp(`['"]${c.replace(/[:-]/g, '\\$&')}['"][^\\n]{0,90}rulesEditor`), c);
  }
  assert.match(mainSrc, /ipcMain\.handle\('hatch:remove', \(e, id\) => \{\n  if \(!rulesEditor\(e\)\) return false;/, 'hatch:remove');
  assert.match(mainSrc, /handle: utilityHandle, allowed: rulesEditor, config: loadConfig/, 'rule-notify:status');
  assert.match(mainSrc, /Publish\.register\(\{ ipcMain, allowed: \(e\) => tasksSenderOk\(e\) \|\| rulesEditor\(e\)/, 'gallery-publish:*');
  // refused channels: whichever line registers them does not mention rulesEditor
  for (const c of REFUSED_CHANNELS) {
    for (const [, l] of mainSrc.split('\n').map((l, i) => [i, l])) if (l.includes(`'${c}'`)) assert.doesNotMatch(l, /rulesEditor/, c);
  }
  for (const f of fs.readdirSync(path.join(root, 'src'))) if (f.endsWith('.js')) assert.doesNotMatch(read(`src/${f}`), /rulesEditor/, f);
  assert.doesNotMatch(between(mainSrc, 'const rulesPane = ', '/** A push the Lights window gets'), /searchParams|location|\.query|\.url/, 'authority is the page id main created');
});

// ── save-config / get-config as main wires them ────────────────────────────

const STORED = { rules: [{ id: 'r1' }], template: null, presets: [], character: {}, autoAnswer: { v: 1, rules: [] }, simpleMode: false, notifyStates: { offline: true, 'turn-failed': true }, spend: { dailyLimit: 5, notifyBudgetWarning: true }, seasonal: true, showAgents: true, sounds: { on: true } };
function handlers({ preview = true } = {}) {
  const g = guards({ preview, lights: true });
  const h = new Map();
  const log = { commits: [], warns: [] };
  const start = mainSrc.indexOf("utilityHandle('get-config', configReader");
  const end = mainSrc.indexOf('// saveConfig plus everything', start);
  const settingsPaneOf = (e) => (preview ? SP.OWNERS.find((p) => e?.pageId === `settings:${p}` && e.main === true) ?? null : null);
  const ctx = {
    SettingsPanes: SP, Rules, settingsPaneOf, fromUtilityPage: (e, id) => e?.pageId === id && e.main === true, CHAT_PREVIEW: preview, settingsAnyPane: (e) => e?.pageId === 'settings' || settingsPaneOf(e) !== null,
    configReader: (e) => g.rulesEditor(e) || settingsPaneOf(e) !== null, widgetConfigSender: (e) => e?.pageId === 'lights-window',
    loadConfig: () => STORED, commitConfig: (p) => { log.commits.push(JSON.parse(JSON.stringify(p))); return { ...STORED, ...p, persona: 'SECRET' }; },
    utilityHandle: (ch, guard, fn) => h.set(ch, (e, ...a) => (guard(e) ? fn(e, ...a) : null)),
    console: { warn: (m) => log.warns.push(String(m)) },
  };
  vm.runInNewContext(`${between(mainSrc, 'const sameValue = ', '// O3: the Tasks helper')}\n${mainSrc.slice(start, end)}`, ctx);
  return { call: (ch, e, ...a) => h.get(ch)(e, ...a), log };
}
const impliedSave = (tpl) => {
  const { notifyStates, spend, ...rest } = tpl.prefs;
  return { rules: [{ id: 'r1' }], template: null, __prefsFrom: tpl.id, ...rest, ...(notifyStates && { notifyStates: { ...STORED.notifyStates, ...notifyStates } }), ...(spend && { spend: { ...STORED.spend, ...spend } }) };
};

test('save-config from the rules pane: its own keys and the control field are stored; the response is only what it may read', () => {
  const h = handlers();
  const r = h.call('save-config', from(RULES), { rules: [{ id: 'r2' }], template: 'quiet', presets: [], __backupReason: 'template' });
  assert.deepEqual(Object.keys(r).sort(), SP.readKeys(SP.RULES_PANE).filter((k) => k in STORED).sort(), 'no key outside WIDGET_RULES.reads in the answer');
  assert.equal(r.persona, undefined);
  assert.equal(h.log.commits.length, 1);
  assert.deepEqual(Object.keys(h.call('get-config', from(RULES))).sort(), Object.keys(r).sort(), 'get-config answers the same view');
  assert.equal(h.call('get-config', from(RULES)).showAgents, undefined);
  assert.equal(h.call('save-config', from(RULES, false), { rules: [] }), null, 'subframe');
  assert.equal(handlers({ preview: false }).call('save-config', from(RULES), { rules: [] }), null, 'gate off');
});

test('save-config from the rules pane: a foreign key refuses the whole save, logs key names only, applies nothing', () => {
  const h = handlers();
  for (const bad of [{ rules: [], showAgents: false }, { rules: [], sounds: { SECRET: 1 } }, { rules: [], integrations: {} }, { constructor: 1 }, null, [], 'x']) {
    const r = h.call('save-config', from(RULES), bad);
    assert.match(r.error, /not on this page/, JSON.stringify(bad));
  }
  assert.deepEqual(h.log.commits, [], 'no partial apply');
  assert.ok(h.log.warns.length >= 6);
  assert.match(h.log.warns[0], /widget-rules/);
  assert.match(h.log.warns[0], /showAgents/);
  assert.doesNotMatch(h.log.warns.join('\n'), /SECRET/, 'key names only');
});

test('crossWrites: only in the same save as a template, only the values that template implies', () => {
  const h = handlers();
  const withPrefs = Rules.templates().filter((t) => Object.keys(t.prefs).length);
  assert.ok(withPrefs.length >= 2);
  for (const tpl of withPrefs) {
    const r = h.call('save-config', from(RULES), impliedSave(tpl));
    assert.equal(r.error, undefined, `${tpl.id}: its own prefs are allowed`);
  }
  assert.equal(h.log.commits.length, withPrefs.length);
  const n = h.log.commits.length;
  const tpl = withPrefs.find((t) => t.prefs.spend) || withPrefs[0];
  // a rule-only save that carries a cross key
  for (const k of Object.keys(SP.WIDGET_RULES.crossWrites)) assert.match(h.call('save-config', from(RULES), { rules: [], [k]: k === 'spend' || k === 'notifyStates' ? {} : false }).error, /not on this page/, `rule-only ${k}`);
  // the named template does not imply this key / this value
  const other = Rules.templates().find((t) => !('spend' in t.prefs));
  assert.match(h.call('save-config', from(RULES), { rules: [], __prefsFrom: other.id, spend: { dailyLimit: 1 } }).error, /not on this page/, 'a key the template does not imply');
  const bad = impliedSave(tpl); const key = Object.keys(tpl.prefs)[0];
  bad[key] = typeof tpl.prefs[key] === 'object' ? { ...bad[key], [Object.keys(tpl.prefs[key])[0]]: 'tampered' } : !tpl.prefs[key];
  assert.match(h.call('save-config', from(RULES), bad).error, /not on this page/, 'a value the template does not imply');
  assert.match(h.call('save-config', from(RULES), { rules: [], __prefsFrom: 'no-such-template', seasonal: false }).error, /not on this page/, 'unknown template');
  assert.match(h.call('save-config', from(RULES), { rules: [], __prefsFrom: ['quiet'], seasonal: false }).error, /not on this page/);
  assert.equal(h.log.commits.length, n, 'nothing applied by the refused ones');
  // another pane may not use the control field to write the rules pane's neighbours
  assert.match(h.call('save-config', from('settings:widget'), { seasonal: false, __prefsFrom: tpl.id }).error, /not on this page/);
});

test('commitConfig strips both control fields', () => {
  const body = between(mainSrc, 'function commitConfig(partial) {', 'const next = saveConfig(partial)');
  assert.match(body, /delete partial\.__backupReason;/);
  assert.match(body, /delete partial\.__prefsFrom;/);
});

// ── routing ────────────────────────────────────────────────────────────────

test('pages: the rules pane is a local lights.html view with the lights preload, outside PAGES; it is a go-pane target and a go-pane sender', () => {
  const p = Pages.paneById(RULES);
  assert.equal(p.file, 'lights.html');
  assert.equal(p.preload, 'lights-preload.js');
  assert.deepEqual({ ...p.query }, { embedded: '1', view: 'rules' });
  assert.equal(Pages.pageById(RULES), null, 'gate off: the id does not exist');
  assert.equal(Pages.paneById('settings:widget-rules2'), null);
  // go-pane: sender can be the rules pane, target can be it, the closed list is OWNERS
  const handlers = new Map(); const selected = [];
  const wc = { mainFrame: {} };
  wc.mainFrame.url = 'file:///lights.html';
  const views = new Map([[RULES, { webContents: wc }]]);
  const code = between(winSrc, '  const fromSettingsPane = ', '  if (chatFirst === true) ipcMain.on(\'buddy:open-newchat\'');
  vm.runInNewContext(code, { SettingsPanes: SP, localViews: views, isLocalPage: (u) => u === 'file:///lights.html', chatFirst: true, select: (id) => selected.push(id), ipcMain: { on: (c, fn) => handlers.set(c, fn) } });
  const go = handlers.get('settings:go-pane');
  const ev = { sender: wc, senderFrame: wc.mainFrame };
  go(ev, 'widget'); go(ev, 'widget-rules'); go(ev, 'nope'); go(ev, 'settings:widget'); go({ sender: wc, senderFrame: {} }, 'general'); go({ sender: {}, senderFrame: wc.mainFrame }, 'general');
  assert.deepEqual(selected, ['settings:widget', 'settings:widget-rules']);
  assert.match(preloadSrc, /goPane: \(pane\) => ipcRenderer\.send\('settings:go-pane'/);
});

test('pushes: the rules pane gets status-changed and motion-paused only with the preview on', () => {
  const sent = [];
  const mk = (preview) => { const o = []; vm.runInNewContext(`${between(mainSrc, '/** A push the Lights window gets', 'const sameValue')}\nglobalThis.sendToRules = sendToRules;`, { CHAT_PREVIEW: preview, SettingsPanes: SP, buddyWin: { sendToPage: (...a) => o.push(a) }, globalThis: {} }); return o; };
  void sent; void mk;
  const run = (preview) => { const o = []; const ctx = { CHAT_PREVIEW: preview, SettingsPanes: SP, buddyWin: { sendToPage: (...a) => o.push(a) } }; vm.runInNewContext(`${between(mainSrc, '/** A push the Lights window gets', 'const sameValue')}\nsendToRules('status-changed'); sendToRules('motion-paused', true);`, ctx); return o; };
  assert.deepEqual(run(true), [[RULES, 'status-changed'], [RULES, 'motion-paused', true]]);
  assert.deepEqual(run(false), [], 'gate off: nothing is sent');
  assert.match(mainSrc, /lightsWin\?\.webContents\.send\('status-changed'\);\n  sendToRules\('status-changed'\);/);
  assert.match(mainSrc, /syncBackgroundThrottling\(lightsWin\.webContents, paused\); \}\n  sendToRules\('motion-paused', paused\);/);
});

// ── the page ───────────────────────────────────────────────────────────────

const NOW = { rules: Rules.defaultRules(), template: null, presets: [], character: Rules.normalizeCharacter ? Rules.normalizeCharacter({}) : {}, autoAnswer: { v: 1, rules: [] }, simpleMode: false, notifyStates: { offline: true }, spend: { dailyLimit: 5, notifyBudgetWarning: true } };

async function boot({ search, config = NOW }) {
  const calls = []; const saves = []; const hooks = {}; const errors = []; let closed = false;
  let stored = JSON.parse(JSON.stringify(config));
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(`${e.message} ${(e.detail && e.detail.stack || '').split('\n').slice(0, 3).join(' | ')}`));
  const fixtures = { getAggregateStatus: { sessions: [], look: { lamp: 'green', name: 'Idle' }, owners: [] }, ruleNotifyStatus: {}, showAutoAnswer: true, cameos: null };
  const api = new Proxy({}, { get: (_, k) => {
    if (k === 'then') return undefined;
    if (k === 'showAutoAnswer') return true;
    if (k === 'cameos') return { list: async () => { calls.push('cameos.list'); return []; }, chooseFile: async () => null, add: async () => null, remove: async () => null };
    if (/^on[A-Z]/.test(String(k))) return (cb) => { hooks[String(k)] = cb; };
    return async (...a) => {
      calls.push(String(k));
      if (k === 'getConfig') return JSON.parse(JSON.stringify(stored));
      if (k === 'saveConfig') { saves.push(a[0]); stored = { ...stored, ...JSON.parse(JSON.stringify(a[0])) }; return JSON.parse(JSON.stringify(stored)); }
      const v = fixtures[k]; return v === undefined ? null : v;
    };
  } });
  const dom = await JSDOM.fromFile(path.join(root, 'lights.html'), {
    url: `file://${root}/lights.html${search}`, runScripts: 'dangerously', resources: 'usable', virtualConsole: vc, pretendToBeVisual: true,
    beforeParse(w) {
      w.lightsApi = api; w.galleryPublishApi = { begin: async () => null }; w.userCharacters = { list: async () => [], onChange() {} }; w.tourApi = { onStep() {}, action: async () => null };
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy(function () {}, { get: (t, k) => (k === 'canvas' ? {} : (() => ({ width: 0 }))), set: () => true });
      // a microtask the page queued before the test closed its window must not report into a closed window
      const qm = w.queueMicrotask.bind(w); w.queueMicrotask = (cb) => qm(() => { try { cb(); } catch (e) { if (!closed) throw e; } });
      w.requestAnimationFrame = () => 0; w.cancelAnimationFrame = () => {}; // the rig's animation loop is not under test
      w.IntersectionObserver = class { observe() {} disconnect() {} }; w.ResizeObserver = class { observe() {} disconnect() {} };
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
    },
  });
  if (dom.window.document.readyState !== 'complete') await new Promise((r) => dom.window.addEventListener('load', r));
  await new Promise((r) => setTimeout(r, 900));
  return { w: dom.window, calls, saves, hooks, errors, setStored: (c) => { stored = { ...stored, ...c }; }, close: () => { closed = true; dom.window.stop(); dom.window.close(); } };
}
const PANE_QUERY = '?embedded=1&view=rules';

test('the rules page boots in the sheet: editor shown, Back to Settings link, no Usage or Stats tab, no refused channel called', async () => {
  const b = await boot({ search: PANE_QUERY });
  try {
    const d = b.w.document;
    assert.deepEqual(b.errors, []);
    assert.ok(d.body.classList.contains('embedded-rules'));
    assert.equal(d.getElementById('back-settings').hidden, false);
    assert.ok([undefined, 'rules'].includes(d.getElementById('main').dataset.view));
    assert.ok(d.querySelectorAll('#rule-list > *, #rules .rule').length > 0 || d.getElementById('rule-count').textContent.length > 0, 'the rules list renders');
    d.getElementById('view-stats').click(); d.getElementById('view-mix').click(); d.getElementById('ut-mix').click();
    assert.ok([undefined, 'rules'].includes(d.getElementById('main').dataset.view), 'Usage and Stats cannot be switched to');
    const channelOf = { getStats: 'get-stats', getCosts: 'get-costs', modelMix: 'model-mix', usageBundle: 'usage-bundle', workCost: 'work-cost', costRollup: 'cost-rollup', burstChip: 'burst:chip', burstUsage: 'burst:usage', limits: 'usage:limits', openPreferences: 'open-preferences', saveSpendLimits: 'save-spend-limits', connectAgent: 'connect-agent', signalEndpoint: 'signal-endpoint', resetRules: 'reset-rules', exportSetup: 'setup-export', importSetupPick: 'setup-import-pick' };
    for (const c of b.calls) assert.equal(c in channelOf, false, `the rules pane called ${c} (${channelOf[c]})`);
    d.getElementById('back-settings').click();
  } finally { b.close(); }
});

test('the page is unchanged elsewhere: the Lights window, Usage and Stats ignore view=rules, and the sheet link stays hidden', async () => {
  for (const search of ['?view=rules', '?embedded=1&view=mix', '?embedded=1&view=stats', '?utility=widget']) {
    const b = await boot({ search });
    try {
      const d = b.w.document;
      assert.equal(d.body.classList.contains('embedded-rules'), false, search);
      assert.equal(d.getElementById('back-settings').hidden, true, search);
    } finally { b.close(); }
  }
  const m = await boot({ search: '?embedded=1&view=mix' });
  try { assert.equal(m.w.document.getElementById('main').dataset.view, 'mix'); } finally { m.close(); }
});

test('applying a template re-reads spend and notifyStates first, merges into the fresh ones, and names the template; a plain edit sends only owned keys', async () => {
  const tpl = Rules.templates().find((t) => t.prefs.spend);
  const b = await boot({ search: PANE_QUERY });
  try {
    const d = b.w.document;
    // another pane changes spend after this page loaded
    b.setStored({ spend: { dailyLimit: 99, notifyBudgetWarning: true }, notifyStates: { offline: true, 'turn-failed': true } });
    d.querySelector(`[data-template="${tpl.id}"]`).click();
    await new Promise((r) => setTimeout(r, 200));
    d.getElementById('save-btn')?.click();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(b.saves.length, 1, 'saved once');
    const s = b.saves[0];
    assert.equal(s.__prefsFrom, tpl.id);
    assert.equal(s.spend.dailyLimit, 99, 'the Spend pane\'s newer value survives the template');
    for (const [k, v] of Object.entries(tpl.prefs.spend)) assert.equal(s.spend[k], v, `template pref ${k} applied`);
    assert.ok(SP.writesAllowed(SP.RULES_PANE, Object.fromEntries(Object.entries(s).filter(([k]) => !SP.crossKeys({ [k]: 1 }).length))), 'everything else it sent is owned');
    assert.equal(s.template, tpl.id);
  } finally { b.close(); }
  const plain = await boot({ search: PANE_QUERY });
  try {
    const d = plain.w.document;
    d.querySelector('#editor input[type="text"], #editor input:not([type])')?.dispatchEvent(new plain.w.Event('input', { bubbles: true }));
    const before = plain.saves.length; const reads = plain.calls.filter((c) => c === 'getConfig').length;
    d.getElementById('save-btn')?.click();
    await new Promise((r) => setTimeout(r, 300));
    for (const s of plain.saves.slice(before)) assert.deepEqual(Object.keys(s).filter((k) => !['rules', 'template', '__backupReason'].includes(k)), [], 'a rule-only save carries no other pane\'s key and no spend read');
    assert.equal(plain.calls.filter((c) => c === 'getConfig').length, reads, 'no extra config read for a plain edit');
    assert.ok(plain.saves.length > before, 'the edit was saved');
  } finally { plain.close(); }
});

test('when the sheet shows the page again it re-reads: a rules change made elsewhere shows, and unsaved edits are kept', async () => {
  const b = await boot({ search: PANE_QUERY });
  try {
    const d = b.w.document;
    assert.equal(typeof b.hooks.onShown, 'function', 'the page listens for settings:shown');
    const first = Rules.normalizeRule(NOW.rules[0]);
    const renamed = JSON.parse(JSON.stringify(NOW.rules)); renamed[0].name = 'Renamed elsewhere';
    b.setStored({ rules: renamed });
    await b.hooks.onShown();
    await new Promise((r) => setTimeout(r, 200));
    assert.match(d.getElementById('rules').textContent, /Renamed elsewhere/);
    assert.notEqual(first.name, 'Renamed elsewhere');
  } finally { b.close(); }
});

test('the preload and page changes are inert without the sheet: no goPane/onShown call outside the rules pane', () => {
  const view = read('lights-view.js');
  const uses = [...view.matchAll(/lightsApi\.(goPane|onShown)/g)];
  assert.equal(uses.length, 2);
  const block = between(view, '  if (rulesPane) {\n    $(\'back-settings\')', '  window.lightsApi.onMotionPaused');
  assert.match(block, /goPane/);
  assert.match(block, /onShown/);
  assert.match(read('lights.html'), /#back-settings\[hidden\] \{ display: none; \}/, 'a .btn would otherwise show the hidden link in the Lights window');
  assert.match(view, /const rulesPane = pageQuery\.get\('embedded'\) === '1' && pageQuery\.get\('view'\) === 'rules';/);
});
