'use strict';
// Enrolment: every AI tool on this Mac, plugged into Plexiform's agent bus (BACKBONE-AUDIT-AND-PLAN §3.2, Lane 1).
// One table of tools; for each, detect / plan / enrol / verify / unenrol, and caps() for the Connections view.
//
// - Claude Code and Codex register their MCP entry through src/mcp-auto.js (~/.claude.json's compare-and-swap edit,
//   `codex mcp add`); here they are rows, and Codex gets its instruction block (~/.codex/AGENTS.md, D1).
// - Gemini CLI, Cursor, VS Code, the Claude desktop app and Hermes get plexiform-bus in their own MCP config file:
//   the bus profile with PLEXIFORM_MCP (ours, and which copy) and PLEXIFORM_CLIENT (which tool, so the server can
//   hold it to the unverified_client tier, D2). Gemini also gets its instruction block (~/.gemini/GEMINI.md, D1).
// - Every write is text-only and compare-and-swap: only our entry or our block changes, comments and formatting
//   stay, and unenrol takes back exactly what went in, so an untouched file comes back byte for byte. A same-named
//   entry without our marker is a conflict and is never touched; one of another copy's is left to that copy.
// - Before the first change to an existing file, a copy goes to <rootDir>/enrol-backups (0600); a byte-identical
//   undo deletes it again. The record (<rootDir>/enrol.json, 0600) holds names, times, hashes and the text we added,
//   never a copy of a config file.
const nodeFs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Runtime = require('../../adapters/runtime.js');
const McpInstall = require('../../mcp-install.js');
const Jsonc = require('./jsonc.js');
const Instr = require('./instructions.js');
const { TIERS } = require('../bus-contract.js');

const NAME = McpInstall.BUS_NAME;
const Adapters = require('../../adapters/index.js');
const CLIENTS = Adapters.mcpClients().map(Adapters.mcpClient);

// Sorted-key JSON, so a tool that rewrites its file in another key order is not "changed".
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const hashOf = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : canon(v)).digest('hex').slice(0, 16);
const tilde = (p, home) => (p && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);
const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const err = (code, message) => Object.assign(new Error(message || code), { code });

/**
 * home: where the tools' configs live (a sandbox in dev runs and tests). rootDir: Plexiform's data folder.
 * codexHome: CODEX_HOME. launch(): McpInstall.launch(...) for the bus profile, or null when this copy registers nothing
 * (caps() still reads). external(): {claude, codex} states from src/mcp-auto.js, when it runs in this process.
 */
function create({ home, rootDir, codexHome = path.join(home, '.codex'), launch = () => null, external = () => null, fs = nodeFs, now = () => Date.now() } = {}) {
  const recordFile = path.join(rootDir, 'enrol.json');
  const backupDir = path.join(rootDir, 'enrol-backups');
  const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
  const ctx = { home, exists };

  const TOOLS = [
    { id: 'claude', label: 'Claude Code', external: true, detect: () => exists(path.join(home, '.claude')) || exists(path.join(home, '.claude.json')),
      instructions: null, instructionsVia: 'hook', hooksAdapter: 'claude', tier: TIERS.LOCAL_ATTESTED,
      reason: 'Claude Code sessions are verified: they see peers, send and receive notes, and hand off work.' },
    { id: 'codex', label: 'Codex', external: true, detect: () => exists(codexHome), instructions: () => path.join(codexHome, 'AGENTS.md'),
      hooksAdapter: 'codex', tier: TIERS.LOCAL_ATTESTED,
      reason: 'Codex sessions are verified once their hooks are approved in Codex: they see peers, send and receive notes, and hand off work.' },
    ...CLIENTS,
  ];
  const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));
  const fileOf = (t) => (t.file ? t.file(ctx) : null);
  const instrOf = (t) => (typeof t.instructions === 'function' ? t.instructions({ home, codexHome }) : null);

  // ---- record ----
  function readRecord() {
    try { const r = JSON.parse(fs.readFileSync(recordFile, 'utf8')); if (r && typeof r === 'object' && !Array.isArray(r)) return { tools: {}, ...r }; } catch { /* none yet */ }
    return { tools: {} };
  }
  function writeRecord(r) {
    fs.mkdirSync(rootDir, { recursive: true });
    Runtime.writeTextAtomic(recordFile, JSON.stringify(r, null, 2), fs, undefined, { newMode: 0o600 });
  }
  const slot = (rec, id) => { rec.tools[id] = rec.tools[id] || {}; return rec.tools[id]; };

  // ---- files ----
  const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  function backup(file, text, id, kind) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const to = path.join(backupDir, `${id}-${kind}-${path.basename(file)}.${stamp(now())}`);
    fs.writeFileSync(to, text, { mode: 0o600 });
    return to;
  }
  // change(src|null) → {text: string|null (delete), changed, ...extra}. Written only if nobody wrote in between.
  function edit(file, change, { mode = 0o600 } = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const readAt = Runtime.mtimeOf(file, fs);
      const src = readText(file);
      const out = change(src);
      if (!out.changed) return { ...out, src };
      if (out.text === null) {
        if (Runtime.mtimeOf(file, fs) !== readAt) continue;
        fs.rmSync(file, { force: true });
        return { ...out, src };
      }
      if (Runtime.writeTextAtomic(file, out.text, fs, src === null ? undefined : readAt, { newMode: mode })) return { ...out, src };
    }
    throw err('BUSY', `${file} kept changing; try again`);
  }

  // ---- MCP entry ----
  function readEntry(t, src) {
    if (src === null) return undefined;
    if (t.format === 'yaml') {
      const hit = t.yaml.find(src);
      return hit ? { marker: hit.marker, body: hit.body } : undefined;
    }
    let v;
    try { v = Jsonc.get(src, t.key, NAME); } catch (e) { throw err('UNREADABLE', `${e.message}`); }
    return v === undefined ? undefined : { marker: McpInstall.markerOf(v), value: v };
  }
  function sameAs(t, src, cur, want) {
    if (t.format === 'yaml') { const hit = t.yaml.find(src); return !!hit && hit.body === t.yaml.render(want, hit.indent, hit.indent.length >= 2 ? hit.indent : '  '); }
    return canon(cur.value) === canon(want);
  }

  function mcpState(t, src, want) {
    let cur;
    try { cur = readEntry(t, src); } catch { return 'error'; }
    if (cur === undefined) return 'missing';
    if (!cur.marker) return 'conflict';
    const ours = want ? McpInstall.markerOf(want) : null;
    if (ours && cur.marker !== ours) return 'other-channel';
    if (!want) return 'ours';
    return sameAs(t, src, cur, want) ? 'ours' : 'stale';
  }

  function enrolMcp(t, rec, base) {
    const file = fileOf(t);
    const want = t.entry(base);
    const marker = McpInstall.markerOf(want);
    const r = slot(rec, t.id);
    const out = edit(file, (src) => {
      const st = mcpState(t, src, want);
      if (st === 'error') throw err('UNREADABLE', `${tilde(file, home)} could not be read as ${t.format === 'yaml' ? 'YAML' : 'JSON'}`);
      if (st === 'conflict') throw err('CONFLICT');
      if (st === 'other-channel') throw err('OTHER_CHANNEL');
      if (st === 'ours') return { changed: false };
      if (st === 'stale') {
        if (t.format === 'yaml') { const x = t.yaml.replace(src, want); const old = r.mcp?.chunk; return { text: x.text, changed: true, chunk: old && old.split(x.oldBody).length === 2 ? old.replace(x.oldBody, x.body) : null }; }
        const x = Jsonc.replace(src, t.key, NAME, want);
        const old = r.mcp?.chunk;
        return { text: x.text, changed: true, chunk: old && old.split(x.before).length === 2 ? old.replace(x.before, x.after) : null };
      }
      if (src === null) {
        const text = t.format === 'yaml' ? t.yaml.add('', want).text : `${JSON.stringify(t.key.reduceRight((v, k) => ({ [k]: v }), { [NAME]: want }), null, 2)}\n`;
        return { text, changed: true, created: true, chunk: text };
      }
      const x = t.format === 'yaml' ? t.yaml.add(src, want) : Jsonc.add(src, t.key, NAME, want);
      return { text: x.text, changed: true, chunk: x.chunk };
    });
    if (!out.changed) {
      if (!r.mcp) r.mcp = { file, marker, entry_hash: hashOf(want), added_at: null, adopted: true };
      return { state: 'ours', changed: false };
    }
    // Read back: the tool (or the person) may be writing the same file.
    if (mcpState(t, readText(file), want) !== 'ours') return { state: 'mismatch', changed: true };
    const prev = r.mcp || {};
    r.mcp = { file, marker, entry_hash: hashOf(want), added_at: prev.added_at || new Date(now()).toISOString(),
      created: prev.created || !!out.created, chunk: out.chunk !== undefined ? out.chunk : prev.chunk || null,
      backup: prev.backup || (out.src !== null ? backup(file, out.src, t.id, 'mcp') : null) };
    return { state: 'ours', changed: true };
  }

  function unenrolMcp(t, rec) {
    const r = rec.tools[t.id];
    if (!r || !r.mcp) return { state: 'none', changed: false };
    const { file, marker, chunk, created } = r.mcp;
    let res;
    try {
      res = edit(file, (src) => {
        if (src === null) return { changed: false };
        if (created && chunk && src === chunk) return { text: null, changed: true };
        let cur;
        try { cur = readEntry(t, src); } catch { throw err('UNREADABLE'); }
        if (!cur || cur.marker !== marker) return { changed: false };
        const x = t.format === 'yaml' ? t.yaml.remove(src, chunk) : Jsonc.remove(src, t.key, NAME, chunk);
        return { text: x.text, changed: x.changed };
      });
    } catch (e) { return { state: 'error', error: e.code || 'error' }; }
    finish(r.mcp, file);
    delete r.mcp;
    return { state: 'removed', changed: !!res.changed };
  }

  // A byte-identical undo needs no backup: drop it. Otherwise it stays, and the record keeps its path for the person.
  function finish(entry, file) {
    if (!entry.backup) return;
    try {
      const now2 = readText(file);
      if (now2 !== null && now2 === fs.readFileSync(entry.backup, 'utf8')) fs.rmSync(entry.backup, { force: true });
    } catch { /* keep it */ }
  }

  // ---- instruction block ----
  function enrolInstr(t, rec) {
    const file = instrOf(t);
    if (!file) return { state: t.instructionsVia || 'none', changed: false };
    const want = Instr.block(t.tier);
    const r = slot(rec, t.id);
    let out;
    try {
      out = edit(file, (src) => {
        const x = Instr.upsert(src, want, r.instructions?.sep ?? null);
        return x.changed ? { text: x.text, changed: true, sep: x.sep, created: src === null } : { changed: false };
      }, { mode: 0o644 });
    } catch (e) { return { state: e.code === 'CONFLICT' ? 'conflict' : 'error', changed: false }; }
    const prev = r.instructions || {};
    if (!out.changed) { if (!r.instructions) r.instructions = { file, version: want.version, sep: null, created: false, added_at: null, adopted: true }; return { state: 'ours', changed: false }; }
    r.instructions = { file, version: want.version, sep: prev.sep !== undefined && prev.sep !== null ? prev.sep : out.sep, created: prev.created || out.created,
      chunk: (prev.created || out.created) ? out.text : null, added_at: prev.added_at || new Date(now()).toISOString(),
      backup: prev.backup || (out.src !== null ? backup(file, out.src, t.id, 'instructions') : null) };
    return { state: 'ours', changed: true, first: !prev.added_at };
  }

  function unenrolInstr(t, rec) {
    const r = rec.tools[t.id];
    if (!r || !r.instructions) return { state: 'none', changed: false };
    const { file, sep, created } = r.instructions;
    let res;
    try {
      res = edit(file, (src) => {
        if (src === null) return { changed: false };
        const x = Instr.remove(src, sep);
        if (!x.changed) return { changed: false };
        return { text: created && x.text === '' ? null : x.text, changed: true };
      }, { mode: 0o644 });
    } catch (e) { return { state: 'error', error: e.code || 'error' }; }
    finish(r.instructions, file);
    delete r.instructions;
    return { state: 'removed', changed: !!res.changed };
  }

  // ---- per tool ----
  // opts.mcpOurs: for Claude/Codex, whether mcp-auto has our entry there (their block is written only then).
  function enrolOne(t, rec, { instructions = true, mcpOurs } = {}) {
    const out = { id: t.id, installed: !!t.detect(ctx), mcp: { state: t.external ? 'external' : 'not-installed' }, instructions: { state: 'none' } };
    if (!out.installed) return out;
    let ours = mcpOurs === undefined ? t.external && externalMcp(t) === 'ours' : !!mcpOurs;
    if (!t.external) {
      const base = launch();
      if (!base) out.mcp = { state: 'off' };
      else {
        try { out.mcp = enrolMcp(t, rec, base); } catch (e) { out.mcp = { state: e.code === 'CONFLICT' ? 'conflict' : e.code === 'OTHER_CHANNEL' ? 'other-channel' : 'error', error: e.code || 'error' }; }
      }
      ours = out.mcp.state === 'ours';
    }
    // An instruction to call tools the agent does not have would only mislead it.
    if (instrOf(t)) out.instructions = instructions && ours ? enrolInstr(t, rec) : unenrolInstr(t, rec);
    else out.instructions = { state: t.instructionsVia || 'none' };
    return out;
  }

  function enrolAll({ instructions, mcpOurs = {} } = {}) {
    const rec = readRecord();
    const want = instructions === undefined ? rec.instructionsOff !== true : instructions;
    const results = {};
    for (const t of TOOLS) {
      try { results[t.id] = enrolOne(t, rec, { instructions: want, mcpOurs: mcpOurs[t.id] }); } catch (e) { results[t.id] = { id: t.id, error: e.code || 'error' }; }
    }
    writeRecord(rec);
    const changed = Object.values(results).some((r) => r.mcp?.changed || r.instructions?.changed);
    const addedInstructions = Object.values(results).filter((r) => r.instructions?.first).map((r) => r.id);
    const addedMcp = Object.values(results).filter((r) => r.mcp?.changed && r.mcp.state === 'ours').map((r) => r.id);
    return { results, changed, addedInstructions, addedMcp };
  }

  function enrol(id, opts = {}) {
    const t = BY_ID.get(id);
    if (!t) return { id, error: 'UNKNOWN' };
    const rec = readRecord();
    const r = enrolOne(t, rec, { instructions: rec.instructionsOff !== true, ...opts });
    writeRecord(rec);
    return r;
  }

  function unenrol(id, { instructionsOnly = false } = {}) {
    const t = BY_ID.get(id);
    if (!t) return { id, error: 'UNKNOWN' };
    const rec = readRecord();
    const out = { id, instructions: unenrolInstr(t, rec), mcp: instructionsOnly || t.external ? { state: 'skipped' } : unenrolMcp(t, rec) };
    if (rec.tools[id] && !Object.keys(rec.tools[id]).length) delete rec.tools[id];
    writeRecord(rec);
    return out;
  }

  function unenrolAll({ instructionsOnly = false } = {}) {
    const out = {};
    for (const t of TOOLS) out[t.id] = unenrol(t.id, { instructionsOnly });
    return out;
  }

  // The person turned the instruction blocks off (or back on): off removes them now and keeps them off.
  function setInstructionsOff(off) {
    const rec = readRecord();
    rec.instructionsOff = !!off;
    writeRecord(rec);
    return off ? unenrolAll({ instructionsOnly: true }) : null;
  }

  // What connecting would write, before and after, for the diff preview. Nothing is written.
  function plan(id) {
    const t = BY_ID.get(id);
    if (!t) return { ok: false, error: 'Unknown tool.' };
    const files = [];
    try {
      const base = launch();
      if (!t.external && base) {
        const file = fileOf(t), want = t.entry(base), src = readText(file);
        const st = mcpState(t, src, want);
        if (st === 'conflict' || st === 'other-channel' || st === 'error') return { ok: false, state: st, error: whyText(t, st) };
        if (st !== 'ours') {
          const after = st === 'stale' ? (t.format === 'yaml' ? t.yaml.replace(src, want).text : Jsonc.replace(src, t.key, NAME, want).text)
            : src === null ? (t.format === 'yaml' ? t.yaml.add('', want).text : `${JSON.stringify(t.key.reduceRight((v, k) => ({ [k]: v }), { [NAME]: want }), null, 2)}\n`)
              : (t.format === 'yaml' ? t.yaml.add(src, want).text : Jsonc.add(src, t.key, NAME, want).text);
          files.push({ file, before: src, after });
        }
      }
      const ifile = instrOf(t);
      if (ifile && readRecord().instructionsOff !== true) {
        const src = readText(ifile);
        const x = Instr.upsert(src, Instr.block(t.tier));
        if (x.changed) files.push({ file: ifile, before: src, after: x.text });
      }
    } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, id, files };
  }

  // ---- read-only state, for caps() ----
  function externalMcp(t) {
    const ext = (() => { try { return external() || null; } catch { return null; } })();
    const s = ext && ext[t.id] && ext[t.id].state;
    if (s) return s === 'full' ? 'ours' : s === 'foreign' ? 'conflict' : s;
    if (t.id === 'claude') {
      if (McpInstall.status({ home }).installed || McpInstall.status({ home, name: NAME }).installed) return 'ours';
      return McpInstall.status({ home, name: NAME }).entry ? 'conflict' : 'missing';
    }
    const toml = (() => { try { return readText(path.join(codexHome, 'config.toml')); } catch { return null; } })() || '';
    const head = new RegExp(`^\\[mcp_servers\\.(?:"${NAME}"|${NAME})\\]`, 'm').exec(toml);
    if (!head) return 'missing';
    const tail = toml.slice(head.index + head[0].length);
    const next = /^\[(?!mcp_servers\.(?:"plexiform-bus"|plexiform-bus)\.)/m.exec(tail);
    return /PLEXIFORM_MCP\s*=\s*"bus-v1:/.test(next ? tail.slice(0, next.index) : tail) ? 'ours' : 'conflict';
  }

  function instrState(t, rec) {
    const file = instrOf(t);
    if (!file) return t.instructionsVia || 'none';
    if (rec.instructionsOff === true) return 'off';
    let src;
    try { src = readText(file); } catch { return 'error'; }
    if (src === null) return 'missing';
    let hit;
    try { hit = Instr.find(src); } catch { return 'conflict'; }
    if (!hit) return 'missing';
    return hit.current === Instr.block(t.tier).text ? 'ours' : 'stale';
  }

  function whyText(t, mcp) {
    const where = fileOf(t) ? tilde(fileOf(t), home) : null;
    switch (mcp) {
      case 'not-installed': return 'Not installed on this Mac.';
      case 'conflict': return `${where || 'Its config'} already has an MCP server named ${NAME} that is not Plexiform's, so Plexiform left it alone.`;
      case 'other-channel': return `${where || 'Its config'} has ${NAME} from another copy of Plexiform (a development build or the installed app), so this copy left it alone.`;
      case 'error': return `${where || 'Its config'} could not be read, so Plexiform left it alone. Fix or move that file, then try again.`;
      case 'missing': case 'stale': case 'mismatch': return `Not connected yet. Plexiform adds ${NAME} to ${where || 'it'} when it starts, or press Fix.`;
      case 'off': return 'The agent bus is turned off in Plexiform Preferences.';
      case 'untrusted': return 'Plexiform found a codex binary it could not verify as OpenAI\'s, so it did not run it.';
      default: return t.reason;
    }
  }

  // Per tool: {id, label, installed, mcp, hooks, instructions, tier, reason, file, instructionsFile, restart}.
  // hooks: {id: true|false} from the AI tools page (its own adapters), when the caller has it.
  function caps({ hooks = {} } = {}) {
    const rec = readRecord();
    const base = (() => { try { return launch(); } catch { return null; } })();
    return TOOLS.map((t) => {
      const installed = !!t.detect(ctx);
      let mcp = 'not-installed';
      if (installed) {
        if (t.external) mcp = externalMcp(t);
        else { try { mcp = mcpState(t, readText(fileOf(t)), base ? t.entry(base) : null); } catch { mcp = 'error'; } }
      }
      const hk = !t.hooksAdapter ? 'n/a' : !installed ? 'not-installed' : hooks[t.hooksAdapter] === true ? 'connected' : hooks[t.hooksAdapter] === false ? 'not-connected' : 'unknown';
      return { id: t.id, label: t.label, installed, mcp, hooks: hk, instructions: installed ? instrState(t, rec) : 'not-installed', tier: t.tier,
        reason: installed && mcp === 'ours' ? t.reason : whyText(t, mcp), file: fileOf(t) ? tilde(fileOf(t), home) : null,
        instructionsFile: instrOf(t) ? tilde(instrOf(t), home) : null, restart: t.restart || null };
    });
  }

  const anyEnrolled = () => Object.values(readRecord().tools).some((r) => (r.mcp && !r.mcp.adopted) || (r.instructions && !r.instructions.adopted));
  const labels = (ids) => ids.map((id) => BY_ID.get(id)?.label || id);

  return { recordFile, ids: () => TOOLS.map((t) => t.id), detect: (id) => !!BY_ID.get(id)?.detect(ctx), plan, enrol, enrolAll, unenrol, unenrolAll,
    verify: (id) => caps().find((c) => c.id === id) || null, caps, setInstructionsOff, instructionsOff: () => readRecord().instructionsOff === true,
    anyEnrolled, labels, instructionFiles: () => TOOLS.filter((t) => instrOf(t)).map((t) => ({ id: t.id, file: tilde(instrOf(t), home) })) };
}

module.exports = { create, NAME, CLIENTS, canon };
