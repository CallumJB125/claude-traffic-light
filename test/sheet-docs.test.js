'use strict';
// Redesign R8-3b-1: the Widget page (widget-look) and Hatch (character) as documents of the Settings sheet (dev chat preview only).
// Each is its own document with its own preload; its guard is the old page id OR that one sheet document, bound only at its own
// channels. Neither uses get-config/save-config. A sheet sender never opens the old Lights or Hatch windows. Fake data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const SP = require('../src/settings-panes.js');
const Pages = require('../buddy-window/pages.js');
const WidgetPage = require('../src/widget-page.js');
const Hatch = require('../characters/hatch.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const mainSrc = read('main.js');
const winSrc = read('buddy-window/index.js');
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };
const LOOK = 'settings:widget-look';
const CHAR = 'settings:character';
const from = (pageId, main = true) => ({ pageId, main });

// ── tables and pages ───────────────────────────────────────────────────────

test('the two documents are sheet pages with their own file and preload, outside PAGES; ids are new and closed', () => {
  const look = Pages.paneById(LOOK); const ch = Pages.paneById(CHAR);
  assert.deepEqual([look.file, look.preload, { ...look.query }], ['widget-page.html', 'widget-page-preload.js', { embedded: '1', sheet: '1' }]);
  assert.deepEqual([ch.file, ch.preload, { ...ch.query }], ['hatch.html', 'hatch-preload.js', { embedded: '1' }]);
  for (const id of [LOOK, CHAR]) { assert.equal(Pages.pageById(id), null, 'gate off: the id does not exist'); assert.ok(!JSON.stringify(Pages.PAGES).includes(`"${id}"`)); assert.ok(!Pages.FUTURE_IDS.includes(id)); }
  assert.ok(SP.isOwner('widget-look') && SP.isOwner('character'));
  assert.equal(SP.isPane('widget-look'), false);
  assert.deepEqual(SP.CONFIG_OWNERS.filter((p) => ['widget-look', 'character'].includes(p)), [], 'they never use get-config / save-config');
  assert.deepEqual(SP.NAV.slice(-10, -3), ['widget-rules', 'widget-look', 'character', 'phone-pairing', 'aitools-setup', 'account-plan', 'account-sync']);
  assert.deepEqual({ ...SP.SHEET_TARGET }, { widget: 'widget-look', hatch: 'character', lights: 'widget-rules', settings: 'general', phone: 'phone-pairing', aitools: 'aitools-setup', upgrade: 'account-plan', sync: 'account-sync' });
  for (const [oldId, pane] of Object.entries(SP.SHEET_TARGET)) {
    assert.ok(Pages.pageById(oldId), `${oldId} is an old page`);
    assert.ok(pane === 'general' ? Pages.paneById('settings:general') : Pages.paneById(`settings:${pane}`), `${oldId} -> ${pane} is a sheet document`);
    assert.equal(Pages.REDIRECTS[oldId].until, 'R8', `${oldId} keeps its until: resolve() learns settings destinations at the cut-over (R6a), not in R8`);
    assert.equal(Pages.resolve(oldId, { chatFirst: true }).page, oldId, 'so nothing redirects yet');
  }
});

test('widget-look writes only the keys cleanPatch can emit; keys another pane owns are listed, not hidden', () => {
  const probe = { showWidget: true, menuBarMode: true, showTasks: true, showAgents: true, agentRoster: true, paceTooltip: true, agentChipSize: 'large',
    agentKinds: { subagent: true }, widgetSnap: 'edges', widgetSize: 'dot', widgetShortcut: 'Command+Shift+K', composeShortcut: 'Command+Shift+J', nextShortcut: 'Command+Shift+N', projectColours: { app: '#aabbcc' } };
  assert.deepEqual(Object.keys(WidgetPage.cleanPatch(probe, {})).sort(), [...SP.WIDGET_LOOK_KEYS].sort(), 'the table equals what the module can emit');
  const shared = SP.WIDGET_LOOK_KEYS.filter((k) => k in SP.KEY_OWNER);
  assert.deepEqual(shared.sort(), ['agentChipSize', 'agentKinds', 'agentRoster', 'menuBarMode', 'paceTooltip', 'showAgents', 'showTasks', 'showWidget']);
  for (const k of shared) assert.ok(SP.isPane(SP.KEY_OWNER[k]) || SP.KEY_OWNER[k] === 'none', `${k} keeps its one owner (a settings.html pane, or none)`);
  for (const k of SP.WIDGET_LOOK_KEYS.filter((x) => !(x in SP.KEY_OWNER))) assert.equal(SP.ownedKeys('widget-look').includes(k), false);
  assert.match(read('widget-page.js'), /onShown/, 'a re-shown widget page re-reads, as the settings panes do');
});

test('the two preloads expose only their own channels, never get-config / save-config', () => {
  const chans = (f) => [...read(f).matchAll(/(?:invoke|send)\('([a-z:-]+)'/g)].map((m) => m[1]).filter((c) => c !== 'settings:go-pane');
  assert.deepEqual([...new Set(chans('widget-page-preload.js'))].sort(), ['widget-page:move', 'widget-page:open', 'widget-page:preview', 'widget-page:set', 'widget-page:size', 'widget-page:state', 'widget:recent-projects']);
  assert.deepEqual([...new Set(chans('hatch-preload.js'))].sort(), ['characters:list', 'gallery-publish:begin', 'gallery-publish:copy', 'gallery-publish:draft', 'gallery-publish:open', 'hatch:close', 'hatch:describe', 'hatch:generate', 'hatch:options', 'hatch:save', 'hatch:surprise']);
});

// ── guards ─────────────────────────────────────────────────────────────────

function guards({ preview }) {
  const code = between(mainSrc, 'const sheetDoc = ', '/** A push the Lights window gets');
  const ctx = { SettingsPanes: SP, CHAT_PREVIEW: preview, fromUtilityPage: (e, id) => e?.pageId === id && e.main === true };
  vm.runInNewContext(`${code}\nglobalThis.out = { sheetDoc, widgetLookPage, fromHatch };`, ctx);
  return ctx.out;
}

test('widgetLookPage / fromHatch: the old page or that ONE sheet document (top frame, preview only), nothing else', () => {
  const g = guards({ preview: true });
  assert.equal(g.widgetLookPage(from('widget')), true);
  assert.equal(g.widgetLookPage(from(LOOK)), true);
  assert.equal(g.widgetLookPage(from(LOOK, false)), false, 'subframe');
  assert.equal(g.fromHatch(from('hatch')), true);
  assert.equal(g.fromHatch(from(CHAR)), true);
  for (const id of ['hatch', CHAR, 'settings:widget-rules', 'settings:widget', 'settings:*', 'lights', 'home', 'usage', undefined]) assert.equal(g.widgetLookPage(from(id)), false, `widget-look refuses ${id}`);
  for (const id of ['widget', LOOK, 'settings:widget-rules', 'settings:widget', 'settings:*', 'lights', 'home', undefined]) assert.equal(g.fromHatch(from(id)), false, `character refuses ${id}`);
  const off = guards({ preview: false });
  assert.equal(off.widgetLookPage(from(LOOK)), false, 'gate off: the sheet document is no sender');
  assert.equal(off.fromHatch(from(CHAR)), false);
  assert.equal(off.widgetLookPage(from('widget')), true);
  assert.equal(off.fromHatch(from('hatch')), true);
});

test('main.js: the old page ids are named only inside the two bound predicates; no generic settings:* here', () => {
  for (const id of ['widget', 'hatch']) assert.equal((mainSrc.match(new RegExp(`fromUtilityPage\\(e, '${id}'\\)`, 'g')) || []).length, 1, `${id} is named once`);
  const block = between(mainSrc, 'const sheetDoc = ', '/** A push the Lights window gets');
  assert.doesNotMatch(block, /searchParams|location|\.query|\.url/);
  assert.doesNotMatch(mainSrc, /settings:\*/);
  assert.match(mainSrc, /require\('\.\/src\/widget-page\.js'\)\.register\(\{ utilityHandle, allowed: widgetLookPage,/);
  assert.match(mainSrc, /pageAllowed: widgetLookPage/);
  assert.match(mainSrc, /allowed: \(e\) => tasksSenderOk\(e\) \|\| rulesEditor\(e\) \|\| fromHatch\(e\), publish/);
  // none of the other lights/usage guards learned about these documents
  assert.doesNotMatch(between(mainSrc, 'const rulesPane = ', 'const sheetDoc = '), /widget-look|character/);
});

test('get-config / save-config: the two documents are no senders (not config owners)', () => {
  const code = between(mainSrc, 'const settingsPaneOf = ', '// R8-2b: the widget rules editor');
  const ctx = { SettingsPanes: SP, CHAT_PREVIEW: true, fromUtilityPage: (e, id) => e?.pageId === id && e.main === true };
  vm.runInNewContext(`${code}\nconst settingsAnyPane = (e) => fromUtilityPage(e, 'settings') || settingsPaneOf(e) !== null;\nglobalThis.out = { settingsPaneOf, settingsAnyPane };`, ctx);
  for (const id of [LOOK, CHAR]) { assert.equal(ctx.out.settingsPaneOf(from(id)), null, id); assert.equal(ctx.out.settingsAnyPane(from(id)), false, id); }
  assert.equal(ctx.out.settingsPaneOf(from('settings:widget-rules')), 'widget-rules');
  assert.equal(ctx.out.settingsPaneOf(from('settings:general')), 'general');
});

// ── navigation never opens the old windows from the sheet (S2) ─────────────

function nav() {
  const calls = [];
  const g = guards({ preview: true });
  const rulesPane = (e) => e?.pageId === 'settings:widget-rules' && e.main === true;
  const rulesEditor = (e) => e?.pageId === 'lights-window' || rulesPane(e);
  const handlers = new Map();
  const ctx = { SettingsPanes: SP, sheetDoc: g.sheetDoc, fromHatch: g.fromHatch, rulesPane, rulesEditor, ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    openBuddy: (id) => calls.push(['open', id]), createHatchWindow: () => calls.push(['hatch-window']), createLightsWindow: () => calls.push(['lights-window']) };
  vm.runInNewContext(between(mainSrc, "ipcMain.handle('hatch:open'", "const HatchAi = "), ctx);
  const openPageSrc = between(mainSrc, 'openPage: (id, e) => {', ', platform: process.platform');
  const sendToPage = [];
  const openPage = vm.runInNewContext(`(${openPageSrc.slice('openPage: '.length)})`, { sheetDoc: g.sheetDoc, SettingsPanes: SP, openBuddy: (id) => calls.push(['open', id]), buddyWin: { sendToPage: (...a) => sendToPage.push(a) } });
  return { calls, handlers, openPage, sendToPage };
}

test('hatch:open / hatch:close: the sheet moves between its own documents; the old windows are still opened for the old pages', () => {
  const n = nav();
  n.handlers.get('hatch:open')(from('settings:widget-rules'));
  n.handlers.get('hatch:open')(from('lights-window'));
  n.handlers.get('hatch:open')(from('home'));
  assert.deepEqual(n.calls.splice(0), [['open', CHAR], ['hatch-window']]);
  n.handlers.get('hatch:close')(from(CHAR));
  n.handlers.get('hatch:close')(from('hatch'));
  n.handlers.get('hatch:close')(from('settings:widget-rules'));
  n.handlers.get('hatch:close')(from('home'));
  assert.deepEqual(n.calls.splice(0), [['open', 'settings:widget-rules'], ['lights-window']], 'a sheet sender never opens the Lights window');
});

test('widget-page:open: from the sheet it opens sheet documents (rules / the Widget pane), from the old page exactly what it did', () => {
  const n = nav();
  n.openPage('lights', from(LOOK)); n.openPage('settings', from(LOOK));
  assert.deepEqual(n.calls.splice(0), [['open', 'settings:widget-rules'], ['open', 'settings:widget']]);
  assert.deepEqual(n.sendToPage, [], 'no show-section push to the old page from the sheet');
  n.openPage('lights', from('widget')); n.openPage('settings', from('widget')); n.openPage('lights');
  assert.deepEqual(n.calls.splice(0), [['open', 'lights'], ['open', 'settings'], ['open', 'lights']]);
  assert.deepEqual(n.sendToPage, [['settings', 'show-section', 'widget']]);
  assert.deepEqual(WidgetPage.PAGES, ['lights', 'settings'], 'the closed list the handler accepts');
  assert.match(read('src/widget-page.js'), /\(e, id\) => \{ if \(PAGES\.includes\(id\)\) ctx\.openPage\(id, e\); return null; \}/);
});

test('settings:go-pane: the two documents can send it and be targeted by it', () => {
  const handlers = new Map(); const selected = [];
  const views = new Map(SP.OWNERS.map((p) => [`settings:${p}`, { webContents: { mainFrame: { url: 'file:///x.html' } } }]));
  const code = between(winSrc, '  const fromSettingsPane = ', '  if (chatFirst === true) ipcMain.on(\'buddy:open-newchat\'');
  vm.runInNewContext(code, { SettingsPanes: SP, localViews: views, isLocalPage: () => true, chatFirst: true, select: (id) => selected.push(id), ipcMain: { on: (c, fn) => handlers.set(c, fn) } });
  const go = handlers.get('settings:go-pane');
  const ev = (p) => { const wc = views.get(`settings:${p}`).webContents; return { sender: wc, senderFrame: wc.mainFrame }; };
  go(ev('widget-look'), 'widget'); go(ev('character'), 'widget-look'); go(ev('general'), 'character'); go(ev('general'), 'nope');
  assert.deepEqual(selected, ['settings:widget', 'settings:widget-look', 'settings:character']);
});

// ── the pages ──────────────────────────────────────────────────────────────

async function boot(file, search, api) {
  const errors = []; const calls = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const proxy = (names) => new Proxy({}, { get: (_, k) => {
    if (k === 'then') return undefined;
    if (/^on[A-Z]/.test(String(k))) return (cb) => { calls.push(`${String(k)}`); proxy.hooks = proxy.hooks || {}; proxy.hooks[String(k)] = cb; };
    return (...a) => { calls.push(String(k)); const v = names[k]; return Promise.resolve(v === undefined ? null : JSON.parse(JSON.stringify(v))); };
  } });
  let closed = false;
  const dom = await JSDOM.fromFile(path.join(root, file), {
    url: `file://${root}/${file}${search}`, runScripts: 'dangerously', resources: 'usable', virtualConsole: vc, pretendToBeVisual: true,
    beforeParse(w) {
      for (const [k, v] of Object.entries(api)) w[k] = proxy(v);
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
      w.requestAnimationFrame = () => 0; w.cancelAnimationFrame = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy(function () {}, { get: (t, k) => (k === 'canvas' ? {} : (() => ({ width: 0 }))), set: () => true });
      const qm = w.queueMicrotask.bind(w); w.queueMicrotask = (cb) => qm(() => { try { cb(); } catch (e) { if (!closed) throw e; } });
    },
  });
  if (dom.window.document.readyState !== 'complete') await new Promise((r) => dom.window.addEventListener('load', r));
  await new Promise((r) => setTimeout(r, 500));
  return { w: dom.window, calls, errors, hooks: () => proxy.hooks || {}, close: () => { closed = true; dom.window.stop(); dom.window.close(); } };
}
const WIDGET_STATE = { config: { showWidget: true, menuBarMode: false, showTasks: true, showAgents: true, agentRoster: true, paceTooltip: true, agentChipSize: 'normal', agentKinds: {}, widgetSnap: 'corners', widgetSize: 'normal', widgetShortcut: '', composeShortcut: '', projectColours: {} },
  visible: true, width: 200, corner: 'top-left', limits: { minWidth: 100, maxWidth: 400 }, held: false, platform: 'darwin', compose: null };

test('the widget page in the sheet: Back to Settings, a fresh read when shown again; the old page has neither', async () => {
  const sheet = await boot('widget-page.html', '?embedded=1&sheet=1', { widgetPageApi: { state: WIDGET_STATE, preview: null, recentProjects: [] } });
  try {
    assert.deepEqual(sheet.errors, []);
    const btn = sheet.w.document.getElementById('back-settings');
    assert.equal(btn.hidden, false);
    const before = sheet.calls.filter((c) => c === 'state').length;
    await sheet.hooks().onShown();
    assert.ok(sheet.calls.filter((c) => c === 'state').length > before, 'shown again -> re-read');
    btn.click();
    assert.ok(sheet.calls.includes('goPane'));
  } finally { sheet.close(); }
  const old = await boot('widget-page.html', '', { widgetPageApi: { state: WIDGET_STATE, preview: null, recentProjects: [] } });
  try {
    assert.equal(old.w.document.getElementById('back-settings').hidden, true);
    assert.equal(old.calls.includes('onShown'), false);
    assert.equal(old.calls.includes('goPane'), false);
  } finally { old.close(); }
});

test('the hatch page in the sheet says it goes back to the widget configuration and calls hatch:close', async () => {
  const api = { hatch: { options: { shapes: Hatch.SHAPES, sizes: Hatch.SIZES, arms: Hatch.ARMS, accessories: Hatch.ACCESSORIES, ai: false }, generate: null, describe: null, surprise: null, save: null, close: null }, userCharacters: { list: [] }, galleryPublishApi: {} };
  const b = await boot('hatch.html', '?embedded=1', api);
  try {
    assert.deepEqual(b.errors, []);
    assert.equal(b.w.document.getElementById('close').textContent, 'Back to widget configuration');
    b.w.document.getElementById('close').click();
    assert.ok(b.calls.includes('close'));
  } finally { b.close(); }
});
