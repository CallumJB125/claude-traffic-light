'use strict';
// Find agents IPC (agents-find.html). Every channel is gated to the Find
// agents page's own main frame. The page sends only an agent id, the
// catalogue sha it was shown, platform ids and an undo id. Main works out
// every path itself, and nothing it returns carries an absolute path, file
// text, the ledger key or exception text.
// The design and its security review: .omc/plans/plan-find-agents.md §9 PR 3.
const fs = require('node:fs');
const path = require('node:path');
const { summary } = require('./agent-catalog.js');
const { worksWith } = require('./agent-install.js');

const CHANNELS = Object.freeze([
  'agents:list', 'agents:detail', 'agents:targets', 'agents:add', 'agents:undo', 'agents:status', 'agents:add-to-project', 'agents:undo-project', 'agents:open-tools', 'discover:open-find-agents',
  // PR 4: manage what's added (plan §9 PR 4 design and its security review).
  'agents:mine', 'agents:adoptable', 'agents:adopt', 'agents:stop-managing', 'agents:update', 'agents:remove', 'agents:undo-op', 'agents:undo-project-op', 'agents:show-backup', 'agents:backup-plan',
]);
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BACKUP_ID = /^claude-agents-\d{8}T\d{9}Z-[0-9a-f]{8}$/;
const MAX_ADOPT_NAMES = 400;
const UNDO_OP_KINDS = new Set(['add', 'adopt', 'update', 'remove', 'release']);
// After a Cancel, further confirms are refused for a while, so a page can't
// stack dialogs until one is clicked through (review PR 4 change 7).
const COOLDOWN_MS = 10_000;
const COOLDOWN = 'You just cancelled. Wait a few seconds before trying again.';
const KIND_WORDS = { add: 'Add', adopt: 'Adopt', update: 'Update', remove: 'Remove from all', release: 'Stop managing', 'add-project': 'Add to a project' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_ALLOWED = Object.freeze({ ok: false, code: 'not-allowed' });
const FAILED = 'Find agents hit a problem, so nothing more was changed. Try again, or check Health.';
const NO_KEY = 'Plexiform can\'t keep a safe record of the agents it adds on this computer (the system keychain isn\'t available), so adding is off. You can still browse and read every agent.';
const DEMO = 'Adding agents is off in the demo.';
const BUSY = 'Plexiform is still finishing the last change.';
const pickable = (p) => p.choice === 'default' || p.choice === 'offered';
const isId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200;

/**
 * deps: { ipcMain, allowed(e), discoverAllowed(e), pageContents(), catalog(),
 *   keyStore (a createLedgerKeyStore function with .peek/.cached/.available),
 *   installer(key), planner(), tools(), demo: { active() }, pickFolder(sender),
 *   home, dataRoot, openTools(), openFindAgents(), log, fsApi,
 *   targets (defaults to the shipped install targets),
 *   confirm(sender, { message, detail, ok }) → Promise<boolean>: a native
 *     dialog whose default and cancel button are Cancel,
 *   showItem(absPath): reveal a folder in Finder, clock }
 */
function register(deps) {
  const { ipcMain, allowed, discoverAllowed, pageContents, catalog, keyStore, installer, planner, tools, demo, pickFolder, home, dataRoot, openTools, openFindAgents, log = () => {}, fsApi = fs, targets, confirm = async () => false, showItem = () => {}, clock = Date.now } = deps;
  // Undo is offered only for clicks made in this run; opId → { kind, root }.
  const issued = new Map();
  let busy = false;

  function handle(ch, gate, fn) {
    ipcMain.handle(ch, async (e, ...args) => {
      if (!gate(e)) return NOT_ALLOWED;
      try { return await fn(e, ...args); } catch (err) {
        // The code only: a message or stack can carry an absolute path.
        log(`[agents-find] ${ch} failed (${typeof err?.code === 'string' ? err.code.slice(0, 32) : 'error'})`);
        return { ok: false, code: 'failed', error: FAILED };
      }
    });
  }
  const page = (ch, fn) => handle(ch, allowed, fn);

  let pendingShow = null;
  const takeShow = () => { const v = pendingShow; pendingShow = null; return v; };
  // "Works with" per agent, worked out once per catalogue: 713 × 5 pure renders.
  let works = null;
  function worksFor(c) {
    if (works?.sha !== c.sha256) works = { sha: c.sha256, byId: new Map(c.catalog.agents.map((a) => [a.id, worksWith(a, targets)])) };
    return works.byId;
  }

  function cat() {
    const c = catalog();
    if (!c || !c.ok) throw Object.assign(new Error('catalogue'), { code: 'catalogue', userError: c?.error });
    return c;
  }
  function withCatalog(fn) {
    return (...a) => {
      let c;
      try { c = cat(); } catch (err) { if (err.code === 'catalogue') return { ok: false, code: 'catalogue', error: err.userError || 'The agent catalogue is damaged. Reinstall Plexiform.' }; throw err; }
      return fn(c, ...a);
    };
  }

  // Never creates the key and never prompts: no key file means "nothing added yet".
  function peekKey() { try { return keyStore.peek(); } catch { return null; } }
  function writesState() {
    if (demo.active()) return { ok: false, code: 'demo', reason: DEMO };
    let can = false;
    try { can = keyStore.available(); } catch { can = false; }
    return can ? { ok: true } : { ok: false, code: 'no-key', reason: NO_KEY };
  }
  // Only a write makes the key.
  function writeKey() {
    if (demo.active()) return { refusal: { ok: false, code: 'demo', error: DEMO } };
    try { return { key: keyStore() }; } catch { return { refusal: { ok: false, code: 'no-key', error: NO_KEY } }; }
  }
  async function locked(fn) {
    if (busy) return { ok: false, code: 'busy', error: BUSY };
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }

  const tildeOf = (abs) => (abs === home ? '~' : abs.startsWith(home + path.sep) ? `~/${path.relative(home, abs).split(path.sep).join('/')}` : null);
  // A project path for display: ~/… under home, otherwise the folder's name.
  const displayRoot = (root) => tildeOf(root) ?? path.basename(root);
  const displayIn = (root, abs) => (typeof abs === 'string' && abs.startsWith(root + path.sep) ? `${displayRoot(root)}/${path.relative(root, abs).split(path.sep).join('/')}` : displayRoot(root));

  function platformRows(c) {
    return (planner ? planner() : null)?.platformsFor(tools()) ?? [];
  }

  // ── reads ────────────────────────────────────────────────────────────────
  page('agents:list', withCatalog((c) => ({
    ok: true,
    demo: !!demo.active(),
    catalogSha: c.sha256,
    count: c.catalog.agents.length,
    categories: c.catalog.categories,
    builtFrom: c.catalog.sources.map((s) => ({ source: s.id, name: s.name, license: s.license, copyright: s.copyright, url: s.url, sha: s.sha })),
    writes: writesState(),
    // Health's "Review on Find agents" opens the page on Added by me, once.
    show: takeShow(),
    agents: c.catalog.agents.map((a) => ({ ...summary(a), works: worksFor(c).get(a.id) })),
    // The "Works with" choices: user-scope tools found on this computer.
    tools: platformRows(c).filter(pickable).map((p) => ({ platform: p.platform, label: p.label })),
  })));

  page('agents:detail', withCatalog((c, _e, agentId) => {
    const a = isId(agentId) ? c.get(agentId) : null;
    if (!a) return { ok: false, code: 'unavailable', error: 'This agent is not in the catalogue.' };
    const src = c.catalog.sources.find((s) => s.id === a.source);
    return {
      ok: true,
      agent: { ...summary(a), model: typeof a.model === 'string' ? a.model : null },
      body: c.body(a),
      flags: a.risk.flags.map((f) => ({ rule: f.rule, level: f.level, line: f.line, excerpt: f.excerpt, why: f.why })),
      upstream: src ? `${src.url}/blob/${a.sourceSha}/${a.sourcePath}` : null,
      sourcePath: a.sourcePath, sourceSha: a.sourceSha, attribution: a.attribution,
      alsoIn: (a.aliases || []).map((id) => c.get(id)?.source).filter(Boolean),
    };
  }));

  page('agents:targets', withCatalog((c, _e, agentId) => {
    const a = isId(agentId) ? c.get(agentId) : null;
    if (!a) return { ok: false, code: 'unavailable', error: 'This agent is not in the catalogue.' };
    const rows = platformRows(c);
    const key = peekKey();
    const inst = key ? installer(key) : planner();
    const want = rows.filter(pickable).map((p) => p.platform);
    const plan = want.length ? inst.preview(a.id, want) : { ok: true, results: [] };
    const byPlatform = new Map((plan.ok ? plan.results : []).map((r) => [r.platform, r]));
    const s = summary(a);
    return {
      ok: true,
      catalogSha: c.sha256,
      everyTool: s.everyTool, toolsSummary: s.toolsSummary, flagCount: s.flagCount,
      platforms: rows.map((p) => {
        const r = byPlatform.get(p.platform);
        return {
          platform: p.platform, label: p.label, choice: p.choice,
          status: r?.status ?? null, path: r?.path ?? null, reason: r?.reason ?? p.reason ?? null,
          canAlt: r?.canAlt === true, altName: r?.canAlt ? `${a.slug}-plexiform` : null,
          projectEnabled: p.choice === 'project-only',
        };
      }),
    };
  }));

  page('agents:status', withCatalog(() => {
    const key = peekKey();
    const empty = { ok: true, demo: !!demo.active(), agents: [], ops: [] };
    if (!key) return empty;
    const s = installer(key).status();
    if (!s.ok) return { ...empty, ok: false, code: 'ledger', error: s.error };
    const by = new Map();
    for (const it of s.items) {
      if (it.state === 'missing' || it.state === 'broken') continue;
      if (!by.has(it.agentId)) by.set(it.agentId, []);
      by.get(it.agentId).push({ platform: it.platform, state: it.state });
    }
    return { ...empty, agents: [...by].map(([agentId, platforms]) => ({ agentId, platforms })), ops: s.ops.filter((o) => issued.has(o.id)).map((o) => ({ opId: o.id, kind: o.kind, agentId: o.agentId, at: o.at })) };
  }));

  page('agents:open-tools', () => { openTools(); return { ok: true }; });
  handle('discover:open-find-agents', discoverAllowed, () => { openFindAgents(); return { ok: true }; });

  // ── writes ───────────────────────────────────────────────────────────────
  function platformsArg(list) {
    if (!Array.isArray(list) || list.length < 1 || list.length > 16) return null;
    const out = [], seen = new Set();
    for (const x of list) {
      let id, alt = false;
      if (typeof x === 'string') id = x;
      else if (x && typeof x === 'object' && !Array.isArray(x)) {
        const keys = Object.keys(x).sort().join(',');
        if (keys !== 'alt,platform' && keys !== 'platform') return null;
        if ('alt' in x && typeof x.alt !== 'boolean') return null;
        id = x.platform; alt = x.alt === true;
      } else return null;
      if (typeof id !== 'string' || !id || id.length > 40 || seen.has(id)) return null;
      seen.add(id);
      out.push(alt ? { platform: id, alt: true } : id);
    }
    return out;
  }

  page('agents:add', withCatalog((c, _e, agentId, catalogSha, platforms) => locked(() => {
    const a = isId(agentId) ? c.get(agentId) : null;
    if (!a) return { ok: false, code: 'unavailable', error: 'This agent is not in the catalogue.' };
    if (catalogSha !== c.sha256) return { ok: false, code: 'changed', error: 'The catalogue changed. Reopen Find agents and try again.' };
    const list = platformsArg(platforms);
    if (!list) return { ok: false, code: 'invalid', error: 'Choose the AI tools to add it to.' };
    // Re-derived now, not trusted from the page: only tools + offers.
    const offered = new Set(platformRows(c).filter(pickable).map((p) => p.platform));
    if (!list.every((p) => offered.has(typeof p === 'string' ? p : p.platform))) return { ok: false, code: 'invalid', error: 'One of those AI tools can\'t take agents from here.' };
    const { key, refusal } = writeKey();
    if (refusal) return refusal;
    const r = installer(key).add(a.id, list, { catalogSha });
    if (r.installId) issued.set(r.installId, { kind: 'add' });
    return {
      ok: r.ok, code: r.ok ? undefined : r.status, error: r.ok ? undefined : r.error,
      opId: r.installId ?? null,
      results: (r.results || []).map((x) => ({ platform: x.platform, label: x.label, status: x.outcome, path: x.path ?? null, reason: x.reason ?? null })),
    };
  })));

  page('agents:undo', withCatalog((_c, _e, opId) => locked(() => {
    if (typeof opId !== 'string' || !UUID.test(opId) || issued.get(opId)?.kind !== 'add') return { ok: false, code: 'unavailable', error: 'Nothing to undo for this click.' };
    const { key, refusal } = writeKey();
    if (refusal) return refusal;
    const inst = installer(key);
    if (!inst.status().ops?.some((o) => o.id === opId && o.kind === 'add')) return { ok: false, code: 'unavailable', error: 'Nothing to undo for this click.' };
    const r = inst.undo(opId);
    if (r.ok) issued.delete(opId);
    return r.ok ? { ok: true, restored: r.restored, conflicts: r.conflicts } : { ok: false, code: r.status, error: r.error };
  })));

  // The folder comes only from a picker main opens for this click. Checked in
  // one synchronous stretch, straight into addToProject (which re-checks).
  function projectFolder(paths) {
    if (!Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== 'string') return null;
    const p = paths[0];
    if (!path.isAbsolute(p) || path.resolve(p) !== p) return null;
    let st, parent;
    try { st = fsApi.lstatSync(p); parent = fsApi.lstatSync(path.dirname(p)); } catch { return null; }
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    let real; try { real = fsApi.realpathSync(p); } catch { return null; }
    if (real !== p) return null;
    if (p === home || home.startsWith(p + path.sep) || p === path.parse(p).root) return null;
    if (st.dev !== parent.dev) return null;
    if (p === dataRoot || p.startsWith(dataRoot + path.sep)) return null;
    return p;
  }

  page('agents:add-to-project', withCatalog((c, e, agentId, catalogSha) => locked(async () => {
    const a = isId(agentId) ? c.get(agentId) : null;
    if (!a) return { ok: false, code: 'unavailable', error: 'This agent is not in the catalogue.' };
    if (catalogSha !== c.sha256) return { ok: false, code: 'changed', error: 'The catalogue changed. Reopen Find agents and try again.' };
    const first = writeKey();
    if (first.refusal) return first.refusal;
    const sender = e.sender;
    const picked = await pickFolder(sender);
    // The world may have moved while the picker was open.
    if (sender.isDestroyed?.() || pageContents() !== sender) return { ok: false, code: 'cancelled' };
    if (!picked || picked.canceled) return { ok: false, code: 'cancelled' };
    const again = writeKey();
    if (again.refusal) return again.refusal;
    if (catalog()?.sha256 !== catalogSha) return { ok: false, code: 'changed', error: 'The catalogue changed. Reopen Find agents and try again.' };
    const root = projectFolder(picked.filePaths);
    if (!root) return { ok: false, code: 'invalid', error: 'Choose a project folder: not a link, not your home folder or one above it, not a whole disk.' };
    const r = installer(again.key).addToProject(a.id, root, { catalogSha });
    if (!r.ok) return { ok: false, code: r.status, error: r.error };
    if (r.opId) issued.set(r.opId, { kind: 'add-project', root });
    const x = r.results[0];
    return { ok: true, opId: r.opId, status: x.outcome, path: displayIn(root, x.path), reason: x.reason ?? null };
  })));

  page('agents:undo-project', withCatalog((_c, _e, opId) => locked(() => {
    const rec = typeof opId === 'string' && UUID.test(opId) ? issued.get(opId) : null;
    if (rec?.kind !== 'add-project') return { ok: false, code: 'unavailable', error: 'Nothing to undo for this click.' };
    const { key, refusal } = writeKey();
    if (refusal) return refusal;
    const r = installer(key).undoProject(opId);
    if (r.ok) issued.delete(opId);
    return r.ok
      ? { ok: true, restored: r.restored.map((p) => displayIn(rec.root, p)), conflicts: r.conflicts.map((x) => ({ path: displayIn(rec.root, x.path), reason: x.reason })) }
      : { ok: false, code: r.status, error: r.error };
  })));

  // ── PR 4: manage what's added ─────────────────────────────────────────────
  let coolUntil = 0;
  // A native confirm built here from main's own counts. The lock is held
  // across it; afterwards the same things are checked again as after the
  // folder picker (PR 3 change 5), and the caller re-runs its preconditions.
  async function confirmed(e, shaBefore, text) {
    if (clock() < coolUntil) return { refusal: { ok: false, code: 'cooldown', error: COOLDOWN } };
    // Off (demo, no keychain) is said before any dialog; the key is made only after a yes.
    const off = writesState();
    if (!off.ok) return { refusal: { ok: false, code: off.code, error: off.reason } };
    const sender = e.sender;
    let yes = false;
    try { yes = (await confirm(sender, text)) === true; } catch { yes = false; }
    if (sender.isDestroyed?.() || pageContents() !== sender) return { refusal: { ok: false, code: 'cancelled' } };
    if (!yes) { coolUntil = clock() + COOLDOWN_MS; return { refusal: { ok: false, code: 'cancelled' } }; }
    const again = writeKey();
    if (again.refusal) return again;
    if (catalog()?.sha256 !== shaBefore) return { refusal: { ok: false, code: 'changed', error: 'The catalogue changed. Reopen Find agents and try again.' } };
    return { key: again.key };
  }
  const reader = () => { const k = peekKey(); return k ? installer(k) : planner(); };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const fail = (r) => ({ ok: false, code: r.status, error: r.error });
  const nameOf = (c, id) => c.get(id)?.name ?? 'An agent';
  const sample = (paths) => (paths.length > 6 ? [...paths.slice(0, 6), `…and ${paths.length - 6} more`] : paths).join('\n');

  page('agents:mine', withCatalog((c) => {
    const key = peekKey();
    const empty = { ok: true, demo: !!demo.active(), agents: [], ops: [], backups: [] };
    if (!key) return empty;
    const inst = installer(key);
    const s = inst.status();
    if (!s.ok) return { ...empty, ok: false, code: 'ledger', error: s.error };
    const by = new Map();
    for (const it of s.items) {
      if (!by.has(it.agentId)) by.set(it.agentId, { agentId: it.agentId, name: nameOf(c, it.agentId), inCatalogue: !!c.get(it.agentId), platforms: [] });
      by.get(it.agentId).platforms.push({ platform: it.platform, state: it.state, how: it.how, path: it.path });
    }
    return {
      ...empty,
      agents: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)),
      ops: s.ops.slice(-50).reverse().map((o) => ({ opId: o.id, kind: o.kind, agentId: o.agentId, name: o.agentId ? nameOf(c, o.agentId) : null, at: o.at, files: o.files, thisRun: issued.has(o.id) })),
      backups: inst.backups().slice(-5).reverse().map((b) => ({ id: b.id, at: b.at, files: b.files, restore: inst.restoreCommand(b.id) })),
    };
  }));

  page('agents:adoptable', withCatalog((c) => {
    const r = reader().adoptable();
    return {
      ok: true, demo: !!demo.active(), userOwned: r.userOwned, reason: r.reason ?? null,
      matches: r.matches.map((m) => ({ name: path.basename(m.rel), path: m.path, agentId: m.agentId, agentName: nameOf(c, m.agentId) })),
    };
  }));

  page('agents:adopt', withCatalog((c, e, names) => locked(async () => {
    if (!Array.isArray(names) || names.length < 1 || names.length > MAX_ADOPT_NAMES || !names.every((n) => typeof n === 'string' && FILE_NAME.test(n) && n.endsWith('.md') && !n.includes('..'))) return { ok: false, code: 'invalid', error: 'Choose the agents to adopt.' };
    const want = new Set(names);
    const listed = reader().adoptable().matches.filter((m) => want.has(path.basename(m.rel)));
    if (!listed.length) return { ok: false, code: 'unavailable', error: 'None of those match the catalogue exactly any more.' };
    const ok = await confirmed(e, c.sha256, {
      message: `Let Plexiform manage ${plural(listed.length, 'agent')} in ~/.claude/agents?`,
      detail: `${plural(listed.length, 'file')} match the catalogue exactly. Plexiform first backs up the whole ~/.claude/agents folder, and changes no file now. Later it can update them, and Undo puts them back.\n\n${sample(listed.map((m) => m.path))}`,
      ok: `Adopt ${plural(listed.length, 'agent')}`,
    });
    if (ok.refusal) return ok.refusal;
    // adopt() re-lists, re-hashes and backs up: what happened is what's reported.
    const inst = installer(ok.key);
    const r = inst.adopt(listed.map((m) => m.rel));
    if (!r.ok) return fail(r);
    if (r.opId) issued.set(r.opId, { kind: 'adopt' });
    return { ok: true, opId: r.opId, adopted: r.adopted.length, paths: r.adopted, skipped: listed.length - r.adopted.length, backup: r.backup, restore: r.backup ? inst.restoreCommand(r.backup) : null };
  })));

  page('agents:stop-managing', withCatalog((c, e) => locked(async () => {
    const key = peekKey();
    const adopted = key ? (installer(key).status().items || []).filter((i) => i.how === 'adopted') : [];
    if (!adopted.length) return { ok: false, code: 'unavailable', error: 'Plexiform isn\'t managing any agents you installed yourself.' };
    const ok = await confirmed(e, c.sha256, {
      message: `Stop managing ${plural(adopted.length, 'agent')} you installed yourself?`,
      detail: 'The files stay exactly as they are. Plexiform just stops updating them.',
      ok: 'Stop managing',
    });
    if (ok.refusal) return ok.refusal;
    const r = installer(ok.key).stopManaging();
    if (r.opId) issued.set(r.opId, { kind: 'release' });
    return { ok: true, opId: r.opId, released: r.released.length };
  })));

  page('agents:update', withCatalog((c, _e, agentId, catalogSha) => locked(() => {
    const a = isId(agentId) ? c.get(agentId) : null;
    if (!a) return { ok: false, code: 'unavailable', error: 'This agent is not in the catalogue.' };
    if (catalogSha !== c.sha256) return { ok: false, code: 'changed', error: 'The catalogue changed. Reopen Find agents and try again.' };
    const { key, refusal } = writeKey();
    if (refusal) return refusal;
    const r = installer(key).update(a.id);
    if (!r.ok) return fail(r);
    if (r.opId) issued.set(r.opId, { kind: 'update' });
    return { ok: true, opId: r.opId, results: r.results.map((x) => ({ platform: x.platform, status: x.outcome, path: x.path ?? null, reason: x.reason ?? null })) };
  })));

  page('agents:remove', withCatalog((c, e, agentId) => locked(async () => {
    if (!isId(agentId)) return { ok: false, code: 'unavailable', error: 'Nothing to remove.' };
    const key = peekKey();
    const mine = key ? (installer(key).status().items || []).filter((i) => i.agentId === agentId) : [];
    if (!mine.length) return { ok: false, code: 'unavailable', error: 'Nothing to remove.' };
    const added = mine.filter((i) => i.how === 'added').length, adopted = mine.length - added;
    const ok = await confirmed(e, c.sha256, {
      message: `Remove ${nameOf(c, agentId)} from all your AI tools?`,
      detail: [added ? `${plural(added, 'file')} Plexiform added will be deleted, unless you changed them.` : null, adopted ? `${plural(adopted, 'file')} you installed yourself will be kept; Plexiform just stops managing them.` : null, 'Undo puts them back.'].filter(Boolean).join(' '),
      ok: 'Remove from all',
    });
    if (ok.refusal) return ok.refusal;
    const r = installer(ok.key).remove(agentId);
    if (!r.ok) return fail(r);
    if (r.opId) issued.set(r.opId, { kind: 'remove' });
    return { ok: true, opId: r.opId, results: r.results.map((x) => ({ platform: x.platform, status: x.outcome, path: x.path ?? null, reason: x.reason ?? null })) };
  })));

  // Any click the signed ledger lists (this run or earlier), after a native
  // confirm built from that record. Re-read after the confirm.
  function listedOp(opId, kinds) {
    const key = peekKey();
    if (!key || typeof opId !== 'string' || !UUID.test(opId)) return null;
    const op = (installer(key).status().ops || []).find((o) => o.id === opId);
    return op && kinds.has(op.kind) ? op : null;
  }
  function opText(c, op) {
    const when = typeof op.at === 'string' ? op.at.slice(0, 16).replace('T', ' ') : 'earlier';
    return {
      message: `Undo "${KIND_WORDS[op.kind]}"${op.agentId ? ` for ${nameOf(c, op.agentId)}` : ''}?`,
      detail: `From ${when} UTC, ${plural(op.files, 'file')}. Files changed since are left as they are.`,
      ok: 'Undo',
    };
  }
  page('agents:undo-op', withCatalog((c, e, opId) => locked(async () => {
    const op = listedOp(opId, UNDO_OP_KINDS);
    if (!op) return { ok: false, code: 'unavailable', error: 'Nothing to undo for this click.' };
    const ok = await confirmed(e, c.sha256, opText(c, op));
    if (ok.refusal) return ok.refusal;
    if (!listedOp(opId, UNDO_OP_KINDS)) return { ok: false, code: 'unavailable', error: 'Nothing to undo for this click.' };
    const r = installer(ok.key).undo(opId);
    if (r.ok) issued.delete(opId);
    return r.ok ? { ok: true, restored: r.restored, conflicts: r.conflicts } : fail(r);
  })));
  page('agents:undo-project-op', withCatalog((c, e, opId) => locked(async () => {
    const kinds = new Set(['add-project']);
    const op = listedOp(opId, kinds);
    if (!op) return { ok: false, code: 'unavailable', error: 'Nothing to undo for this click.' };
    const ok = await confirmed(e, c.sha256, opText(c, op));
    if (ok.refusal) return ok.refusal;
    if (!listedOp(opId, kinds)) return { ok: false, code: 'unavailable', error: 'Nothing to undo for this click.' };
    const r = installer(ok.key).undoProject(opId);
    if (r.ok) issued.delete(opId);
    // .../<project>/.cursor/rules/<x>.mdc: shown relative to the project.
    const shown = (p) => displayIn(path.resolve(p, '..', '..', '..'), p);
    return r.ok ? { ok: true, restored: r.restored.map(shown), conflicts: r.conflicts.map((x) => ({ path: shown(x.path), reason: x.reason })) } : fail(r);
  })));

  function backupArg(id) {
    if (typeof id !== 'string' || !BACKUP_ID.test(id)) return null;
    const inst = reader();
    if (!inst.backups().some((b) => b.id === id)) return null;
    return inst.backupPath(id);
  }
  page('agents:show-backup', (_e, id) => {
    const dir = backupArg(id);
    if (!dir) return { ok: false, code: 'unavailable', error: 'That backup is gone.' };
    showItem(dir);
    return { ok: true };
  });
  page('agents:backup-plan', (_e, id) => {
    if (!backupArg(id)) return { ok: false, code: 'unavailable', error: 'That backup is gone.' };
    const r = reader().restoreBackupPlan(id);
    return r.ok ? { ok: true, items: r.items } : fail(r);
  });

  return { channels: CHANNELS, issued, showMine: () => { pendingShow = 'mine'; } };
}

/**
 * Dev-only home and data folders for Find agents (tests, never the real
 * ~/.claude or the real key). A packaged build ignores both. Each must be an
 * absolute path to an existing folder that is not a link.
 */
function devOverrides({ isPackaged, env, fsApi = fs, log = () => {} }) {
  if (isPackaged) return {};
  const out = {};
  for (const [k, name] of [['home', 'PLEXIFORM_AGENTS_HOME'], ['data', 'PLEXIFORM_AGENTS_DATA']]) {
    const v = env[name];
    if (!v) continue;
    let ok = false;
    try { const st = fsApi.lstatSync(v); ok = path.isAbsolute(v) && !st.isSymbolicLink() && st.isDirectory(); } catch { ok = false; }
    if (ok) out[k] = v; else log(`[agents-find] ignoring ${name}: not an absolute folder`);
  }
  return out;
}

module.exports = { register, devOverrides, CHANNELS };
