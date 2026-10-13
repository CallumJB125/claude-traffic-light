'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testTempDir } = require('./helpers/tmp');
const Publish = require('../src/gallery-publish.js');
const S = require('../src/gallery-schema.js');
const Recipes = require('../src/recipes.js');
const CharacterStore = require('../src/character-store.js');
const Hatch = require('../characters/hatch.js');
const Rules = require('../rules.js');

const NOW = Date.parse('2026-10-13T09:00:00.000Z');
const meta = (over = {}) => ({ title: 'Explain this repo', summary: 'Reads the repo and explains it.', tags: 'docs, onboarding', stacks: ['any'], license: 'CC0-1.0', authorName: 'Ana', authorGithub: '@ana-dev', ...over });
const recipe = (over = {}) => ({ id: 'my-explain', title: 'Explain this repo (my copy)', what: 'Reads the repo and explains it.', prompt: 'Explain the repository. Do not change any files.', tool: 'auto', edits: false, cost: 'Low.', ...over });
const rule = (over = {}) => Rules.normalizeRule({ id: 'done', name: 'Done', when: { signal: ['done'] }, then: { lamp: 'green' }, ...over });

test('slug: a title becomes a gallery id within the id rules', () => {
  assert.equal(Publish.slug('Explain this repo (my copy)'), 'explain-this-repo-my-copy');
  assert.equal(Publish.slug('  Weekly  Report! '), 'weekly-report');
  assert.equal(Publish.slug('one two three four five six seven eight nine'), 'one-two-three-four-five-six-seven-eight');
  assert.equal(Publish.slug('x'.repeat(60)), '');
  assert.equal(Publish.slug(''), '');
  for (const t of ['Café au lait', 'Ünïcode name']) assert.match(Publish.slug(t), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test('a recipe of mine becomes a valid gallery item that CI would accept', () => {
  const { item, problems } = Publish.buildItem({ kind: 'recipe', source: recipe(), meta: meta(), now: NOW });
  assert.deepEqual(problems, []);
  assert.equal(item.id, 'explain-this-repo');
  assert.deepEqual(item.author, { name: 'Ana', github: 'ana-dev' });
  assert.deepEqual(item.tags, ['docs', 'onboarding']);
  assert.deepEqual(item.tools, ['auto']);
  assert.equal(item.added, '2026-10-13');
  assert.equal(item.payload.id, item.id);
  assert.equal(item.payload.title, item.title);
  assert.equal(item.payload.edits, false);
  assert.deepEqual(S.validateItem(item, item.id), []);
  assert.doesNotThrow(() => S.buildIndex([{ item, name: item.id, kind: 'recipe' }], { serial: 1, now: NOW }));
  assert.equal(Publish.itemText(item), `${JSON.stringify(item, null, 2)}\n`);
});

test('a recipe that changes files, a secret, a home path or a long summary is refused with the reason', () => {
  const p = (over, m = {}) => Publish.buildItem({ kind: 'recipe', source: recipe(over), meta: meta(m), now: NOW }).problems.join('\n');
  assert.match(p({ edits: true }), /only read/);
  assert.match(p({ prompt: 'Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK' }), /secret/);
  assert.match(p({ prompt: 'Look in /Users/ana/code first.' }), /home folder path/);
  assert.match(p({}, { summary: 'x'.repeat(301) }), /summary/);
  assert.match(p({}, { title: '' }), /title/);
  assert.match(p({}, { authorName: '' }), /author/);
  assert.match(p({}, { authorGithub: 'not a handle' }), /author/);
  assert.match(p({}, { license: 'GPL-3.0' }).length ? p({}, { license: 'GPL-3.0' }) : 'CC0 default used', /CC0 default used/);
});

test('a hatched character and a rules set become valid items; css and command clicks are kept out', () => {
  const ch = Hatch.templateCharacter({ name: 'Pebble' });
  const c = Publish.buildItem({ kind: 'character', source: { ...ch, css: 'body{}' }, meta: meta({ title: 'Pebble', summary: 'A round one.', tags: ['character'] }), now: NOW });
  assert.deepEqual(c.problems, []);
  assert.equal(c.item.id, 'pebble');
  assert.equal(c.item.payload.id, 'pebble');
  assert.equal(Object.hasOwn(c.item.payload, 'css'), false);
  assert.deepEqual(c.item.tools, []);

  const r = Publish.buildItem({ kind: 'rules', source: { rules: [rule()] }, meta: meta({ title: 'Quiet desk', summary: 'No sounds.' }), now: NOW });
  assert.deepEqual(r.problems, []);
  assert.equal(r.item.payload.rulesVersion, Rules.RULES_VERSION);
  assert.deepEqual(S.validateItem(r.item, 'quiet-desk'), []);

  const bad = Publish.buildItem({ kind: 'rules', source: [rule({ then: { lamp: 'green', clicks: { click: { type: 'shell', arg: 'rm -rf /' } } } })], meta: meta({ title: 'Loud' }), now: NOW });
  assert.match(bad.problems.join('\n'), /clicks that run commands/);
  assert.match(Publish.buildItem({ kind: 'setup', source: {}, meta: meta(), now: NOW }).problems[0], /not something you can share/);
  assert.match(Publish.buildItem({ kind: 'rules', source: null, meta: meta(), now: NOW }).problems[0], /No rules/);
});

test('the pull request URL is GitHub\'s new-file page with the path and JSON prefilled, or null past 8 KB', () => {
  const { item } = Publish.buildItem({ kind: 'recipe', source: recipe(), meta: meta(), now: NOW });
  const url = Publish.prUrl(item);
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, `${Publish.REPO}/new/${Publish.BRANCH}/gallery/items/recipe`);
  assert.equal(u.searchParams.get('filename'), 'explain-this-repo.json');
  assert.equal(u.searchParams.get('value'), Publish.itemText(item));
  assert.equal(JSON.parse(u.searchParams.get('value')).id, 'explain-this-repo');
  const big = Publish.buildItem({ kind: 'recipe', source: recipe({ prompt: `${'Read everything carefully. '.repeat(220)}Do not change any files.` }), meta: meta(), now: NOW });
  assert.deepEqual(big.problems, []);
  assert.equal(Publish.prUrl(big.item), null);
  assert.equal(Publish.prUrl(big.item, { limit: 1024 * 1024 }) !== null, true);
});

function rig(t) {
  const root = testTempDir('gallery-publish-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recipes = Recipes.create({ builtInDir: path.join(__dirname, '..', 'recipes'), dataDir: path.join(root, 'recipes'), home: root, now: () => NOW });
  const characterStore = CharacterStore.create({ dir: path.join(root, 'characters') });
  let author = null;
  const opened = [], copied = [];
  let presets = [];
  const publish = Publish.create({
    recipes, characterStore, presets: () => presets,
    profile: { get: () => author, set: (v) => { author = v; } },
    openExternal: async (u) => { opened.push(u); }, clipboard: { writeText: (t2) => copied.push(t2) }, now: () => NOW,
  });
  return { root, recipes, characterStore, publish, opened, copied, setPresets: (p) => { presets = p; }, author: () => author };
}

test('begin: only my own things are offered, with what they already say and the remembered author', (t) => {
  const r = rig(t);
  assert.equal(r.publish.begin('recipe', 'explain-repo').ok, false, 'a built-in recipe is not mine');
  const mine = r.recipes.saveMine('explain-repo');
  const b = r.publish.begin('recipe', mine.id);
  assert.equal(b.ok, true);
  assert.equal(b.defaults.title, 'Explain this repo to a new teammate', 'the (my copy) suffix is dropped');
  assert.equal(b.defaults.authorName, '');
  assert.deepEqual(b.licenses, S.LICENSES);
  assert.equal(r.publish.begin('setup', 'x').ok, false);
  assert.equal(r.publish.begin('character', 'u-nobody').ok, false);
  const ch = r.characterStore.save({ ...Hatch.templateCharacter({ name: 'Pebble' }), id: 'u-pebble' });
  assert.equal(r.publish.begin('character', ch.id).defaults.title, 'Pebble');
  r.setPresets([{ id: 'p1', name: 'Quiet desk', rules: [rule()] }]);
  assert.equal(r.publish.begin('rules', { preset: 'p1' }).defaults.title, 'Quiet desk');
  assert.equal(r.publish.begin('rules', { preset: 'nope' }).ok, false);
  assert.equal(r.publish.begin('rules', { rules: [rule()] }).ok, true);
  assert.equal(r.publish.begin('rules', { rules: [] }).ok, false);
});

test('a recipe that came from the gallery is not offered back to it', (t) => {
  const r = rig(t);
  const entry = S.entryOf({ schema: 1, kind: 'recipe', id: 'explain-it', title: 'Explain it', summary: 'One line.', author: { name: 'Ana' }, license: 'CC0-1.0', tags: [], stacks: ['any'], tools: ['auto'], added: '2026-10-01', updated: '2026-10-05', payload: { id: 'explain-it', title: 'Explain it', what: 'Explains.', prompt: 'Explain. Do not change any files.', tool: 'auto', edits: false, cost: 'Low.' } });
  const added = r.recipes.addFromGallery(entry);
  assert.equal(added.ok, true);
  assert.match(r.publish.begin('recipe', added.id).error, /came from the gallery/);
});

test('draft keeps the item under a token; open goes to the PR page, copy puts the JSON on the clipboard; the author is remembered', (t) => {
  const r = rig(t);
  const mine = r.recipes.saveMine('explain-repo');
  const d = r.publish.draft('recipe', mine.id, meta({ title: 'Explain this repo', summary: 'Explains the repo.' }));
  assert.equal(d.ok, true);
  assert.deepEqual(d.problems, []);
  assert.equal(d.canOpen, true);
  assert.equal(d.path, 'gallery/items/recipe/explain-this-repo.json');
  assert.equal(d.repo, Publish.REPO);
  assert.deepEqual(r.author(), { name: 'Ana', github: 'ana-dev' });
  assert.equal(JSON.parse(d.text).payload.prompt, JSON.parse(fs.readFileSync(path.join(r.root, 'recipes', `${mine.id}.json`), 'utf8')).prompt);
  return (async () => {
    assert.deepEqual(await r.publish.open(d.token), { ok: true });
    assert.equal(r.opened.length, 1);
    assert.match(r.opened[0], /^https:\/\/github\.com\/CallumJB125\/claude-traffic-light\/new\/main\/gallery\/items\/recipe\?filename=explain-this-repo\.json&value=/);
    assert.deepEqual(r.publish.copy(d.token), { ok: true, path: d.path });
    assert.equal(r.copied[0], d.text);
    assert.equal((await r.publish.open('nope')).ok, false);
    assert.equal(r.publish.copy(42).ok, false);
    assert.equal(r.publish.begin('recipe', mine.id).defaults.authorGithub, 'ana-dev');
  })();
});

test('draft reports the validator\'s problems, opens nothing for them, and remembers no author until the item is valid', async (t) => {
  const r = rig(t);
  const mine = r.recipes.saveMine('explain-repo');
  const d = r.publish.draft('recipe', mine.id, meta({ title: 'Explain this repo', summary: '', authorGithub: 'bad handle!' }));
  assert.equal(d.ok, true);
  assert.ok(d.problems.some((p) => /summary/.test(p)) && d.problems.some((p) => /author/.test(p)), d.problems.join('\n'));
  assert.equal(d.canOpen, false);
  assert.equal(r.author(), null);
  assert.equal((await r.publish.open(d.token)).ok, false);
  assert.equal(r.opened.length, 0);
  assert.equal(r.publish.copy(d.token).ok, true, 'the JSON can still be copied to fix by hand');
  const nope = r.publish.draft('recipe', mine.id, { title: 'T', summary: 'S', authorName: 'A', run: 'rm -rf /' });
  assert.equal(nope.ok, true, 'unknown meta fields are ignored');
  assert.equal(Object.hasOwn(nope.item, 'run'), false);
});

test('the demo shares nothing, and drafts expire', (t) => {
  const r = rig(t);
  const mine = r.recipes.saveMine('explain-repo');
  let demo = true, clock = NOW;
  const p = Publish.create({ recipes: r.recipes, characterStore: r.characterStore, profile: { get: () => null, set() {} }, openExternal: async () => {}, clipboard: { writeText() {} }, now: () => clock, demo: () => demo });
  assert.match(p.draft('recipe', mine.id, meta()).error, /demo/);
  demo = false;
  const d = p.draft('recipe', mine.id, meta());
  assert.equal(d.ok, true);
  clock += 11 * 60 * 1000;
  assert.equal(p.copy(d.token).ok, false);
});

test('register: the page gets begin, draft, open and copy over IPC and nothing when the sender is not allowed', async () => {
  const handlers = new Map();
  const calls = [];
  const publish = { begin: (...a) => { calls.push(['begin', ...a]); return { ok: true }; }, draft: (...a) => { calls.push(['draft', ...a]); return { ok: true }; }, open: async () => { throw new Error('boom'); }, copy: () => ({ ok: true }) };
  Publish.register({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, allowed: (e) => e.ok, publish });
  assert.deepEqual([...handlers.keys()], ['gallery-publish:begin', 'gallery-publish:draft', 'gallery-publish:open', 'gallery-publish:copy']);
  assert.deepEqual(await handlers.get('gallery-publish:begin')({ ok: true }, 'recipe', 'x'), { ok: true });
  assert.deepEqual(calls[0], ['begin', 'recipe', 'x']);
  assert.equal(await handlers.get('gallery-publish:draft')({ ok: false }, 'recipe', 'x', {}), null);
  assert.deepEqual(await handlers.get('gallery-publish:open')({ ok: true }, 't'), { ok: false, error: 'Something went wrong. Nothing was sent.' });
});
