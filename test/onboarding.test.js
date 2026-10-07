'use strict';
// First-run setup (WP1): main's real onboarding IPC, run against the real AI
// tools engine in a throwaway home, driven by the real page script and preload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fromPage } = require('../src/utility-pages');
const AiToolsLib = require('../src/ai-tools.js');
const Adapters = require('../adapters/index.js');
const SetupChecklist = require('../src/setup-checklist.js');
const BuddyPages = require('../buddy-window/pages');
const Help = require('../help.js');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const slice = (from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `main.js still has ${from}`);
  return source.slice(a, b);
};
const contents = () => ({ mainFrame: {}, isDestroyed: () => false, send() {} });
const event = (sender) => ({ sender, senderFrame: sender.mainFrame });

function rig({ claudeAuto = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-onboard-'));
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const original = { codex: '{\n  "hooks": {}\n}', gemini: JSON.stringify({ theme: 'dark' }, null, 2) };
  fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), original.codex);
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), original.gemini);
  const runtime = Adapters.Runtime.make({ execPath: null, hooksDir: path.join(root, 'hooks'), dataDir });
  const tools = AiToolsLib.create({ home, runtime, dataDir, pathDirs: () => [], extraBinDirs: [], run: (_b, _a, _o, cb) => { cb(null, '1.0.0'); return {}; } });
  const registered = new Map(), opened = [], toolsOpened = [];
  let config = { spend: { dailyBudget: 0, warnAt: 0.8 }, claudeAutoConnect: undefined };
  const ctx = {
    require: (p) => ({ './src/ai-tools.js': AiToolsLib, './src/setup-checklist.js': SetupChecklist })[p],
    ipcMain: { handle: (name, fn) => registered.set(name, fn) },
    fromPage, BuddyPages, setupChecklist: () => { throw new Error('the Help checklist is not the setup view'); },
    AiTools: { tools, quick: () => tools.quick() },
    aiToolsOpen: (d) => { toolsOpened.push(d); return true; },
    openBuddy: (id) => opened.push(id),
    localSessions: (s) => s.filter((x) => !x.remote),
    sessions: [],
    aggregateState() { return { sessions: ctx.sessions }; },
    LoginItem: { on: true, get() { return this.on; }, set(v) { this.on = v; } },
    claudeAutoConnect: () => claudeAuto && config.claudeAutoConnect !== false,
    loadConfig: () => config,
    saveConfig: (p) => { config = { ...config, ...p }; return config; },
    commitConfig: (p) => { config = { ...config, ...p }; return config; },
    accountSummary: () => null,
    broadcastStatus() {},
    onboardingWin: null,
  };
  ctx.onboardingWin = { webContents: contents(), closed: false, close() { this.closed = true; } };
  vm.runInNewContext(slice('const onboardingOnly =', '\nfunction maybeAutoShowHelp()'), ctx);
  const call = (name, ...args) => registered.get(name)(event(ctx.onboardingWin.webContents), ...args);
  return { home, original, tools, ctx, registered, call, opened, toolsOpened, config: () => config };
}

test('every onboarding channel answers only its own window', async () => {
  const r = rig();
  const foreign = event(contents());
  for (const [name, args] of [['onboarding:state', []], ['onboarding:preview', ['codex']], ['onboarding:connect', [['codex']]], ['onboarding:undo', ['codex']], ['onboarding:login-item', [false]], ['onboarding:budget', [20]], ['onboarding:navigate', ['home']]]) {
    assert.ok([null, false].includes(await r.registered.get(name)(foreign, ...args)), name);
  }
  assert.equal(r.ctx.LoginItem.on, true);
  assert.deepEqual(r.opened, []);
  assert.equal(r.tools.quick().find((t) => t.id === 'codex').connected, false);
});

test('two detected tools: one "Connect 2 tools" call connects both, keeps backups, and Undo restores each', async () => {
  const r = rig();
  const before = await r.call('onboarding:state');
  assert.deepEqual(before.pending, ['codex', 'gemini']);
  assert.ok(before.missing.some((m) => m.id === 'cursor'));
  const out = await r.call('onboarding:connect', ['codex', 'gemini']);
  assert.equal(out.ok, true, JSON.stringify(out));
  const after = await r.call('onboarding:state');
  assert.deepEqual(after.rows.map((x) => [x.id, x.connected, x.canUndo]), [['codex', true, true], ['gemini', true, true]]);
  assert.match(fs.readFileSync(path.join(r.home, '.gemini', 'settings.json'), 'utf8'), /--adapter gemini/);
  assert.notEqual(fs.readFileSync(path.join(r.home, '.codex', 'hooks.json'), 'utf8'), r.original.codex);
  for (const dir of ['.codex', '.gemini']) assert.equal(fs.readdirSync(path.join(r.home, dir)).filter((f) => f.includes('.plexiform-backup-')).length, 1, `${dir} keeps a backup`);
  for (const id of ['codex', 'gemini']) assert.equal((await r.call('onboarding:undo', id)).ok, true);
  assert.equal(fs.readFileSync(path.join(r.home, '.codex', 'hooks.json'), 'utf8'), r.original.codex);
  assert.equal(fs.readFileSync(path.join(r.home, '.gemini', 'settings.json'), 'utf8'), r.original.gemini);
  assert.deepEqual((await r.call('onboarding:state')).pending, ['codex', 'gemini']);
});

test('connect refuses anything but a short list of known tool ids', async () => {
  const r = rig();
  for (const bad of ['codex', [], ['codex', '../x'], [{}], Array(9).fill('codex')]) {
    const out = await r.call('onboarding:connect', bad);
    assert.ok(out === null || (out.ok && out.results.length === 0), JSON.stringify(bad));
  }
  assert.equal(r.tools.quick().find((t) => t.id === 'codex').connected, false);
  assert.equal(await r.call('onboarding:preview', '/etc/passwd'), null);
  assert.equal((await r.call('onboarding:preview', 'gemini')).ok, true);
});

test('Claude Code connected automatically is disclosed, and its Undo removes the hooks and stops the re-connect', async () => {
  const r = rig({ claudeAuto: true });
  fs.mkdirSync(path.join(r.home, '.claude'));
  const runtime = Adapters.Runtime.make({ execPath: null, hooksDir: path.join(root, 'hooks'), dataDir: path.join(r.home, 'data') });
  Adapters.get('claude').install({ home: r.home, runtime }); // what main's installHooks() does at start
  const claude = (await r.call('onboarding:state')).rows.find((x) => x.id === 'claude');
  assert.deepEqual([claude.auto, claude.canUndo, claude.status], [true, true, 'Connected automatically']);
  const out = await r.call('onboarding:undo', 'claude');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(r.config().claudeAutoConnect, false, 'the 10-minute re-connect is off');
  const now = (await r.call('onboarding:state')).rows.find((x) => x.id === 'claude');
  assert.deepEqual([now.connected, now.auto, now.selectable], [false, false, true]);
  assert.equal((await r.call('onboarding:connect', ['claude'])).ok, true);
  assert.equal(r.config().claudeAutoConnect, true, 'connecting again by hand is consent again');
});

test('the login item is disclosed with a working toggle', async () => {
  const r = rig();
  assert.equal((await r.call('onboarding:state')).loginItem, true);
  assert.equal(await r.call('onboarding:login-item', false), false);
  assert.equal(r.ctx.LoginItem.on, false);
  assert.equal(await r.call('onboarding:login-item', 'yes'), null);
  assert.equal(await r.call('onboarding:login-item', true), true);
});

test('a simulated session signal shows up as "<Tool> is working in <folder>"', async () => {
  const r = rig();
  assert.equal((await r.call('onboarding:state')).session, null);
  r.ctx.sessions = [{ sessionId: 's1', source: 'codex', cwd: '/Users/me/api', updatedAt: new Date().toISOString() }];
  assert.equal((await r.call('onboarding:state')).session.text, 'Codex is working in api.');
});

test('budget writes the Spend daily budget; navigation is a short allow-list and Home ends setup', async () => {
  const r = rig();
  assert.equal(await r.call('onboarding:budget', 20), 20);
  assert.equal(r.config().spend.dailyBudget, 20);
  assert.equal(r.config().spend.warnAt, 0.8, 'the rest of Spend is kept');
  for (const bad of [-1, NaN, Infinity, '20', 2e6]) assert.equal(await r.call('onboarding:budget', bad), null);
  for (const bad of ['settings', 'https://x', 'aitools:../x', 'Home', '']) assert.equal(await r.call('onboarding:navigate', bad), false);
  assert.equal(await r.call('onboarding:navigate', 'home', 'extra'), false);
  assert.equal(await r.call('onboarding:navigate', 'aitools:codex'), true);
  assert.deepEqual(r.toolsOpened, ['aitools:codex']);
  for (const d of ['join', 'create-team']) assert.equal(await r.call('onboarding:navigate', d), true);
  assert.equal(r.ctx.onboardingWin.closed, false);
  assert.equal(await r.call('onboarding:navigate', 'home'), true);
  assert.deepEqual(r.opened, ['join', 'create-team', BuddyPages.pageById('home') ? 'home' : BuddyPages.SECTIONS[0].default]);
  assert.equal(r.ctx.onboardingWin.closed, true);
});

test('first run opens setup (not Help) once; an install that already saw Help is left alone', () => {
  const run = ({ markers = [], devRun = false }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-onboard-root-'));
    for (const m of markers) fs.writeFileSync(path.join(dir, m), 'x');
    const shown = [];
    const ctx = { fs, path, ROOT_DIR: dir, Help, IS_DEV_RUN: devRun, console, createOnboardingWindow: () => shown.push('setup'), createHelpWindow: () => shown.push('help') };
    vm.runInNewContext(`${slice('\nfunction maybeAutoShowHelp()', '\n// ── Notifications')}\nmaybeAutoShowHelp();`, ctx);
    return { shown, marker: fs.existsSync(path.join(dir, '.onboarded')) };
  };
  assert.deepEqual(run({}), { shown: ['setup'], marker: true });
  assert.deepEqual(run({ markers: ['.onboarded'] }), { shown: [], marker: true });
  assert.deepEqual(run({ markers: ['.help-shown'] }), { shown: [], marker: false });
  assert.deepEqual(run({ devRun: true }), { shown: [], marker: false });
  assert.match(source, /else setTimeout\(maybeAutoShowHelp, 1500\);/, 'setup opens within 3 s of start');
});

test('the default tray menu is 20 items or fewer, with debug controls only in dev or the widget menu', () => {
  const build = (from, devRun = false) => {
    const ctx = { IS_DEV_RUN: devRun, IS_MAC: true, BuddyPages, AppMenu: require('../src/app-menu.js'), BRAND: { OPEN_MENU_LABEL: 'Open Plexiform…' },
      Menu: { buildFromTemplate: (t) => t }, budgetItems: () => [], scopeItem: () => [], BurstIpc: { trayItems: () => [] }, quietItems: () => [{ label: 'Snooze Notifications' }],
      loadConfig: () => ({ showWidget: true, menuBarMode: false }), LoginItem: { get: () => true }, updaterTrayItems: () => [{ label: 'Check for Updates…' }], hooksLabel: 'Reinstall Claude Code Hooks' };
    for (const fn of ['openBuddy', 'createFeedbackWindow', 'createHelpWindow', 'showHealth', 'knockNow', 'resizeBy', 'installHooks', 'createTray', 'setManual', 'clearManual', 'saveConfig', 'createWindow', 'applyWidgetVisibility', 'broadcastStatus', 'updateTrayMode']) ctx[fn] = () => {};
    return vm.runInNewContext(`${slice('  const sectionItems = ', '\n  // Rebuilt in place')}\nbuildMenu(${JSON.stringify(from)});`, ctx).filter((i) => i.type !== 'separator');
  };
  const tray = build('tray');
  assert.ok(tray.length <= 20, `${tray.length} items: ${tray.map((i) => i.label).join(' | ')}`);
  const labels = tray.map((i) => i.label);
  for (const gone of ['Knock now', 'Bigger', 'Smaller', 'Reinstall Claude Code Hooks', 'Override: Green (5 min)', 'Clear override']) assert.ok(!labels.includes(gone), gone);
  assert.equal(labels.filter((l) => /^Open .+…$/.test(l) && l !== 'Open Plexiform…').length, BuddyPages.sectionsFor().length, 'one Open item per sidebar section');
  for (const kept of ['Open at Login', 'Quit', 'Floating Widget', 'What does this mean?…']) assert.ok(labels.includes(kept), kept);
  for (const advanced of [build('widget'), build('tray', true)]) assert.ok(advanced.some((i) => i.label === 'Knock now') && advanced.some((i) => i.label === 'Override: Red (5 min)'));
});

// ── The page itself ─────────────────────────────────────────────────────────
function page(r) {
  const els = new Map();
  const el = (id = '') => {
    const e = { id, listeners: {}, children: [], attrs: {}, textContent: '', hidden: false, disabled: false, checked: false, value: '', className: '', parentElement: { hidden: false },
      addEventListener(t, fn) { this.listeners[t] = fn; }, replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); },
      setAttribute(k, v) { this.attrs[k] = v; }, focus() {} };
    return e;
  };
  const html = fs.readFileSync(path.join(root, 'onboarding.html'), 'utf8');
  for (const m of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"([^>]*)>/g)) { const e = el(m[2]); e.hidden = /\shidden(\s|>)/.test(m[0]); els.set(m[2], e); }
  let api, statusCb = null;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'onboarding-preload.js'), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld: (_n, v) => { api = v; } },
    ipcRenderer: { on: (ch, cb) => { if (ch === 'status-changed') statusCb = cb; }, invoke: async (ch, ...a) => { calls.push([ch, ...a]); return r.call(ch, ...a); } },
  }) });
  const document = { getElementById: (id) => els.get(id), createElement: () => el(), querySelectorAll: () => [], querySelector: () => ({ focus() {} }) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'onboarding.js'), 'utf8'), { window: { onboardingApi: api }, document, console, setTimeout, clearTimeout });
  const settle = () => new Promise((res) => setTimeout(res, 20));
  return { els, calls, settle, click: async (id) => { await els.get(id).listeners.click(); await settle(); }, status: async () => { statusCb(); await settle(); } };
}

test('the page: connect two tools in one click, then the first session flips step 2, then Home in three clicks', async () => {
  const r = rig();
  const p = page(r);
  await p.settle();
  const $ = (id) => p.els.get(id);
  assert.equal($('step-connect').hidden, false);
  assert.equal($('step-signal').hidden, true);
  assert.equal($('connect').textContent, 'Connect 2 tools');
  assert.equal($('login-text').textContent, 'Plexiform opens when you log in.');
  assert.equal($('missing-title').textContent, 'Not installed (3)');
  await p.click('connect');                                   // click 1
  assert.deepEqual(p.calls.find((c) => c[0] === 'onboarding:connect'), ['onboarding:connect', ['codex', 'gemini']]);
  assert.equal($('step-connect').hidden, true);
  assert.equal($('step-signal').hidden, false);
  assert.equal($('signal-title').textContent, 'Start a session in Codex or Gemini CLI');
  assert.equal($('seen').hidden, true);
  assert.equal($('signal-next').hidden, true);
  r.ctx.sessions = [{ sessionId: 's1', source: 'gemini', cwd: '/Users/me/plexiform-release', updatedAt: new Date().toISOString() }];
  const t0 = Date.now();
  await p.status();
  assert.ok(Date.now() - t0 < 2000);
  assert.equal($('seen-text').textContent, 'Gemini CLI is working in plexiform-release.');
  assert.equal($('waiting').hidden, true);
  assert.equal($('signal-next').hidden, false);
  await p.click('signal-next');                               // click 2
  assert.equal($('step-extras').hidden, false);
  await p.click('finish');                                    // click 3
  assert.equal(r.ctx.onboardingWin.closed, true);
  assert.equal(r.opened.length, 1);
});

test('the page: the login toggle and Undo work from step 1, and nothing found offers install and check again', async () => {
  const r = rig();
  const p = page(r);
  await p.settle();
  await p.click('login-toggle');
  assert.equal(r.ctx.LoginItem.on, false);
  assert.equal(p.els.get('login-toggle').textContent, 'Turn on');
  fs.rmSync(path.join(r.home, '.codex'), { recursive: true });
  fs.rmSync(path.join(r.home, '.gemini'), { recursive: true });
  await p.click('check-again');
  assert.equal(p.els.get('none').hidden, false);
  assert.equal(p.els.get('connect').textContent, 'Next');
  await p.click('how-install');
  assert.deepEqual(r.toolsOpened, ['aitools']);
});
