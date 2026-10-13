'use strict';
// D5: widget rules from the community gallery. Main confirms natively, then
// offers them to Widget rules, which still needs Load and Save.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testTempDir } = require('./helpers/tmp');
const Gallery = require('../src/gallery.js');
const S = require('../src/gallery-schema.js');
const Rules = require('../rules.js');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const rule = (id, name, then = { lamp: 'green' }) => Rules.normalizeRule({ id, name, when: { signal: ['done'] }, then });
const rulesItem = (over = {}) => ({ schema: 1, kind: 'rules', id: 'calm', title: 'Calm lights', summary: 'Quiet rules.', author: { name: 'Ana', github: 'ana-dev' }, license: 'CC0-1.0', tags: [], stacks: ['any'], tools: [], added: '2026-10-01', updated: '2026-10-05', payload: { rulesVersion: Rules.RULES_VERSION, rules: [rule('r1', 'Done'), rule('r2', 'Done quietly', { lamp: 'green', sound: 'none' })] }, ...over });

async function rig(t, { item = rulesItem(), confirm = true, demo = false } = {}) {
  const dir = testTempDir('gallery-rules-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from(S.buildIndex([{ item, name: item.id }]).text);
  const confirms = [], offers = [];
  const g = Gallery.create({ dataDir: dir, keysDir: dir, now: () => NOW, demo: () => demo, fetch: async () => new Response(bytes), confirm: async (o) => { confirms.push(o); return confirm; }, offerRules: (r) => offers.push(r) });
  const v = await g.fetchIndex();
  return { g, v, confirms, offers, sha: v.items[0].sha256 };
}

test('widget rules are addable and previewed by name', async (t) => {
  const r = await rig(t);
  assert.ok(S.ADDABLE.includes('rules'));
  assert.equal(r.v.items[0].addable, true);
  assert.deepEqual(r.v.items[0].preview, { names: ['Done', 'Done quietly'] });
});

test('adding widget rules confirms natively first, then offers them; nothing is offered on Cancel', async (t) => {
  const no = await rig(t, { confirm: false });
  const out = await no.g.add('rules/calm', no.sha);
  assert.equal(out.cancelled, true);
  assert.equal(no.offers.length, 0);

  const r = await rig(t);
  assert.deepEqual(await r.g.add('rules/calm', r.sha), { ok: true, kind: 'rules' });
  assert.equal(r.confirms.length, 1);
  assert.equal(r.confirms[0].action, 'Open in Widget rules');
  assert.match(r.confirms[0].detail, /by Ana \(@ana-dev\), self-declared/);
  assert.match(r.confirms[0].detail, /2 widget rules: Done, Done quietly\./);
  assert.match(r.confirms[0].detail, /only if you press Load there and then Save/);
  assert.equal(r.offers.length, 1);
  assert.deepEqual(r.offers[0].map((x) => x.name), ['Done', 'Done quietly']);
  assert.deepEqual(r.offers[0], r.offers[0].map(Rules.normalizeRule), 'offered in the app’s rule format');
});

test('rules from an older rulesVersion are migrated like an imported rules file', async (t) => {
  const old = rulesItem({ payload: { rulesVersion: 1, rules: [rule('r1', 'Done')] } });
  const r = await rig(t, { item: old });
  await r.g.add('rules/calm', r.sha);
  const expected = Rules.migrateRules([rule('r1', 'Done')], 1);
  assert.ok(expected.length > 1, 'migration adds the newer default rules');
  assert.deepEqual(r.offers[0], expected);
});

test('a wrong sha or the demo adds nothing', async (t) => {
  const r = await rig(t);
  assert.match((await r.g.add('rules/calm', 'f'.repeat(64))).error, /changed or is no longer/);
  const demo = await rig(t, { demo: true });
  assert.match((await demo.g.add('rules/calm', demo.sha)).error, /demo/);
  assert.equal(r.offers.length + demo.offers.length, 0);
  assert.equal(r.confirms.length + demo.confirms.length, 0);
});

test('main offers through Widget rules; the page waits for its own rules before showing the offer', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /offerRules: \(rules\) => showLightsView\('rules', \{ event: 'rules:offer', data: rules \}\)/);
  const preload = fs.readFileSync(path.join(ROOT, 'lights-preload.js'), 'utf8');
  assert.match(preload, /onOffer: \(cb\) => ipcRenderer\.on\('rules:offer', \(e, rules\) => cb\(rules\)\)/);
  const view = fs.readFileSync(path.join(ROOT, 'lights-view.js'), 'utf8');
  assert.match(view, /window\.lightsApi\.onOffer\(\(incoming\) => \{ if \(Array\.isArray\(incoming\)\) void booted\.then\(\(\) => offerRules\(incoming, 'From the gallery — Save to keep them'\)\); \}\);/);
  assert.match(view, /const booted = \(async \(\) => \{/);
});
