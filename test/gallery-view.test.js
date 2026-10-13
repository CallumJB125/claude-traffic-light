'use strict';
// The Discover page (gallery-view.js in discover.html), rendered in jsdom
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
const html = fs.readFileSync(path.join(ROOT, 'discover.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'gallery-view.js'), 'utf8');
const base = (kind, id, payload, over = {}) => ({ schema: 1, kind, id, title: `Title ${id}`, summary: `About ${id}.`, author: { name: 'Ana', github: 'ana-dev' }, license: 'CC0-1.0', tags: [], stacks: ['any'], tools: [], added: '2026-10-01', updated: '2026-10-05', payload, ...over });
const items = [
  base('recipe', 'explain-it', { id: 'explain-it', title: 'Title explain-it', what: 'Explains the repo.', prompt: 'THE FULL PROMPT <b>text</b>', tool: 'auto', edits: false, cost: 'Low.' }, { stacks: ['python'] }),
  base('recipe', 'review-it', { id: 'review-it', title: 'Title review-it', what: 'Reviews a PR.', prompt: 'Review the open PR.', tool: 'auto', edits: false, cost: 'Low.' }),
  base('character', 'pebble', Hatch.templateCharacter({ name: 'Pebble' }), { stacks: ['swift'] }),
  base('pack', 'starter', { members: ['recipe/explain-it', 'recipe/review-it', 'character/pebble', 'rules/calm'], note: 'Starter.' }),
  base('rules', 'calm', { rulesVersion: Rules.RULES_VERSION, rules: [Rules.normalizeRule({ id: 'r1', name: 'Done', when: { signal: ['done'] }, then: { lamp: 'green' } })] }),
];
const tick = () => new Promise((r) => setTimeout(r, 0));

async function rig(t, { demo = false, cachedFirst = true, installed = { ok: true, recipes: [], characters: [] } } = {}) {
  const dir = testTempDir('gallery-view-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from(S.buildIndex(items.map((item) => ({ item, name: item.id }))).text);
  const service = Gallery.create({ dataDir: dir, keysDir: dir, now: () => Date.parse('2026-10-10T12:00:00.000Z'), demo: () => demo, fetch: async () => new Response(bytes) });
  if (cachedFirst) await service.fetchIndex();
  const calls = { fetch: 0, add: [], addPack: [], remove: [], installed: 0 };
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const state = { installed };
  w.galleryApi = {
    refresh: async () => { calls.fetch += 1; return service.fetchIndex(); },
    cached: async () => service.cached(),
    add: async (id, sha) => { calls.add.push([id, sha]); return { ok: true, id: id.split('/')[1], kind: id.split('/')[0] }; },
    addPack: async (id, sha) => { calls.addPack.push([id, sha]); return { ok: true, added: ['recipe/explain-it', 'character/pebble'], present: ['recipe/review-it'], separate: ['rules/calm'], failed: [] }; },
    installed: async () => { calls.installed += 1; return state.installed; },
    remove: async (kind, id) => { calls.remove.push([kind, id]); return { ok: true }; },
  };
  w.eval(script);
  await tick(); await tick();
  const $ = (sel) => w.document.querySelector(sel);
  const $$ = (sel) => [...w.document.querySelectorAll(sel)];
  const cards = () => $$('#cg-gallery .cg-card').map((c) => c.dataset.id);
  const tab = (label) => { $$('.cg-tabs .cg-chip').find((b) => b.textContent === label).click(); };
  return { w, $, $$, calls, cards, tab, state };
}

test('the page opens from the cache without fetching, on the Recipes tab; Fetch is offered only without a cache', async (t) => {
  const r = await rig(t, { cachedFirst: false });
  assert.equal(r.calls.fetch, 0);
  const fetchBtn = r.$$('#cg-gallery button').find((b) => b.textContent === 'Fetch the gallery');
  assert.ok(fetchBtn);
  assert.match(r.$('.cg-list').textContent, /Fetch the gallery to see/);
  fetchBtn.click(); await tick(); await tick();
  assert.equal(r.calls.fetch, 1);
  assert.deepEqual(r.cards(), ['recipe/explain-it', 'recipe/review-it'], 'the Recipes tab lists recipes only');
  assert.match(r.$('.cg-provenance').textContent, /^Unsigned · fetched from plexiform\.dev over HTTPS$/);
  assert.ok(r.$$('#cg-gallery button').some((b) => b.textContent === 'Refresh'));
  assert.deepEqual(r.$$('.cg-tabs .cg-chip').map((b) => b.textContent), ['Installed', 'Recipes', 'Characters', 'Packs', 'Widget rules', 'Setups']);
  assert.equal(r.$('.cg-tabs .cg-chip[aria-pressed="true"]').textContent, 'Recipes');
  assert.equal(r.$('#cg-gallery h2').textContent, 'Discover');
  assert.equal(r.$$('#cg-gallery button').find((b) => b.textContent === 'Back to recipes'), undefined);
});

test('tabs show one kind each; a pack is one card naming its members with no Add of their own', async (t) => {
  const r = await rig(t);
  assert.deepEqual(r.cards(), ['recipe/explain-it', 'recipe/review-it']);
  r.tab('Packs');
  assert.deepEqual(r.cards(), ['pack/starter']);
  const pack = r.$('[data-id="pack/starter"]');
  const members = r.$$('[data-id="pack/starter"] .cg-members li');
  assert.equal(members.length, 4);
  assert.equal(members[0].querySelector('button').textContent, 'Recipe: Title explain-it');
  assert.equal(r.$$('[data-id="pack/starter"] .cg-members .btn.primary').length, 0, 'members have no Add in the pack card');
  assert.equal(members[3].querySelector('button').textContent, 'Widget rules: Title calm');
  assert.equal(members[3].querySelector('span').textContent, 'opens on its own');
  assert.ok(r.$$('[data-id="pack/starter"] .recipe-actions button').some((b) => b.textContent === 'Add pack'));
  assert.equal(r.$$('.cg-card').filter((c) => c.textContent.includes('Title explain-it')).length, 1, 'a recipe appears once on this tab');
  r.tab('Characters');
  assert.deepEqual(r.cards(), ['character/pebble']);
  r.tab('Widget rules');
  assert.deepEqual(r.cards(), ['rules/calm']);
  assert.match(r.$('[data-id="rules/calm"]').textContent, /1 widget rule: Done/);
  r.tab('Setups');
  assert.match(r.$('.cg-list').textContent, /Nothing matches/);
  assert.equal(pack.isConnected, false);
});

test('the stack filter and search narrow the current tab', async (t) => {
  const r = await rig(t);
  const stack = r.$('.cg-stack'); stack.value = 'python'; stack.dispatchEvent(new r.w.Event('change'));
  assert.deepEqual(r.cards(), ['recipe/explain-it', 'recipe/review-it'], 'any-stack items stay');
  r.tab('Characters');
  assert.deepEqual(r.cards(), [], 'a Swift character goes under the Python filter');
  stack.value = ''; stack.dispatchEvent(new r.w.Event('change'));
  r.tab('Recipes');
  const search = r.$('.cg-search'); search.value = 'review'; search.dispatchEvent(new r.w.Event('input'));
  assert.deepEqual(r.cards(), ['recipe/review-it']);
  assert.equal(r.$('.cg-filters').hidden, false);
  r.tab('Installed');
  assert.equal(r.$('.cg-filters').hidden, true, 'no stack or search on Installed');
});

test('a card opens the drawer with the whole item, the site link and Add; Escape closes it', async (t) => {
  const r = await rig(t);
  assert.equal(r.$('#cg-drawer').hidden, true);
  r.$('[data-id="recipe/explain-it"]').click();
  const d = r.$('#cg-drawer');
  assert.equal(d.hidden, false);
  assert.equal(r.$('#cg-drawer-title').textContent, 'Title explain-it');
  assert.equal(d.querySelector('pre').textContent, 'THE FULL PROMPT <b>text</b>', 'text, never markup');
  assert.equal(d.querySelector('b'), null);
  const facts = Object.fromEntries([...d.querySelectorAll('.cg-facts dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));
  assert.equal(facts.By, 'Ana (@ana-dev), self-declared');
  assert.equal(facts.License, 'CC0-1.0');
  assert.equal(facts.Added, '2026-10-01');
  assert.equal(facts.Updated, '2026-10-05');
  assert.equal(facts.Stacks, 'python');
  assert.match(facts.sha256, /^[0-9a-f]{64}$/);
  const link = d.querySelector('a.cg-site');
  assert.equal(link.href, 'https://plexiform.dev/gallery/recipe/explain-it');
  assert.equal(link.target, '_blank');
  assert.ok([...d.querySelectorAll('button')].some((b) => b.textContent === 'Add'));
  r.w.document.dispatchEvent(new r.w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(d.hidden, true);
  assert.equal(d.children.length, 0);
  // a pack's drawer lists its members and offers Add pack; a member opens its own drawer
  r.tab('Packs');
  r.$$('[data-id="pack/starter"] .recipe-actions button').find((b) => b.textContent === 'Details').click();
  assert.equal(r.$('#cg-drawer-title').textContent, 'Title starter');
  assert.ok([...d.querySelectorAll('button')].some((b) => b.textContent === 'Add pack'));
  d.querySelector('.cg-members button').click();
  assert.equal(r.$('#cg-drawer-title').textContent, 'Title explain-it');
  // a character's drawer shows the preview stage (rig.js is not loaded here, so it says what happens)
  r.tab('Characters');
  r.$('[data-id="character/pebble"]').click();
  assert.ok(d.querySelector('.cg-stage'));
  assert.match(d.querySelector('.cg-stage').textContent, /checked by the app’s sanitiser/);
});

test('Add sends only the id and sha from a card or the drawer; Add pack sends the pack and reports the accounting', async (t) => {
  const r = await rig(t);
  r.$$('[data-id="recipe/explain-it"] .recipe-actions button').find((b) => b.textContent === 'Add').click(); await tick(); await tick();
  assert.equal(r.calls.add.length, 1);
  assert.equal(r.calls.add[0][0], 'recipe/explain-it');
  assert.match(r.calls.add[0][1], /^[0-9a-f]{64}$/);
  assert.match(r.$('#cg-gallery .recipes-status').textContent, /Added “Title explain-it” to My recipes\./);
  assert.ok(r.calls.installed >= 2, 'what is installed is read again after an add');
  r.$('[data-id="recipe/review-it"]').click();
  [...r.$('#cg-drawer').querySelectorAll('button')].find((b) => b.textContent === 'Add').click(); await tick(); await tick();
  assert.equal(r.calls.add[1][0], 'recipe/review-it');
  assert.equal(r.$('#cg-drawer').hidden, true, 'the drawer closes after an add');
  r.tab('Packs');
  r.$$('[data-id="pack/starter"] .recipe-actions button').find((b) => b.textContent === 'Add pack').click(); await tick(); await tick();
  assert.equal(r.calls.addPack.length, 1);
  assert.equal(r.calls.addPack[0][0], 'pack/starter');
  assert.equal(r.calls.add.length, 2, 'Add pack never adds members one by one from the page');
  assert.equal(r.$('#cg-gallery .recipes-status').textContent, 'Added 2 items from “Title starter”. 1 already here. Widget rules and setups in it open one at a time from their own cards.');
});

test('the Installed tab lists gallery recipes and characters with Remove, marks cards as installed, and says what is not tracked', async (t) => {
  const installed = { ok: true, recipes: [{ id: 'explain-it', galleryId: 'recipe/explain-it', title: 'Title explain-it', author: { name: 'Ana', github: 'ana-dev' }, addedAt: '2026-10-09T10:00:00.000Z' }], characters: [{ id: 'u-pebble', galleryId: 'character/pebble', title: 'Pebble', addedAt: '2026-10-09T10:00:00.000Z' }] };
  const r = await rig(t, { installed });
  assert.ok(r.$('[data-id="recipe/explain-it"] .rtag.installed'), 'an installed item is marked on its card');
  assert.equal(r.$$('[data-id="recipe/explain-it"] .recipe-actions button').find((b) => b.textContent === 'Add again') != null, true);
  assert.equal(r.$('[data-id="recipe/review-it"] .rtag.installed'), null);
  r.tab('Installed');
  assert.deepEqual(r.$$('.cg-installed').map((c) => c.dataset.local), ['explain-it', 'u-pebble']);
  assert.match(r.$('.cg-list').textContent, /My recipes from the gallery \(1\)/);
  assert.match(r.$('.cg-list').textContent, /Characters from the gallery \(1\)/);
  assert.match(r.$('.cg-note').textContent, /not tracked here/);
  r.state.installed = { ok: true, recipes: [], characters: installed.characters };
  r.$$('[data-local="explain-it"] button').find((b) => b.textContent === 'Remove').click(); await tick(); await tick();
  assert.deepEqual(r.calls.remove, [['recipe', 'explain-it']]);
  assert.deepEqual(r.$$('.cg-installed').map((c) => c.dataset.local), ['u-pebble']);
  assert.match(r.$('#cg-gallery .recipes-status').textContent, /Removed “Title explain-it”\./);
  r.state.installed = { ok: true, recipes: [], characters: [] };
  r.$$('[data-local="u-pebble"] button').find((b) => b.textContent === 'Remove').click(); await tick(); await tick();
  assert.deepEqual(r.calls.remove[1], ['character', 'u-pebble']);
  assert.match(r.$('.cg-list').textContent, /Nothing from the gallery is installed yet/);
});

test('in the demo Add, Add pack and Remove are disabled', async (t) => {
  const r = await rig(t, { demo: true, installed: { ok: true, recipes: [{ id: 'explain-it', galleryId: 'recipe/explain-it', title: 'Title explain-it', author: null, addedAt: null }], characters: [] } });
  assert.ok(r.$$('#cg-gallery .cg-card .btn.primary').every((b) => b.disabled));
  r.tab('Packs');
  assert.ok(r.$$('#cg-gallery .cg-card .btn.primary').every((b) => b.disabled));
  r.tab('Installed');
  assert.ok(r.$$('.cg-installed button').filter((b) => b.textContent === 'Remove').every((b) => b.disabled));
});

test('adding widget rules says where they opened and does not re-read what is installed', async (t) => {
  const r = await rig(t);
  r.tab('Widget rules');
  const before = r.calls.installed;
  r.$$('[data-id="rules/calm"] .recipe-actions button').find((b) => b.textContent === 'Add').click(); await tick(); await tick();
  assert.equal(r.calls.add.at(-1)[0], 'rules/calm');
  assert.match(r.$('#cg-gallery .recipes-status').textContent, /Opened “Title calm” in Widget rules\. Press Load there, then Save/);
  assert.equal(r.calls.installed, before);
});
