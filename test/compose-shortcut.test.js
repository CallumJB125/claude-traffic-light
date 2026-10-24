'use strict';
// The task box's global shortcut (src/compose-shortcut.js) and its order against the widget and voice keys.
// Off by default on every OS (team-lead, 2026-10-24): ⇧⌘Space is Parameter Hints in VS Code and Cursor.
const test = require('node:test');
const assert = require('node:assert/strict');
const CS = require('../src/compose-shortcut.js');
const WidgetPolish = require('../src/widget-polish-main.js');
const WidgetPage = require('../src/widget-page.js');
const { applyConfigSideEffects } = require('../src/config-effects.js');

function shortcuts(taken = []) {
  const held = new Map();
  return {
    held,
    register(a, fn) { const k = CS.canonicalAccelerator(a, 'darwin'); if (taken.includes(k) || [...held.keys()].some((x) => CS.canonicalAccelerator(x, 'darwin') === k)) return false; held.set(a, fn); return true; },
    unregister(a) { held.delete(a); },
  };
}

test('off by default on every OS: nothing is registered without a saved key', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const gs = shortcuts();
    const s = CS.install({ globalShortcut: gs, config: () => ({}), onPress: () => {}, platform });
    assert.equal(s.apply().state, 'off', platform);
    assert.equal(gs.held.size, 0, platform);
  }
  const mac = CS.install({ globalShortcut: shortcuts(), config: () => ({}), onPress: () => {}, platform: 'darwin' }).view();
  assert.equal(mac.suggestedLabel, '⇧⌘Space');
  assert.match(mac.editorNote, /Parameter Hints in VS Code and Cursor\. Clear the field to give it back\./);
  assert.equal(CS.install({ globalShortcut: shortcuts(), config: () => ({}), onPress: () => {}, platform: 'win32' }).view().suggestedLabel, 'Ctrl+Shift+Space');
});

test('turned on: registers, and pressing it only calls onPress', () => {
  const gs = shortcuts(); let pressed = 0;
  const s = CS.install({ globalShortcut: gs, config: () => ({ composeShortcut: CS.SUGGESTED }), onPress: () => { pressed++; }, platform: 'darwin' });
  assert.equal(s.apply().state, 'on');
  gs.held.get(CS.SUGGESTED)();
  assert.equal(pressed, 1);
  assert.equal(s.apply({ composeShortcut: '' }).state, 'off', 'clearing gives the key back');
  assert.equal(gs.held.size, 0);
});

test('a dev run never registers', () => {
  const gs = shortcuts();
  const s = CS.install({ globalShortcut: gs, config: () => ({ composeShortcut: CS.SUGGESTED }), onPress: () => {}, enabled: false, platform: 'darwin' });
  assert.equal(s.apply().state, 'dev');
  assert.equal(gs.held.size, 0);
});

test('finding 4: alias and order variants are one key', () => {
  const k = CS.canonicalAccelerator('CmdOrCtrl+Shift+Space', 'darwin');
  for (const a of ['Shift+Command+Space', 'Command+Shift+Space', 'cmd+shift+space', 'CommandOrControl+Shift+Space', 'Shift+Cmd+Space']) assert.equal(CS.canonicalAccelerator(a, 'darwin'), k, a);
  assert.equal(CS.canonicalAccelerator('Option+Command+K', 'darwin'), CS.canonicalAccelerator('Cmd+Alt+K', 'darwin'));
  assert.equal(CS.canonicalAccelerator('CmdOrCtrl+Shift+Space', 'win32'), CS.canonicalAccelerator('Ctrl+Shift+Space', 'win32'));
  assert.notEqual(CS.canonicalAccelerator('Command+Shift+Space', 'win32'), CS.canonicalAccelerator('Ctrl+Shift+Space', 'win32'));
  assert.equal(CS.canonicalAccelerator('F13'), null, 'a bare key is never a compose key (so it cannot be the voice key)');
});

test('R2: the widget’s configured key wins, read from config even when the widget never applied it', () => {
  const gs = shortcuts();
  const s = CS.install({ globalShortcut: gs, config: () => ({ composeShortcut: 'Command+Shift+Space', widgetShortcut: 'CmdOrCtrl+Shift+Space' }), onPress: () => {}, platform: 'darwin' });
  const v = s.apply();
  assert.equal(v.state, 'widget');
  assert.equal(gs.held.size, 0);
  assert.match(s.view().line, /Used by your widget shortcut/);
  assert.equal(CS.reserved({ voice: { hotkey: 'F15' } }, 'darwin')[0].owner, 'voice', 'the voice key is reserved too');
});

test('finding 4 and R5: the widget set to compose’s key after compose registered gets it; clearing it gives compose its key back', () => {
  const gs = shortcuts();
  let cfg = { composeShortcut: 'Command+Shift+Space' };
  const compose = CS.install({ globalShortcut: gs, config: () => cfg, onPress: () => {}, platform: 'darwin' });
  const widget = WidgetPolish.install({ ipcMain: { handle() {} }, utilityHandle: () => {}, globalShortcut: gs, config: () => cfg, widgetWindow: () => null, widgetAllowed: () => true, pageAllowed: () => true });
  assert.equal(compose.apply().state, 'on');
  const order = [];
  const d = {
    installHooks() {}, applyWidgetVisibility() {}, createTray() {}, broadcastStatus() {}, syncTailnetListener() {},
    applyVoiceHotkey: () => order.push('voice'),
    composeShortcut: (n) => { order.push('compose'); compose.apply(n); },
    widgetPolish: (p, n) => { order.push('widget'); widget.configChanged(p, n); },
    composeShortcutSettle: (n) => { order.push('settle'); compose.settle(n); },
  };
  const prev = cfg; cfg = { ...cfg, widgetShortcut: 'CmdOrCtrl+Shift+Space' };
  applyConfigSideEffects(prev, cfg, d);
  assert.deepEqual(order, ['compose', 'widget', 'settle'], 'compose lets go first');
  assert.equal(widget.shortcut, 'CmdOrCtrl+Shift+Space', 'the widget registered it');
  assert.equal(compose.view().state, 'widget');
  order.length = 0;
  const prev2 = cfg; cfg = { ...cfg, widgetShortcut: '' };
  applyConfigSideEffects(prev2, cfg, d);
  assert.deepEqual(order, ['compose', 'widget', 'settle']);
  assert.equal(widget.shortcut, null);
  assert.equal(compose.view().state, 'on', 'clearing the widget key: compose registers');
  assert.equal(compose.held, 'Command+Shift+Space');
  order.length = 0;
  applyConfigSideEffects({ ...cfg, voice: { hotkey: null } }, { ...cfg, voice: { hotkey: 'F15' } }, d);
  assert.deepEqual(order, ['compose', 'voice', 'settle'], 'before the voice line too');
});

test('another app holding it: marked taken, not retried until a setting changes', () => {
  let tries = 0;
  const gs = { register: () => { tries++; return false; }, unregister() {} };
  const s = CS.install({ globalShortcut: gs, config: () => ({ composeShortcut: CS.SUGGESTED }), onPress: () => {}, platform: 'darwin' });
  assert.equal(s.apply().state, 'taken');
  s.apply(); s.apply();
  assert.equal(tries, 1);
  assert.match(s.view().line, /Another app already uses this key/);
});

test('the widget page saves composeShortcut, cleaned, and "" turns it off', () => {
  assert.deepEqual(WidgetPage.cleanPatch({ composeShortcut: 'cmdorctrl+shift+space' }), { composeShortcut: 'CmdOrCtrl+Shift+Space' });
  assert.deepEqual(WidgetPage.cleanPatch({ composeShortcut: '' }), { composeShortcut: '' });
  assert.equal(WidgetPage.cleanPatch({ composeShortcut: 'Space' }), null, 'no modifier: refused');
  assert.equal(WidgetPage.configView({}).composeShortcut, '');
});
