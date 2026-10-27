'use strict';
// Redesign R8-3c-2: the account screens in the Settings sheet are NAVIGATION ONLY (dev chat preview only). No second account document:
// the shared account view and flow stay as they are. Covers the sheet nav entries (settings:go-account), Back to Settings on the account page
// (buddy:acct:back-to-settings), ledger 24 (fromAccount needs the main frame) and ledger 27 (every buddy:acct:* handler is guarded, per handler).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const SP = require('../src/settings-panes.js');
const Pages = require('../buddy-window/pages.js');
const { ACCT_ARGS } = require('../buddy-window/account-flow.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const winSrc = read('buddy-window/index.js');
const lineOf = (needle) => { const l = winSrc.split('\n').find((x) => x.includes(needle)); assert.ok(l, needle); return l; };
const J = (v) => JSON.parse(JSON.stringify(v ?? null)); // values made inside a vm context are not reference-equal
const slice = (a, b) => { const i = winSrc.indexOf(a); const j = winSrc.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return winSrc.slice(i, j); };

// ── the nav map ────────────────────────────────────────────────────────────

test('ACCOUNT_NAV is a closed three-entry map to real pages; not owners; settings:go-pane does not take them', () => {
  assert.deepEqual({ ...SP.ACCOUNT_NAV }, { 'account-team': 'account', 'this-mac': 'thismac', team: 'team' });
  for (const [id, page] of Object.entries(SP.ACCOUNT_NAV)) {
    assert.ok(Pages.pageById(page), `${id} -> ${page} is a real page`);
    assert.equal(SP.isOwner(id), false, `${id} is not a sheet document`);
    assert.ok(SP.NAV.includes(id)); assert.ok(SP.TITLE[id]);
  }
  assert.equal(SP.NAV.includes('integrations'), false, 'Integrations lives in the Terminal pane (R8-3a)');
  assert.deepEqual(SP.NAV.slice(-3), ['account-team', 'this-mac', 'team']);
  assert.equal(Object.isFrozen(SP.ACCOUNT_NAV), true);
  assert.match(winSrc, /ipcMain\.on\('settings:go-pane', \(e, pane\) => \{ if \(fromSettingsPane\(e\) && SettingsPanes\.isOwner\(pane\)\) select\(`settings:\$\{pane\}`\); \}\);/);
});

// ── settings:go-account ────────────────────────────────────────────────────

function goAccount() {
  const handlers = new Map(); const selected = [];
  const mk = (id) => { const wc = { id, mainFrame: { url: 'file:///x.html' } }; return { webContents: wc }; };
  const localViews = new Map([...SP.OWNERS.map((p) => [`settings:${p}`, mk(p)]), ['home', mk('home')]]);
  const code = `${lineOf('const fromSettingsHtmlPane = ')}\n${lineOf("ipcMain.on('settings:go-account'")}`;
  vm.runInNewContext(code.replace('if (chatFirst === true) ', ''), { SettingsPanes: SP, localViews, isLocalPage: () => true, select: (...a) => selected.push(a), ipcMain: { on: (c, fn) => handlers.set(c, fn) } });
  const from = (p, frame = true) => { const wc = localViews.get(p.startsWith('home') ? 'home' : `settings:${p}`).webContents; return { sender: wc, senderFrame: frame ? wc.mainFrame : { url: wc.mainFrame.url } }; };
  return { go: handlers.get('settings:go-account'), selected, from };
}

test('settings:go-account: settings.html panes select the three account pages; everything else does nothing (S1: assert the select call)', () => {
  const g = goAccount();
  for (const p of SP.PANES) for (const [id, page] of Object.entries(SP.ACCOUNT_NAV)) g.go(g.from(p), id);
  assert.equal(g.selected.length, SP.PANES.length * 3);
  assert.deepEqual(J(g.selected.slice(0, 3)), [['account', { fromSheet: true }], ['thismac', { fromSheet: true }], ['team', { fromSheet: true }]]);
  g.selected.length = 0;
  for (const id of ['integrations', 'account', 'thismac', 'upgrade', 'sync', '__proto__', 'constructor', 'toString', '', 'account-team ', ['account-team'], { a: 1 }, null, undefined, 7]) g.go(g.from('general'), id);
  g.go(g.from('general')); // no argument
  for (const p of ['widget-rules', 'widget-look', 'character', 'phone-pairing', 'aitools-setup', 'account-plan', 'account-sync', 'home']) g.go(g.from(p), 'account-team');
  g.go(g.from('general', false), 'account-team'); // a child frame
  g.go({ sender: { id: 'x' }, senderFrame: { url: 'file:///x.html' } }, 'account-team');
  assert.deepEqual(g.selected, []);
  assert.match(winSrc, /if \(chatFirst === true\) ipcMain\.on\('settings:go-account'/, 'registered only with the preview on');
  const gateOff = fs.readFileSync(path.join(root, 'test/fixtures/ipc-channels-gate-off.txt'), 'utf8');
  assert.doesNotMatch(gateOff, /settings:go-account|back-to-settings/);
});

test('the Settings preload and nav: goAccount sends the one channel; a nav click on an account entry calls it, other entries are unchanged', () => {
  assert.match(read('settings-preload.js'), /goAccount: \(id\) => ipcRenderer\.send\('settings:go-account', typeof id === 'string' \? id : ''\),/);
  const js = read('settings.js');
  assert.match(js, /if \(PANE && window\.SettingsPanes\.ACCOUNT_NAV\[id\]\) \{ window\.settingsApi\.goAccount\?\.\(id\); return; \}\n\s+if \(PANE && id !== PANE\) \{ window\.settingsApi\.goPane\?\.\(id\); return; \}/);
  for (const f of ['widget-page-preload.js', 'hatch-preload.js', 'phone-pairing-preload.js', 'aitools-preload.js', 'upgrade-preload.js', 'sync-preload.js', 'lights-preload.js']) assert.doesNotMatch(read(f), /go-account/, f);
});

// ── ledger 24: the main frame ──────────────────────────────────────────────

function fromAccountFn() {
  const accountWc = { id: 'account', mainFrame: { url: 'file:///a.html' } };
  const ctx = { accountView: { webContents: accountWc }, isLocalPage: () => true };
  vm.runInNewContext(`${lineOf('const fromAccount = ')}\nglobalThis.fromAccount = fromAccount;`, ctx);
  return { accountWc, fromAccount: (e) => !!ctx.fromAccount(e), ctx };
}

test('ledger 24: fromAccount needs the account view\'s MAIN frame; a child frame, another view and a missing view are refused', () => {
  const f = fromAccountFn();
  assert.equal(f.fromAccount({ sender: f.accountWc, senderFrame: f.accountWc.mainFrame }), true);
  assert.equal(f.fromAccount({ sender: f.accountWc, senderFrame: { url: 'file:///a.html' } }), false, 'child frame of the account view');
  assert.equal(f.fromAccount({ sender: f.accountWc, senderFrame: null }), false);
  assert.equal(f.fromAccount({ sender: { id: 'sheet' }, senderFrame: f.accountWc.mainFrame }), false);
  f.ctx.accountView = null;
  assert.equal(f.fromAccount({ sender: f.accountWc, senderFrame: f.accountWc.mainFrame }), false);
  assert.match(lineOf('const fromAccount = '), /e\.sender === accountView\.webContents && e\.senderFrame === accountView\.webContents\.mainFrame && isLocalPage/);
});

// ── ledger 27: every buddy:acct:* handler, per handler ─────────────────────

test('ledger 27: the ACCT loop refuses a non-account sender and a child frame on EVERY op, and never calls the op', async () => {
  const handlers = new Map(); const called = [];
  const f = fromAccountFn();
  const ACCT = Object.fromEntries(Object.keys(ACCT_ARGS).map((op) => [op, (...a) => { called.push(op); return { ok: true }; }]));
  const loop = slice('  for (const [op, fn] of Object.entries(flow.ACCT)) {', '  const fromHubView = ');
  const ctx = { flow: { ACCT }, ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, fromAccount: (e) => f.fromAccount(e), ACCT_ARGS, captureEnabled: false, workCapture: {}, log() {}, require };
  vm.runInNewContext(loop, ctx);
  assert.deepEqual([...handlers.keys()].sort(), Object.keys(ACCT_ARGS).map((o) => `buddy:acct:${o}`).sort(), 'the loop registers exactly the flow ops');
  const sheetSender = { sender: { id: 'upgrade-sheet' }, senderFrame: f.accountWc.mainFrame };
  const childFrame = { sender: f.accountWc, senderFrame: { url: 'file:///a.html' } };
  for (const [ch, h] of handlers) {
    const args = ACCT_ARGS[ch.slice('buddy:acct:'.length)].map((t) => (t === 'boolean' ? true : 'x'));
    for (const e of [sheetSender, childFrame, { sender: null, senderFrame: null }]) assert.deepEqual(J(await h(e, ...args)), { ok: false, error: 'Not allowed.' }, ch);
  }
  assert.deepEqual(called, [], 'no op ran for a refused sender');
  const ok = { sender: f.accountWc, senderFrame: f.accountWc.mainFrame };
  const args = ACCT_ARGS.state.map(() => 'x');
  await handlers.get('buddy:acct:state')(ok, ...args);
  assert.deepEqual(called, ['state'], 'the account view\'s main frame still works');
});

test('ledger 27: every other buddy:acct:* registration is guarded by fromAccount as its first statement, and the list is complete', () => {
  const regs = [...winSrc.matchAll(/ipcMain\.(?:handle|on)\((?:`buddy:acct:\$\{op\}`|'buddy:acct:([A-Za-z-]+)')/g)].map((m) => m[1] ?? '${op}');
  assert.deepEqual(regs.sort(), ['${op}', 'back-to-settings', 'captureDefault', 'captureEnabled'], 'a new buddy:acct:* handler must be added to this check');
  const body = (name) => {
    const at = winSrc.indexOf(`ipcMain.handle('buddy:acct:${name}'`);
    assert.ok(at >= 0, name);
    const rest = winSrc.slice(at);
    return rest.slice(0, rest.indexOf('\n  });') + 6);
  };
  for (const name of ['captureEnabled', 'captureDefault', 'back-to-settings']) {
    const b = body(name);
    const firstStatement = b.split('\n').slice(1).find((l) => l.trim() && !l.trim().startsWith('//'));
    assert.match(firstStatement, /^\s+(if \(!fromAccount\(e\)|const .*|if \(!fromAccount\(e\) \|\|)/, name);
    assert.match(b.split('\n').slice(0, 3).join('\n'), /!fromAccount\(e\)/, `${name}: guarded in its first lines`);
  }
  // the loop's own guard is the first line of its handler
  const loop = slice('  for (const [op, fn] of Object.entries(flow.ACCT)) {', 'const types = ACCT_ARGS[op];');
  assert.match(loop, /if \(!fromAccount\(e\)\) return \{ ok: false, error: 'Not allowed\.' \};/);
});

// ── Back to Settings ───────────────────────────────────────────────────────

test('buddy:acct:back-to-settings: the account view\'s main frame only, preview only, fixed target', () => {
  const handlers = new Map(); const selected = [];
  const f = fromAccountFn();
  const code = slice("  // R8-3c-2: Back to Settings on the account page", "  ipcMain.handle('buddy:acct:captureEnabled'");
  vm.runInNewContext(code.replace('if (chatFirst === true) ', ''), { SettingsPanes: SP, ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, fromAccount: (e) => f.fromAccount(e), select: (...a) => selected.push(a) });
  const h = handlers.get('buddy:acct:back-to-settings');
  const refused = { ok: false, error: 'Not allowed.' };
  assert.deepEqual(J(h({ sender: { id: 'sheet' }, senderFrame: f.accountWc.mainFrame }, 'account')), refused);
  assert.deepEqual(J(h({ sender: f.accountWc, senderFrame: { url: 'x' } })), refused);
  assert.deepEqual(selected, []);
  assert.deepEqual(J(h({ sender: f.accountWc, senderFrame: f.accountWc.mainFrame }, 'anything', 'else')), { ok: true });
  assert.deepEqual(J(selected), [['settings:general']], 'one fixed target, arguments ignored');
  assert.match(winSrc, /if \(chatFirst === true\) ipcMain\.handle\('buddy:acct:back-to-settings'/);
  assert.match(read('buddy-window/account-preload.js'), /backToSettings: \(\) => call\('back-to-settings'\),/);
});

test('back=1 reaches the account page only from showScreen\'s query, only for a visit that began in the sheet; select() clears it otherwise', () => {
  assert.match(winSrc, /loadFile\(path\.join\(DIR, 'account\.html'\), \{ query: chatFirst === true && accountFromSheet \? \{ screen, back: '1' \} : \{ screen \} \}\)/);
  assert.match(winSrc, /function select\(id, \{ fromSheet = false \} = \{\}\) \{\n    const page = pageOf\(id\);\n    if \(!page\) return;\n    accountFromSheet = fromSheet === true;/);
  assert.equal((winSrc.match(/fromSheet: true/g) || []).length, 1, 'only settings:go-account sets it');
  assert.equal((winSrc.match(/\n\s+accountFromSheet = /g) || []).length, 1);
  assert.equal((winSrc.match(/back: '1'/g) || []).length, 1);
});

async function bootAccount(search) {
  const errors = []; const calls = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const api = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : (...a) => { calls.push(String(k)); return Promise.resolve(k === 'state' ? { ok: true, screen: 'account', brand: { name: 'P' }, accounts: [], teams: [] } : null); }) });
  const dom = await JSDOM.fromFile(path.join(root, 'buddy-window/account.html'), {
    url: `file://${root}/buddy-window/account.html${search}`, runScripts: 'dangerously', resources: 'usable', virtualConsole: vc, pretendToBeVisual: true,
    beforeParse(w) { w.buddyAccount = api; },
  });
  if (dom.window.document.readyState !== 'complete') await new Promise((r) => dom.window.addEventListener('load', r));
  await new Promise((r) => setTimeout(r, 300));
  return { w: dom.window, calls, errors };
}

test('account.js: Back to Settings only for back=1 exactly; a click calls backToSettings; it is never reflected into the page', async () => {
  const withBack = await bootAccount('?screen=account&back=1');
  try {
    const btn = [...withBack.w.document.querySelectorAll('button')].find((b) => b.textContent === 'Back to Settings');
    assert.ok(btn, 'button shown');
    btn.click();
    assert.ok(withBack.calls.includes('backToSettings'));
  } finally { withBack.w.close(); }
  for (const q of ['?screen=account', '?screen=account&back=2', '?screen=account&back=true', '?screen=account&back=%3Cb%3E', '?screen=account&back=']) {
    const b = await bootAccount(q);
    try {
      assert.equal([...b.w.document.querySelectorAll('button')].some((x) => x.textContent === 'Back to Settings'), false, q);
      assert.doesNotMatch(b.w.document.body.innerHTML, /back=|%3Cb/, q);
    } finally { b.w.close(); }
  }
});
