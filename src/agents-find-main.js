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

const CHANNELS = Object.freeze(['agents:list', 'agents:detail', 'agents:targets', 'agents:add', 'agents:undo', 'agents:status', 'agents:add-to-project', 'agents:undo-project', 'agents:open-tools', 'discover:open-find-agents']);
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
 *   home, dataRoot, openTools(), openFindAgents(), log, fsApi }
 */
function register(deps) {
  const { ipcMain, allowed, discoverAllowed, pageContents, catalog, keyStore, installer, planner, tools, demo, pickFolder, home, dataRoot, openTools, openFindAgents, log = () => {}, fsApi = fs } = deps;
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
    agents: c.catalog.agents.map(summary),
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

  return { channels: CHANNELS, issued };
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
