'use strict';
// Redesign R1: the committed page-id inventory (plan-redesign §R2.5, lead
// decision 4) stays current, and every id it finds is a page, a flow, a
// section or a reviewed exception.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const P = require('../buddy-window/pages.js');
const { render, inventory, OUT, IN_SCOPE } = require('../scripts/page-id-inventory.js');

// Matches of the parsed shapes that are not main-window page ids, each reviewed.
const NOT_PAGE_IDS = {
  // A different select(): the signing step's per-binary entitlement selector.
  '/fixture/app/Contents/MacOS/Plexiform\ttest/setups-helper-build.test.js': 'helper build fixture',
  '/fixture/app/Contents/Resources/calendar-helper/buddy-calendar\ttest/setups-helper-build.test.js': 'helper build fixture',
  '/fixture/app/Contents/Resources/setups/buddy-setups\ttest/setups-helper-build.test.js': 'helper build fixture',
  // The help page's own in-page navigate() to its onboarding screen.
  'onboarding\ttest-visual/simple-mode.spec.js': 'help in-page screen',
};

test('test/page-id-inventory.txt is current (regenerate with: node scripts/page-id-inventory.js --write)', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8'), render());
});

test('every inventoried id is a page, a flow, a section or a reviewed exception, and no exception is stale', () => {
  // R7-2: Usage's preview-only panes (usage:today) are pages with the preview on.
  const known = new Set([...P.flat().map((p) => p.id), ...P.FLOW_IDS, ...P.SECTIONS.map(P.sectionAddress), ...P.SECTIONS.map((s) => s.id), ...P.USAGE_PANES.map((p) => p.id)]);
  const used = new Set();
  for (const line of inventory()) {
    const [id, where, shape] = line.split('\t');
    assert.ok(where && shape, line);
    if (known.has(id)) continue;
    const k = `${id}\t${where}`;
    assert.ok(NOT_PAGE_IDS[k], `unknown page id "${id}" (${shape}) at ${where}: add a page, fix the id, or review it into NOT_PAGE_IDS`);
    used.add(k);
  }
  for (const k of Object.keys(NOT_PAGE_IDS)) assert.ok(used.has(k), `stale exception: ${k}`);
});

test('the inventory covers every page and section, and its scope is the desktop app and its tests', () => {
  const ids = new Set(inventory().map((l) => l.split('\t')[0]));
  for (const p of P.flat()) assert.ok(ids.has(p.id), p.id);
  assert.ok(ids.has('section:sessions'));
  for (const f of ['main.js', 'src/home-main.js', 'buddy-window/sidebar.js', 'test/redirect.test.js', 'test-visual/discover.spec.js', 'home.html']) assert.ok(IN_SCOPE(f), f);
  for (const f of ['board/web/js/app.js', 'site/index.html', 'remote/src/index.js', 'node_modules/x/index.js', 'test-visual/__screenshots__/a.png', 'test/page-id-inventory.txt']) assert.ok(!IN_SCOPE(f), f);
});

test('it parses the four call shapes only, with literal arguments', () => {
  const src = fs.readFileSync(require.resolve('../scripts/page-id-inventory.js'), 'utf8');
  for (const s of ['openBuddy', 'navigate', 'select', 'data-page']) assert.match(src, new RegExp(`\\['${s}', /`));
  assert.equal((src.match(/^  \['[a-zA-Z-]+', \//gm) || []).length, 4);
});

// Redesign R2a (plan-r2 Q1): the thread is not a page. It has no PAGES or
// SECTIONS entry, so the sidebar, route(), goTo() and deep links can never
// show it as one; only a row (openThread, gate-on) opens it.
test('the thread is reached only by a row: absent from PAGES and SECTIONS, a future id until R6a', () => {
  assert.equal(P.pageById('thread'), null);
  assert.ok(!P.SECTIONS.some((s) => s.id === 'thread' || s.pages.includes('thread')));
  assert.ok(P.FUTURE_IDS.includes('thread'));
  assert.ok(!inventory().some((l) => l.split('\t')[0] === 'thread'), 'no page-shaped reference to "thread" anywhere in scope');
});
