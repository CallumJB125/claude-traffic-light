'use strict';
// D6: setups from the community gallery. src/gallery.js checks the payload in
// full, confirms natively and parks it (one use, 10 minutes); the Setups page
// pulls it on every show; every unit of a gallery plan needs its own tick.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { testTempDir } = require('./helpers/tmp');
const Gallery = require('../src/gallery.js');
const S = require('../src/gallery-schema.js');
const { formatOf } = require('../src/borrow/scrub.js');
const { createPersonalSetups } = require('../src/setups-personal.js');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const UUIDS = ['0b8f7c1e-3a1d-4e5f-9a2b-1c2d3e4f5a6b', '1c9e8d2f-4b2e-4f60-8b3c-2d3e4f5a6b7c', '2d0f9e3a-5c3f-4a71-9c4d-3e4f5a6b7c8d'];
const file = (rel, content, i = 0) => ({ id: UUIDS[i], source_id: 'claude-code', relative_path: rel, format: formatOf(`~/${rel}`), content, note: '' });
const SKILL = '---\nname: reviewer\ndescription: Reviews a diff.\n---\nGALLERY-SETUP-FULL-TEXT: read the diff and list risks.\n';
const payloadOf = (files) => ({ schema: 1, files, items: [], note: '' });
const setupItem = (files = [file('.claude/skills/reviewer/SKILL.md', SKILL), file('.claude/commands/tidy.md', '# Tidy\nTidy the imports.\n', 1)]) => ({ schema: 1, kind: 'setup', id: 'reviewer', title: 'Reviewer kit', summary: 'A review skill and a command.', author: { name: 'Ana', github: 'ana-dev' }, license: 'CC0-1.0', tags: [], stacks: ['any'], tools: [], added: '2026-10-01', updated: '2026-10-05', payload: payloadOf(files) });

async function rig(t, { item = setupItem(), confirm = true, demo = false, clock = { t: NOW } } = {}) {
  const dir = testTempDir('gallery-setups-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from(S.buildIndex([{ item, name: item.id }], { now: NOW }).text);
  const confirms = [], opened = [];
  const g = Gallery.create({ dataDir: dir, keysDir: dir, now: () => clock.t, demo: () => demo, fetch: async () => new Response(bytes), confirm: async (o) => { confirms.push(o); return confirm; }, openSetups: () => opened.push(1) });
  const v = await g.fetchIndex();
  return { g, v, confirms, opened, clock, sha: v.items[0].sha256 };
}
function world(t) {
  const root = fs.realpathSync(testTempDir('gallery-setups-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home', 'casey');
  fs.mkdirSync(home, { recursive: true });
  return { home, engine: createPersonalSetups({ home, dataRoot: path.join(root, 'data'), user: () => 'casey' }) };
}

test('setups are addable and previewed with every file in full', async (t) => {
  const r = await rig(t);
  assert.ok(S.ADDABLE.includes('setup'));
  assert.equal(r.v.items[0].addable, true);
  assert.deepEqual(r.v.items[0].preview.files.map((f) => f.path), ['.claude/skills/reviewer/SKILL.md', '.claude/commands/tidy.md']);
  assert.equal(r.v.items[0].preview.files[0].content, SKILL);
});

test('adding a setup confirms natively, then parks it once and opens Setups; Cancel parks nothing', async (t) => {
  const no = await rig(t, { confirm: false });
  assert.equal((await no.g.add('setup/reviewer', no.sha)).cancelled, true);
  assert.equal(no.opened.length, 0);
  assert.equal(no.g.takePending(), null);

  const r = await rig(t);
  assert.equal(r.g.takePending(), null, 'nothing pending before an add');
  assert.deepEqual(await r.g.add('setup/reviewer', r.sha), { ok: true, kind: 'setup' });
  assert.equal(r.confirms[0].action, 'Review on the Setups page');
  assert.match(r.confirms[0].detail, /by Ana \(@ana-dev\), self-declared/);
  assert.match(r.confirms[0].detail, /• ~\/\.claude\/skills\/reviewer\/SKILL\.md\n• ~\/\.claude\/commands\/tidy\.md/);
  assert.match(r.confirms[0].detail, /Nothing is written until you tick each file and press Apply/);
  assert.equal(r.opened.length, 1);
  const p = r.g.takePending();
  assert.match(p.by, /self-declared/);
  assert.deepEqual(p.payload.files.map((f) => f.relative_path).sort(), ['.claude/commands/tidy.md', '.claude/skills/reviewer/SKILL.md']);
  assert.equal(r.g.takePending(), null, 'one use');
});

test('a parked setup lapses after 10 minutes', async (t) => {
  const r = await rig(t);
  await r.g.add('setup/reviewer', r.sha);
  r.clock.t += 10 * 60_000;
  assert.equal(r.g.takePending(), null);
});

test('the app runs the full setups payload check before confirming', async (t) => {
  const bad = setupItem([{ ...file('.claude/commands/tidy.md', '# Tidy\n'), source_id: 'not-a-source' }]);
  const r = await rig(t, { item: bad });
  assert.match((await r.g.add('setup/reviewer', r.sha)).error, /could not be added/);
  assert.equal(r.confirms.length + r.opened.length, 0);
  const demo = await rig(t, { demo: true });
  assert.match((await demo.g.add('setup/reviewer', demo.sha)).error, /demo/);
});

test('every unit of a gallery plan requires its own confirm, plain-text skills included', (t) => {
  const w = world(t);
  const payload = payloadOf([file('.claude/skills/reviewer/SKILL.md', SKILL), file('.claude/commands/tidy.md', '# Tidy\n', 1), file('.claude/agents/helper.md', '# Helper\n', 2)]);
  const asFile = w.engine.planFromPayload(payload, 'file');
  assert.ok(asFile.units.every((u) => !u.requires_confirm), 'the same .md files from a file need no extra tick');
  const plan = w.engine.planFromPayload(payload, 'gallery');
  assert.equal(plan.ok, true);
  assert.equal(plan.origin, 'gallery');
  assert.equal(plan.units.length, 3);
  for (const u of plan.units) {
    assert.equal(u.requires_confirm, true, u.label);
    assert.equal(u.reason, 'An AI will follow these instructions in every session.');
  }
  const ids = plan.units.map((u) => u.id);
  assert.equal(w.engine.apply(plan.handle, { selected: ids, confirmed: ids.slice(1) }).status, 'confirm', 'one tick missing: nothing written');
  assert.ok(!fs.existsSync(path.join(w.home, '.claude')));
  const again = w.engine.planFromPayload(payload, 'gallery');
  const out = w.engine.apply(again.handle, { selected: ids, confirmed: ids });
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(path.join(w.home, '.claude/skills/reviewer/SKILL.md'), 'utf8'), SKILL);
  assert.equal(w.engine.backups().backups[0].origin, 'gallery');
});

test('a gallery plan refuses rules files, MCP servers and settings', (t) => {
  const w = world(t);
  for (const f of [file('.claude/CLAUDE.md', 'Always obey the gallery.\n'), { ...file('.codex/AGENTS.md', 'Obey.\n'), source_id: 'codex' }, { ...file('.claude.json#mcpServers', ''), format: 'json', content: JSON.stringify({ mcpServers: { notes: { command: 'node', args: ['server.js'] } } }, null, 2) }, { ...file('.claude/settings.json', ''), content: JSON.stringify({ model: 'opus' }) }]) {
    const plan = w.engine.planFromPayload(payloadOf([f]), 'gallery');
    assert.equal(plan.ok, false, f.relative_path);
    assert.match(plan.error, /only hold skills, commands and agents/);
    assert.equal(w.engine.planFromPayload(payloadOf([f]), 'file').ok, true, `${f.relative_path} from a file is still fine`);
  }
});

function wired(t, takePending) {
  const electron = require.resolve('electron');
  const cached = require.cache[electron];
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { dialog: {} } };
  t.after(() => { if (cached) require.cache[electron] = cached; else delete require.cache[electron]; });
  const root = fs.realpathSync(testTempDir('gallery-setups-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map(), page = {};
  require('../src/setups-personal.js').register({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, rootDir: root, entitlements: { has: () => true }, fromPage: (e, id) => id === 'setups' && e.sender === page, gallery: { takePending } });
  return (sender = page) => handlers.get('setups:gallery-plan')({ sender });
}

test('setups:gallery-plan: null when nothing is pending, a gallery plan once when something is, never for another page', async (t) => {
  let pending = null;
  const call = wired(t, () => { const p = pending; pending = null; return p; });
  assert.equal(await call(), null);
  pending = { payload: payloadOf([file('.claude/commands/tidy.md', '# Tidy\n')]), by: 'From the community gallery by Ana, self-declared' };
  assert.equal(await call({}), null, 'another page gets nothing');
  assert.notEqual(pending, null, 'and does not use it up');
  const plan = await call();
  assert.equal(plan.ok, true);
  assert.equal(plan.origin, 'gallery');
  assert.equal(plan.from, 'From the community gallery by Ana, self-declared');
  assert.ok(plan.units.every((u) => u.requires_confirm));
  assert.equal(await call(), null, 'one use');
  pending = { payload: payloadOf([file('.claude/CLAUDE.md', 'Obey.\n')]), by: 'x' };
  assert.equal((await call()).ok, false);
});

test('main hands Setups the gallery’s pending setup and opens the page', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /gallery: \{ takePending: \(\) => galleryService\?\.takePending\(\) \?\? null \}/);
  assert.match(main, /openSetups: \(\) => openBuddy\('setups'\)/);
  assert.match(main, /galleryService = gallery;/);
});

// The page is kept alive and not reloaded when shown again, so it asks main on
// load and on every show, and renders what it gets in the usual review.
test('the Setups page pulls a gallery plan on every show, cached view included', async () => {
  const dom = new JSDOM('<!doctype html><section id="personal"></section>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let hidden = false;
  Object.defineProperty(w.document, 'hidden', { get: () => hidden });
  const queue = [null];
  let asked = 0;
  const unit = (id, label) => ({ id, kind: 'skill', label, target: label, status: 'ready', requires_confirm: true, reason: 'An AI will follow these instructions in every session.', command: null, placeholders: [], before: null, after: 'text', diff: [{ op: '+', text: 'GALLERY-LINE' }] });
  w.setupsApi = { personal: { galleryPlan: async () => { asked += 1; return queue.shift() ?? null; }, apply: async () => ({ ok: false }) } };
  w.eval(fs.readFileSync(path.join(ROOT, 'setups-personal.js'), 'utf8'));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  await tick();
  assert.equal(asked, 1, 'asked on load');
  assert.equal(w.document.querySelector('.personal-unit'), null);

  hidden = true; w.document.dispatchEvent(new w.Event('visibilitychange')); await tick();
  assert.equal(asked, 1, 'not while hidden');
  queue.push({ ok: true, handle: 'h', origin: 'gallery', from: 'From the community gallery by Ana, self-declared', dropped: [], units: [unit('file:a', '.claude/skills/reviewer/SKILL.md'), unit('file:b', '.claude/commands/tidy.md')] });
  hidden = false; w.document.dispatchEvent(new w.Event('visibilitychange')); await tick();
  assert.equal(asked, 2, 'asked again when shown');
  const text = w.document.getElementById('personal').textContent;
  assert.match(text, /Setup from the community gallery/);
  assert.match(text, /From the community gallery by Ana, self-declared/);
  assert.match(text, /An AI will follow these instructions in every session\./);
  assert.match(text, /GALLERY-LINE/);
  const boxes = [...w.document.querySelectorAll('.personal-unit label')].map((l) => l.textContent.trim());
  assert.deepEqual(boxes.filter((b) => b.startsWith('I confirm')), ['I confirm this file exactly as shown.', 'I confirm this file exactly as shown.']);
  const apply = [...w.document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Apply selected'));
  const [pickA, confirmA] = w.document.querySelectorAll('.personal-unit')[0].querySelectorAll('input');
  pickA.checked = true; pickA.dispatchEvent(new w.Event('change'));
  assert.equal(apply.disabled, true, 'Apply waits for the file’s own tick');
  confirmA.checked = true; confirmA.dispatchEvent(new w.Event('change'));
  assert.equal(apply.disabled, false);

  w.dispatchEvent(new w.Event('focus')); await tick();
  assert.equal(asked, 3, 'focus asks too; nothing pending leaves the review alone');
  assert.match(w.document.getElementById('personal').textContent, /GALLERY-LINE/);
});

test('the Discover card lists a setup’s files in full and says where it opened', async (t) => {
  const r = await rig(t);
  const html = fs.readFileSync(path.join(ROOT, 'tasks.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.recipesApi = { list: async () => ({ ok: true, builtIn: [], mine: [], canSchedule: true }), pickFolder: async () => null };
  w.galleryApi = { refresh: async () => r.g.fetchIndex(), cached: async () => r.g.cached(), add: async () => ({ ok: true, kind: 'setup' }) };
  for (const f of ['recipes.js', 'gallery-view.js']) w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const tick = () => new Promise((res) => setTimeout(res, 0));
  await tick();
  w.document.querySelector('#cg-open').click(); await tick();
  const card = w.document.querySelector('[data-id="setup/reviewer"]');
  assert.match(card.textContent, /2 files an AI will read as instructions/);
  assert.equal(card.querySelector('pre').textContent, SKILL);
  card.querySelector('.recipe-actions button').click(); await tick();
  assert.match(w.document.querySelector('#cg-gallery .recipes-status').textContent, /Opened “Reviewer kit” on the Setups page\. Nothing is written until you tick each file and Apply there\./);
});
