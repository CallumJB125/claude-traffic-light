'use strict';
// Organised views PR 7: This Mac → Automatic work cards lists one row per project with a team board, worded like
// the Sessions strip (src/work-routing-view.js), and its Change saves through captureDefault.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { rowsFor } = require('../src/work-routing-view.js');

const tick = () => new Promise((r) => setTimeout(r, 30));
const routing = [
  { repo: 'github.com/org/app', short: 'app', state: 'ask', destination: { kind: 'local' }, matches: [{ key: 'k1', team: 'Plexiform', board: 'Core', read_only: false }, { key: 'k2', team: 'Plexiform', board: 'Website', read_only: false }] },
  { repo: 'github.com/org/ro', short: 'ro', state: 'read_only', destination: { kind: 'local' }, matches: [{ key: 'k3', team: 'Ops', board: 'Ops', read_only: true }] },
  { repo: 'github.com/org/solo', short: 'solo', state: 'single', destination: { kind: 'team', key: 'k4', team: 'Plexiform', board: 'Core' }, matches: [{ key: 'k4', team: 'Plexiform', board: 'Core', read_only: false }] },
  { repo: 'github.com/org/none', short: 'none', state: 'unlinked', destination: { kind: 'local' }, matches: [] },
];
// What buddy-window/index.js puts in the This Mac state.
const projects = rowsFor(routing).map(({ repo, short, goesTo, note, change }) => ({ repo, short, goesTo, note, change }));

function page(saved) {
  const dom = new JSDOM('<!doctype html><main id="acct"></main>', { url: 'file:///account.html?screen=thismac', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.buddyAccount = new Proxy({
    state: async () => ({ ok: true, screen: 'thismac', brand: { name: 'Plexiform', copy: {}, defaultHost: 'app.plexiform.dev' }, signedInHubs: [], accounts: [], hubs: [],
      workCapture: { enabled: true, notice: null, tasks: [], projects } }),
    onChanged() {},
    captureDefault: async (repo, key) => { saved.push([repo, key]); return { ok: true }; },
    keepAwakeGet: async () => ({ on: false, label: '' }), macView: async () => null, burstStatus: async () => null,
  }, { get: (t, k) => t[k] ?? (async () => ({ ok: true })) });
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../buddy-window/account.js'), 'utf8'));
  return dom;
}

test('This Mac: a per-project table replaces the per-task select; Change saves the pick for that project', async () => {
  const saved = [];
  const dom = page(saved);
  try {
    await tick();
    const d = dom.window.document;
    const table = d.querySelector('table.acct-routing');
    assert.ok(table, 'the table is shown');
    const rows = [...table.querySelectorAll('tbody tr')];
    assert.deepEqual(rows.map((r) => r.querySelector('th').textContent), ['app', 'ro', 'solo'], 'a project on no team board is not listed: nothing to change');
    assert.match(rows[0].textContent, /Not chosen yet \(My board until you pick\)/);
    assert.match(rows[1].textContent, /read-only, so its work stays on My board/);
    assert.equal(rows[1].querySelector('select'), null, 'nothing to change to');
    assert.equal(rows[2].querySelector('select').value, 'k4', 'the current board is selected');
    assert.equal(d.querySelector('select[name="destination"] option[value="local"]').textContent, 'My board (private)');
    assert.doesNotMatch(d.body.textContent, /Board for future tasks in this repository|Save default/, 'the old per-task select is gone');
    const sel = rows[0].querySelector('select'); sel.value = 'k2';
    rows[0].querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    assert.deepEqual(saved, [['github.com/org/app', 'k2']]);
  } finally { dom.window.close(); }
});
