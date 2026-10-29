'use strict';
// QoL4a: My sessions' search matcher, and the folder-name hint a notification's "Show in Overview" hands it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../src/overview-mine-hint.js');
const W = require('../src/work-organise.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('queryOf: the folder name only, cleaned of control and direction characters, at most 100', () => {
  assert.equal(H.queryOf('/Users/me/proj/'), 'proj');
  assert.equal(H.queryOf('C:\\work\\api'), 'api');
  assert.equal(H.queryOf('/a/b\u202Egnp.exe'), 'bgnp.exe');
  assert.equal(H.queryOf('/a/x\u0007y\u2066z'), 'xyz');
  assert.equal(H.queryOf(`/a/${'n'.repeat(150)}`).length, 100);
  for (const bad of [null, undefined, 7, {}, '', '/', '   ']) assert.equal(H.queryOf(bad), '', String(bad));
});

test('the hint: set, taken once, gone after 10 s, cleared by a set with nothing usable', () => {
  const clock = { t: 1000 };
  const h = H.createMineHint({ now: () => clock.t });
  assert.equal(h.take(), null);
  assert.equal(h.set('/Users/me/app'), true);
  assert.deepEqual(h.take(), { query: 'app' });
  assert.equal(h.take(), null, 'once');
  h.set('/Users/me/app');
  clock.t += H.HINT_MS;
  assert.deepEqual(h.take(), { query: 'app' }, 'still fresh at exactly 10 s');
  h.set('/Users/me/app');
  clock.t += H.HINT_MS + 1;
  assert.equal(h.take(), null, 'expired');
  h.set('/Users/me/app');
  assert.equal(h.set(null), false);
  assert.equal(h.take(), null, 'a later unusable set replaces it');
});

test('matchesQuery: title, folder, AI tool, device, board, card key and child agents; case-insensitive; empty matches all', () => {
  const e = { task: { title: 'Fix login' }, project: 'api', provider: { label: 'Codex' }, device: { label: 'Studio' }, board: { label: 'Main board' }, card: { key: 'PLX-12' },
    children: [{ label: 'reviewer', task: { title: 'Check tests' } }] };
  for (const q of ['fix', 'API', 'codex', 'studio', 'main b', 'plx-12', 'REVIEWER', 'check tests', '  login  ', '']) assert.equal(W.matchesQuery(e, q), true, q);
  for (const q of ['zzz', 'Fix  login']) assert.equal(W.matchesQuery(e, q), false, q);
  assert.equal(W.matchesQuery({ task: { title: 'x' }, children: null }, 'x'), true);
  assert.equal(W.matchesQuery(null, 'x'), false);
});

test('main: only the local row\'s folder arms the hint, from the notification\'s Show in Overview; the channel is ungated and argument-free', () => {
  const main = read('main.js');
  assert.match(main, /else if \(b\.run === 'overview'\) \{\n\s+\/\/ QoL4a[^\n]*\n\s+const r = rowNow\(\);\n\s+if \(r && !r\.remote && !r\.device && !isRemote\(r\)\) OverviewMineHint\.set\(r\.cwd\); else OverviewMineHint\.clear\(\);\n\s+openBuddy\('overview'\);/);
  assert.doesNotMatch(main, /OverviewMineHint\.set\((n|note)\./, 'never the notification\'s own text');
  const om = read('src/overview-main.js');
  const at = om.indexOf("ipc.handle('overview:mine-hint'");
  assert.ok(at > 0 && at < om.indexOf('if(chatPreview===true){'), 'registered whatever the preview gate says');
  assert.match(om, /ipc\.handle\('overview:mine-hint',\(e,\.\.\.args\)=>\{const before=owner\(true\);if\(!allowed\(e,before\)\|\|args\.length!==0\|\|!mineHint\)return null;return mineHint\.take\(\);\}\);/);
  assert.match(read('overview-preload.js'), /mineHint: \(\) => ipcRenderer\.invoke\('overview:mine-hint'\),/);
  assert.match(read('test/fixtures/ipc-channels-gate-off.txt'), /^handle overview:mine-hint$/m);
});

test('page: a search left more than 10 minutes is cleared on return; the query never reaches store', () => {
  const js = read('overview-directory.js');
  assert.match(js, /if \(hiddenAt && Date\.now\(\) - hiddenAt > 600000 && \$\('mine-search'\)\.value\) \{ \$\('mine-search'\)\.value = ''; render\('mine'\); \}/);
  assert.doesNotMatch(js, /store\.write\([^)]*mine-search|store\.write\([^)]*mineQuery/);
});
