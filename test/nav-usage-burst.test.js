'use strict';

// B1: the main window's sidebar has a "Usage & Burst" entry that opens the Usage optimiser
// page (optimiser.html), the same page the lights widget reaches through `usage:open-optimiser`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { PAGES, SECTIONS, GROUPS, FOOTER, sectionOf, sectionsFor, pageById } = require('../buddy-window/pages.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 30));

test('B1 registry: Usage & Burst is a sidebar section whose one page is the optimiser, on every platform', () => {
  const sec = SECTIONS.find((s) => s.title === 'Usage & Burst');
  assert.ok(sec, 'the entry exists');
  assert.equal(sec.id, 'optimiser');
  assert.equal(sec.default, 'optimiser');
  assert.deepEqual(sec.pages, ['optimiser']);
  assert.equal(sec.menu, 'more', 'listed under More in the tray and widget menus, so the six primary sections stay six');
  assert.equal(sectionOf('optimiser'), 'optimiser');
  const page = pageById('optimiser');
  assert.equal(page.file, 'optimiser.html');
  assert.equal(page.preload, 'optimiser-preload.js');
  assert.ok(!page.macOnly && !page.burstOnly && !page.hidden, 'everyone sees it; Burst-only parts say so inside the page');
  for (const platform of ['darwin', 'win32', 'linux']) assert.ok(sectionsFor(platform).some((s) => s.id === 'optimiser' && s.pages.includes('optimiser')), platform);
  assert.ok(!SECTIONS.find((s) => s.id === 'usage').pages.includes('optimiser'), 'Usage & cost no longer holds the optimiser');
  assert.ok(SECTIONS.filter((s) => s.menu === undefined).length <= 6);
});

test('B1 sidebar (JSDOM): the entry is rendered with its label and a click selects the optimiser page', async () => {
  const dom = new JSDOM(read('buddy-window/sidebar.html').replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, ''), { runScripts: 'outside-only', url: 'file:///synthetic/sidebar.html' });
  const selected = [];
  let onState;
  dom.window.buddy = { onState: (cb) => { onState = cb; }, pages: async () => ({ pages: PAGES, groups: GROUPS, sections: SECTIONS, footer: FOOTER, brand: { name: 'Plexiform', hubText: {} } }), select: (id) => selected.push(id), optimiserSection() {}, workspace() {}, signOut() {}, retry() {} };
  dom.window.eval(read('buddy-window/sidebar.js'));
  await settle();
  const d = dom.window.document;
  const btn = d.querySelector('[data-section="optimiser"]');
  assert.ok(btn, 'the section button is in the nav');
  assert.equal(btn.querySelector('.nav-label').textContent, 'Usage & Burst');
  assert.ok(btn.querySelector('svg.nav-icon'), 'with an icon like every other entry');
  onState({ selected: 'home' });
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  btn.click();
  assert.deepEqual(selected, ['optimiser'], 'one click, the optimiser page');
  onState({ selected: 'optimiser' });
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.equal(btn.hasAttribute('data-active'), true);
  // A single-page section lists no sub-entries: the entry itself is the page.
  assert.equal(btn.parentElement.querySelectorAll('.nav-sub .nav-item').length, 0);
  btn.click();
  assert.deepEqual(selected, ['optimiser'], 'clicking the open section again selects nothing new');
  dom.window.close();
});

test('B1 IPC: the sidebar select and the widget\'s usage:open-optimiser land on the same page in main', () => {
  const main = read('main.js');
  assert.match(main, /utilityHandle\('usage:open-optimiser', analyticsSender, \(\) => \{ openBuddy\('optimiser'\); return true; \}\);/);
  assert.match(read('buddy-window/sidebar-preload.js'), /select: \(id\) => ipcRenderer\.send\('buddy:select', String\(id\)\)/);
  assert.match(read('buddy-window/index.js'), /ipcMain\.on\('buddy:select', onSelect\)/);
  // The Burst notice and the lights widget open the optimiser through the same helper the sidebar's select reaches.
  assert.match(main, /BurstIpc\.setOpener\(\(\) => openBuddy\('optimiser'\)\)/);
});
