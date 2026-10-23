'use strict';
// Find agents: add a catalogue agent to each AI tool's own agents folder,
// with a hash ledger, per-click Undo, and adoption of agents the person
// already installed. Pure of Electron: main passes `home`, `dataRoot` and the
// verified catalogue (src/agent-catalog.js); tests pass a temp home and fakes.
//
// Rules (plan-find-agents.md §5 and Callum's decisions of 2026-10-23):
// - Only files Plexiform wrote, or adopted because their bytes match a
//   catalogue entry exactly, are ever changed or removed. The ledger is the
//   record of ownership; nothing is inferred from a file's content alone.
// - A file that already exists is never replaced on add: identical → "already
//   there" (not claimed), different → skipped, and the person may add a
//   separately named copy with a second click.
// - Writes go through src/home-files.js: regular files under the home folder
//   only, no links, never executable, new files linked into place so an
//   existing file is never overwritten by a race.
// - Adoption backs up ~/.claude/agents first; undoing an adoption restores the
//   original bytes and never deletes the file.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createHomeFiles } = require('./home-files.js');
const Runtime = require('../adapters/runtime.js');
const { TARGETS, UNSUPPORTED } = require('./agent-install/targets/index.js');

const LEDGER_FILE = 'agent-installs.json';
const ORIGINALS_DIR = 'agent-originals';
const BACKUPS_DIR = 'agent-backups';
const MAX_OPS = 500;
const MAX_ADOPT_SCAN = 2000;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const refuse = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const tilde = (rel) => `~/${rel}`;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function createAgentInstaller({ home, dataRoot, catalog, fsApi = fs, now = Date.now, targets = TARGETS, enableCursorProject = false, failAfterWrites = null } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw new Error('agent installs need an absolute home and data folder');
  if (!catalog?.ok) throw new Error('agent installs need a verified catalogue');
  const HOME = path.resolve(home), DATA = path.resolve(dataRoot);
  const files = createHomeFiles({ home: HOME, fsApi, maxBytes: 1024 * 1024 });
  const userTargets = targets.filter((t) => t.id !== 'cursor-project');
  const byId = new Map(userTargets.map((t) => [t.id, t]));
  const ledgerPath = path.join(DATA, LEDGER_FILE);
  let writesDone = 0; // tests: fail on the Nth write

  // ── ledger ──────────────────────────────────────────────────────────────
  function readLedger() {
    let text;
    try {
      const st = fsApi.lstatSync(ledgerPath);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('ledger is not a regular file');
      text = fsApi.readFileSync(ledgerPath, 'utf8');
    } catch (e) { if (e.code === 'ENOENT') return { schema: 1, owned: {}, ops: [] }; throw e; }
    const l = JSON.parse(text);
    if (!isObject(l) || l.schema !== 1 || !isObject(l.owned) || !Array.isArray(l.ops)) throw new Error('ledger is damaged');
    return l;
  }
  function writeLedger(l) {
    fsApi.mkdirSync(DATA, { recursive: true, mode: 0o700 });
    if (l.ops.length > MAX_OPS) l.ops = l.ops.slice(-MAX_OPS);
    Runtime.writeTextAtomic(ledgerPath, `${JSON.stringify(l, null, 2)}\n`, fsApi, undefined, { newMode: 0o600 });
    fsApi.chmodSync(ledgerPath, 0o600);
  }
  const keyOf = (platform, rel) => `${platform}:${rel}`;

  // Content-addressed copies of bytes Plexiform may need to put back (an
  // adopted original, the text before an update).
  function keepOriginal(text) {
    const dir = path.join(DATA, ORIGINALS_DIR);
    fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fsApi.lstatSync(dir).isSymbolicLink()) throw new Error('link');
    const h = sha(text), file = path.join(dir, h);
    try { fsApi.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (sha(fsApi.readFileSync(file, 'utf8')) !== h) throw new Error('kept copy does not match');
    return h;
  }
  function original(h) {
    const file = path.join(DATA, ORIGINALS_DIR, h);
    const st = fsApi.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('kept copy is not a regular file');
    const text = fsApi.readFileSync(file, 'utf8');
    if (sha(text) !== h) throw new Error('kept copy is damaged');
    return text;
  }

  function current(rel) {
    try { const r = files.readTarget(rel); return { ok: true, text: r.text, sha: r.text == null ? null : sha(r.text) }; } catch (e) { return { ok: false, reason: e.message === 'link' ? 'The folder or file is a link, so Plexiform leaves it alone.' : 'Not a regular file Plexiform can change safely.' }; }
  }
  function write(rel, text, opts) {
    if (failAfterWrites !== null && writesDone >= failAfterWrites) throw new Error('simulated write failure');
    files.writeTarget(rel, text, 0o644, opts);
    writesDone++;
    const back = current(rel);
    if (!back.ok || back.sha !== sha(text)) throw new Error('read-back did not match');
  }

  // ── platforms ───────────────────────────────────────────────────────────
  /**
   * Which platforms the + offers, from src/ai-tools.js toolRows(): connected
   * tools are ticked, installed-but-not-connected ones offered unticked,
   * Cursor is per project only, unsupported tools are listed with a reason.
   */
  function platformsFor(toolRows = []) {
    const rows = new Map(toolRows.map((r) => [r.id, r]));
    const out = [];
    for (const t of userTargets) {
      const r = rows.get(t.id);
      if (!r?.installed) continue;
      if (!t.verified) { out.push({ platform: t.id, label: t.label, choice: 'disabled', reason: t.reason }); continue; }
      out.push({ platform: t.id, label: t.label, choice: r.state === 'connected' ? 'default' : 'offered', reason: r.state === 'connected' ? null : 'Found but not connected to Plexiform.' });
    }
    if (rows.get('cursor')?.installed) out.push({ platform: 'cursor', label: 'Cursor', choice: 'project-only', reason: enableCursorProject ? 'Cursor rules live in a project. Use "Add to a project…".' : 'Cursor rules live in a project; "Add to a project…" is off.' });
    for (const [id, reason] of Object.entries(UNSUPPORTED)) if (rows.get(id)?.installed) out.push({ platform: id, label: rows.get(id).label || id, choice: 'unsupported', reason });
    return out;
  }

  // ── plan one platform for one agent ─────────────────────────────────────
  function planOne(agent, t, ledger, { alt = false } = {}) {
    const rendered = t.render(agent, { alt });
    if (!rendered.ok) return { platform: t.id, label: t.label, status: 'unmappable', reason: rendered.reason };
    const rel = `${t.dir}/${rendered.file}`;
    const base = { platform: t.id, label: t.label, path: tilde(rel), rel, text: rendered.text, notes: rendered.notes ?? [] };
    const cur = current(rel);
    if (!cur.ok) return { ...base, status: 'refused', reason: cur.reason };
    const owned = ledger.owned[keyOf(t.id, rel)];
    if (cur.text == null) return { ...base, status: owned ? 'missing' : 'new' };
    if (owned) {
      if (cur.sha !== owned.sha) return { ...base, status: 'modified', reason: `You changed ${tilde(rel)} after Plexiform added it, so Plexiform leaves it alone.` };
      return { ...base, status: owned.fileSha256 === agent.fileSha256 ? 'ours' : 'update', owned };
    }
    if (cur.sha === sha(rendered.text) || cur.sha === agent.fileSha256) return { ...base, status: 'already-there', reason: 'Already there (added outside Plexiform). Plexiform does not claim it.' };
    return { ...base, status: 'user-file', reason: `You have your own ${rendered.file} here; Plexiform left it alone.`, canAlt: !alt };
  }

  /** What + would do per platform, without writing anything. */
  function preview(agentId, platforms) {
    const agent = catalog.get(agentId);
    if (!agent) return refuse('unavailable', 'This agent is not in the catalogue.');
    const ledger = readLedger();
    const list = checkPlatforms(platforms);
    if (!list.ok) return list;
    return { ok: true, agentId, catalogSha: catalog.sha256, everyTool: agent.tools.declared === null, risk: agent.risk, results: list.items.map(({ t, alt }) => planOne(agent, t, ledger, { alt })) };
  }

  function checkPlatforms(platforms) {
    if (!Array.isArray(platforms) || !platforms.length || platforms.length > 16) return refuse('invalid', 'Choose at least one platform.');
    const items = [];
    for (const p of platforms) {
      const id = typeof p === 'string' ? p : p?.platform;
      const alt = typeof p === 'object' && p?.alt === true;
      if (id === 'cursor') return refuse('invalid', 'Cursor rules are added per project with "Add to a project…".');
      const t = byId.get(id);
      if (!t) return refuse('invalid', `${String(id).slice(0, 32)} does not support add-on agents.`);
      if (!t.verified) return refuse('disabled', `${t.label}: ${t.reason}`);
      if (items.some((x) => x.t === t)) return refuse('invalid', 'Each platform once.');
      items.push({ t, alt });
    }
    return { ok: true, items };
  }

  // ── add ─────────────────────────────────────────────────────────────────
  /** One click of +. Writes new files only; rolls back this click on any failure. */
  function add(agentId, platforms, { catalogSha } = {}) {
    if (catalogSha !== catalog.sha256) return refuse('changed', 'The catalogue changed. Reopen Find agents and try again.');
    const agent = catalog.get(agentId);
    if (!agent) return refuse('unavailable', 'This agent is not in the catalogue.');
    const list = checkPlatforms(platforms);
    if (!list.ok) return list;
    let ledger;
    try { ledger = readLedger(); } catch { return refuse('ledger', 'Plexiform\'s record of added agents can\'t be read, so nothing was changed.'); }
    const plans = list.items.map(({ t, alt }) => planOne(agent, t, ledger, { alt }));
    const done = [], results = [];
    for (const p of plans) {
      if (p.status !== 'new' && p.status !== 'missing') {
        results.push({ platform: p.platform, label: p.label, path: p.path ?? null, outcome: p.status === 'ours' ? 'already-added' : p.status === 'update' ? 'update-available' : p.status === 'already-there' ? 'already-there' : 'skipped', reason: p.reason ?? null });
        continue;
      }
      try {
        write(p.rel, p.text, { exclusive: true });
        done.push(p);
        results.push({ platform: p.platform, label: p.label, path: p.path, outcome: 'added', notes: p.notes });
      } catch {
        for (const d of done.reverse()) { const c = current(d.rel); if (c.ok && c.sha === sha(d.text)) try { files.removeTarget(d.rel); } catch { /* left; the result says so */ } }
        return refuse('failed', `Couldn't write to ${p.label}. Nothing from this click was kept.`, { results: plans.map((x) => ({ platform: x.platform, label: x.label, outcome: x === p ? 'failed' : done.includes(x) ? 'rolled-back' : 'not-tried' })) });
      }
    }
    if (!done.length) return { ok: true, installId: null, results };
    const op = { id: randomUUID(), kind: 'add', at: new Date(now()).toISOString(), agentId, catalogSha: catalog.sha256, changes: done.map((d) => ({ platform: d.platform, rel: d.rel, before: null, after: sha(d.text) })) };
    for (const d of done) ledger.owned[keyOf(d.platform, d.rel)] = { platform: d.platform, rel: d.rel, agentId, how: 'added', sha: sha(d.text), fileSha256: agent.fileSha256, since: op.at };
    ledger.ops.push(op);
    try { writeLedger(ledger); } catch {
      for (const d of done) { const c = current(d.rel); if (c.ok && c.sha === sha(d.text)) try { files.removeTarget(d.rel); } catch { /* left */ } }
      return refuse('ledger', 'Couldn\'t save Plexiform\'s record of added agents, so the new files were removed again.');
    }
    return { ok: true, installId: op.id, results };
  }

  // ── update an owned copy to the current catalogue version ─────────────────
  function update(agentId) {
    const agent = catalog.get(agentId);
    if (!agent) return refuse('unavailable', 'This agent is not in the catalogue.');
    const ledger = readLedger();
    const changes = [], results = [];
    for (const o of Object.values(ledger.owned).filter((x) => x.agentId === agentId)) {
      const t = byId.get(o.platform);
      const cur = current(o.rel);
      if (!t || !cur.ok || cur.sha !== o.sha) { results.push({ platform: o.platform, path: tilde(o.rel), outcome: 'skipped', reason: cur.ok && cur.text == null ? 'The file is gone.' : 'Changed outside Plexiform, so it is left alone.' }); continue; }
      if (o.fileSha256 === agent.fileSha256) { results.push({ platform: o.platform, path: tilde(o.rel), outcome: 'current' }); continue; }
      const r = t.render(agent, { alt: o.alt === true });
      if (!r.ok) { results.push({ platform: o.platform, path: tilde(o.rel), outcome: 'skipped', reason: r.reason }); continue; }
      const before = keepOriginal(cur.text);
      write(o.rel, r.text);
      changes.push({ platform: o.platform, rel: o.rel, before, after: sha(r.text), prevFileSha256: o.fileSha256 });
      Object.assign(o, { sha: sha(r.text), fileSha256: agent.fileSha256 });
      results.push({ platform: o.platform, path: tilde(o.rel), outcome: 'updated' });
    }
    if (!changes.length) return { ok: true, opId: null, results };
    const op = { id: randomUUID(), kind: 'update', at: new Date(now()).toISOString(), agentId, catalogSha: catalog.sha256, changes };
    ledger.ops.push(op);
    writeLedger(ledger);
    return { ok: true, opId: op.id, results };
  }

  // ── remove from all ─────────────────────────────────────────────────────
  /** Removes every unchanged copy Plexiform added; adopted files are only released. */
  function remove(agentId) {
    const ledger = readLedger();
    const changes = [], results = [];
    for (const [k, o] of Object.entries(ledger.owned).filter(([, x]) => x.agentId === agentId)) {
      const cur = current(o.rel);
      if (!cur.ok) { results.push({ platform: o.platform, path: tilde(o.rel), outcome: 'skipped', reason: cur.reason }); continue; }
      if (cur.text == null) { delete ledger.owned[k]; changes.push({ platform: o.platform, rel: o.rel, before: null, after: null, owned: o }); results.push({ platform: o.platform, path: tilde(o.rel), outcome: 'already-gone' }); continue; }
      if (cur.sha !== o.sha) { results.push({ platform: o.platform, path: tilde(o.rel), outcome: 'skipped', reason: 'Changed outside Plexiform, so it is left alone.' }); continue; }
      if (o.how === 'adopted') {
        delete ledger.owned[k];
        changes.push({ platform: o.platform, rel: o.rel, before: o.sha, after: o.sha, owned: o });
        results.push({ platform: o.platform, path: tilde(o.rel), outcome: 'released', reason: 'You installed this one yourself, so the file is kept; Plexiform just stops managing it.' });
        continue;
      }
      const before = keepOriginal(cur.text);
      files.removeTarget(o.rel);
      delete ledger.owned[k];
      changes.push({ platform: o.platform, rel: o.rel, before, after: null, owned: o });
      results.push({ platform: o.platform, path: tilde(o.rel), outcome: 'removed' });
    }
    if (!changes.length) return { ok: true, opId: null, results };
    const op = { id: randomUUID(), kind: 'remove', at: new Date(now()).toISOString(), agentId, changes };
    ledger.ops.push(op);
    writeLedger(ledger);
    return { ok: true, opId: op.id, results };
  }

  // ── adoption of agents already in ~/.claude/agents ───────────────────────
  const CLAUDE_DIR = '.claude/agents';
  /** Files in ~/.claude/agents whose bytes match a catalogue entry exactly. Reads only. */
  function adoptable() {
    const ledger = readLedger();
    const dir = path.join(HOME, CLAUDE_DIR);
    try { files.locate(`${CLAUDE_DIR}/x`); } catch { return { ok: true, matches: [], userOwned: 0, reason: 'The agents folder is a link or not a folder, so Plexiform leaves it alone.' }; }
    let names = [];
    try { names = fsApi.readdirSync(dir).filter((n) => n.endsWith('.md')).sort().slice(0, MAX_ADOPT_SCAN); } catch { return { ok: true, matches: [], userOwned: 0 }; }
    const byHash = new Map();
    for (const a of catalog.catalog.agents) if (!byHash.has(a.fileSha256) || a.primary) byHash.set(a.fileSha256, a);
    const matches = [];
    let userOwned = 0;
    for (const n of names) {
      const rel = `${CLAUDE_DIR}/${n}`;
      if (ledger.owned[keyOf('claude', rel)]) continue;
      const cur = current(rel);
      if (!cur.ok || cur.text == null) continue;
      const a = byHash.get(cur.sha);
      if (a) matches.push({ rel, path: tilde(rel), agentId: a.id, name: a.name, sha: cur.sha });
      else userOwned++;
    }
    return { ok: true, matches, userOwned };
  }

  // Copies ~/.claude/agents to a dated folder in the data folder, keeping links
  // as links, and checks every regular file's bytes in the copy.
  function backupClaudeAgents() {
    const src = path.join(HOME, CLAUDE_DIR);
    const root = path.join(DATA, BACKUPS_DIR);
    fsApi.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fsApi.lstatSync(root).isSymbolicLink()) throw new Error('link');
    const dest = path.join(root, `claude-agents-${stamp(now())}-${randomUUID().slice(0, 8)}`);
    fsApi.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true, dereference: false });
    const walk = (a, b) => {
      for (const e of fsApi.readdirSync(a, { withFileTypes: true })) {
        const pa = path.join(a, e.name), pb = path.join(b, e.name);
        const sa = fsApi.lstatSync(pa), sb = fsApi.lstatSync(pb);
        if (sa.isSymbolicLink()) { if (!sb.isSymbolicLink() || fsApi.readlinkSync(pa) !== fsApi.readlinkSync(pb)) throw new Error('backup mismatch'); }
        else if (sa.isDirectory()) walk(pa, pb);
        else if (sa.isFile() && sha(fsApi.readFileSync(pa)) !== sha(fsApi.readFileSync(pb))) throw new Error('backup mismatch');
      }
    };
    walk(src, dest);
    fsApi.chmodSync(dest, 0o700);
    return dest;
  }

  /**
   * Adopts the given adoptable files (or all of them): backs up the folder
   * first, then records each in the ledger. File bytes are not changed.
   */
  function adopt(rels = null) {
    const found = adoptable();
    const chosen = rels === null ? found.matches : found.matches.filter((m) => Array.isArray(rels) && rels.includes(m.rel));
    if (!chosen.length) return { ok: true, opId: null, adopted: [], backup: null };
    let backup;
    try { backup = backupClaudeAgents(); } catch { return refuse('backup', 'Could not back up ~/.claude/agents first, so nothing was adopted.'); }
    const ledger = readLedger();
    const at = new Date(now()).toISOString();
    const changes = [];
    for (const m of chosen) {
      const cur = current(m.rel);
      if (!cur.ok || cur.sha !== m.sha) continue;
      const agent = catalog.get(m.agentId);
      keepOriginal(cur.text);
      ledger.owned[keyOf('claude', m.rel)] = { platform: 'claude', rel: m.rel, agentId: m.agentId, how: 'adopted', sha: m.sha, original: m.sha, fileSha256: agent.fileSha256, since: at };
      changes.push({ platform: 'claude', rel: m.rel, before: m.sha, after: m.sha });
    }
    const op = { id: randomUUID(), kind: 'adopt', at, backup: path.relative(DATA, backup), changes };
    ledger.ops.push(op);
    writeLedger(ledger);
    return { ok: true, opId: op.id, adopted: changes.map((c) => tilde(c.rel)), backup };
  }

  /** Releases every adopted file: the files stay exactly as they are. */
  function stopManaging() {
    const ledger = readLedger();
    const changes = [];
    for (const [k, o] of Object.entries(ledger.owned)) if (o.how === 'adopted') { delete ledger.owned[k]; changes.push({ platform: o.platform, rel: o.rel, before: o.sha, after: o.sha, owned: o }); }
    if (!changes.length) return { ok: true, opId: null, released: [] };
    const op = { id: randomUUID(), kind: 'release', at: new Date(now()).toISOString(), changes };
    ledger.ops.push(op);
    writeLedger(ledger);
    return { ok: true, opId: op.id, released: changes.map((c) => tilde(c.rel)) };
  }

  // ── undo one click ───────────────────────────────────────────────────────
  /** Reverses one recorded click. Anything changed since is left alone and listed. */
  function undo(opId) {
    const ledger = readLedger();
    const op = ledger.ops.find((o) => o.id === opId);
    if (!op || op.undone) return refuse('unavailable', 'Nothing to undo for this click.');
    const restored = [], conflicts = [];
    for (const c of op.changes) {
      const k = keyOf(c.platform, c.rel);
      const cur = current(c.rel);
      const label = tilde(c.rel);
      if (!cur.ok) { conflicts.push({ path: label, reason: cur.reason }); continue; }
      try {
        if (op.kind === 'add') {
          if (cur.text == null) { delete ledger.owned[k]; restored.push(label); continue; }
          if (cur.sha !== c.after) { conflicts.push({ path: label, reason: 'Changed since it was added, so it is kept.' }); continue; }
          files.removeTarget(c.rel);
          delete ledger.owned[k];
        } else if (op.kind === 'adopt') {
          const o = ledger.owned[k];
          // Never deletes: puts the original bytes back if Plexiform changed them.
          if (cur.text == null) { conflicts.push({ path: label, reason: 'The file is gone; nothing to restore over.' }); delete ledger.owned[k]; continue; }
          if (cur.sha !== c.before) {
            if (!o || cur.sha !== o.sha) { conflicts.push({ path: label, reason: 'Changed outside Plexiform, so it is kept as it is.' }); delete ledger.owned[k]; continue; }
            write(c.rel, original(c.before));
          }
          delete ledger.owned[k];
        } else if (op.kind === 'update') {
          if (cur.sha !== c.after) { conflicts.push({ path: label, reason: 'Changed since the update, so it is kept.' }); continue; }
          write(c.rel, original(c.before));
          const o = ledger.owned[k];
          if (o) Object.assign(o, { sha: c.before, fileSha256: c.prevFileSha256 });
        } else if (op.kind === 'remove' || op.kind === 'release') {
          if (c.after === null && c.before !== null) {
            if (cur.text != null) { conflicts.push({ path: label, reason: 'A file is there again, so it is kept.' }); continue; }
            write(c.rel, original(c.before), { exclusive: true });
          } else if (c.before !== null && cur.sha !== c.before) { conflicts.push({ path: label, reason: 'Changed since, so Plexiform does not manage it again.' }); continue; }
          if (c.owned && (c.before !== null || c.after !== null)) ledger.owned[k] = c.owned;
        }
        restored.push(label);
      } catch { conflicts.push({ path: label, reason: 'Could not be changed safely.' }); }
    }
    op.undone = new Date(now()).toISOString();
    writeLedger(ledger);
    return { ok: true, restored, conflicts };
  }

  // ── reconcile ────────────────────────────────────────────────────────────
  /** Every owned file: current, modified, missing or update-available. Reads only. */
  function status() {
    let ledger;
    try { ledger = readLedger(); } catch { return { ok: false, error: 'Plexiform\'s record of added agents can\'t be read.' }; }
    const items = Object.values(ledger.owned).map((o) => {
      const cur = current(o.rel);
      const agent = catalog.get(o.agentId);
      const state = !cur.ok ? 'broken' : cur.text == null ? 'missing' : cur.sha !== o.sha ? 'modified' : agent && agent.fileSha256 !== o.fileSha256 ? 'update-available' : 'current';
      return { platform: o.platform, path: tilde(o.rel), agentId: o.agentId, how: o.how, state };
    });
    return { ok: true, items, ops: ledger.ops.filter((o) => !o.undone).map((o) => ({ id: o.id, kind: o.kind, at: o.at, agentId: o.agentId ?? null, files: o.changes.length })) };
  }

  // ── Cursor: per project, off by default ──────────────────────────────────
  /** Writes .cursor/rules/<slug>.mdc into a project folder the person chose. */
  function addToProject(agentId, projectDir, { catalogSha } = {}) {
    if (!enableCursorProject) return refuse('disabled', 'Adding to a Cursor project is turned off.');
    if (catalogSha !== catalog.sha256) return refuse('changed', 'The catalogue changed. Reopen Find agents and try again.');
    const agent = catalog.get(agentId);
    const t = targets.find((x) => x.id === 'cursor-project');
    if (!agent || !t) return refuse('unavailable', 'This agent is not in the catalogue.');
    if (!t.verified) return refuse('disabled', `Cursor: ${t.reason}`);
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return refuse('invalid', 'Choose a project folder.');
    const root = path.resolve(projectDir);
    let st; try { st = fsApi.lstatSync(root); } catch { return refuse('invalid', 'That folder is gone.'); }
    if (st.isSymbolicLink() || !st.isDirectory() || root === HOME || root === path.parse(root).root) return refuse('invalid', 'Choose a project folder (not a link, your home folder or the disk).');
    const proj = createHomeFiles({ home: root, fsApi, maxBytes: 1024 * 1024 });
    const r = t.render(agent, {});
    if (!r.ok) return refuse('unmappable', r.reason);
    const rel = `${t.dir}/${r.file}`;
    let cur; try { cur = proj.readTarget(rel); } catch { return refuse('refused', 'The rules folder or file is a link, so Plexiform leaves it alone.'); }
    if (cur.text != null) return { ok: true, opId: null, results: [{ platform: 'cursor', path: path.join(root, rel), outcome: sha(cur.text) === sha(r.text) ? 'already-there' : 'skipped', reason: sha(cur.text) === sha(r.text) ? null : `You have your own ${r.file} in this project; Plexiform left it alone.` }] };
    proj.writeTarget(rel, r.text, 0o644, { exclusive: true });
    const ledger = readLedger();
    const op = { id: randomUUID(), kind: 'add-project', at: new Date(now()).toISOString(), agentId, catalogSha: catalog.sha256, project: root, changes: [{ platform: 'cursor', rel, before: null, after: sha(r.text) }] };
    ledger.ops.push(op);
    writeLedger(ledger);
    return { ok: true, opId: op.id, results: [{ platform: 'cursor', path: path.join(root, rel), outcome: 'added' }] };
  }
  /** Undo for a Cursor project add: removes the rule only if unchanged. */
  function undoProject(opId) {
    const ledger = readLedger();
    const op = ledger.ops.find((o) => o.id === opId && o.kind === 'add-project');
    if (!op || op.undone) return refuse('unavailable', 'Nothing to undo for this click.');
    const proj = createHomeFiles({ home: op.project, fsApi, maxBytes: 1024 * 1024 });
    const c = op.changes[0];
    let cur; try { cur = proj.readTarget(c.rel); } catch { return { ok: true, restored: [], conflicts: [{ path: path.join(op.project, c.rel), reason: 'Not a regular file Plexiform can change safely.' }] }; }
    if (cur.text != null && sha(cur.text) !== c.after) return { ok: true, restored: [], conflicts: [{ path: path.join(op.project, c.rel), reason: 'Changed since it was added, so it is kept.' }] };
    if (cur.text != null) proj.removeTarget(c.rel);
    op.undone = new Date(now()).toISOString();
    writeLedger(ledger);
    return { ok: true, restored: [path.join(op.project, c.rel)], conflicts: [] };
  }

  return { platformsFor, preview, add, update, remove, adoptable, adopt, stopManaging, undo, status, addToProject, undoProject, ledgerPath };
}

// For Health: what the ledger says Plexiform manages, checked against disk.
// Needs no catalogue. null when Find agents was never used.
function ledgerHealth({ home, dataRoot, fsApi = fs }) {
  const file = path.join(dataRoot, LEDGER_FILE);
  let ledger;
  try {
    const st = fsApi.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return { status: 'fail', detail: 'Plexiform\'s record of added agents is not a regular file.', next: 'Review on Find agents.' };
    ledger = JSON.parse(fsApi.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { status: 'fail', detail: 'Plexiform\'s record of added agents can\'t be read.', next: 'Review on Find agents.' };
  }
  const owned = Object.values(isObject(ledger?.owned) ? ledger.owned : {});
  if (!owned.length) return null;
  const files = createHomeFiles({ home, fsApi, maxBytes: 1024 * 1024 });
  let modified = 0, missing = 0, broken = 0;
  for (const o of owned) {
    try { const r = files.readTarget(o.rel); if (r.text == null) missing++; else if (sha(r.text) !== o.sha) modified++; } catch { broken++; }
  }
  const tools = new Set(owned.map((o) => o.platform)).size;
  const parts = [`${owned.length} agent file${owned.length === 1 ? '' : 's'} managed by Plexiform across ${tools} tool${tools === 1 ? '' : 's'}`];
  if (modified) parts.push(`${modified} changed outside Plexiform`);
  if (missing) parts.push(`${missing} missing`);
  if (broken) parts.push(`${broken} now a link or not a regular file`);
  return { status: broken ? 'fail' : modified || missing ? 'warn' : 'ok', detail: `${parts.join('; ')}.`, next: modified || missing || broken ? 'Review on Find agents.' : undefined };
}

module.exports = { createAgentInstaller, ledgerHealth, LEDGER_FILE };
