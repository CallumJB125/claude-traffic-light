'use strict';
// Redesign R8-3c-1: Plan & billing and Sync as documents of the Settings sheet (dev chat preview only).
// Payments (entitlement:*) and sync secrets (sync:*) are guarded here: each document may call ONLY its own channels, through the REAL
// registrations. The handler bodies are unchanged except where ledger 23 says (sync:open / phone:upgrade pick the page by sender). Fake data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const SP = require('../src/settings-panes.js');
const Pages = require('../buddy-window/pages.js');
const Wiring = require('../src/paid-wiring.js');
const { testTempDir } = require('./helpers/tmp');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const mainSrc = read('main.js');
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return s.slice(i, j); };
const PLAN = 'settings:account-plan';
const SYNC = 'settings:account-sync';
const PHONE = 'settings:phone-pairing';
const from = (pageId, main = true) => ({ pageId, main });

function guards({ preview }) {
  const code = `${between(mainSrc, 'const sheetDoc = ', 'const widgetLookPage')}\n${between(mainSrc, 'const phonePage = ', 'const fromHatch')}`;
  const opened = []; const old = [];
  const ctx = { SettingsPanes: SP, CHAT_PREVIEW: preview, fromUtilityPage: (e, id) => e?.pageId === id && e.main === true, openBuddy: (id) => opened.push(id), buddyWin: { open: (id) => old.push(id) } };
  vm.runInNewContext(`${code}\nglobalThis.out = { phonePage, planPage, syncPage, openPlan };`, ctx);
  return { ...ctx.out, opened, old };
}

test('the two documents: own file and preload, outside PAGES, never config owners, in the nav and the redirect map', () => {
  const pl = Pages.paneById(PLAN); const sy = Pages.paneById(SYNC);
  assert.deepEqual([pl.file, pl.preload, { ...pl.query }], ['upgrade.html', 'upgrade-preload.js', { embedded: '1', sheet: '1' }]);
  assert.deepEqual([sy.file, sy.preload, { ...sy.query }], ['sync.html', 'sync-preload.js', { embedded: '1', sheet: '1' }]);
  for (const id of [PLAN, SYNC]) { assert.equal(Pages.pageById(id), null, 'gate off: the id resolves to nothing'); assert.ok(!JSON.stringify(Pages.PAGES).includes(`"${id}"`)); assert.ok(!Pages.FUTURE_IDS.includes(id)); }
  for (const p of ['account-plan', 'account-sync']) { assert.ok(SP.isOwner(p)); assert.equal(SP.isPane(p), false); assert.ok(!SP.CONFIG_OWNERS.includes(p)); assert.ok(SP.NAV.includes(p)); }
  assert.equal(SP.SHEET_TARGET.upgrade, 'account-plan');
  assert.equal(SP.SHEET_TARGET.sync, 'account-sync');
  for (const old of ['upgrade', 'sync']) assert.equal(Pages.REDIRECTS[old].until, 'R8', 'dropped at the R6a cut-over');
  assert.equal(Pages.paneById('settings:account'), null, 'the account screens are not documents (R8-3c-2)');
});

test('the preloads expose only their own channels, never get-config / save-config', () => {
  const chans = (f) => [...new Set([...read(f).matchAll(/(?:invoke|send|on)\('([A-Za-z:-]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(chans('upgrade-preload.js'), ['entitlement:open', 'entitlement:refresh', 'entitlement:sign-in', 'entitlement:state', 'settings:go-pane', 'settings:shown']);
  assert.deepEqual(chans('sync-preload.js'), ['settings:go-pane', 'settings:shown', 'sync:approve', 'sync:disable', 'sync:enable', 'sync:new-code', 'sync:now', 'sync:open', 'sync:recover', 'sync:revoke', 'sync:state']);
});

test('planPage / syncPage: the old page or that ONE document (top frame, preview only)', () => {
  const g = guards({ preview: true });
  assert.equal(g.planPage(from('upgrade')), true); assert.equal(g.planPage(from(PLAN)), true); assert.equal(g.planPage(from(PLAN, false)), false);
  for (const id of ['sync', SYNC, PHONE, 'settings:upgrade', 'settings:*', 'settings', 'home', 'team', undefined]) assert.equal(g.planPage(from(id)), false, `plan refuses ${id}`);
  assert.equal(g.syncPage(from('sync')), true); assert.equal(g.syncPage(from(SYNC)), true); assert.equal(g.syncPage(from(SYNC, false)), false);
  for (const id of ['upgrade', PLAN, PHONE, 'settings:sync', 'settings:*', 'settings', 'home', 'team', undefined]) assert.equal(g.syncPage(from(id)), false, `sync refuses ${id}`);
  const off = guards({ preview: false });
  assert.equal(off.planPage(from(PLAN)), false); assert.equal(off.syncPage(from(SYNC)), false);
  assert.equal(off.planPage(from('upgrade')), true); assert.equal(off.syncPage(from('sync')), true);
});

test('main.js: the successors are bound at the registration, the old ids are named once each', () => {
  for (const id of ['upgrade', 'sync']) assert.equal((mainSrc.match(new RegExp(`fromUtilityPage\\(e, '${id}'\\)`, 'g')) || []).length, 1, id);
  assert.doesNotMatch(mainSrc, /settings:\*/);
  assert.match(mainSrc, /phoneAllowed: phonePage, upgradeAllowed: planPage, syncAllowed: syncPage, openPlan, /);
  assert.equal((mainSrc.match(/CHAT_PREVIEW/g) || []).length, 14, 'no new gate use');
});

function wired({ preview = true } = {}) {
  const g = guards({ preview });
  const handlers = new Map(); const sent = [];
  const buddyOpen = [];
  const dir = testTempDir('r8-3c-');
  const realFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('no network in tests'); };
  const quits = [];
  const out = Wiring.registerAll({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, rootDir: dir, fromPage: (e, id) => e?.pageId === id && e.main === true, onQuit: (fn) => quits.push(fn), log() {},
    entitlements: { has: () => false, plan: () => 'free', limits: () => ({ devices: 0 }), on() {} }, setInteractionHostExtras() {},
    buddy: () => ({ interactionHostIdentity: () => ({ origin: 'https://hub.example', userId: 'u1', token: () => 't' }), open: (id) => buddyOpen.push(id), pageWebContents: () => null }),
    phoneAllowed: g.phonePage, upgradeAllowed: g.planPage, syncAllowed: g.syncPage, openPlan: g.openPlan,
  }, Wiring.PACKAGES.filter(([n]) => ['sync', 'entitlement-refresh', 'phone-approvals'].includes(n)));
  return { g, handlers, buddyOpen, out, done: () => { for (const q of quits) q(); globalThis.fetch = realFetch; } };
}

test('REAL registrations: the Plan document is refused on every sync:* channel, the Sync document on every entitlement:* channel, both ways (payments / secrets)', async () => {
  const w = wired();
  try {
    assert.ok(w.out.every((o) => o.status === 'ok'), JSON.stringify(w.out));
    const ent = ['entitlement:state', 'entitlement:refresh', 'entitlement:open', 'entitlement:sign-in'];
    const syn = [...w.handlers.keys()].filter((c) => c.startsWith('sync:'));
    assert.equal(syn.length, 9);
    for (const ch of ent) assert.ok(w.handlers.has(ch), ch);
    // entitlement:* answers the old page and the Plan document only
    for (const id of ['upgrade', PLAN]) assert.ok(await w.handlers.get('entitlement:state')(from(id)), `${id} may read the plan`);
    for (const id of [SYNC, PHONE, 'sync', 'settings:upgrade', 'team', 'home', undefined]) {
      for (const ch of ent) {
        const r = await w.handlers.get(ch)(from(id), 'checkout', 'month');
        assert.ok(r === null || r?.ok === false, `${id} must not use ${ch}`);
      }
    }
    assert.equal(await w.handlers.get('entitlement:state')(from(PLAN, false)), null, 'subframe');
    // sync:* answers the old page and the Sync document only
    for (const id of ['sync', SYNC]) assert.ok(await w.handlers.get('sync:state')(from(id)), `${id} may read sync`);
    for (const id of [PLAN, PHONE, 'upgrade', 'settings:sync', 'team', 'home', undefined]) {
      for (const ch of syn) assert.equal(await w.handlers.get(ch)(from(id), 'x'), null, `${id} must not use ${ch}`);
    }
    assert.equal(await w.handlers.get('sync:state')(from(SYNC, false)), null, 'subframe');
  } finally { w.done(); }
});

test('gate off: neither sheet document is a sender of anything', async () => {
  const w = wired({ preview: false });
  try {
    assert.equal(await w.handlers.get('entitlement:state')(from(PLAN)), null);
    assert.equal(await w.handlers.get('sync:state')(from(SYNC)), null);
    assert.equal(await w.handlers.get('phone:upgrade')(from(PHONE)), null);
    assert.ok(await w.handlers.get('entitlement:state')(from('upgrade')));
    assert.ok(await w.handlers.get('sync:state')(from('sync')));
  } finally { w.done(); }
});

test('ledger 23: See plans opens the sheet Plan document from a sheet sender and the old page from an old sender; sign-in always opens Team', async () => {
  const w = wired();
  try {
    // phone:upgrade (phone-pairing document in the sheet, the old Phone page otherwise)
    await w.handlers.get('phone:upgrade')(from(PHONE));
    await w.handlers.get('phone:upgrade')(from('phone'));
    await w.handlers.get('phone:upgrade')(from('home'));
    // sync:open
    await w.handlers.get('sync:open')(from(SYNC), 'upgrade');
    await w.handlers.get('sync:open')(from('sync'), 'upgrade');
    await w.handlers.get('sync:open')(from(PLAN), 'upgrade');
    await w.handlers.get('sync:open')(from(SYNC), 'account');
    await w.handlers.get('sync:open')(from('sync'), 'anything');
    // entitlement:sign-in
    await w.handlers.get('entitlement:sign-in')(from(PLAN));
    await w.handlers.get('entitlement:sign-in')(from('upgrade'));
    await w.handlers.get('entitlement:sign-in')(from(SYNC));
    assert.deepEqual(w.g.opened, [PLAN, PLAN], 'phone-pairing and sync sheet senders -> the sheet Plan document (the Plan document itself is refused on sync:*)');
    assert.deepEqual(w.g.old, ['upgrade', 'upgrade'], 'old pages -> the old Plan page');
    assert.deepEqual(w.buddyOpen, ['team', 'team', 'team', 'team'], 'sign-in and Team links stay on the Team page (sync account/other, entitlement sign-in from the Plan document and the old page)');
  } finally { w.done(); }
});

test('handler bodies are unchanged: the entitlement and sync handlers still do exactly what they did (static pins)', () => {
  const ent = read('src/entitlement-refresh.js');
  assert.match(ent, /ipcMain\.handle\('entitlement:state', \(e\) => \(fromUpgrade\(e\) \? \{ \.\.\.describe\(\), signedIn: !!refresher\.current\(\), lastCheck: refresher\.last\(\) \} : null\)\);/);
  assert.match(ent, /ipcMain\.handle\('entitlement:open', async \(e, kind, interval\) => \{\n    if \(!fromUpgrade\(e\)\) return \{ ok: false \};\n    const r = await refresher\.link\(kind === 'portal' \? 'portal' : 'checkout', interval\);\n    const url = r\.ok \? r\.url : r\.fallback;\n    if \(url\) await open\(url\);\n    return \{ ok: !!url, reason: r\.reason \?\? null \};\n  \}\);/);
  assert.match(ent, /const open = \(url\) => shell\.openExternal\(url\); \/\/ privacy-flow: billing-checkout-link/);
  assert.match(ent, /ipcMain\.handle\('entitlement:sign-in', \(e\) => \{ if \(fromUpgrade\(e\)\) ctx\.buddy\?\.\(\)\?\.open\?\.\('team'\); return null; \}\);/);
  const sync = read('src/sync/index.js');
  for (const line of [
    "ipcMain.handle('sync:state', wrap(view));",
    "ipcMain.handle('sync:disable', wrap(async () => { store.save('settings', { ...settings(), enabled: false }); return { ok: true }; }));",
    "ipcMain.handle('sync:recover', wrap(async (code) => { const r = await client.recover(String(code ?? '')); store.save('settings', { ...settings(), enabled: true }); round(); return r; }));",
    "ipcMain.handle('sync:approve', wrap(async (id) => client.approve(String(id ?? ''))));",
    "ipcMain.handle('sync:revoke', wrap(async (id) => client.revoke(String(id ?? ''))));",
    "ipcMain.handle('sync:new-code', wrap(async () => client.newRecoveryCode()));",
    "ipcMain.handle('sync:now', wrap(async () => round()));",
    "const wrap = (fn) => async (e, ...args) => {\n    if (!fromSync(e)) return null;\n    try { return await fn(...args); } catch (err) {\n      return { ok: false, code: err?.code ?? 'error', message: err?.message ?? String(err) };\n    }\n  };",
  ]) assert.ok(sync.includes(line), line.slice(0, 60));
  assert.ok(sync.includes("ipcMain.handle('sync:enable', wrap(async () => {\n    if (!E.has('sync')) return { ok: false, code: 'PLAN_REQUIRED', message: \"Sync isn't part of your current plan.\" };\n    const r = await client.enable();"));
});

async function boot(file, search, api) {
  const errors = []; const calls = []; const hooks = {};
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const proxy = (vals) => new Proxy({}, { get: (_, k) => {
    if (k === 'then') return undefined;
    if (/^on[A-Z]/.test(String(k))) return (cb) => { calls.push(String(k)); hooks[String(k)] = cb; };
    return (...a) => { calls.push(String(k)); const v = typeof vals[k] === 'function' ? vals[k](...a) : vals[k]; return Promise.resolve(v === undefined ? null : JSON.parse(JSON.stringify(v))); };
  } });
  const dom = await JSDOM.fromFile(path.join(root, file), {
    url: `file://${root}/${file}${search}`, runScripts: 'dangerously', resources: 'usable', virtualConsole: vc, pretendToBeVisual: true,
    beforeParse(w) { for (const [k, v] of Object.entries(api)) w[k] = proxy(v); w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} })); },
  });
  if (dom.window.document.readyState !== 'complete') await new Promise((r) => dom.window.addEventListener('load', r));
  await new Promise((r) => setTimeout(r, 300));
  return { w: dom.window, calls, errors, hooks, close: () => dom.window.close() };
}
const PLAN_STATE = { plan: 'free', entitled: false, signedIn: true, features: [], limits: {}, lastCheck: null };
const SYNC_STATE = { entitled: false, plan: 'free', signedIn: true, enabled: false, local: {}, last: null, hub: null };

test('the Plan & billing page in the sheet: Back button and a re-read when shown; the old page has neither', async () => {
  const sheet = await boot('upgrade.html', '?embedded=1&sheet=1', { plan: { state: PLAN_STATE } });
  try {
    assert.deepEqual(sheet.errors, []);
    const btn = sheet.w.document.getElementById('back-settings');
    assert.equal(btn.hidden, false);
    const before = sheet.calls.filter((c) => c === 'state').length;
    await sheet.hooks.onShown();
    assert.ok(sheet.calls.filter((c) => c === 'state').length > before);
    btn.click();
    assert.ok(sheet.calls.includes('goPane'));
  } finally { sheet.close(); }
  const old = await boot('upgrade.html', '', { plan: { state: PLAN_STATE } });
  try { assert.equal(old.w.document.getElementById('back-settings').hidden, true); assert.equal(old.calls.includes('onShown'), false); } finally { old.close(); }
});

test('the Sync page in the sheet: Back button and a re-read when shown; the old page has neither', async () => {
  const sheet = await boot('sync.html', '?embedded=1&sheet=1', { sync: { state: SYNC_STATE } });
  try {
    assert.deepEqual(sheet.errors, []);
    const btn = sheet.w.document.getElementById('back-settings');
    assert.equal(btn.hidden, false);
    const before = sheet.calls.filter((c) => c === 'state').length;
    await sheet.hooks.onShown();
    assert.ok(sheet.calls.filter((c) => c === 'state').length > before);
    btn.click();
    assert.ok(sheet.calls.includes('goPane'));
  } finally { sheet.close(); }
  const old = await boot('sync.html', '', { sync: { state: SYNC_STATE } });
  try { assert.equal(old.w.document.getElementById('back-settings').hidden, true); assert.equal(old.calls.includes('onShown'), false); } finally { old.close(); }
});

test('the two sheet documents are refused on every buddy:acct:* channel (fromAccount needs the account view\'s own webContents); no preload names an account or token channel', () => {
  const winSrc = read('buddy-window/index.js');
  const line = winSrc.split('\n').find((l) => l.includes('const fromAccount = '));
  assert.ok(line, 'fromAccount exists');
  assert.match(line, /accountView && e\.sender === accountView\.webContents && isLocalPage\(e\.senderFrame\?\.url \?\? ''\)/);
  const accountWc = { id: 'account' };
  const ctx = { accountView: { webContents: accountWc }, isLocalPage: () => true };
  vm.runInNewContext(`${line}\nglobalThis.fromAccount = fromAccount;`, ctx);
  const sheetWc = (id) => ({ id });
  for (const id of ['upgrade-sheet', 'sync-sheet', 'phone-sheet']) assert.equal(!!ctx.fromAccount({ sender: sheetWc(id), senderFrame: { url: 'file:///x.html' } }), false, id);
  assert.equal(!!ctx.fromAccount({ sender: accountWc, senderFrame: { url: 'file:///x.html' } }), true, 'only the account view');
  // every buddy:acct:* handler goes through fromAccount
  assert.ok(!/ipcMain\.handle\(`buddy:acct:\$\{op\}`/.test(winSrc) || /if \(!fromAccount\(e\)\) return \{ ok: false, error: 'Not allowed\.' \};/.test(winSrc));
  for (const f of ['upgrade-preload.js', 'sync-preload.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /buddy:acct|buddyAccount|token|burst|keepawake/i, f);
  }
});
