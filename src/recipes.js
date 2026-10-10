'use strict';
// Recipes: ready-made tasks in plain language (recipes/*.json, shipped with
// the app) and the person's own copies (<data root>/recipes/*.json). A recipe
// runs through the Tasks engine like any task: main builds the task from the
// recipe file itself (the page names an id and an opaque folder handle, never
// prompt text or a path), asks with a native dialog first, and a recipe that
// edits files must run in a git repository so the engine gives it its own
// worktree and branch. Read-only recipes run in plan mode.
//
// Sharing is a file in the personal setups export format
// (src/setups-personal.js): each recipe becomes a Claude Code command at
// ~/.claude/commands/plexiform-recipes/<id>.md, so the same file also imports
// on the Setups page. Nothing here opens a network channel.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
// Loaded on first share: they pull in the .mjs secret patterns, and the site
// build validates gallery recipes with problems() on a Node that may not load it.
const schema = () => require('./borrow/payload.js');
const Personal = () => require('./setups-personal.js');
const scrub = () => require('./borrow/scrub.js');

const KEYS = Object.freeze(['id', 'title', 'what', 'prompt', 'tool', 'edits', 'cost']);
const TOOLS = Object.freeze(['auto', 'claude', 'codex', 'gemini']);
const TOOL_LABEL = Object.freeze({ auto: 'Best available AI', claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' });
const ID = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/;
const LIMITS = Object.freeze({ id: 48, title: 80, what: 300, prompt: 6000, cost: 200, mine: 100 });
const SHARE_DIR = '.claude/commands/plexiform-recipes';
const SHARE_FILE = /^\.claude\/commands\/plexiform-recipes\/([a-z0-9-]{1,48})\.md$/;
const META = 'plexiform-recipe: ';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const line = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const block = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v);

// → [] when valid, else what is wrong.
function problems(r) {
  if (!isObject(r)) return ['not an object'];
  const out = [];
  const keys = Object.keys(r);
  for (const k of keys) if (!KEYS.includes(k)) out.push(`unknown field: ${k}`);
  for (const k of KEYS) if (!Object.hasOwn(r, k)) out.push(`missing field: ${k}`);
  if (Object.hasOwn(r, 'id') && !(typeof r.id === 'string' && r.id.length <= LIMITS.id && ID.test(r.id))) out.push('id: lowercase words joined by dashes');
  if (Object.hasOwn(r, 'title') && !line(r.title, LIMITS.title)) out.push(`title: one line, up to ${LIMITS.title} characters`);
  if (Object.hasOwn(r, 'what') && !line(r.what, LIMITS.what)) out.push(`what: one line, up to ${LIMITS.what} characters`);
  if (Object.hasOwn(r, 'prompt') && !block(r.prompt, LIMITS.prompt)) out.push(`prompt: text up to ${LIMITS.prompt} characters`);
  if (Object.hasOwn(r, 'tool') && !TOOLS.includes(r.tool)) out.push(`tool: one of ${TOOLS.join(', ')}`);
  if (Object.hasOwn(r, 'edits') && typeof r.edits !== 'boolean') out.push('edits: true or false');
  if (Object.hasOwn(r, 'cost') && !line(r.cost, LIMITS.cost)) out.push(`cost: one line, up to ${LIMITS.cost} characters`);
  return out;
}
const valid = (r) => problems(r).length === 0;
const clean = (r) => Object.fromEntries(KEYS.map((k) => [k, r[k]]));

function readDir(dir, fsApi = fs) {
  let names = [];
  try { names = fsApi.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const st = fsApi.lstatSync(path.join(dir, n));
      if (!st.isFile() || st.size > 64 * 1024) continue;
      const r = JSON.parse(fsApi.readFileSync(path.join(dir, n), 'utf8'));
      if (valid(r) && `${r.id}.json` === n) out.push(clean(r));
    } catch { /* skipped */ }
  }
  return out;
}

// The folder the task runs in is inside a git work tree (so the engine makes a worktree for it).
function inRepo(dir, fsApi = fs) {
  let cur = path.resolve(dir);
  for (;;) {
    try { fsApi.statSync(path.join(cur, '.git')); return true; } catch { /* keep looking */ }
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

// The Tasks engine draft (src/tasks-guard.js validateCreate) for one recipe.
function draftFor(r, folder, when) {
  return { text: r.prompt, folder, ai: r.tool, surface: 'background', permissionLevel: r.edits ? 'auto-edits' : 'plan', planFirst: false, when: when === 'tonight' ? 'tonight' : 'now' };
}

function commandText(r) {
  const meta = { id: r.id, title: r.title, what: r.what, tool: r.tool, edits: r.edits, cost: r.cost };
  return `---\ndescription: ${r.title}\n${META}${JSON.stringify(meta)}\n---\n${r.prompt.trim()}\n`;
}
function fromCommand(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(String(text));
  if (!m) return null;
  const metaLine = m[1].split('\n').find((l) => l.startsWith(META));
  if (!metaLine) return null;
  let meta; try { meta = JSON.parse(metaLine.slice(META.length)); } catch { return null; }
  if (!isObject(meta)) return null;
  const r = { id: meta.id, title: meta.title, what: meta.what, prompt: m[2].trim(), tool: meta.tool, edits: meta.edits, cost: meta.cost };
  return valid(r) ? r : null;
}

function create({ builtInDir, dataDir, home, fsApi = fs, now = Date.now }) {
  const builtIn = () => readDir(builtInDir, fsApi);
  const mine = () => readDir(dataDir, fsApi);
  const find = (id) => (typeof id === 'string' ? mine().find((r) => r.id === id) || builtIn().find((r) => r.id === id) || null : null);

  function write(r) {
    fsApi.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, `${r.id}.json`), tmp = `${file}.${process.pid}.tmp`;
    fsApi.writeFileSync(tmp, `${JSON.stringify(clean(r), null, 2)}\n`, { mode: 0o600 });
    fsApi.renameSync(tmp, file);
  }
  function freeId(base) {
    const taken = new Set([...mine(), ...builtIn()].map((r) => r.id));
    const stem = `my-${base.replace(/^my-/, '')}`.slice(0, LIMITS.id - 4).replace(/-+$/, '');
    if (!taken.has(stem)) return stem;
    for (let n = 2; n < 1000; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
    return null;
  }

  // "Save as my own": a copy in the person's recipes, with its own id.
  function saveMine(id) {
    const r = find(id);
    if (!r) return { ok: false, error: 'That recipe is no longer available.' };
    if (mine().length >= LIMITS.mine) return { ok: false, error: `You can keep up to ${LIMITS.mine} recipes of your own.` };
    const nid = freeId(r.id);
    if (!nid) return { ok: false, error: 'Could not name the copy. Delete an older copy first.' };
    const title = r.title.endsWith('(my copy)') ? r.title : `${r.title} (my copy)`.slice(0, LIMITS.title);
    write({ ...r, id: nid, title });
    return { ok: true, id: nid };
  }
  function deleteMine(id) {
    if (typeof id !== 'string' || !ID.test(id) || !mine().some((r) => r.id === id)) return { ok: false, error: 'That recipe is not one of yours.' };
    fsApi.rmSync(path.join(dataDir, `${id}.json`), { force: true });
    return { ok: true };
  }

  // The share file: the personal setups envelope, one Claude Code command per recipe.
  function exportText(ids) {
    const all = mine();
    const chosen = Array.isArray(ids) ? all.filter((r) => ids.includes(r.id)) : all;
    if (!chosen.length) return { ok: false, error: 'Save a recipe as your own first, then share it.' };
    const files = chosen.map((r) => {
      const rel = `${SHARE_DIR}/${r.id}.md`;
      return { id: randomUUID(), source_id: 'claude-code', relative_path: rel, format: scrub().formatOf(`~/${rel}`), content: commandText(r), note: '' };
    });
    let checked;
    try { checked = schema().validatePayload({ schema: 1, files, items: [], note: '' }); } catch { return { ok: false, error: 'One of your recipes did not pass the privacy check (a home folder path or a secret). Edit it out, then share again.' }; }
    const text = `${JSON.stringify({ kind: Personal().ENVELOPE_KIND, schema: 1, exported_at: new Date(now()).toISOString(), content_hash: checked.content_hash, payload: checked.payload }, null, 2)}\n`;
    return { ok: true, text, count: chosen.length };
  }

  function importText(text) {
    const checked = Personal().createPersonalSetups({ home, dataRoot: dataDir, fsApi }).parseEnvelope(text);
    if (!checked) return { ok: false, error: 'That is not a valid shared setup or recipe file.' };
    const found = checked.payload.files.filter((f) => f.source_id === 'claude-code' && SHARE_FILE.test(f.relative_path)).map((f) => fromCommand(f.content)).filter(Boolean);
    if (!found.length) return { ok: false, error: 'That file has no recipes in it.' };
    const added = [];
    for (const r of found) {
      if (mine().length >= LIMITS.mine) break;
      const nid = freeId(r.id);
      if (!nid) break;
      write({ ...r, id: nid });
      added.push(nid);
    }
    return added.length ? { ok: true, added } : { ok: false, error: `You can keep up to ${LIMITS.mine} recipes of your own.` };
  }

  return { builtIn, mine, find, saveMine, deleteMine, exportText, importText };
}

const view = (r, own) => ({ id: r.id, title: r.title, what: r.what, tool: r.tool, toolLabel: TOOL_LABEL[r.tool], edits: r.edits, cost: r.cost, prompt: r.prompt, mine: own });

// IPC for the Tasks page's Recipes block. tasks(): the Tasks service (create, folderOf, composerInfo);
// confirm(lines, e) and the two file pickers are main's native dialogs.
function register({ ipcMain, allowed, recipes, tasks, confirm, pickSave, pickOpen, readFile, writeFile, home = '', demo = () => false }) {
  const on = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!allowed(e)) return null;
    try { return await fn(e, ...args); } catch { return { ok: false, error: 'Something went wrong. Nothing was changed.' }; }
  });
  const tilde = (p) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  on('recipes:list', async () => {
    let canSchedule = false;
    try { canSchedule = !!(await tasks().composerInfo())?.canSchedule; } catch { canSchedule = false; }
    return { ok: true, builtIn: recipes.builtIn().map((r) => view(r, false)), mine: recipes.mine().map((r) => view(r, true)), canSchedule, demo: demo() };
  });
  on('recipes:run', async (e, id, folder, when) => {
    if (demo()) return { ok: false, error: 'This is the demo: nothing runs. Exit the demo to run a recipe.' };
    const r = recipes.find(id);
    if (!r) return { ok: false, error: 'That recipe is no longer available.' };
    const dir = typeof folder === 'string' ? tasks().folderOf(folder) : null;
    if (!dir) return { ok: false, error: 'Choose the folder it should work in first.' };
    if (r.edits && !inRepo(dir)) return { ok: false, error: 'This recipe changes files, so it runs in its own git worktree. Choose a folder inside a git repository.' };
    const tonight = when === 'tonight';
    const yes = await confirm({
      title: r.title,
      action: tonight ? 'Run tonight' : 'Run now',
      detail: [
        `Runs in: ${tilde(dir)}`,
        r.what,
        r.edits ? 'It can change files, only in its own git worktree on a new branch. Your checkout is untouched until you merge.' : 'It only reads: plan mode, no file changes.',
        `AI: ${TOOL_LABEL[r.tool]}`,
        tonight ? 'Starts between 10 pm and 7 am while this Mac is awake.' : 'Starts now in the background.',
        `Cost: ${r.cost}`,
      ].join('\n'),
    }, e);
    if (!yes) return { ok: false, cancelled: true, error: 'Cancelled. Nothing was started.' };
    const made = await tasks().create(draftFor(r, folder, tonight ? 'tonight' : 'now'));
    return made && made.code === 'BUDGET_HELD' ? { ...made, error: `${made.text} Start it from Tasks to override.` } : made;
  });
  on('recipes:save-mine', async (_e, id) => recipes.saveMine(id));
  on('recipes:delete-mine', async (e, id) => {
    const r = recipes.mine().find((x) => x.id === id);
    if (!r) return { ok: false, error: 'That recipe is not one of yours.' };
    if (!(await confirm({ title: r.title, action: 'Delete', detail: 'Deletes your copy of this recipe. Tasks it already started are kept.' }, e))) return { ok: false, cancelled: true, error: 'Cancelled.' };
    return recipes.deleteMine(id);
  });
  on('recipes:export', async (e) => {
    if (demo()) return { ok: false, error: 'This is the demo: exit it to share your own recipes.' };
    const out = recipes.exportText();
    if (!out.ok) return out;
    const file = await pickSave(e);
    if (!file) return { ok: false, cancelled: true, error: 'Cancelled.' };
    try { writeFile(file, out.text); } catch { return { ok: false, error: 'Choose a new file name. Existing files and links are never overwritten.' }; }
    return { ok: true, count: out.count };
  });
  on('recipes:import', async (e) => {
    if (demo()) return { ok: false, error: 'This is the demo: exit it to import recipes.' };
    const file = await pickOpen(e);
    if (!file) return { ok: false, cancelled: true, error: 'Cancelled.' };
    const text = readFile(file);
    return text == null ? { ok: false, error: 'Choose a regular recipe file under 2 MB.' } : recipes.importText(text);
  });
}

module.exports = { create, register, problems, valid, draftFor, inRepo, commandText, fromCommand, readDir, KEYS, TOOLS, LIMITS, SHARE_DIR };
