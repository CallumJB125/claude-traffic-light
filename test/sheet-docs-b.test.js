'use strict';
// Redesign R8-3b-2: Phone pairing and AI tools setup as documents of the Settings sheet (dev chat preview only).
// Same shape as sheet-docs.test.js: own page id, own preload, a predicate bound to that one document, no config owner.
// The sheet's AI tools document never takes the pending aitools:focus (it belongs to the page aiToolsOpen opens). Fake data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const SP = require('../src/settings-panes.js');
const Pages = require('../buddy-window/pages.js');
const AiToolsMain = require('../src/ai-tools-main.js');
const Wiring = require('../src/paid-wiring.js');
const { testTempDir } = require('./helpers/tmp');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const mainSrc = read('main.js');
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };
const PHONE = 'settings:phone-pairing';
const TOOLS = 'settings:aitools-setup';
const from = (pageId, main = true) => ({ pageId, main });

function guards({ preview }) {
  const code = `${between(mainSrc, 'const sheetDoc = ', 'const widgetLookPage')}\n${between(mainSrc, 'const phonePage = ', 'const fromHatch')}`;
  const ctx = { SettingsPanes: SP, CHAT_PREVIEW: preview, fromUtilityPage: (e, id) => e?.pageId === id && e.main === true };
  vm.runInNewContext(`${code}\nglobalThis.out = { phonePage, aiToolsPage };`, ctx);
  return ctx.out;
}

test('the two documents: own file and preload, outside PAGES, never config owners, in the nav and the redirect map', () => {
  const ph = Pages.paneById(PHONE); const ai = Pages.paneById(TOOLS);
  assert.deepEqual([ph.file, ph.preload, { ...ph.query }], ['phone-pairing.html', 'phone-pairing-preload.js', { embedded: '1', sheet: '1' }]);
  assert.deepEqual([ai.file, ai.preload, { ...ai.query }], ['aitools.html', 'aitools-preload.js', { embedded: '1', sheet: '1' }]);
  for (const id of [PHONE, TOOLS]) { assert.equal(Pages.pageById(id), null); assert.ok(!JSON.stringify(Pages.PAGES).includes(`"${id}"`)); assert.ok(!Pages.FUTURE_IDS.includes(id)); }
  for (const p of ['phone-pairing', 'aitools-setup']) { assert.ok(SP.isOwner(p)); assert.equal(SP.isPane(p), false); assert.ok(!SP.CONFIG_OWNERS.includes(p)); assert.ok(SP.NAV.includes(p)); }
  assert.equal(SP.SHEET_TARGET.phone, 'phone-pairing');
  assert.equal(SP.SHEET_TARGET.aitools, 'aitools-setup');
  for (const old of ['phone', 'aitools']) assert.equal(Pages.REDIRECTS[old].until, 'R8', 'redirect rows keep their until: dropped at the R6a cut-over');
});

test('the preloads expose only their own channels, never get-config / save-config', () => {
  const chans = (f) => [...new Set([...read(f).matchAll(/(?:invoke|send|on)\('([A-Za-z:-]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(chans('phone-pairing-preload.js'), ['phone:changed', 'phone:pair-cancel', 'phone:pair-confirm', 'phone:pair-start', 'phone:revoke', 'phone:set', 'phone:state', 'phone:upgrade', 'settings:go-pane', 'settings:shown']);
  assert.deepEqual(chans('aitools-preload.js'), ['aitools:add-custom', 'aitools:connect', 'aitools:connect-all', 'aitools:copy', 'aitools:disconnect', 'aitools:fix-runner', 'aitools:focus', 'aitools:open-install', 'aitools:preview', 'aitools:remove-custom', 'aitools:scan', 'aitools:undo', 'burst-action', 'burst:codex-routing', 'mcp-set-enabled', 'mcp-status', 'settings:go-pane', 'settings:shown', 'status-changed']);
});

test('phonePage / aiToolsPage: the old page or that ONE document (top frame, preview only)', () => {
  const g = guards({ preview: true });
  assert.equal(g.phonePage(from('phone')), true);
  assert.equal(g.phonePage(from(PHONE)), true);
  assert.equal(g.phonePage(from(PHONE, false)), false);
  for (const id of ['aitools', TOOLS, 'settings:phone', 'settings:widget-look', 'settings:character', 'settings:*', 'settings', 'home', undefined]) assert.equal(g.phonePage(from(id)), false, `phone refuses ${id}`);
  assert.equal(g.aiToolsPage(from('aitools')), true);
  assert.equal(g.aiToolsPage(from(TOOLS)), true);
  assert.equal(g.aiToolsPage(from(TOOLS, false)), false);
  for (const id of ['phone', PHONE, 'settings:aitools', 'settings:widget-look', 'settings:*', 'settings', 'home', undefined]) assert.equal(g.aiToolsPage(from(id)), false, `aitools refuses ${id}`);
  const off = guards({ preview: false });
  assert.equal(off.phonePage(from(PHONE)), false); assert.equal(off.aiToolsPage(from(TOOLS)), false);
  assert.equal(off.phonePage(from('phone')), true); assert.equal(off.aiToolsPage(from('aitools')), true);
});

test('main.js binds the successors at every wiring site of the two documents, and nowhere else', () => {
  assert.equal((mainSrc.match(/fromUtilityPage\(e, 'phone'\)/g) || []).length, 1);
  assert.equal((mainSrc.match(/fromUtilityPage\(e, 'aitools'\)/g) || []).length, 2, 'the successor and the focus guard');
  assert.doesNotMatch(mainSrc, /settings:\*/);
  assert.match(mainSrc, /phoneAllowed: phonePage,/);
  assert.match(mainSrc, /utilityHandle\('mcp-status', aiToolsPage,/);
  assert.match(mainSrc, /utilityHandle\('mcp-set-enabled', aiToolsPage,/);
  assert.match(mainSrc, /fromPage: aiToolsPage, focusAllowed: \(e\) => fromUtilityPage\(e, 'aitools'\),/);
  assert.match(mainSrc, /aitoolsAllowed: aiToolsPage/);
  assert.match(mainSrc, /phoneViews: \(\) => \['phone', `settings:\$\{SettingsPanes\.PHONE_PAIRING\}`\]\.map\(\(id\) => buddyWin\?\.pageWebContents\(id\)\)/);
  assert.match(read('src/ai-tools-wire.js'), /AiToolsMain\.register\(\{ ipcMain, fromPage, focusAllowed, shell,/);
  assert.match(mainSrc, /\['usage', 'stats', 'help', 'aitools', `settings:\$\{SettingsPanes\.AITOOLS_SETUP\}`\]/);
  assert.equal((mainSrc.match(/CHAT_PREVIEW/g) || []).length, 15, 'no new gate use');
});

test('aitools:focus: the sheet document never consumes the pending focus; the old page still does (S1)', async () => {
  const handlers = new Map();
  const g = guards({ preview: true });
  const ipc = AiToolsMain.register({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, fromPage: g.aiToolsPage, focusAllowed: (e) => e?.pageId === 'aitools' && e.main === true,
    shell: {}, clipboard: {}, tools: { scan: async () => ({ rows: [] }) },
  });
  ipc.setFocus('codex');
  assert.equal(await handlers.get('aitools:focus')(from(TOOLS)), null);
  assert.equal(await handlers.get('aitools:focus')(from(TOOLS)), null, 'still not');
  assert.deepEqual(await handlers.get('aitools:scan')(from(TOOLS)), { rows: [] }, 'the sheet document may use its other channels');
  assert.equal(await handlers.get('aitools:scan')(from(PHONE)), null);
  assert.equal(await handlers.get('aitools:focus')(from('aitools')), 'codex', 'the old page gets it');
  assert.equal(await handlers.get('aitools:focus')(from('aitools')), null, 'one use');
  // default stays fromPage for any other caller
  const h2 = new Map();
  AiToolsMain.register({ ipcMain: { handle: (c, fn) => h2.set(c, fn) }, fromPage: (e) => e === 1, shell: {}, clipboard: {}, tools: {} }).setFocus('x');
  assert.equal(await h2.get('aitools:focus')(1), 'x');
  assert.match(read('aitools.js'), /inSheet \? undefined : takeFocus/);
});

test('phone: the pairing document is a sender; a pairing started there pushes phone:changed to both views (S2)', async () => {
  const handlers = new Map(); const sent = [];
  const g = guards({ preview: true });
  const wc = (n) => ({ isDestroyed: () => false, send: (c) => sent.push([n, c]) });
  const views = [wc('old'), wc('sheet'), null];
  const dir = testTempDir('r8-3b2-');
  const out = Wiring.registerAll({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, rootDir: dir, fromPage: (e, id) => e?.pageId === id && e.main === true, onQuit() {}, log() {},
    entitlements: { has: () => true, limits: () => ({ devices: 3 }), on() {} }, setInteractionHostExtras() {},
    phoneAllowed: g.phonePage, phoneViews: () => views,
  }, Wiring.PACKAGES.filter(([n]) => n === 'phone-approvals'));
  assert.deepEqual(out, [{ name: 'phone-approvals', status: 'ok' }]);
  assert.ok(await handlers.get('phone:state')(from(PHONE)), 'sheet document answered');
  assert.ok(await handlers.get('phone:state')(from('phone')), 'old page answered');
  for (const id of ['aitools', TOOLS, 'settings:phone', 'home']) assert.equal(await handlers.get('phone:state')(from(id)), null, id);
  assert.equal(await handlers.get('phone:state')(from(PHONE, false)), null);
  await handlers.get('phone:set')(from(PHONE), { enabled: true });
  assert.deepEqual([...new Set(sent.map(([n]) => n))].sort(), ['old', 'sheet'], 'both views hear the change');
  assert.ok(sent.every(([, c]) => c === 'phone:changed'));
  // without the injected deps: the old page only, as before
  const h2 = new Map();
  Wiring.registerAll({ ipcMain: { handle: (ch, fn) => h2.set(ch, fn) }, rootDir: testTempDir('r8-3b2-'), fromPage: (e, id) => e?.pageId === id, onQuit() {}, log() {}, entitlements: { has: () => true, limits: () => ({ devices: 3 }) }, setInteractionHostExtras() {} }, Wiring.PACKAGES.filter(([n]) => n === 'phone-approvals'));
  assert.equal(await h2.get('phone:state')(from(PHONE)), null);
  assert.ok(await h2.get('phone:state')(from('phone')));
});

test('settings:go-pane reaches the two documents', () => {
  for (const p of ['phone-pairing', 'aitools-setup']) assert.ok(SP.isOwner(p));
});

async function boot(file, search, api) {
  const errors = []; const calls = []; const hooks = {};
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const proxy = (vals) => new Proxy({}, { get: (_, k) => {
    if (k === 'then') return undefined;
    if (/^on[A-Z]|^changed$/.test(String(k))) return (cb) => { calls.push(String(k)); hooks[String(k)] = cb; };
    return (...a) => { calls.push(String(k)); const v = typeof vals[k] === 'function' ? vals[k](...a) : vals[k]; return Promise.resolve(v === undefined ? null : JSON.parse(JSON.stringify(v))); };
  } });
  const dom = await JSDOM.fromFile(path.join(root, file), {
    url: `file://${root}/${file}${search}`, runScripts: 'dangerously', resources: 'usable', virtualConsole: vc, pretendToBeVisual: true,
    beforeParse(w) {
      for (const [k, v] of Object.entries(api)) w[k] = proxy(v);
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.Element.prototype.scrollIntoView = () => {};
    },
  });
  if (dom.window.document.readyState !== 'complete') await new Promise((r) => dom.window.addEventListener('load', r));
  await new Promise((r) => setTimeout(r, 400));
  return { w: dom.window, calls, errors, hooks, close: () => dom.window.close() };
}
const PHONE_STATE = { entitled: true, enabled: false, ready: true, connected: true, devices: [], limit: 3, pairing: null };
const TOOLS_SCAN = { rows: [], pending: [] };
const toolsApi = { scan: TOOLS_SCAN, focus: 'codex', mcpStatus: { installed: false, current: true }, burstCodex: null };

test('the phone page: in the sheet a Back button and a re-read when shown; on the old page neither', async () => {
  const sheet = await boot('phone-pairing.html', '?embedded=1&sheet=1', { phonePairing: { state: PHONE_STATE } });
  try {
    assert.deepEqual(sheet.errors, []);
    const btn = sheet.w.document.getElementById('back-settings');
    assert.equal(btn.hidden, false);
    const before = sheet.calls.filter((c) => c === 'state').length;
    await sheet.hooks.onShown();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(sheet.calls.filter((c) => c === 'state').length > before);
    btn.click();
    assert.ok(sheet.calls.includes('goPane'));
  } finally { sheet.close(); }
  const old = await boot('phone-pairing.html', '', { phonePairing: { state: PHONE_STATE } });
  try {
    assert.equal(old.w.document.getElementById('back-settings').hidden, true);
    assert.equal(old.calls.includes('onShown'), false);
  } finally { old.close(); }
});

test('the AI tools page: in the sheet a Back button, a re-read when shown and NEVER a focus request; the old page still asks', async () => {
  const sheet = await boot('aitools.html', '?embedded=1&sheet=1', { aiToolsApi: toolsApi });
  try {
    assert.deepEqual(sheet.errors, []);
    assert.equal(sheet.w.document.getElementById('back-settings').hidden, false);
    const before = sheet.calls.filter((c) => c === 'scan').length;
    await sheet.hooks.onShown();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(sheet.calls.filter((c) => c === 'scan').length > before);
    sheet.w.dispatchEvent(new sheet.w.Event('focus'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sheet.calls.includes('focus'), false, 'no focus request on boot or window focus');
    sheet.w.document.getElementById('back-settings').click();
    assert.ok(sheet.calls.includes('goPane'));
  } finally { sheet.close(); }
  const old = await boot('aitools.html', '', { aiToolsApi: toolsApi });
  try {
    assert.equal(old.w.document.getElementById('back-settings').hidden, true);
    assert.ok(old.calls.includes('focus'));
    assert.equal(old.calls.includes('onShown'), false);
  } finally { old.close(); }
});
