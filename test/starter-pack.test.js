'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Starter = require('../src/starter-pack.js');
const StarterMain = require('../src/starter-pack-main.js');
const { testTempDir } = require('./helpers/tmp');

const NOW = Date.parse('2026-10-13T09:00:00Z');
const H = 3600_000;
const mk = (dir, files) => { fs.mkdirSync(dir, { recursive: true }); for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); fs.writeFileSync(path.join(dir, n), c); } return dir; };
const entry = (kind, id, o = {}) => ({ id: `${kind}/${id}`, kind, slug: id, title: o.title || id, summary: 'A summary', author: { name: 'Plexiform', github: 'CallumJB125' }, license: 'CC0-1.0', tags: [], stacks: o.stacks || ['any'], tools: [], added: '2026-10-11', updated: '2026-10-11', sha256: 'a'.repeat(64), payload: o.payload || {} });
const recipe = (id) => entry('recipe', id, { payload: { id, title: id, what: 'Explains', prompt: 'Explain', tool: 'auto', edits: false, cost: 'low' } });
const character = (id) => entry('character', id, { payload: { id, name: id } });
const pack = (id, stacks, members) => entry('pack', id, { title: `${id} pack`, stacks, payload: { members } });

test('stack detection reads marker files only inside the folder', (t) => {
  const root = testTempDir('starter-', t);
  const next = mk(path.join(root, 'web'), { 'package.json': JSON.stringify({ dependencies: { next: '15' } }) });
  const node = mk(path.join(root, 'cli'), { 'package.json': '{}' });
  const py = mk(path.join(root, 'ml'), { 'pyproject.toml': '' });
  const swift = mk(path.join(root, 'app'), { 'Thing.xcodeproj/project.pbxproj': '' });
  const go = mk(path.join(root, 'svc'), { 'go.mod': '' });
  const rust = mk(path.join(root, 'fast'), { 'Cargo.toml': '' });
  const rails = mk(path.join(root, 'shop'), { Gemfile: '' });
  const plain = mk(path.join(root, 'notes'), { 'README.md': '' });
  const broken = mk(path.join(root, 'odd'), { 'package.json': '{not json' });
  assert.deepEqual(Starter.stacksOf(next), ['nextjs', 'node']);
  assert.deepEqual(Starter.stacksOf(node), ['node']);
  assert.deepEqual(Starter.stacksOf(py), ['python']);
  assert.deepEqual(Starter.stacksOf(swift), ['swift']);
  assert.deepEqual(Starter.stacksOf(go), ['go']);
  assert.deepEqual(Starter.stacksOf(rust), ['rust']);
  assert.deepEqual(Starter.stacksOf(rails), ['rails']);
  assert.deepEqual(Starter.stacksOf(plain), []);
  assert.deepEqual(Starter.stacksOf(broken), ['node'], 'an unreadable package.json is still a Node project');
  assert.deepEqual(Starter.stacksOf(path.join(root, 'missing')), []);
  assert.deepEqual(Starter.stacksOf('relative/path'), []);
  assert.deepEqual(Starter.stacksOf(null), []);
});

test('recent folders come from turns and local sessions, newest first, without duplicates or remote rows', () => {
  const folders = Starter.recentFolders({
    turns: [{ cwd: '/w/a', ts: NOW - 3 * H }, { cwd: '/w/b/', ts: NOW - H }, { cwd: 'rel', ts: NOW }, { cwd: '/w/a', ts: NOW - 5 * H }],
    sessions: [{ cwd: '/w/c', updatedAt: new Date(NOW - 2 * H).toISOString() }, { cwd: '/w/d', remote: true, updatedAt: new Date(NOW).toISOString() }, { cwd: '/w/b', updatedAt: 'nope' }],
  });
  assert.deepEqual(folders.map((f) => f.cwd), ['/w/b', '/w/c', '/w/a']);
  assert.deepEqual(Starter.recentFolders({ turns: Array.from({ length: 30 }, (_, i) => ({ cwd: `/w/${i}`, ts: NOW - i })) }).length, 20);
});

test('the pack for the most recent known stack is offered, stable by id', (t) => {
  const root = testTempDir('starter-', t);
  const web = mk(path.join(root, 'web'), { 'package.json': JSON.stringify({ dependencies: { next: '15' } }) });
  const ml = mk(path.join(root, 'ml'), { 'requirements.txt': '' });
  const detected = Starter.detect([{ cwd: ml, at: NOW }, { cwd: web, at: NOW - H }]);
  assert.deepEqual(detected.map((d) => [d.folder, d.stacks]), [['ml', ['python']], ['web', ['nextjs', 'node']]]);
  const entries = [pack('python-starter', ['python'], ['recipe/a', 'character/pebble']), pack('nextjs-starter', ['nextjs'], ['recipe/b']), pack('aaa-python', ['python'], ['recipe/a']), recipe('a'), recipe('b'), character('pebble')];
  const m = Starter.matchPack(entries, detected);
  assert.equal(m.pack.id, 'pack/aaa-python'); assert.equal(m.repo.folder, 'ml'); assert.equal(m.stack, 'python');
  assert.equal(Starter.matchPack(entries, Starter.detect([{ cwd: web, at: NOW }])).pack.id, 'pack/nextjs-starter');
  assert.equal(Starter.matchPack([pack('go-starter', ['go'], ['recipe/a'])], detected), null, 'no pack for the stack: nothing offered');
  const s = Starter.suggestion({ detected, entries, connected: true });
  assert.equal(s.stage, 'add'); assert.equal(s.stackLabel, 'Python'); assert.equal(s.folder, 'ml');
  assert.deepEqual(s.pack.members, [{ kind: 'recipe', title: 'a' }]);
  assert.deepEqual(s.recipe, { id: 'recipe/a', title: 'a' });
  assert.ok(!('cwd' in s) && !JSON.stringify(s).includes(root), 'no paths reach the page');
});

test('nothing is suggested before a tool is connected, after dismissal, or once something from the gallery is installed; without the list it offers to look', (t) => {
  const root = testTempDir('starter-', t);
  const web = mk(path.join(root, 'web'), { 'package.json': JSON.stringify({ dependencies: { next: '15' } }) });
  const detected = Starter.detect([{ cwd: web, at: NOW }]);
  const entries = [pack('nextjs-starter', ['nextjs'], ['recipe/b']), recipe('b')];
  assert.equal(Starter.suggestion({ detected, entries, connected: false }), null);
  assert.equal(Starter.suggestion({ detected, entries, connected: true, dismissed: true }), null);
  assert.equal(Starter.suggestion({ detected, entries, connected: true, installed: true }), null);
  assert.equal(Starter.suggestion({ detected: [], entries, connected: true }), null);
  const look = Starter.suggestion({ detected, entries: null, connected: true });
  assert.deepEqual(look, { stage: 'look', stack: 'nextjs', stackLabel: 'Next.js', folder: 'web', pack: null, recipe: null });
});

test('the decision is kept in a small file and survives a bad file', (t) => {
  const dir = testTempDir('starter-', t);
  const store = Starter.createStore({ dir, now: () => NOW });
  assert.deepEqual(store.get(), { dismissed: false, added: null });
  store.dismiss();
  assert.equal(store.get().dismissed, true);
  store.markAdded('pack/x');
  assert.deepEqual(store.get(), { dismissed: true, added: 'pack/x' });
  fs.writeFileSync(path.join(dir, Starter.STORE_FILE), '{nope');
  assert.deepEqual(store.get(), { dismissed: false, added: null });
  store.dismiss();
  assert.equal(fs.statSync(path.join(dir, Starter.STORE_FILE)).mode & 0o777, 0o600, 'private file');
});

function harness(t, { entries, cached = entries, confirmAnswer = true } = {}) {
  const root = testTempDir('starter-', t);
  const web = mk(path.join(root, 'web'), { 'package.json': JSON.stringify({ dependencies: { next: '15' } }) });
  const mine = [], origins = new Map(), chars = [], created = [], confirms = [], fetched = [];
  let list = cached;
  const recipes = {
    mine: () => mine, originOf: (id) => origins.get(id) || null,
    addFromGallery: (e) => { const id = `${e.slug}-copy`; mine.push({ id }); origins.set(id, { source: 'gallery', gallery_id: e.id }); return { ok: true, id, kind: 'recipe' }; },
  };
  const characters = { list: () => chars, freeId: (id) => id, save: (def, meta) => { chars.push({ character: def, meta }); return def; } };
  const svc = { start() {}, registerFolder: (cwd) => ({ handle: `h:${cwd}`, label: path.basename(cwd) }), create: async (draft) => { created.push(draft); return { ok: true, id: 'tsk_1' }; } };
  const gallery = { entries: () => list, fetchIndex: async () => { fetched.push(1); list = entries; return { ok: true }; } };
  const starter = StarterMain.create({
    store: Starter.createStore({ dir: root, now: () => NOW }), gallery, recipes, characters, tasks: () => svc,
    confirm: async (info) => { confirms.push(info); return confirmAnswer; },
    turns: async () => [{ cwd: web, ts: NOW }], sessions: () => [], tools: () => [{ id: 'claude', connected: true }], now: () => NOW,
  });
  return { starter, root, web, mine, chars, created, confirms, fetched, recipes };
}

test('add: one confirm lists every member, recipes and characters are added, rules are left for the gallery, already-present ones are counted', async (t) => {
  const entries = [pack('nextjs-starter', ['nextjs'], ['recipe/a', 'recipe/b', 'character/pebble', 'rules/calm']), recipe('a'), recipe('b'), character('pebble'), entry('rules', 'calm', { payload: { rules: [] } })];
  const h = harness(t, { entries });
  h.mine.push({ id: 'b-old' }); h.recipes.originOf = (id) => (id === 'b-old' ? { source: 'gallery', gallery_id: 'recipe/b' } : null);
  const before = await h.starter.view();
  assert.equal(before, null, 'a gallery recipe is already installed, so the card is not shown');
  h.recipes.originOf = () => null; h.mine.length = 0;
  const s = await h.starter.view();
  assert.equal(s.stage, 'add'); assert.equal(s.pack.title, 'nextjs-starter pack');
  const r = await h.starter.act('add', { sender: { id: 7 } });
  assert.equal(r.ok, true);
  assert.equal(r.note, 'Added 3, 1 to add from the gallery.');
  assert.deepEqual(r.run, { recipe: { title: 'a' }, folder: 'web' });
  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0].detail, /• a \(recipe\)\n• b \(recipe\)\n• pebble \(character\)\n• calm \(widget rules, skipped here: add it from the gallery\)/);
  assert.equal(h.mine.length, 2); assert.equal(h.chars.length, 1); assert.equal(h.chars[0].meta.source, 'gallery');
  assert.equal(await h.starter.view(), null, 'shown once: the pack was added');
  const run = await h.starter.act('run', { sender: { id: 7 } });
  assert.equal(run.ok, true);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].folder, `h:${h.web}`);
  assert.equal(h.created[0].permissionLevel, 'plan'); assert.equal(h.created[0].text, 'Explain'); assert.equal(h.created[0].when, 'now');
  assert.equal((await h.starter.act('run', { sender: { id: 7 } })).ok, false, 'run is one-shot');
});

test('add counts members already present and a declined confirm adds nothing', async (t) => {
  const entries = [pack('nextjs-starter', ['nextjs'], ['recipe/a', 'character/pebble']), recipe('a'), character('pebble')];
  const h = harness(t, { entries, confirmAnswer: false });
  const r = await h.starter.act('add', { sender: { id: 1 } });
  assert.equal(r.ok, false); assert.equal(r.cancelled, true); assert.equal(h.mine.length, 0);
  const h2 = harness(t, { entries });
  h2.chars.push({ character: { id: 'pebble' }, meta: { source: 'hatch' } });
  const r2 = await h2.starter.act('add', { sender: { id: 1 } });
  assert.equal(r2.note, 'Added 1, 1 already there.');
});

test('look fetches the list on the click and dismiss hides the card for good; the IPC answers only Home', async (t) => {
  const entries = [pack('nextjs-starter', ['nextjs'], ['recipe/a']), recipe('a')];
  const h = harness(t, { entries, cached: null });
  assert.equal((await h.starter.view()).stage, 'look');
  const r = await h.starter.act('look');
  assert.equal(h.fetched.length, 1); assert.equal(r.suggestion.stage, 'add');
  assert.equal((await h.starter.act('dismiss')).ok, true);
  assert.equal(await h.starter.view(), null);
  const handlers = new Map(); const page = {};
  StarterMain.register({ ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, allowed: (e) => e.sender === page, starter: h.starter });
  assert.equal(await handlers.get('home:starter')({ sender: {} }), null);
  assert.equal(await handlers.get('home:starter')({ sender: page }), null);
  assert.deepEqual(await handlers.get('home:starter-act')({ sender: page }, 'format'), { ok: false, error: 'Unknown action.' });
});

test('the Home card renders from the suggestion and sends only action words', async () => {
  const { JSDOM } = require('jsdom');
  const ROOT = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(ROOT, 'home.html'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'home-starter.js'), 'utf8');
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(html, /<script src="home-starter\.js"><\/script>/);
  assert.match(fs.readFileSync(path.join(ROOT, 'home-preload.js'), 'utf8'), /starterAct/);
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.setInterval = () => 0;
  const sent = [];
  let suggestion = { stage: 'add', stack: 'nextjs', stackLabel: 'Next.js', folder: 'web', pack: { id: 'pack/x', sha256: 'a', title: 'Next.js starter pack', summary: 'Four recipes.', members: [{ kind: 'recipe', title: 'Explain this repo' }] }, recipe: { id: 'recipe/a', title: 'Explain this repo' } };
  dom.window.homeApi = { starter: async () => suggestion, starterAct: async (a) => { sent.push(a); if (a === 'add') return { ok: true, note: 'Added 1.', run: { recipe: { title: 'Explain this repo' }, folder: 'web' } }; if (a === 'run') return { ok: true, note: 'Started. It shows up in Tasks.' }; return { ok: true }; } };
  dom.window.eval(script);
  await new Promise((r) => setImmediate(r));
  const section = dom.window.document.getElementById('starter');
  assert.equal(section.hidden, false);
  assert.match(section.textContent, /web looks like a Next\.js project\. Next\.js starter pack: Four recipes\./);
  assert.match(section.textContent, /Explain this repo \(recipe\)/);
  const add = [...section.querySelectorAll('button')].find((b) => b.textContent === 'Add the pack');
  add.click();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['add']);
  assert.match(section.textContent, /Added 1\. Run “Explain this repo” on web\?/);
  [...section.querySelectorAll('button')].find((b) => b.textContent === 'Run it now').click();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['add', 'run']);
  assert.match(section.textContent, /Started\. It shows up in Tasks\./);
  suggestion = null;
  dom.window.close();
});
