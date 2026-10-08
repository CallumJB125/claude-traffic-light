'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Recipes = require('../src/recipes.js');
const Personal = require('../src/setups-personal.js');

const DIR = path.join(__dirname, '..', 'recipes');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const temp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-recipes-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const engine = (root) => Recipes.create({ builtInDir: DIR, dataDir: path.join(root, 'data'), home: root });

test('every shipped recipe file passes the schema, is named after its id, and the set is 10 to 12 distinct recipes', () => {
  assert.ok(files.length >= 10 && files.length <= 12, `${files.length} recipes`);
  assert.deepEqual(fs.readdirSync(DIR).filter((f) => !f.endsWith('.json')), [], 'only recipe files in recipes/');
  const ids = new Set(), titles = new Set();
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    assert.deepEqual(Recipes.problems(r), [], f);
    assert.deepEqual(Object.keys(r), Recipes.KEYS, `${f}: fields in the schema order`);
    assert.equal(`${r.id}.json`, f);
    assert.ok(!ids.has(r.id) && !titles.has(r.title), `${f}: duplicate`);
    ids.add(r.id); titles.add(r.title);
    if (!r.edits) assert.match(r.prompt, /Do not change any files/, `${f}: a read-only recipe says so in its prompt`);
    assert.doesNotMatch(r.prompt, /\/Users\/|\/home\/|\{\{/, `${f}: no personal paths or placeholders`);
  }
  for (const need of ['weekly-report', 'review-open-pr', 'fix-flaky-tests', 'explain-repo', 'update-dependencies', 'release-notes', 'triage-failing-ci', 'summarise-todays-ai-work']) assert.ok(ids.has(need), need);
  assert.ok([...ids].some((id) => JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`))).edits), 'some recipes edit files');
});

test('the schema rejects missing, unknown and malformed fields', () => {
  const good = JSON.parse(fs.readFileSync(path.join(DIR, files[0]), 'utf8'));
  assert.equal(Recipes.valid(good), true);
  assert.equal(Recipes.valid(null), false);
  assert.match(Recipes.problems({ ...good, run: 'rm -rf' }).join(), /unknown field: run/);
  const { cost, ...noCost } = good;
  assert.match(Recipes.problems(noCost).join(), /missing field: cost/);
  for (const bad of [{ id: 'Weekly Report' }, { id: '../x' }, { title: 'a\nb' }, { title: '' }, { tool: 'cursor' }, { edits: 'yes' }, { prompt: 'x'.repeat(Recipes.LIMITS.prompt + 1) }, { what: 5 }]) {
    assert.equal(Recipes.valid({ ...good, ...bad }), false, JSON.stringify(bad).slice(0, 60));
  }
});

test('a recipe becomes a Tasks draft: edits run with edit permission (worktree), read-only ones in plan mode', () => {
  const r = { id: 'x', title: 'X', what: 'w', prompt: 'p', tool: 'codex', edits: true, cost: 'c' };
  assert.deepEqual(Recipes.draftFor(r, 'h1', 'tonight'), { text: 'p', folder: 'h1', ai: 'codex', surface: 'background', permissionLevel: 'auto-edits', planFirst: false, when: 'tonight' });
  assert.equal(Recipes.draftFor({ ...r, edits: false }, 'h1', 'whenever').permissionLevel, 'plan');
  assert.equal(Recipes.draftFor(r, 'h1', 'whenever').when, 'now');
});

test('inRepo finds a git work tree from a subfolder and not outside one', (t) => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'repo', 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plain'));
  assert.equal(Recipes.inRepo(path.join(root, 'repo', 'a', 'b')), true);
  assert.equal(Recipes.inRepo(path.join(root, 'plain')), fs.existsSync(path.join(os.tmpdir(), '.git')));
});

test('Save as my own copies a recipe under a new id; Delete removes only your own', (t) => {
  const root = temp(t);
  const e = engine(root);
  assert.equal(e.mine().length, 0);
  const s = e.saveMine('weekly-report');
  assert.deepEqual(s, { ok: true, id: 'my-weekly-report' });
  assert.equal(e.saveMine('weekly-report').id, 'my-weekly-report-2');
  const mine = e.mine().find((r) => r.id === 'my-weekly-report');
  assert.match(mine.title, /\(my copy\)$/);
  assert.equal(mine.prompt, e.builtIn().find((r) => r.id === 'weekly-report').prompt);
  assert.equal((fs.statSync(path.join(root, 'data', 'my-weekly-report.json')).mode & 0o777), 0o600);
  assert.equal(e.deleteMine('weekly-report').ok, false, 'a built-in is not yours to delete');
  assert.equal(e.deleteMine('../weekly-report').ok, false);
  assert.equal(e.deleteMine('my-weekly-report').ok, true);
  assert.equal(e.mine().length, 1);
  assert.equal(e.saveMine('nope').ok, false);
});

test('sharing: every recipe exports in the personal setups format, imports back intact, and the file also plans on the Setups page', (t) => {
  const root = temp(t);
  const e = engine(root);
  assert.equal(e.exportText().ok, false, 'nothing of your own yet');
  for (const r of e.builtIn()) assert.equal(e.saveMine(r.id).ok, true);
  const out = e.exportText();
  assert.equal(out.ok, true, out.error);
  assert.equal(out.count, files.length);
  const env = JSON.parse(out.text);
  assert.equal(env.kind, Personal.ENVELOPE_KIND);
  assert.ok(env.payload.files.every((f) => f.source_id === 'claude-code' && f.relative_path.startsWith(`${Recipes.SHARE_DIR}/`)));
  const before = e.mine();
  for (const r of before) e.deleteMine(r.id);
  const back = e.importText(out.text);
  assert.equal(back.ok, true);
  assert.equal(back.added.length, files.length);
  for (const r of before) assert.deepEqual(e.mine().find((x) => x.id === r.id), r);
  const setups = Personal.createPersonalSetups({ home: root, dataRoot: path.join(root, 'setups') });
  const plan = setups.planFromText(out.text);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(e.importText('{"kind":"plexiform.setup"}').ok, false);
  const tampered = JSON.parse(out.text); tampered.payload.files[0].content += 'x';
  assert.equal(e.importText(JSON.stringify(tampered)).ok, false, 'the content hash is checked');
});

test('a command file round-trips; anything else is not a recipe', () => {
  const r = JSON.parse(fs.readFileSync(path.join(DIR, files[0]), 'utf8'));
  assert.deepEqual(Recipes.fromCommand(Recipes.commandText(r)), r);
  assert.equal(Recipes.fromCommand('# just a command\n'), null);
  assert.equal(Recipes.fromCommand(Recipes.commandText(r).replace('"edits":', '"run":')), null);
});

function rig(t, over = {}) {
  const root = temp(t);
  fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plain'));
  const handlers = new Map(), created = [], asked = [];
  const folders = { repo: path.join(root, 'repo'), plain: path.join(root, 'plain') };
  const tasks = { folderOf: (h) => folders[h] ?? null, create: async (d) => { created.push(d); return { ok: true, id: 'tsk_1' }; }, composerInfo: async () => ({ canSchedule: true }) };
  Recipes.register({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, allowed: (e) => e.page === 'tasks', recipes: engine(root), tasks: () => tasks, home: root,
    confirm: async (info) => { asked.push(info); return over.yes ?? true; }, pickSave: async () => null, pickOpen: async () => null, readFile: () => null, writeFile: () => {}, demo: () => over.demo === true,
  });
  const call = (ch, ...a) => handlers.get(ch)({ page: 'tasks' }, ...a);
  return { handlers, created, asked, call };
}

test('Run builds the task from the recipe file after a native confirmation; edits need a git repo', async (t) => {
  const r = rig(t);
  assert.equal(await r.handlers.get('recipes:list')({ page: 'memory' }), null, 'other pages get nothing');
  const list = await r.call('recipes:list');
  assert.equal(list.builtIn.length, files.length); assert.equal(list.canSchedule, true);
  assert.match((await r.call('recipes:run', 'weekly-report', 'nowhere', 'now')).error, /Choose the folder/);
  assert.match((await r.call('recipes:run', 'fix-flaky-tests', 'plain', 'now')).error, /git repository/);
  assert.equal(r.created.length, 0); assert.equal(r.asked.length, 0);
  assert.equal((await r.call('recipes:run', 'weekly-report', 'plain', 'now')).ok, true, 'read-only recipes may run anywhere');
  assert.equal(r.created[0].permissionLevel, 'plan');
  const res = await r.call('recipes:run', 'fix-flaky-tests', 'repo', 'tonight');
  assert.equal(res.ok, true);
  const flaky = JSON.parse(fs.readFileSync(path.join(DIR, 'fix-flaky-tests.json'), 'utf8'));
  assert.deepEqual(r.created[1], { text: flaky.prompt, folder: 'repo', ai: flaky.tool, surface: 'background', permissionLevel: 'auto-edits', planFirst: false, when: 'tonight' });
  assert.match(r.asked[1].detail, /own git worktree/); assert.equal(r.asked[1].action, 'Run tonight');
  assert.equal((await r.call('recipes:run', 'not-a-recipe', 'repo', 'now')).ok, false);
});

test('Run stops when the confirmation is cancelled, and in the demo nothing runs', async (t) => {
  const no = rig(t, { yes: false });
  const r1 = await no.call('recipes:run', 'weekly-report', 'repo', 'now');
  assert.equal(r1.cancelled, true); assert.equal(no.created.length, 0);
  const demo = rig(t, { demo: true });
  assert.match((await demo.call('recipes:run', 'weekly-report', 'repo', 'now')).error, /demo/);
  assert.equal(demo.asked.length, 0); assert.equal(demo.created.length, 0);
  assert.equal((await demo.call('recipes:list')).demo, true);
});
