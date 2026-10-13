'use strict';

// IPC for Home's "Start with a pack" card (home-starter.js, src/starter-pack.js).
// Main works out the stack from recent folders and answers only the Home
// page. The gallery list is fetched only on the person's click ("Look it
// up"), the pack is added after one native confirm that lists every member,
// and the first recipe runs only after a second click. The page sends an
// action word, never a path, an id or a prompt.

const Starter = require('./starter-pack.js');
const Recipes = require('./recipes.js');

const ACTIONS = new Set(['look', 'add', 'run', 'dismiss']);
const ADDABLE_HERE = new Set(['recipe', 'character']);
const KIND = { recipe: 'recipe', character: 'character', rules: 'widget rules', setup: 'setup' };

// gallery: src/gallery.js (entries(), fetchIndex(), cached()); recipes: src/recipes.js create();
// characters: src/character-store.js; tasks(): the Tasks service; confirm(info, e) → bool.
function create({ store, gallery, recipes, characters, tasks, confirm, turns = async () => [], sessions = () => [], tools = () => [], demo = () => false, fsApi, now = Date.now }) {
  let lastAdd = null; // {recipe entry, cwd} after a pack add, so Run needs no re-read

  const installed = () => {
    try { if (recipes.mine().some((r) => recipes.originOf(r.id))) return true; } catch { /* unreadable: not installed */ }
    try { if (characters.list().some((c) => c?.meta?.source === 'gallery')) return true; } catch { /* same */ }
    return false;
  };
  const connected = () => { try { return (tools() || []).some((t) => t && t.connected); } catch { return false; } };
  async function detected() {
    let all = [];
    try { all = await turns(); } catch { all = []; }
    let live = [];
    try { live = sessions(); } catch { live = []; }
    return Starter.detect(Starter.recentFolders({ turns: all, sessions: live }), fsApi);
  }

  async function view(entries) {
    if (demo()) return null;
    const s = store.get();
    const sug = Starter.suggestion({ detected: await detected(), entries, dismissed: s.dismissed, installed: !!s.added || installed(), connected: connected() });
    return sug;
  }

  async function add(ev) {
    const entries = gallery.entries() || [];
    const sug = await view(entries);
    if (!sug || sug.stage !== 'add') return { ok: false, error: 'That pack is no longer offered. Refresh Home.' };
    const byId = new Map(entries.map((e) => [e.id, e]));
    const pack = byId.get(sug.pack.id);
    if (!pack || pack.sha256 !== sug.pack.sha256) return { ok: false, error: 'That pack changed. Look it up again.' };
    const members = (pack.payload.members || []).map((id) => byId.get(id)).filter(Boolean);
    const lines = members.map((m) => `• ${m.title} (${KIND[m.kind] || m.kind}${ADDABLE_HERE.has(m.kind) ? '' : ', skipped here: add it from the gallery'})`);
    const yes = await confirm({ title: pack.title, action: 'Add this pack', detail: [`From the community gallery by ${pack.author.name}${pack.author.github ? ` (@${pack.author.github})` : ''}, self-declared · ${pack.license}.`, `${members.length} item${members.length === 1 ? '' : 's'}:`, ...lines, '', 'Recipes only read: plan mode, no file changes. Characters are checked by the app’s sanitiser before they are saved.'].join('\n') }, ev);
    if (!yes) return { ok: false, cancelled: true, error: 'Cancelled. Nothing was added.' };
    const had = new Set();
    try { for (const r of recipes.mine()) { const o = recipes.originOf(r.id); if (o) had.add(o.gallery_id); } } catch { /* none known */ }
    let charIds = new Set();
    try { charIds = new Set(characters.list().map((c) => c.character.id)); } catch { /* none known */ }
    let added = 0, already = 0, skipped = 0;
    for (const m of members) {
      if (m.kind === 'recipe') {
        if (had.has(m.id)) { already += 1; continue; }
        const r = recipes.addFromGallery(m);
        if (r.ok) added += 1; else skipped += 1;
      } else if (m.kind === 'character') {
        if (charIds.has(m.payload.id)) { already += 1; continue; }
        try { characters.save({ ...m.payload, id: characters.freeId(m.payload.id) }, { source: 'gallery' }); added += 1; } catch { skipped += 1; }
      } else skipped += 1;
    }
    store.markAdded(pack.id);
    const recipe = members.find((m) => m.kind === 'recipe') || null;
    const repo = (await detected()).find((r) => r.folder === sug.folder) || null;
    lastAdd = recipe && repo ? { recipe, cwd: repo.cwd, expires: now() + 30 * 60_000 } : null;
    const parts = [`Added ${added}`];
    if (already) parts.push(`${already} already there`);
    if (skipped) parts.push(`${skipped} to add from the gallery`);
    return { ok: true, note: `${parts.join(', ')}.`, run: lastAdd ? { recipe: { title: recipe.title }, folder: repo.folder } : null };
  }

  async function run(ev) {
    if (!lastAdd || lastAdd.expires < now()) return { ok: false, error: 'Add the pack first, then run its first recipe.' };
    const { recipe, cwd } = lastAdd;
    const p = recipe.payload;
    const yes = await confirm({ title: recipe.title, action: 'Run it now', detail: [`It runs as a task in ${require('node:path').basename(cwd)} with ${Recipes.TOOLS.includes(p.tool) && p.tool !== 'auto' ? p.tool : 'the best available AI'}, in plan mode: it only reads and reports.`, p.cost ? `Cost: ${p.cost}` : ''].filter(Boolean).join('\n') }, ev);
    if (!yes) return { ok: false, cancelled: true, error: 'Cancelled. Nothing started.' };
    const svc = tasks();
    svc.start();
    const folder = svc.registerFolder(cwd);
    const r = await svc.create(Recipes.draftFor(p, folder.handle, 'now'), { wcId: ev?.sender?.id ?? 0 });
    lastAdd = null;
    return r && r.ok ? { ok: true, note: 'Started. It shows up in Tasks.' } : { ok: false, error: (r && r.text) || 'Tasks could not start it. Open Tasks to see why.' };
  }

  async function act(action, ev) {
    if (demo()) return { ok: false, error: 'This is the demo: exit it to add things from the gallery.' };
    if (action === 'dismiss') { store.dismiss(); return { ok: true }; }
    if (action === 'look') {
      const r = await gallery.fetchIndex();
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, suggestion: await view(gallery.entries()) };
    }
    if (action === 'add') return add(ev);
    if (action === 'run') return run(ev);
    return { ok: false, error: 'Unknown action.' };
  }

  return { view: () => view(gallery.entries()), act };
}

function register({ ipcMain, allowed, starter }) {
  const on = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!allowed(e)) return null;
    try { return await fn(e, ...args); } catch { return { ok: false, error: 'Something went wrong. Nothing was changed.' }; }
  });
  on('home:starter', () => starter.view());
  on('home:starter-act', (e, action) => (ACTIONS.has(action) ? starter.act(action, e) : { ok: false, error: 'Unknown action.' }));
}

module.exports = { create, register, ACTIONS };
