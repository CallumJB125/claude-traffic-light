'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Recipes = require('../src/recipes.js');
const S = require('../src/gallery-schema.js');

const DIR = path.join(__dirname, '..', 'recipes');
const temp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-recipes-gallery-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const engine = (root) => Recipes.create({ builtInDir: DIR, dataDir: path.join(root, 'data'), home: root, now: () => NOW });
const PROMPT = 'Read the repository and explain it.\n\nStep two: list every module.';
function entry(payload = {}, id = 'explain-it') {
  const item = { schema: 1, kind: 'recipe', id, title: 'Explain it', summary: 'Explains it.', author: { name: 'Ana', github: 'ana-dev' }, license: 'MIT', tags: [], stacks: ['any'], tools: ['auto'], added: '2026-10-01', updated: '2026-10-01', payload: { id, title: 'Explain it', what: 'Explains the repo.', prompt: PROMPT, tool: 'auto', edits: false, cost: 'Low.', ...payload } };
  return S.buildIndex([{ item, name: id }]).index.entries[0];
}

test('addFromGallery writes a read-only recipe and its origin sidecar, keeping the id when it is free', (t) => {
  const root = temp(t), e = engine(root);
  const out = e.addFromGallery(entry());
  assert.deepEqual(out, { ok: true, id: 'explain-it', kind: 'recipe' });
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'explain-it.json'), 'utf8'));
  assert.equal(saved.edits, false);
  assert.deepEqual(Object.keys(saved), [...Recipes.KEYS]);
  const origin = JSON.parse(fs.readFileSync(path.join(root, 'data', 'explain-it.origin.json'), 'utf8'));
  assert.deepEqual(origin, { source: 'gallery', gallery_id: 'recipe/explain-it', sha256: entry().sha256, author: { github: 'ana-dev', name: 'Ana' }, license: 'MIT', added_at: '2026-10-10T12:00:00.000Z' });
  assert.equal(fs.statSync(path.join(root, 'data', 'explain-it.origin.json')).mode & 0o777, 0o600);
  assert.deepEqual(e.mine().map((r) => r.id), ['explain-it'], 'the sidecar is not loaded as a recipe');
  assert.equal(e.originOf('explain-it').author.name, 'Ana');
  assert.equal(e.addFromGallery(entry()).id, 'my-explain-it', 'a taken id gets a free one');
  assert.equal(e.addFromGallery(entry({}, 'explain-repo')).id, 'my-explain-repo', 'a built-in id is taken too');
});

test('addFromGallery refuses a secret, a home path, a changed or editing entry and a full recipe list', (t) => {
  const root = temp(t), e = engine(root);
  const tamper = (payload) => { const x = entry(); x.payload = { ...x.payload, ...payload }; x.sha256 = S.entryHash(x); return x; };
  assert.match(e.addFromGallery(tamper({ prompt: `Use sk-ant-api03-${'a'.repeat(93)}AA to call it.` })).error, /did not pass the checks/);
  assert.match(e.addFromGallery(tamper({ prompt: 'Open /Users/ana/secret-project.' })).error, /did not pass the checks/);
  assert.match(e.addFromGallery({ ...entry(), title: 'Changed after hashing' }).error, /did not pass the checks/);
  assert.match(e.addFromGallery(tamper({ edits: true })).error, /did not pass the checks/, 'gallery recipes never edit files');
  assert.deepEqual(fs.existsSync(path.join(root, 'data')) ? fs.readdirSync(path.join(root, 'data')) : [], []);
  for (let i = 0; i < Recipes.LIMITS.mine; i++) assert.equal(e.addFromGallery(entry()).ok, true);
  assert.match(e.addFromGallery(entry()).error, /up to 100/);
});

test('deleting a gallery recipe removes its sidecar', (t) => {
  const root = temp(t), e = engine(root);
  e.addFromGallery(entry());
  assert.equal(e.deleteMine('explain-it').ok, true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')), []);
});

function rig(t) {
  const root = temp(t);
  fs.mkdirSync(path.join(root, 'plain'));
  const handlers = new Map(), asked = [];
  const tasks = { folderOf: (h) => (h === 'plain' ? path.join(root, 'plain') : null), create: async () => ({ ok: true, id: 'tsk_1' }), composerInfo: async () => ({ canSchedule: true }) };
  const recipes = engine(root);
  Recipes.register({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, allowed: () => true, recipes, tasks: () => tasks, home: root, confirm: async (info) => { asked.push(info); return true; }, pickSave: async () => null, pickOpen: async () => null, readFile: () => null, writeFile: () => {} });
  return { recipes, asked, call: (ch, ...a) => handlers.get(ch)({}, ...a) };
}

test('the recipes:run confirm shows the full prompt for your own recipes and says where a gallery one came from', async (t) => {
  const r = rig(t);
  r.recipes.addFromGallery(entry());
  assert.equal((await r.call('recipes:run', 'explain-it', 'plain', 'now')).ok, true);
  assert.ok(r.asked[0].detail.includes(PROMPT), 'the whole prompt, not a summary');
  assert.match(r.asked[0].detail, /From the community gallery by Ana \(self-declared\)\./);
  r.recipes.saveMine('weekly-report');
  await r.call('recipes:run', 'my-weekly-report', 'plain', 'now');
  assert.ok(r.asked[1].detail.includes(r.recipes.find('my-weekly-report').prompt));
  assert.ok(!/community gallery/.test(r.asked[1].detail));
  await r.call('recipes:run', 'weekly-report', 'plain', 'now');
  assert.ok(!r.asked[2].detail.includes('The full prompt'), 'built-in recipes keep today’s text');
});
