'use strict';
// The Tasks page's community gallery view (gallery-view.js), rendered in jsdom
// against a stubbed galleryApi whose answers come from the real main service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { testTempDir } = require('./helpers/tmp');
const Gallery = require('../src/gallery.js');
const S = require('../src/gallery-schema.js');
const Hatch = require('../characters/hatch.js');
const Rules = require('../rules.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'tasks.html'), 'utf8');
const scripts = ['recipes.js', 'gallery-view.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
const base = (kind, id, payload, over = {}) => ({ schema: 1, kind, id, title: `Title ${id}`, summary: `About ${id}.`, author: { name: 'Ana', github: 'ana-dev' }, license: 'CC0-1.0', tags: [], stacks: ['any'], tools: [], added: '2026-10-01', updated: '2026-10-05', payload, ...over });
const items = [
  base('recipe', 'explain-it', { id: 'explain-it', title: 'Title explain-it', what: 'Explains the repo.', prompt: 'THE FULL PROMPT <b>text</b>', tool: 'auto', edits: false, cost: 'Low.' }, { stacks: ['python'] }),
  base('character', 'pebble', Hatch.templateCharacter({ name: 'Pebble' }), { stacks: ['swift'] }),
  base('pack', 'starter', { members: ['recipe/explain-it', 'character/pebble', 'rules/calm'], note: 'Starter.' }),
  base('rules', 'calm', { rulesVersion: Rules.RULES_VERSION, rules: [Rules.normalizeRule({ id: 'r1', name: 'Done', when: { signal: ['done'] }, then: { lamp: 'green' } })] }),
];
const tick = () => new Promise((r) => setTimeout(r, 0));

async function rig(t, { demo = false, cachedFirst = false } = {}) {
  const dir = testTempDir('gallery-view-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from(S.buildIndex(items.map((item) => ({ item, name: item.id }))).text);
  const service = Gallery.create({ dataDir: dir, keysDir: dir, now: () => Date.parse('2026-10-10T12:00:00.000Z'), demo: () => demo, fetch: async () => new Response(bytes) });
  if (cachedFirst) await service.fetchIndex();
  const calls = { fetch: 0, add: [], list: 0 };
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.recipesApi = { list: async () => { calls.list += 1; return { ok: true, builtIn: [], mine: [], canSchedule: true, demo }; }, pickFolder: async () => null };
  w.galleryApi = { refresh: async () => { calls.fetch += 1; return service.fetchIndex(); }, cached: async () => service.cached(), add: async (id, sha) => { calls.add.push([id, sha]); return { ok: true, id: 'explain-it', kind: id.split('/')[0] }; } };
  for (const s of scripts) w.eval(s);
  await tick();
  const $ = (sel) => w.document.querySelector(sel);
  const $$ = (sel) => [...w.document.querySelectorAll(sel)];
  const cards = () => $$('#cg-gallery .cg-card').map((c) => c.dataset.id);
  return { w, $, $$, calls, cards };
}

test('opening the gallery fetches nothing until Fetch is pressed; then it lists what main verified', async (t) => {
  const r = await rig(t);
  r.$('#cg-open').click(); await tick();
  assert.equal(r.$('#cg-gallery').hidden, false);
  assert.ok(r.w.document.body.classList.contains('cg-open'));
  assert.equal(r.calls.fetch, 0);
  const fetchBtn = r.$$('#cg-gallery button').find((b) => b.textContent === 'Fetch the gallery');
  assert.ok(fetchBtn);
  fetchBtn.click(); await tick(); await tick();
  assert.equal(r.calls.fetch, 1);
  assert.deepEqual(r.cards(), ['character/pebble', 'pack/starter', 'recipe/explain-it', 'rules/calm']);
  assert.match(r.$('.cg-provenance').textContent, /^Unsigned · fetched from plexiform\.dev over HTTPS$/);
  assert.match(r.$('#cg-gallery').textContent, /Fetched /);
  assert.ok(r.$$('#cg-gallery button').some((b) => b.textContent === 'Refresh'));
  const recipe = r.$('[data-id="recipe/explain-it"]');
  assert.equal(recipe.querySelector('pre').textContent, 'THE FULL PROMPT <b>text</b>', 'text, never markup');
  assert.equal(recipe.querySelector('b'), null);
  assert.match(recipe.textContent, /by Ana \(@ana-dev\), self-declared/);
  assert.match(r.$('[data-id="rules/calm"]').textContent, /1 widget rule/);
  assert.equal(r.$('[data-id="rules/calm"] .cg-members li').textContent, 'Done');
  assert.ok(r.$('[data-id="rules/calm"] .recipe-actions button'));
});

test('with a cache it opens without fetching; filters and search narrow the list', async (t) => {
  const r = await rig(t, { cachedFirst: true });
  r.$('#cg-open').click(); await tick();
  assert.equal(r.calls.fetch, 0);
  assert.equal(r.cards().length, 4);
  r.$$('.cg-chip').find((b) => b.textContent === 'Characters').click();
  assert.deepEqual(r.cards(), ['character/pebble']);
  r.$$('.cg-chip').find((b) => b.textContent === 'All').click();
  const stack = r.$('.cg-stack'); stack.value = 'python'; stack.dispatchEvent(new r.w.Event('change'));
  assert.deepEqual(r.cards(), ['pack/starter', 'recipe/explain-it', 'rules/calm'], 'any-stack items stay; a Swift one goes');
  stack.value = ''; stack.dispatchEvent(new r.w.Event('change'));
  const search = r.$('.cg-search'); search.value = 'explain'; search.dispatchEvent(new r.w.Event('input'));
  assert.deepEqual(r.cards(), ['recipe/explain-it']);
});

test('Add sends only the id and sha, reloads My recipes, and pack members add on their own', async (t) => {
  const r = await rig(t, { cachedFirst: true });
  r.$('#cg-open').click(); await tick();
  const before = r.calls.list;
  r.$('[data-id="recipe/explain-it"] .recipe-actions button').click(); await tick();
  assert.equal(r.calls.add.length, 1);
  assert.equal(r.calls.add[0][0], 'recipe/explain-it');
  assert.match(r.calls.add[0][1], /^[0-9a-f]{64}$/);
  assert.ok(r.calls.list > before, 'My recipes reloads');
  assert.match(r.$('#cg-gallery .recipes-status').textContent, /Added “Title explain-it” to My recipes\./);
  const members = r.$$('[data-id="pack/starter"] .cg-members li');
  assert.equal(members.length, 3);
  assert.ok(members[2].querySelector('button'), 'widget rules add from a pack too');
  members[1].querySelector('button').click(); await tick();
  assert.equal(r.calls.add[1][0], 'character/pebble');
  assert.equal(r.$('[data-id="pack/starter"] .recipe-actions button'), null, 'a pack has no Add all');
});

test('in the demo Add is disabled; Back and Escape close the gallery', async (t) => {
  const r = await rig(t, { demo: true, cachedFirst: true });
  r.$('#cg-open').click(); await tick();
  assert.ok(r.$$('#cg-gallery .cg-card button').every((b) => b.disabled));
  r.$$('#cg-gallery button').find((b) => b.textContent === 'Back to recipes').click();
  assert.equal(r.$('#cg-gallery').hidden, true);
  r.$('#cg-open').click(); await tick();
  r.w.document.dispatchEvent(new r.w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(r.$('#cg-gallery').hidden, true);
});

test('adding widget rules says where they opened and does not reload My recipes', async (t) => {
  const r = await rig(t, { cachedFirst: true });
  r.$('#cg-open').click(); await tick();
  const before = r.calls.list;
  r.$('[data-id="rules/calm"] .recipe-actions button').click(); await tick();
  assert.equal(r.calls.add.at(-1)[0], 'rules/calm');
  assert.match(r.$('#cg-gallery .recipes-status').textContent, /Opened “Title calm” in Widget configuration\. Press Load there, then Save/);
  assert.equal(r.calls.list, before);
});
