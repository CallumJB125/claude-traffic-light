'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { testTempDir } = require('./helpers/tmp');
const Gallery = require('../src/gallery.js');
const S = require('../src/gallery-schema.js');
const V = require('../src/plugins/index-verify.js');
const Hatch = require('../characters/hatch.js');
const CharacterStore = require('../src/character-store.js');
const Recipes = require('../src/recipes.js');
const Inventory = require('../src/data-inventory.js');
const DataDelete = require('../src/data-delete.js');

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const base = (kind, id, payload, over = {}) => ({ schema: 1, kind, id, title: `Title ${id}`, summary: 'One line.', author: { name: 'Ana', github: 'ana-dev' }, license: 'CC0-1.0', tags: [], stacks: ['any'], tools: [], added: '2026-10-01', updated: '2026-10-05', payload, ...over });
const recipeItem = (over = {}) => base('recipe', 'explain-it', { id: 'explain-it', title: 'Title explain-it', what: 'Explains the repo.', prompt: 'Read the repository.\n\nNEVER-ELIDED full prompt line.', tool: 'auto', edits: false, cost: 'Low.' }, over);
const charItem = (over = {}) => base('character', 'pebble', Hatch.templateCharacter({ name: 'Pebble' }), over);
const packItem = () => base('pack', 'starter', { members: ['recipe/explain-it', 'character/pebble'], note: '' });
const rulesItem = () => { const Rules = require('../rules.js'); return base('rules', 'calm', { rulesVersion: Rules.RULES_VERSION, rules: [Rules.normalizeRule({ id: 'r1', name: 'Done', when: { signal: ['done'] }, then: { lamp: 'green' } })] }); };
const indexOf = (items, serial = 1) => Buffer.from(S.buildIndex(items.map((item) => ({ item, name: item.id })), { serial }).text);
const defaultItems = () => [recipeItem(), charItem(), packItem(), rulesItem()];

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = typeof routes === 'function' ? routes(url, opts) : routes[url];
    if (r instanceof Error) throw r;
    if (r == null) return new Response('missing', { status: 404 });
    return new Response(r, { status: 200, headers: r.headers || {} });
  };
  fn.calls = calls;
  return fn;
}

function rig(t, { items = defaultItems(), bytes = null, keys = null, routes = null, demo = false, confirm = true } = {}) {
  const dir = testTempDir('gallery-main-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data'), keysDir = path.join(dir, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });
  let signer = null;
  if (keys) {
    signer = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(keysDir, 'gallery-key.pub.pem'), keys === 'broken' ? 'not a key' : signer.publicKey.export({ type: 'spki', format: 'pem' }));
  }
  const body = bytes || indexOf(items);
  const sign = (b) => JSON.stringify({ alg: 'ed25519', keyId: V.keyId(signer.publicKey), sig: crypto.sign(null, b, signer.privateKey).toString('base64') });
  const fetch = fakeFetch(routes || { [Gallery.INDEX_URL]: body, ...(signer && keys !== 'broken' ? { [Gallery.SIG_URL]: sign(body) } : {}) });
  const store = CharacterStore.create({ dir: path.join(dataDir, 'characters') });
  const confirms = [], added = [], broadcasts = [], changed = [];
  // The real recipes store, so origin sidecars and Installed are exercised; `added` records what reached it.
  const realRecipes = Recipes.create({ builtInDir: path.join(dir, 'no-built-in'), dataDir: path.join(dataDir, 'recipes'), home: dir, now: () => NOW });
  const recipes = { ...realRecipes, addFromGallery: (e) => { added.push(e); const r = realRecipes.addFromGallery(e); return r.ok ? { ok: true, id: e.slug ?? r.id } : r; } };
  const g = Gallery.create({
    dataDir, fetch, keysDir, now: () => NOW,
    recipes,
    characterStore: store,
    confirm: async (opts) => { confirms.push(opts); return confirm; },
    broadcastCharacters: () => broadcasts.push(1),
    onRecipesChanged: () => changed.push(1),
    demo: () => demo,
  });
  return { g, recipes: realRecipes, changed, fetch, dataDir, keysDir, store, confirms, added, broadcasts, sign };
}

test('nothing is fetched when the service is created or when the cache is read', async (t) => {
  const r = rig(t);
  assert.equal(r.fetch.calls.length, 0);
  assert.deepEqual(r.g.cached(), { ok: false, none: true });
  assert.equal(r.fetch.calls.length, 0);
});

test('a click fetches through the injected fetch with redirects refused, and caches what it verified (0600)', async (t) => {
  const r = rig(t);
  const v = await r.g.fetchIndex();
  assert.equal(v.ok, true);
  assert.deepEqual(r.fetch.calls.map((c) => c.url), [Gallery.INDEX_URL], 'no signature fetch while no key is pinned');
  assert.equal(r.fetch.calls[0].opts.redirect, 'error');
  assert.ok(r.fetch.calls[0].opts.signal);
  assert.match(v.provenance, /^Unsigned · fetched from plexiform\.dev over HTTPS$/);
  assert.equal(v.signed, false);
  assert.deepEqual(v.items.map((i) => [i.id, i.addable]), [['character/pebble', true], ['pack/starter', false], ['recipe/explain-it', true], ['rules/calm', true]]);
  assert.match(v.items.find((i) => i.kind === 'recipe').preview.prompt, /NEVER-ELIDED/);
  assert.deepEqual(v.items.find((i) => i.kind === 'pack').preview.members.map((m) => m.addable), [true, true]);
  const file = path.join(r.dataDir, 'gallery', 'index.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = Gallery.create({ dataDir: r.dataDir, fetch: r.fetch, keysDir: r.keysDir, now: () => NOW });
  assert.equal(again.cached().items.length, 4, 'opens from the cache with no fetch');
  assert.equal(r.fetch.calls.length, 1);
});

test('size cap, redirects and network errors refuse without caching', async (t) => {
  const big = Buffer.alloc(S.LIMITS.indexBytes + 1, 0x20);
  for (const routes of [{ [Gallery.INDEX_URL]: big }, () => new TypeError('fetch failed: redirect mode is set to error'), {}]) {
    const r = rig(t, { routes });
    const v = await r.g.fetchIndex();
    assert.equal(v.ok, false);
    assert.ok(!fs.existsSync(path.join(r.dataDir, 'gallery')));
  }
  const lying = rig(t, { routes: () => Object.assign(Buffer.from('{}'), { headers: { 'content-length': String(S.LIMITS.indexBytes + 1) } }) });
  assert.equal((await lying.g.fetchIndex()).ok, false);
});

test('a pinned key makes the signature required; an unsigned list is still strict-JSON checked', async (t) => {
  const s = rig(t, { keys: true });
  const v = await s.g.fetchIndex();
  assert.equal(v.ok, true);
  assert.match(v.provenance, /^Signed \(key [0-9a-f]{16}\)$/);
  assert.deepEqual(s.fetch.calls.map((c) => c.url), [Gallery.INDEX_URL, Gallery.SIG_URL]);

  const bytes = indexOf(defaultItems());
  const missing = rig(t, { keys: true, routes: { [Gallery.INDEX_URL]: bytes } });
  assert.match((await missing.g.fetchIndex()).error, /signature/);
  const forged = rig(t, { keys: true, routes: { [Gallery.INDEX_URL]: bytes, [Gallery.SIG_URL]: JSON.stringify({ alg: 'ed25519', keyId: 'abcdef0123456789', sig: `${'A'.repeat(86)}==` }) } });
  assert.match((await forged.g.fetchIndex()).error, /key this version does not know/);
  const broken = rig(t, { keys: 'broken' });
  assert.match((await broken.g.fetchIndex()).error, /could not be read/);
  assert.equal(broken.fetch.calls.length, 0, 'a broken pinned key never falls back to unsigned');

  const dup = Buffer.from(bytes.toString().replace('"kind": "plexiform.gallery"', '"kind": "plexiform.gallery", "kind": "plexiform.gallery"'));
  assert.equal((await rig(t, { bytes: dup }).g.fetchIndex()).ok, false);
});

test('lists are ordered by serial: lower is refused, the same serial with other bytes is refused, a takedown is accepted', async (t) => {
  const r = rig(t, { items: [recipeItem(), charItem({ updated: '2026-10-09' })], bytes: indexOf([recipeItem(), charItem({ updated: '2026-10-09' })], 5) });
  assert.equal((await r.g.fetchIndex()).ok, true);
  const next = (bytes) => Gallery.create({ dataDir: r.dataDir, fetch: fakeFetch({ [Gallery.INDEX_URL]: bytes }), keysDir: r.keysDir, now: () => NOW });
  assert.match((await next(indexOf([recipeItem(), charItem({ updated: '2026-10-09' })], 4)).fetchIndex()).error, /older than the one you already have/);
  assert.match((await next(indexOf([recipeItem()], 5)).fetchIndex()).error, /does not match the one you already have/, 'a replayed or forked list under the same serial');
  assert.equal((await next(indexOf([recipeItem(), charItem({ updated: '2026-10-09' })], 5)).fetchIndex()).ok, true, 'the same list again is fine');
  // Taking down the newest item lowers generatedAt; the raised serial still wins.
  const takedown = indexOf([recipeItem()], 6);
  assert.ok(JSON.parse(takedown).generatedAt < '2026-10-09');
  const v = await next(takedown).fetchIndex();
  assert.equal(v.ok, true);
  assert.deepEqual(v.items.map((i) => i.id), ['recipe/explain-it']);
  assert.match((await next(indexOf([recipeItem(), charItem({ updated: '2026-10-09' })], 5)).fetchIndex()).error, /older/, 'the taken-down list cannot be replayed');
});

test('bad entries are dropped and counted; the cache is re-read, so deleting it empties the list', async (t) => {

  const index = JSON.parse(indexOf(defaultItems()).toString());
  index.entries[0].title = 'Changed after hashing';
  index.entries.push({ ...index.entries[1] });
  const r = rig(t, { bytes: Buffer.from(JSON.stringify(index)) });
  const v = await r.g.fetchIndex();
  assert.equal(v.ok, true);
  assert.equal(v.dropped, 2);
  assert.equal(v.items.length, 3);
  assert.equal(r.g.cached().items.length, 3);
  fs.rmSync(path.join(r.dataDir, 'gallery'), { recursive: true });
  assert.deepEqual(r.g.cached(), { ok: false, none: true });
  assert.match((await r.g.add('recipe/explain-it', v.items.find((i) => i.kind === 'recipe').sha256)).error, /no longer in the gallery/);
});

test('the character confirm and saved name come from the validated character', async (t) => {
  const r = rig(t);
  await r.g.fetchIndex();
  await r.g.add('character/pebble', (r.g.cached().items.find((i) => i.kind === 'character')).sha256);
  assert.equal(r.confirms[0].title, 'Pebble');
});

test('adds: the sha must match, demo refuses, packs are not added', async (t) => {
  const r = rig(t);
  const v = await r.g.fetchIndex();
  const item = (id) => v.items.find((i) => i.id === id);
  assert.match((await r.g.add('recipe/explain-it', 'f'.repeat(64))).error, /changed or is no longer/);
  assert.match((await r.g.add('pack/starter', item('pack/starter').sha256)).error, /one at a time/);
  assert.equal(r.confirms.length, 0);
  const demo = rig(t, { demo: true });
  const dv = await demo.g.fetchIndex();
  assert.match((await demo.g.add('recipe/explain-it', dv.items.find((i) => i.kind === 'recipe').sha256)).error, /demo/);
  assert.equal(demo.added.length, 0);
});

test('a pack adds its recipes and characters after one confirm, skips what is here, and names what opens on its own', async (t) => {
  const items = [recipeItem(), charItem(), rulesItem(), base('pack', 'starter', { members: ['recipe/explain-it', 'character/pebble', 'rules/calm'], note: '' })];
  const no = rig(t, { items, confirm: false });
  const nv = await no.g.fetchIndex();
  const sha = nv.items.find((i) => i.id === 'pack/starter').sha256;
  assert.equal((await no.g.addPack('pack/starter', sha)).cancelled, true);
  assert.equal(no.added.length, 0);
  assert.equal(no.store.list().length, 0);
  const r = rig(t, { items });
  const v = await r.g.fetchIndex();
  assert.match((await r.g.addPack('pack/starter', 'f'.repeat(64))).error, /changed or is no longer/);
  assert.match((await r.g.addPack('recipe/explain-it', v.items.find((i) => i.kind === 'recipe').sha256)).error, /not a pack/);
  const out = await r.g.addPack('pack/starter', sha);
  assert.deepEqual(out, { ok: true, added: ['recipe/explain-it', 'character/pebble'], present: [], separate: ['rules/calm'], failed: [] });
  assert.equal(r.confirms.length, 1, 'one confirm for the whole pack');
  assert.equal(r.confirms[0].action, 'Add the pack');
  assert.match(r.confirms[0].detail, /2 items will be added:\n• recipe: Title explain-it\n• character: Title pebble/);
  assert.match(r.confirms[0].detail, /open one at a time/);
  assert.equal(r.broadcasts.length, 1);
  assert.equal(r.changed.length, 1);
  assert.deepEqual(r.store.list().map((c) => [c.character.id, c.meta.source, c.meta.params]), [['u-pebble', 'gallery', { gallery_id: 'character/pebble', sha256: v.items.find((i) => i.kind === 'character').sha256 }]]);
  // again: everything is here already, nothing is asked or added
  const again = await r.g.addPack('pack/starter', sha);
  assert.deepEqual(again, { ok: true, added: [], present: ['recipe/explain-it', 'character/pebble'], separate: ['rules/calm'], failed: [] });
  assert.equal(r.confirms.length, 1);
  const demo = rig(t, { items, demo: true });
  await demo.g.fetchIndex();
  assert.match((await demo.g.addPack('pack/starter', sha)).error, /demo/);
});

test('installed lists what the gallery put here, and remove takes only that away', async (t) => {
  const r = rig(t);
  const v = await r.g.fetchIndex();
  const item = (id) => v.items.find((i) => i.id === id);
  assert.deepEqual(r.g.installed(), { ok: true, recipes: [], characters: [] });
  await r.g.add('recipe/explain-it', item('recipe/explain-it').sha256);
  await r.g.add('character/pebble', item('character/pebble').sha256);
  r.store.save(Hatch.templateCharacter({ name: 'Mine' }), { source: 'hatch' });
  r.recipes.saveMine('explain-it');
  const inst = r.g.installed();
  assert.deepEqual(inst.recipes, [{ id: 'explain-it', galleryId: 'recipe/explain-it', title: 'Title explain-it', author: { name: 'Ana', github: 'ana-dev' }, addedAt: '2026-10-10T12:00:00.000Z' }]);
  assert.equal(inst.characters.length, 1);
  assert.equal(inst.characters[0].id, 'u-pebble');
  assert.equal(inst.characters[0].galleryId, 'character/pebble');
  assert.equal(inst.characters[0].title, 'Pebble');
  assert.equal(r.changed.length, 1, 'the recipe add told the Tasks page');
  assert.match(r.g.remove('recipe', 'my-explain-it').error, /did not come from the gallery/);
  assert.match(r.g.remove('character', 'u-mine').error, /did not come from the gallery/);
  assert.match(r.g.remove('setup', 'x').error, /Only gallery recipes and characters/);
  assert.deepEqual(r.g.remove('recipe', 'explain-it'), { ok: true });
  assert.equal(r.changed.length, 2);
  assert.deepEqual(r.g.remove('character', 'u-pebble'), { ok: true });
  assert.equal(r.broadcasts.length, 2);
  assert.deepEqual(r.g.installed(), { ok: true, recipes: [], characters: [] });
  assert.deepEqual(r.recipes.mine().map((x) => x.id), ['my-explain-it'], 'the person’s own copy stays');
  assert.deepEqual(r.store.list().map((c) => c.character.id), ['u-mine']);
  const demo = rig(t, { demo: true });
  assert.match(demo.g.remove('recipe', 'explain-it').error, /demo/);
});

test('a character preview carries the sanitised definition the app would save', async (t) => {
  const r = rig(t);
  const v = await r.g.fetchIndex();
  const ch = v.items.find((i) => i.kind === 'character');
  assert.equal(ch.preview.name, 'Pebble');
  assert.equal(ch.preview.character.name, 'Pebble');
  assert.ok(typeof ch.preview.character.sprite.body === 'string');
  assert.equal(ch.added, '2026-10-01');
});

test('adding a recipe confirms with the full prompt first; cancelling adds nothing', async (t) => {
  const no = rig(t, { confirm: false });
  const nv = await no.g.fetchIndex();
  assert.equal((await no.g.add('recipe/explain-it', nv.items.find((i) => i.kind === 'recipe').sha256)).cancelled, true);
  assert.equal(no.added.length, 0);
  const r = rig(t);
  const v = await r.g.fetchIndex();
  const out = await r.g.add('recipe/explain-it', v.items.find((i) => i.kind === 'recipe').sha256);
  assert.deepEqual(out, { ok: true, id: 'explain-it' });
  assert.match(r.confirms[0].detail, /Read the repository\.\n\nNEVER-ELIDED full prompt line\./);
  assert.match(r.confirms[0].detail, /by Ana \(@ana-dev\), self-declared/);
  assert.equal(r.added[0].id, 'recipe/explain-it');
});

test('adding a character takes a free id when the name is taken and tells the windows', async (t) => {
  const r = rig(t);
  r.store.save(Hatch.templateCharacter({ name: 'Pebble' }), { source: 'hatch' });
  const v = await r.g.fetchIndex();
  const out = await r.g.add('character/pebble', v.items.find((i) => i.kind === 'character').sha256);
  assert.deepEqual(out, { ok: true, id: 'u-pebble-2', kind: 'character' });
  assert.match(r.confirms[0].detail, /self-declared/);
  assert.deepEqual(r.store.list().map((c) => c.character.id).sort(), ['u-pebble', 'u-pebble-2']);
  assert.equal(r.store.list().find((c) => c.character.id === 'u-pebble-2').meta.source, 'gallery');
  assert.equal(r.broadcasts.length, 1);
});

test('the gallery cache is listed in Your data and removed by Delete my data', async (t) => {
  const r = rig(t);
  await r.g.fetchIndex();
  const row = Inventory.inventory({ dataDir: r.dataDir, home: '/nonexistent-home' }).find((x) => x.id === 'gallery');
  assert.equal(row.paths.length, 1);
  assert.equal(row.kind, 'cache');
  const [res] = DataDelete.deleteStores({ ids: ['gallery'], dataDir: r.dataDir, home: '/nonexistent-home' });
  assert.equal(res.status, 'deleted');
  assert.ok(!fs.existsSync(path.join(r.dataDir, 'gallery')));
});

test('IPC answers only the allowed sender and passes only an id and sha', async (t) => {
  const handlers = {};
  const calls = [];
  const opened = [];
  Gallery.register({ ipcMain: { handle: (c, fn) => { handlers[c] = fn; } }, allowed: (e) => e.ok, openDiscover: () => opened.push(1), gallery: { fetchIndex: async () => ({ ok: true }), cached: () => ({ ok: true }), add: async (...a) => { calls.push(a); return { ok: true }; }, addPack: async (...a) => { calls.push(['pack', ...a]); return { ok: true }; }, installed: () => ({ ok: true, recipes: [], characters: [] }), remove: (...a) => { calls.push(['remove', ...a]); return { ok: true }; } } });
  assert.deepEqual(Object.keys(handlers).sort(), ['gallery:add', 'gallery:add-pack', 'gallery:cached', 'gallery:fetch', 'gallery:installed', 'gallery:open-discover', 'gallery:remove']);
  assert.equal(await handlers['gallery:fetch']({ ok: false }), null);
  assert.equal(await handlers['gallery:open-discover']({ ok: false }), null);
  assert.equal(opened.length, 0);
  const e = { ok: true };
  await handlers['gallery:add'](e, 'recipe/x', 'abc', 'ignored');
  assert.deepEqual(calls[0], ['recipe/x', 'abc', e]);
  await handlers['gallery:add-pack'](e, 'pack/x', 'abc', 'ignored');
  assert.deepEqual(calls[1], ['pack', 'pack/x', 'abc', e]);
  await handlers['gallery:remove'](e, 'recipe', 'x', 'ignored');
  assert.deepEqual(calls[2], ['remove', 'recipe', 'x']);
  assert.deepEqual(await handlers['gallery:installed'](e), { ok: true, recipes: [], characters: [] });
  assert.deepEqual(await handlers['gallery:open-discover'](e), { ok: true });
  assert.equal(opened.length, 1);
});
