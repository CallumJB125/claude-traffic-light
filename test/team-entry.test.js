'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TeamEntry = require('../src/team-entry.js');
const AppMenu = require('../src/app-menu.js');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('hint: neutral without an account summary, and never claims a sign-in state', () => {
  const h = TeamEntry.hintFor(null, false);
  assert.deepEqual([h.text, h.label, h.page], ['Working with others? Plexiform has a shared team board.', 'Open Team', 'team']);
  assert.ok(!/signed|sign in/i.test(h.text));
});

test('hint: with a summary it appears only when signed out or without a team, and once', () => {
  assert.equal(TeamEntry.hintFor({ signedIn: false }, false).page, 'team');
  assert.equal(TeamEntry.hintFor({ signedIn: true, teamName: null }, false).page, 'create-team');
  assert.equal(TeamEntry.hintFor({ signedIn: true, teamName: 'Acme' }, false), null);
  assert.equal(TeamEntry.hintFor(null, true), null);
  assert.equal(TeamEntry.hintFor({ signedIn: false }, true), null);
});

test('settings view: neutral, signed out, signed in', () => {
  const n = TeamEntry.settingsView(null, 'hub.example');
  assert.match(n.line, /live on Plexiform's team hub \(hub\.example\)\./);
  assert.equal(n.signIn, true);
  assert.deepEqual(TeamEntry.settingsView({ signedIn: false }, 'h'), { line: 'Not signed in', signIn: true });
  assert.deepEqual(TeamEntry.settingsView({ signedIn: true, name: 'Ada', teamName: 'Acme', hubHost: 'hub.x' }, 'h'), { line: 'Signed in as Ada · Acme · hub.x', signIn: false });
  assert.match(TeamEntry.settingsView({ signedIn: true, name: 'Ada' }, 'h').line, /no team yet/);
});

test('tray and widget right-click are built from the same template', () => {
  assert.match(main, /\.\.\.AppMenu\.appItems\(\{ pages: sectionItems\(\), groups: \[\{ id: 'sections' \}\], open: openBuddy/);
  assert.match(main, /buildWidgetMenu = buildMenu;\n\s+trayMenu = buildMenu\(\);/);
  assert.match(main, /const menu = buildWidgetMenu\('widget'\);/);
  assert.match(main, /ipcMain\.handle\('widget-menu', \(e, opts\) => \{\n\s+if \(!win \|\| win\.isDestroyed\(\) \|\| e\.sender !== win\.webContents\) return;\n\s+if \(!\(opts && opts\.menu === true\)\) \{ openBuddy\(\); return; \}/);
});

test('app menu: every page is there, soon ones disabled, actions open the page', () => {
  const { PAGES, GROUPS } = require('../buddy-window/pages');
  const opened = [];
  const items = AppMenu.appItems({ pages: PAGES, groups: GROUPS, open: (id) => opened.push(id ?? null), openLabel: 'Open Plexiform…' });
  assert.equal(items[0].label, 'Open Plexiform…');
  assert.equal(items[0].accelerator, 'CmdOrCtrl+B');
  for (const p of PAGES) {
    const it = items.find((i) => i.label && i.label.startsWith(`Open ${p.title}…`));
    assert.ok(it, p.title);
    if (p.kind === 'soon') { assert.equal(it.enabled, false); assert.match(it.label, /\(soon\)$/); assert.equal(it.click, undefined); }
    else { it.click(); assert.equal(opened.pop(), p.id); }
  }
  assert.equal(items.find((i) => i.label === 'Open Widget configuration…').accelerator, 'CmdOrCtrl+L');
  assert.equal(items.find((i) => i.label === 'Open Preferences…').accelerator, 'CmdOrCtrl+,');
  const fb = { label: 'Something\u2019s off / Idea…', click() {} };
  assert.ok(AppMenu.appItems({ pages: PAGES, groups: GROUPS, open() {}, openLabel: 'x', feedback: fb }).includes(fb));
});

test('IPC: the account handlers answer Settings only, the hint handlers the widget only, and the page is never the renderer\'s', () => {
  for (const ch of ['account-view', 'account-open']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${ch}', \\(e[^)]*\\) => \\{\\n\\s+if \\(!settingsOnly\\(e\\)\\)`), ch);
  }
  assert.match(main, /ipcMain\.handle\('team-hint', \(e\) => widgetOnly\(e\) \?/);
  assert.match(main, /ipcMain\.handle\('team-hint-done', \(e, open\) => \{\n\s+if \(!widgetOnly\(e\)\) return false;/);
  assert.match(main, /openBuddy\(\['team', 'signin'\]\.includes\(which\) \? which : 'account'\)/);
  assert.match(main, /if \(open === true\) openBuddy\(hint\.page\)/);
});

test('the Plexiform window\'s account summary is optional and feature-checked', () => {
  assert.match(main, /typeof buddyWin\?\.accountSummary === 'function'/);
  assert.match(main, /typeof buddyWin\.onAccountChange === 'function'/);
});
