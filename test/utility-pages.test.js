'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { fromPage } = require('../src/utility-pages');
const { PAGES, GROUPS, pageById } = require('../buddy-window/pages');
const { appItems } = require('../src/app-menu');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const wc = () => ({ mainFrame: {}, isDestroyed: () => false });
const event = contents => ({ sender: contents, senderFrame: contents.mainFrame });

test('page authority refuses missing, foreign, destroyed and child-frame senders', () => {
  const contents = wc();
  assert.equal(fromPage(event(contents), contents), true);
  for (const [e, c] of [[null, contents], [event(wc()), contents], [event(contents), null], [{ sender: contents, senderFrame: {} }, contents]]) assert.equal(fromPage(e, c), false);
  contents.isDestroyed = () => true;
  assert.equal(fromPage(event(contents), contents), false);
});

test('all ordinary utility menu routes target main pages except Widget configuration', () => {
  const utilities = ['usage', 'stats', 'settings', 'help', 'hatch', 'updates', 'feedback', 'sessions', 'waiting', 'tasks'];
  for (const id of utilities) assert.equal(pageById(id).kind, 'local', id);
  assert.deepEqual(PAGES.filter(p => p.kind === 'window').map(p => p.id), ['lights']);
  for (const [id, view] of [['usage', 'mix'], ['stats', 'stats']]) assert.deepEqual(pageById(id).query, { embedded: '1', view });
  const opened = [];
  for (const item of appItems({ pages: PAGES, groups: GROUPS, open: id => opened.push(id), openLabel: 'Open' })) if (item.click) item.click();
  for (const id of utilities.concat('lights')) assert.ok(opened.includes(id), id);
});

function handlers() {
  const registered = new Map();
  const pages = Object.fromEntries(['usage', 'stats', 'settings', 'sessions', 'hatch', 'help', 'feedback'].map(id => [id, wc()]));
  const widget = wc(); const popup = wc(); const observed = []; const opened = [];
  const context = {
    require: p => p === './src/utility-pages.js' ? { fromPage } : require(path.join(__dirname, '..', p)),
    buddyWin: { pageWebContents: id => pages[id] }, win: { webContents: widget }, lightsWin: { webContents: popup },
    ipcMain: { handle: (channel, fn) => registered.set(channel, fn) },
    loadConfig: () => ({ fixture: 'config' }), Stats: { summary: () => ({ fixture: 'stats' }) }, stats: {},
    BurstIpc: { enrichSession: () => null },
    clipboard: { writeText: () => {} },
    SessionOverview: { snapshot: input => { observed.push(input); return { status: input.available === false ? 'unavailable' : 'complete' }; } },
    localSessions: sessions => sessions, aggregateState: () => ({ sessions: [{ fixture: 'metadata' }] }),
    IS_DEV_RUN: false, Adapters: { get: () => ({ isActivityInstalled: () => true }) }, os: { homedir: () => '/synthetic' }, HOOK_RUNTIME: {},
    createSettingsWindow: () => opened.push('settings'), Date,
  };
  const start = source.indexOf("const { fromPage } =");
  const end = source.indexOf('// plexiform://', start);
  vm.runInNewContext(source.slice(start, end), context);
  vm.runInNewContext("const settingsOnly = e => fromUtilityPage(e, 'settings'); const widgetOnly = e => fromPage(e, win?.webContents);", context);
  for (const channel of ['get-config', 'get-stats']) {
    const line = source.split('\n').find(s => s.startsWith(`utilityHandle('${channel}',`));
    vm.runInNewContext(line, context);
  }
  const sessionStart = source.indexOf("const sessionsSender =");
  const sessionEnd = source.indexOf('// Overview uses main-owned', sessionStart);
  assert.ok(sessionStart >= 0 && sessionEnd > sessionStart, 'extract the complete Sessions handlers before the separate Overview registration');
  vm.runInNewContext(source.slice(sessionStart, sessionEnd), context);
  return { registered, pages, widget, popup, observed, opened, context };
}

test('actual main IPC allows analytics reads but refuses unrelated page and subframe requests', () => {
  const f = handlers();
  const read = f.registered.get('get-stats');
  for (const id of ['stats', 'usage', 'settings']) assert.equal(read(event(f.pages[id]), 7).fixture, 'stats');
  for (const id of ['hatch', 'feedback', 'help', 'sessions']) assert.equal(read(event(f.pages[id]), 7), null);
  assert.equal(read({ sender: f.pages.stats, senderFrame: {} }, 7), null);
  assert.equal(read(event(f.popup), 7), null, 'Widget configuration does not expose analytics');
  assert.equal(f.registered.get('get-config')(event(f.widget)).fixture, 'config');
  assert.equal(f.registered.get('get-config')(event(f.popup)).fixture, 'config');
  assert.equal(f.registered.get('get-config')(event(f.pages.sessions)), null);
});

test('actual Sessions refresh and Preferences IPC require current main-frame Sessions owner', () => {
  const f = handlers();
  const refresh = f.registered.get('sessions:state'); const preferences = f.registered.get('sessions:settings');
  for (const e of [event(f.widget), event(f.popup), event(f.pages.settings), { sender: f.pages.sessions, senderFrame: {} }, {}]) {
    assert.equal(refresh(e), null); assert.equal(preferences(e), false);
  }
  assert.equal(f.observed.length, 0); assert.equal(f.opened.length, 0);
  assert.equal(refresh(event(f.pages.sessions)).status, 'complete');
  assert.equal(f.observed[0].activity.configured, true);
  assert.equal(preferences(event(f.pages.sessions)), true);
  assert.deepEqual(f.opened, ['settings']);
  const old = f.pages.sessions; f.pages.sessions = wc();
  assert.equal(refresh(event(old)), null);
  f.pages.sessions.isDestroyed = () => true;
  assert.equal(refresh(event(f.pages.sessions)), null);
});

test('Sessions observation failure stays unavailable and never returns the exception', () => {
  const f = handlers(); f.context.aggregateState = () => { throw new Error('private failure'); };
  assert.equal(f.registered.get('sessions:state')(event(f.pages.sessions)).status, 'unavailable');
  assert.equal(JSON.stringify(f.observed).includes('private failure'), false);
});
