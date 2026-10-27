'use strict';
// Redesign R8-1: the Settings sheet's panes. One table says which pane owns which channel and config key; main's
// guards are bound to ONE pane each; a pane page saves only what it owns. Dev chat preview only: with the gate off
// the pane ids do not exist and the old Settings page is unchanged. Fake data only; no real CLI, no real home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const SP = require('../src/settings-panes.js');
const Pages = require('../buddy-window/pages.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const mainSrc = read('main.js');
const preloadSrc = read('settings-preload.js');
const winSrc = read('buddy-window/index.js');

// ── the table ──────────────────────────────────────────────────────────────

test('every channel the Settings preload exposes has exactly one row, and the rows name a real pane or none', () => {
  const channels = [...preloadSrc.matchAll(/(?:invoke|send)\('([a-z:-]+)'/g)].map((m) => m[1]).filter((c) => c !== 'settings:go-pane');
  assert.ok(channels.length > 50, 'found the preload channels');
  for (const c of new Set(channels)) assert.ok(c in SP.CHANNEL_PANE, `${c} needs a row in CHANNEL_PANE`);
  for (const [c, p] of Object.entries(SP.CHANNEL_PANE)) {
    assert.ok(SP.isPane(p) || p === 'none' || p === 'config', `${c} -> ${p}`);
    assert.ok(channels.includes(c), `${c} is in the preload`);
  }
});

test('every config key has exactly one owner: the defaults and everything the page saves', () => {
  const block = mainSrc.slice(mainSrc.indexOf('const DEFAULT_CONFIG = {'));
  const body = block.slice(0, block.indexOf('\n};'));
  const defaults = [...body.matchAll(/^  ([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]);
  const saved = read('settings.js');
  const saveAll = saved.slice(saved.indexOf('async function saveAll()'), saved.indexOf('\n    }\n', saved.indexOf('async function saveAll()')));
  const savedKeys = [...saveAll.matchAll(/^        ([A-Za-z]+):/gm)].map((m) => m[1]);
  assert.ok(defaults.length > 40 && savedKeys.length > 30);
  for (const k of new Set([...defaults, ...savedKeys])) assert.ok(k in SP.KEY_OWNER, `${k} needs an owner (or none)`);
  for (const [k, p] of Object.entries(SP.KEY_OWNER)) assert.ok(SP.isOwner(p) || p === 'none', `${k} -> ${p}`);
  for (const k of savedKeys) assert.ok(SP.isPane(SP.KEY_OWNER[k]), `${k} is saved by the page-wide save, so a pane must own it`);
  // The pages' own saves (voice, compaction) are inside owned keys too.
  assert.equal(SP.KEY_OWNER.voice, 'general');
  assert.equal(SP.KEY_OWNER.compaction, 'aitools');
});

test('helpers: ownership, reads, whole-write check, and a hostile ?pane= value gains nothing', () => {
  assert.deepEqual(SP.ownedKeys('spend'), ['spend']);
  assert.deepEqual(SP.ownedKeys('nope'), []);
  assert.ok(SP.readKeys('spend').includes('simpleMode') && !SP.ownedKeys('spend').includes('simpleMode'));
  assert.equal(SP.writesAllowed('spend', { spend: {} }), true);
  assert.equal(SP.writesAllowed('spend', { spend: {}, sounds: {} }), false);
  assert.equal(SP.writesAllowed('spend', { simpleMode: true }), false, 'a shared read is not a write');
  assert.equal(SP.writesAllowed('spend', { __proto__: null, constructor: 1 }), false);
  assert.equal(SP.writesAllowed('spend', null), false);
  assert.equal(SP.writesAllowed('spend', ['spend']), false);
  assert.equal(SP.writesAllowed('nope', {}), false);
  for (const bad of ['?pane=nope', '?pane=', '?pane=__proto__', '?pane=spend&pane=widget', '?pane=spend%00', '?pane[]=spend', '', '?pane=SPEND', '?pane=%E0%A4%A']) {
    assert.equal(SP.paneFromSearch(bad), null, bad);
  }
  assert.equal(SP.paneFromSearch('?embedded=1&pane=spend'), 'spend');
});

// ── main's guards ──────────────────────────────────────────────────────────

const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };

// The real helper block from main.js, run against fake pages: sender -> page id.
function guards({ preview }) {
  const code = between(mainSrc, 'function settingsPane(pane) {', '\nconst settingsAnyPane =') + '\nconst settingsAnyPane = (e) => fromUtilityPage(e, "settings") || settingsPaneOf(e) !== null;';
  const ctx = { SettingsPanes: SP, CHAT_PREVIEW: preview, fromUtilityPage: (e, id) => e?.pageId === id && e.main === true };
  vm.runInNewContext(`${code}\nglobalThis.out = { settingsPane, settingsPaneOf, settingsAnyPane };`, ctx);
  return ctx.out;
}
const from = (pageId, main = true) => ({ pageId, main });

test('a pane guard accepts the old page and that ONE pane (preview), never another pane, never a subframe', () => {
  const g = guards({ preview: true });
  for (const pane of SP.PANES) {
    const ok = g.settingsPane(pane);
    assert.equal(ok(from('settings')), true);
    assert.equal(ok(from(`settings:${pane}`)), true);
    assert.equal(ok(from(`settings:${pane}`, false)), false, 'subframe');
    for (const other of SP.PANES.filter((p) => p !== pane)) assert.equal(ok(from(`settings:${other}`)), false, `${other} cannot use ${pane}'s channels`);
    for (const id of ['home', 'lights', 'usage', 'settings:projects', 'settings:*', 'sessions', undefined]) assert.equal(ok(from(id)), false, String(id));
  }
  const none = g.settingsPane('none');
  assert.equal(none(from('settings')), true);
  for (const pane of SP.PANES) assert.equal(none(from(`settings:${pane}`)), false, `'none' is the old page only (${pane})`);
  assert.throws(() => g.settingsPane('nope'));
  assert.throws(() => g.settingsPane('*'));
});

test('gate off: no pane is ever a Settings sender; the old page is unchanged', () => {
  const g = guards({ preview: false });
  for (const pane of SP.PANES) {
    assert.equal(g.settingsPane(pane)(from(`settings:${pane}`)), false);
    assert.equal(g.settingsPaneOf(from(`settings:${pane}`)), null);
    assert.equal(g.settingsAnyPane(from(`settings:${pane}`)), false);
    assert.equal(g.settingsPane(pane)(from('settings')), true);
  }
});

test('main.js: no unbound settingsOnly(...) guard is left, and guards never read the page query', () => {
  assert.doesNotMatch(mainSrc, /settingsOnly\(/);
  assert.doesNotMatch(mainSrc, /\bsettingsOnly\b(?!: settingsPane)/);
  const helper = between(mainSrc, 'const SettingsPanes = require', 'function sendToSettings') + between(mainSrc, 'function settingsPane(pane) {', '\nconst settingsAnyPane =');
  assert.doesNotMatch(helper, /searchParams|location|\.query|\.url/, 'authority is the page id main created, not anything the page sent');
  assert.doesNotMatch(mainSrc, /settingsPane\(\s*['"`]?\*|settings:\*/, 'no generic settings:* predicate');
  // Each wiring site names exactly one pane (a variable would let one site go generic).
  for (const m of mainSrc.matchAll(/settingsPane\(([^)]*)\)/g)) assert.match(m[1], /^'(general|notifications|aitools|widget|spend|privacy|phone|advanced|none)'$|^pane$/, m[0]);
});

test('every guarded channel is bound to the pane its table row names', () => {
  const owners = new Map();
  const files = [mainSrc, read('src/spend-safety-main.js'), read('src/deploy-status-main.js'), read('src/data-rights-main.js')];
  assert.ok(files.length);
  for (const [ch, pane] of Object.entries(SP.CHANNEL_PANE)) {
    if (pane === 'config' || pane === 'none') continue;
    const re = new RegExp(`['"]${ch.replace(/[:-]/g, '\\$&')}['"][^\\n]{0,80}settingsPane\\('(\\w+)'\\)`);
    const m = mainSrc.match(re);
    if (m) { owners.set(ch, m[1]); assert.equal(m[1], pane, ch); }
  }
  assert.ok(owners.size >= 20, `checked ${owners.size} direct wiring sites`);
  // Dependency-injected sites: the predicate handed in is bound to the table's pane.
  const bound = [
    [/data-rights-main\.js'\)\.register\(\{ utilityHandle, allowed: settingsPane\('privacy'\)/, 'data:*'],
    [/spend-safety-main\.js'\)\.install\(\{[^\n]*allowed: \(e\) => analyticsSender\(e\) \|\| settingsPane\('spend'\)\(e\)/, 'spend-safety:*'],
    [/deploy-status-main\.js'\)\.install\(\{[^\n]*allowedSettings: settingsPane\('advanced'\)/, 'deploy:*'],
    [/cli-install\.js'\)\.register\(\{ utilityHandle, allowed: settingsPane\('general'\)/, 'cli-install*'],
    [/GhosttyDockInstall\.register\(\{ utilityHandle, allowed: \(e\) => settingsPane\('aitools'\)\(e\) \|\| fromUtilityPage\(e, 'home'\)/, 'ghostty-dock-install'],
    [/const fromNativeBoardSettings = settingsPane\('aitools'\);/, 'native-board-*'],
    [/const backupsSenderOk = settingsPane\('privacy'\);/, 'backups-*'],
    [/settingsAllowed: settingsPane\('privacy'\)/, 'policy:*'],
    [/settingsOnly: settingsPane\('none'\)/, 'burst:*'],
    [/ipcMain\.handle\('health-fix', \(e, id\) => \{\n  if \(!settingsPane\('advanced'\)\(e\)\)/, 'health-fix (Health is Advanced, not AI tools)'],
  ];
  for (const [re, what] of bound) assert.match(mainSrc, re, what);
  assert.equal(SP.CHANNEL_PANE['policy:state'], 'privacy');
  assert.equal(SP.CHANNEL_PANE['deploy:settings'], 'advanced');
  assert.equal(SP.CHANNEL_PANE['spend-safety:get'], 'spend');
});

// get-config / save-config as main wires them, with the real source and stubbed config.
function configHandlers({ preview, config = { sounds: { on: true }, spend: { x: 1 }, simpleMode: false, persona: 'p' } }) {
  const g = guards({ preview });
  const handlers = new Map();
  const log = { commits: [], warns: [] };
  const start = mainSrc.indexOf("utilityHandle('get-config', configReader");
  const end = mainSrc.indexOf('// saveConfig plus everything', start);
  assert.ok(start > 0 && end > start);
  const ctx = {
    SettingsPanes: SP, settingsPaneOf: g.settingsPaneOf, settingsAnyPane: g.settingsAnyPane, configReader: g.settingsAnyPane, widgetConfigSender: () => false,
    loadConfig: () => config, commitConfig: (p) => { log.commits.push(p); return { saved: true }; },
    utilityHandle: (ch, guard, fn) => handlers.set(ch, (e, ...a) => (guard(e) ? fn(e, ...a) : null)),
    console: { warn: (m) => log.warns.push(String(m)) },
  };
  vm.runInNewContext(mainSrc.slice(start, end), ctx);
  return { call: (ch, e, ...a) => handlers.get(ch)(e, ...a), log };
}

test('save-config from a pane: {allowed key, foreign key} is refused whole, logged by key name only, nothing applied', () => {
  const h = configHandlers({ preview: true });
  const r = h.call('save-config', from('settings:notifications'), { sounds: { on: false }, spend: { secret: 'SHOULD-NOT-LOG' } });
  assert.match(r.error, /not on this page/);
  assert.deepEqual(h.log.commits, [], 'no partial apply');
  assert.equal(h.log.warns.length, 1);
  assert.match(h.log.warns[0], /notifications/);
  assert.match(h.log.warns[0], /spend/);
  assert.doesNotMatch(h.log.warns[0], /SHOULD-NOT-LOG/, 'key names only');
  assert.deepEqual(h.call('save-config', from('settings:notifications'), { sounds: { on: false } }), { saved: true });
  assert.deepEqual(h.log.commits, [{ sounds: { on: false } }]);
  for (const bad of [null, [], 'x', 5, { __backupReason: 'x', sounds: {} }, { unknownKey: 1 }, { constructor: 1 }]) {
    assert.match(h.call('save-config', from('settings:notifications'), bad).error, /not on this page/, JSON.stringify(bad));
  }
  assert.equal(h.log.commits.length, 1);
});

test('save-config: the old page and the gate-off world keep the full write; other senders get nothing', () => {
  const h = configHandlers({ preview: true });
  assert.deepEqual(h.call('save-config', from('settings'), { spend: { a: 1 }, sounds: {}, persona: 'x' }), { saved: true });
  assert.equal(h.log.commits.length, 1);
  const off = configHandlers({ preview: false });
  assert.equal(off.call('save-config', from('settings:notifications'), { sounds: {} }), null, 'gate off: a pane page is no sender');
  assert.deepEqual(off.log.commits, []);
  assert.equal(h.call('save-config', from('home'), { sounds: {} }), null);
  assert.equal(h.call('save-config', from('settings:spend', false), { spend: {} }), null, 'subframe');
});

test('get-config from a pane returns only its keys and shared reads; the old page and widget keep the whole config', () => {
  const h = configHandlers({ preview: true });
  assert.deepEqual(h.call('get-config', from('settings:spend')), { spend: { x: 1 }, simpleMode: false });
  assert.deepEqual(h.call('get-config', from('settings:notifications')), { sounds: { on: true }, simpleMode: false });
  assert.deepEqual(Object.keys(h.call('get-config', from('settings'))).sort(), ['persona', 'simpleMode', 'sounds', 'spend']);
});

// ── routing ────────────────────────────────────────────────────────────────

function world(chatFirst) {
  const calls = [];
  const ctx = {
    calls, pageById: Pages.pageById, paneById: Pages.paneById, resolve: Pages.resolve, sectionTarget: Pages.sectionTarget, chatFirst,
    setupLocalGeneration: 0, tasksGeneration: 0, homeGeneration: 0, selected: 'board', content: null, hubInfo: null,
    sidebar: { webContents: { isDestroyed: () => false, focus: () => {} } },
    getTeamHub: () => null, forgetHub: () => {}, optimiser: { open: () => {} }, flow: { show: () => {}, leftAccountPages: () => {} }, openWindow: () => {},
    pushState: () => calls.push(['state']), showHubPage: (p) => { calls.push(['hub', p.id]); ctx.content = {}; },
    showLocal: (p) => { calls.push(['local', p.id]); ctx.content = {}; }, showInfo: (p) => calls.push(['info', p.id]), fromSidebarOk: true,
  };
  const code = between(winSrc, '  // Chat-first preview only (redesign R1)', '  const fromSidebar = ') + 'const fromSidebar = () => fromSidebarOk;\n'
    + between(winSrc, '  function onSelect(e, id) {', '  function onRetry(');
  vm.runInNewContext(`${code}\nglobalThis.api = { select, route, onSelect };`, ctx);
  return ctx;
}

test('the pane ids exist only with the preview on; the old settings page is unchanged', () => {
  for (const pane of SP.PANES) assert.equal(Pages.pageById(`settings:${pane}`), null, 'never in PAGES');
  assert.ok(Pages.pageById('settings'));
  assert.equal(Pages.SETTINGS_PANES.length, SP.PANES.length);
  for (const p of Pages.SETTINGS_PANES) {
    assert.equal(p.file, 'settings.html'); assert.equal(p.preload, 'settings-preload.js'); assert.equal(p.kind, 'local');
    assert.deepEqual({ ...p.query }, { embedded: '1', pane: p.pane }, 'main builds the query from the closed list');
    assert.equal(p.id, `settings:${p.pane}`);
  }
  assert.equal(Pages.paneById('settings:__proto__'), null);
  assert.equal(Pages.paneById('settings:*'), null);
  assert.equal(Pages.paneById({}), null);
  const off = world(false);
  for (const pane of SP.PANES) { off.api.select(`settings:${pane}`); off.api.onSelect({}, `settings:${pane}`); off.api.route(`settings:${pane}`); }
  assert.deepEqual(off.calls, [], 'gate off: a pane id selects nothing');
  const offOld = world(false); offOld.api.route('settings');
  assert.deepEqual(offOld.calls, [['state'], ['local', 'settings']], 'gate off: Settings is the old page');
  const on = world(true);
  on.api.route('settings');
  assert.deepEqual(on.calls, [['state'], ['local', 'settings:general']], 'preview: Settings opens the sheet');
  const pick = world(true); pick.api.select(`settings:${'spend'}`);
  assert.deepEqual(pick.calls, [['state'], ['local', 'settings:spend']]);
  const bad = world(true); bad.api.select(`settings:${'nope'}`); bad.api.select(`settings:${'*'}`);
  assert.deepEqual(bad.calls, []);
});

// settings:go-pane: navigation only.
function goPane() {
  const handlers = new Map();
  const views = new Map(SP.PANES.map((p) => [`settings:${p}`, { webContents: { mainFrame: { id: p }, id: p } }]));
  const selected = [];
  const code = between(winSrc, '  const fromSettingsPane = ', '  if (chatFirst === true) ipcMain.on(\'buddy:open-newchat\'');
  const ctx = { SettingsPanes: SP, localViews: views, isLocalPage: (u) => u === 'file:///settings.html', chatFirst: true, select: (id) => selected.push(id), ipcMain: { on: (c, fn) => handlers.set(c, fn) } };
  vm.runInNewContext(code, ctx);
  const ev = (pane, over = {}) => ({ sender: views.get(`settings:${pane}`).webContents, senderFrame: { ...views.get(`settings:${pane}`).webContents.mainFrame, url: 'file:///settings.html' }, ...over });
  // senderFrame must be the main frame object itself
  const evMain = (pane) => { const wc = views.get(`settings:${pane}`).webContents; return { sender: wc, senderFrame: Object.assign(wc.mainFrame, { url: 'file:///settings.html' }) }; };
  return { go: handlers.get('settings:go-pane'), selected, ev, evMain, views };
}

test('settings:go-pane: pane senders only, a closed list of six ids, nothing else opens', () => {
  const g = goPane();
  g.go(g.evMain('general'), 'spend');
  assert.deepEqual(g.selected, ['settings:spend']);
  for (const bad of ['nope', 'settings', 'home', '../x', 'settings:spend', '', null, undefined, 5, {}, ['spend'], '__proto__', 'projects']) g.go(g.evMain('general'), bad);
  assert.deepEqual(g.selected, ['settings:spend'], 'only the closed list');
  g.go({ sender: {}, senderFrame: {} }, 'widget');
  g.go({ sender: g.views.get('settings:general').webContents, senderFrame: { url: 'file:///settings.html' } }, 'widget');
  assert.deepEqual(g.selected, ['settings:spend'], 'other senders and subframes do nothing');
  assert.match(winSrc, /if \(chatFirst === true\) ipcMain\.on\('settings:go-pane'/, 'registered only with the preview on');
});

test('the pane table loads before every script that checks it', () => {
  const html = read('settings.html');
  const at = (f) => html.indexOf(`<script src="${f}"></script>`);
  assert.ok(at('src/settings-panes.js') > 0);
  for (const f of ['settings-backups.js', 'settings-crash-reports.js', 'settings-deploys.js', 'settings-policies.js', 'settings-data.js', 'settings.js', 'settings-spend-safety.js', 'native-board/settings.js']) assert.ok(at('src/settings-panes.js') < at(f), f);
});

test('settings:go-pane and settings:shown are absent from the gate-off world', () => {
  assert.match(winSrc, /page\.pane && shownAgain/);
  assert.doesNotMatch(read('buddy-window/pages.js'), /id: 'settings:general'/);
  assert.match(preloadSrc, /goPane: \(pane\) => ipcRenderer\.send\('settings:go-pane'/);
});

// ── the page ───────────────────────────────────────────────────────────────

const FIXTURES = {
  voiceStatus: { hotkeys: [], preset: '', screen: false, ok: true },
  getConfig: {}, saveConfig: {}, busyStatus: { calendar: { on: false }, ics: { on: false }, focus: { on: false } },
  compactionStats: { settings: {}, total: { compactions: 0 }, last: null, providers: [] }, health: { rows: [], summary: '' },
  signalEndpoint: { port: 1, emit: 'x', token: 'y' }, gitStatus: { enabled: false, repos: [] }, cliStatus: { state: 'missing' },
  remoteDevices: { devices: [], loopback: {}, tailnet: { enabled: false }, port: 1, pairing: null }, interactionHostStatus: 'Off.', privacyText: null,
};

async function boot({ pane, search, config = {} }) {
  const calls = []; const timers = []; const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const api = new Proxy({}, { get: (_, k) => {
    if (k === 'then') return undefined;
    return (...a) => { calls.push({ name: String(k), args: a }); const v = k === 'getConfig' ? config : FIXTURES[k]; return Promise.resolve(v === undefined ? null : JSON.parse(JSON.stringify(v))); };
  } });
  const q = search ?? `?embedded=1${pane ? `&pane=${pane}` : ''}`;
  const dom = await JSDOM.fromFile(path.join(root, 'settings.html'), {
    url: `file://${root}/settings.html${q}`, runScripts: 'dangerously', resources: 'usable', virtualConsole: vc, pretendToBeVisual: true,
    beforeParse(w) {
      w.settingsApi = api; w.IntersectionObserver = class { observe() {} disconnect() {} };
      const st = w.setTimeout, si = w.setInterval;
      w.setTimeout = (...a) => { timers.push('timeout'); return st(...a); }; w.setInterval = (...a) => { timers.push('interval'); return si(...a); };
    },
  });
  await new Promise((r) => setTimeout(r, 600));
  const w = dom.window;
  // What is on screen: the top-level elements of every visible .pane that are not switched off, by their data-pane.
  const on = (el) => w.getComputedStyle(el).display !== 'none';
  const shown = [...w.document.querySelectorAll('.pane')].filter((p) => !p.hidden && on(p)).flatMap((p) => [...p.children].filter(on).map((c) => c.dataset.pane ?? 'untagged'));
  return { w, calls, timers, errors, shown, close: () => w.close() };
}
// The api method each channel is reached by, so the boot test can compare what a pane called with the table.
const METHOD_CHANNEL = {};
for (const m of preloadSrc.matchAll(/^\s+(\w+): (?:\([^)]*\)|\w+) => ipcRenderer\.invoke\('([a-z:-]+)'/gm)) METHOD_CHANNEL[m[1]] = m[2];
Object.assign(METHOD_CHANNEL, { spendSafety: null });

test('a pane page shows only its own pane, calls only its own channels, and starts no timers for the others', async () => {
  for (const pane of SP.PANES) {
    const b = await boot({ pane });
    try {
      assert.ok(b.shown.length > 0, `${pane} shows something`);
      assert.deepEqual([...new Set(b.shown)], [pane], `${pane} shows only its own sections`);
      assert.deepEqual(b.errors, [], `${pane} boots clean`);
      for (const c of b.calls) {
        const ch = METHOD_CHANNEL[c.name];
        if (c.name === 'onShown' || c.name === 'onShowSection' || c.name === 'onGhosttyDockChanged' || c.name === 'goPane') continue;
        if (ch === undefined || ch === null) continue; // not a plain channel (spendSafety is a namespace)
        const owner = SP.CHANNEL_PANE[ch];
        assert.ok(owner === pane || owner === 'config', `${pane} called ${c.name} (${ch}), which ${owner} owns`);
      }
    } finally { b.close(); }
  }
});

test('a pane that owns nothing of a loader starts none of it (timers and calls), checked on the pane with the fewest', async () => {
  const spend = await boot({ pane: 'spend' });
  const general = await boot({ pane: 'general' });
  try {
    const names = (b) => new Set(b.calls.map((c) => c.name));
    for (const n of ['health', 'remoteDevices', 'cliStatus', 'gitStatus', 'signalEndpoint', 'interactionHostStatus', 'privacyText', 'compactionStats', 'busyStatus']) {
      assert.ok(!names(spend).has(n), `spend must not call ${n}`);
      if (n !== 'cliStatus') assert.ok(!names(general).has(n), `general must not call ${n}`);
    }
    assert.ok(names(general).has('cliStatus'), 'Command line is in General now');
    assert.ok(names(spend).has('spend'));
    assert.ok(names(general).has('voiceStatus'));
    assert.ok(!names(general).has('spend'));
  } finally { spend.close(); general.close(); }
});

test('the old page (no query) still shows every section and runs every loader', async () => {
  const b = await boot({ pane: null });
  try {
    assert.ok(b.shown.length >= 1);
    assert.deepEqual([...new Set(b.shown)], ['general'], 'the old page still shows one div.pane at a time (its first)');
    assert.equal(b.w.document.querySelectorAll('#section-nav button').length, 6, 'and keeps its six-button nav');
    const names = new Set(b.calls.map((c) => c.name));
    for (const n of ['spend', 'voiceStatus', 'cliStatus', 'gitStatus', 'signalEndpoint', 'compactionStats', 'getConfig']) assert.ok(names.has(n), n);
    assert.equal(b.w.SettingsPanes.current, null);
  } finally { b.close(); }
});

test('hostile ?pane= values render the old page and gain nothing; the main side never reads the query', async () => {
  for (const search of ['?embedded=1&pane=nope', '?embedded=1&pane=spend&pane=widget', '?embedded=1&pane=__proto__', '?embedded=1&pane=']) {
    const b = await boot({ search });
    try {
      assert.equal(b.w.SettingsPanes.current, null, search);
      const save = b.calls.filter((c) => c.name === 'saveConfig');
      assert.deepEqual(save, []);
    } finally { b.close(); }
  }
});

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const lastSave = (b) => { const s = b.calls.filter((c) => c.name === 'saveConfig'); return s.length ? s[s.length - 1].args[0] : null; };
const firstControl = (b, pane) => b.w.document.querySelector(`[data-pane="${pane}"] input[type=checkbox][id]:not([id^=voice-]):not([id^=compact-]):not([id^=spend-]):not([id^=safety-]):not([id^=native-board-]):not(#busyCalendar)`);

test('a pane saves only the keys it owns: the whole form is never sent from a pane, and a round trip changes exactly the edited key', async () => {
  for (const pane of SP.PANES) {
    const probe = await boot({ pane });
    let base;
    try {
      const c = firstControl(probe, pane);
      if (!c || !SP.ownedKeys(pane).some((k) => !['voice', 'compaction'].includes(k))) { probe.close(); continue; }
      probe.calls.length = 0;
      c.dispatchEvent(new probe.w.Event('change', { bubbles: true }));
      await settle();
      base = lastSave(probe);
      assert.ok(base && Object.keys(base).length > 0, `${pane}: a change saves`);
      for (const k of Object.keys(base)) assert.equal(SP.KEY_OWNER[k], pane, `${pane} sent ${k}, which ${SP.KEY_OWNER[k]} owns`);
      assert.deepEqual(Object.keys(base).sort(), SP.ownedKeys(pane).filter((k) => !['voice', 'compaction'].includes(k)).sort(), `${pane} sends all of its own keys (and only those; voice and compaction have their own saves)`);
    } finally { probe.close(); }
    // The stored config is what the page would have written. Load it, edit ONE control, save: exactly one key differs.
    const b = await boot({ pane, config: JSON.parse(JSON.stringify(base)) });
    try {
      const c = firstControl(b, pane);
      b.calls.length = 0;
      c.checked = !c.checked;
      c.dispatchEvent(new b.w.Event('change', { bubbles: true }));
      await settle();
      const next = lastSave(b);
      const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(base[k]));
      assert.equal(changed.length, 1, `${pane}: editing ${c.id} changed ${JSON.stringify(changed)}; hidden or dev-only owned controls must round-trip untouched`);
    } finally { b.close(); }
  }
});

test('a pane that is shown again re-reads config: a value another sender changed shows, and the next save does not revert it', async () => {
  const config = {};
  const probe = await boot({ pane: 'notifications' });
  let base;
  try {
    firstControl(probe, 'notifications').dispatchEvent(new probe.w.Event('change', { bubbles: true }));
    await settle();
    base = lastSave(probe);
  } finally { probe.close(); }
  Object.assign(config, JSON.parse(JSON.stringify(base)), { oneKeyApprove: false });
  const b = await boot({ pane: 'notifications', config });
  try {
    const box = b.w.document.getElementById('oneKeyApprove');
    assert.equal(box.checked, false);
    const shown = b.calls.filter((c) => c.name === 'onShown').map((c) => c.args[0]);
    assert.equal(shown.length, 1, 'the pane listens for main\'s shown push');
    config.oneKeyApprove = true; // another pane / the old page / the tray changed it while this view was detached
    b.calls.length = 0;
    shown[0]();
    await settle();
    assert.ok(b.calls.some((c) => c.name === 'getConfig'), 're-read on show');
    assert.equal(box.checked, true, 'the new value shows');
    const other = b.w.document.querySelector('[data-pane="notifications"] input[type=checkbox][id]:not(#oneKeyApprove):not(#busyCalendar)');
    b.calls.length = 0;
    other.checked = !other.checked;
    other.dispatchEvent(new b.w.Event('change', { bubbles: true }));
    await settle();
    assert.equal(lastSave(b).oneKeyApprove, true, 'the next save does not revert it');
  } finally { b.close(); }
});

// ── R8-2a: the sections are re-split by data-pane ──────────────────────────

// §9 of plan-r8.md as built: h2 (or block id) -> pane. 'none' = the old page only.
const SECTION_TABLE = {
  Sessions: 'general', Voice: 'general', 'How much to show': 'general', 'Command line': 'general',
  Alerts: 'notifications', 'Permission prompts': 'notifications', 'Busy & Focus': 'notifications',
  'Claude Code helpers': 'aitools', 'Boards in your AI apps': 'aitools', Compactor: 'aitools', 'Other tools': 'aitools',
  Widget: 'widget',
  Spend: 'spend', 'Runaway sessions': 'spend',
  Privacy: 'privacy', 'Crash reports': 'privacy', Policies: 'privacy', Backups: 'privacy',
  'Sharing and remote control': 'phone', 'Remote devices': 'phone',
  Health: 'advanced', 'Git and CI': 'advanced', 'Agent bus': 'advanced',
};

function settingsDoc() { return new JSDOM(read('settings.html')).window.document; }

test('every top-level element of every pane carries a data-pane, each section is whole, and the table is the one in the plan', () => {
  const doc = settingsDoc();
  const seen = new Map();
  let section = null;
  for (const el of doc.querySelectorAll('.pane > *')) {
    const pane = el.dataset.pane;
    assert.ok(pane === 'none' || SP.isPane(pane), `${el.tagName}#${el.id} has no valid data-pane (${pane})`);
    const name = el.tagName === 'H2' ? el.textContent.trim() : el.id === 'crash-reports' ? 'Crash reports' : el.id === 'policies' ? 'Policies' : el.id === 'backups' ? 'Backups' : el.id === 'health' ? 'Health' : null;
    if (name) { section = name; seen.set(name, new Set()); }
    assert.ok(section, 'content before the first heading');
    seen.get(section).add(pane);
  }
  for (const [name, panes] of seen) {
    const nothingNew = [...panes].filter((p) => p !== 'none');
    assert.equal(nothingNew.length, 1, `${name} is in exactly one pane: ${[...panes]}`);
    assert.equal(nothingNew[0], SECTION_TABLE[name], name);
  }
  assert.deepEqual([...seen.keys()].sort(), Object.keys(SECTION_TABLE).sort(), 'no section lost or invented');
  // The second "Permission prompts" heading is the answering block; both are Notifications.
  assert.equal(doc.getElementById('data-rights').dataset.pane, 'privacy', 'Your data (a section, not a heading) follows Privacy');
  assert.equal(doc.getElementById('answering-title').dataset.pane, 'notifications');
  assert.equal(doc.getElementById('askFromWidget-moved').closest('[data-pane]').dataset.pane, 'none', 'the "moved to Widget" note is for the old page only');
});

test('a key is only ever written by controls in the pane that owns it (no key spans two panes)', () => {
  const doc = settingsDoc();
  const js = read('settings.js');
  const save = js.slice(js.indexOf('async function saveAll()'), js.indexOf('const body = PANE'));
  const ids = { workingStaleMinutes: ['workingStaleMinutes'], stuckMinutes: ['stuckMinutes'], waitingStaleHours: ['waitingStaleHours'] };
  let checked = 0;
  let key = null;
  for (const line of save.split('\n')) {
    const m = line.match(/^ {8}([A-Za-z]+):/);
    if (m) key = m[1];
    if (!key) continue;
    for (const id of [...line.matchAll(/getElementById\('([\w-]+)'\)/g)].map((x) => x[1]).concat([...line.matchAll(/commaList\('(\w+)'/g)].map((x) => x[1]))) {
      const el = doc.getElementById(id);
      if (!el) continue;
      const pane = el.closest('[data-pane]')?.dataset.pane;
      assert.equal(pane, SP.KEY_OWNER[key], `${key} is written by #${id}, which sits in ${pane}, but ${SP.KEY_OWNER[key]} owns it`);
      checked++;
    }
  }
  assert.ok(checked > 35, `checked ${checked} controls`);
  assert.ok(Object.keys(ids).length);
});

test('nothing in a pane document survives on screen from another pane (the switch-off class), and a pane\'s nav lists every pane', async () => {
  const b = await boot({ pane: 'phone' });
  try {
    const buttons = [...b.w.document.querySelectorAll('#section-nav button')].map((x) => x.dataset.go);
    assert.deepEqual(buttons, SP.NAV);
    assert.equal(b.w.document.getElementById('answering-title').textContent, 'Answering from the widget');
    for (const el of b.w.document.querySelectorAll('.pane > *')) {
      assert.equal(el.classList.contains('not-pane'), el.dataset.pane !== 'phone', `${el.tagName}#${el.id}`);
    }
  } finally { b.close(); }
  const old = await boot({ pane: null });
  try {
    assert.equal(old.w.document.querySelectorAll('.not-pane').length, 0, 'the old page switches nothing off');
    assert.equal(old.w.document.getElementById('answering-title').textContent, 'Permission prompts');
  } finally { old.close(); }
});

// ── deep links (ledger 20) ─────────────────────────────────────────────────

function deepLinks({ preview }) {
  const code = between(mainSrc, 'const SECTION_PANE = ', '// Preferences scrolled to its Health section');
  const calls = [];
  const ctx = { CHAT_PREVIEW: preview, openBuddy: (id) => calls.push(['open', id]), buddyWin: { sendToPage: (...a) => calls.push(['send', ...a]) } };
  vm.runInNewContext(`${code}\nglobalThis.out = { openSettingsAt, SECTION_PANE };`, ctx);
  return { ...ctx.out, calls };
}

test('deep links: gate off is exactly the old calls; gate on selects the pane from a closed table; unknown sections do nothing new', () => {
  for (const section of ['widget', 'health']) {
    const off = deepLinks({ preview: false });
    off.openSettingsAt(section);
    assert.deepEqual(off.calls, [['open', 'settings'], ['send', 'settings', 'show-section', section]], `gate off ${section}`);
  }
  const w = deepLinks({ preview: true });
  w.openSettingsAt('widget');
  assert.deepEqual(w.calls, [['open', 'settings:widget']], 'the pane is the destination, no push needed');
  const h = deepLinks({ preview: true });
  h.openSettingsAt('health');
  assert.deepEqual(h.calls, [['open', 'settings:advanced'], ['send', 'settings:advanced', 'show-section', 'health']], 'Health scroll push goes to the Advanced pane only');
  for (const bad of ['__proto__', 'constructor', 'nope', '', undefined, null, 5]) {
    const x = deepLinks({ preview: true });
    x.openSettingsAt(bad);
    assert.deepEqual(x.calls, [['open', 'settings'], ['send', 'settings', 'show-section', bad]], `unknown ${String(bad)} falls back to the old call`);
  }
  for (const pane of Object.values(deepLinks({ preview: true }).SECTION_PANE)) assert.ok(SP.isPane(pane));
  assert.match(mainSrc, /function showHealth\(\) \{ openSettingsAt\('health'\); \}/, 'the tray item');
  assert.match(mainSrc, /ipcMain\.handle\('open-widget-settings', \(e\) => \{ if \(!inputSenderOk\(e\)\) return false; openSettingsAt\('widget'\); return true; \}\);/);
});

test('route() takes a pane id only with the preview on', () => {
  const off = world(false); off.api.route(`settings:${'advanced'}`);
  assert.deepEqual(off.calls, []);
  const on = world(true); on.api.route(`settings:${'advanced'}`);
  assert.deepEqual(on.calls, [['state'], ['local', 'settings:advanced']]);
  const bad = world(true); bad.api.route(`settings:${'nope'}`);
  assert.deepEqual(bad.calls, [], 'not a pane, not a page');
});
