'use strict';
// The AI tools page's engine: what is installed, what is connected, a preview
// of exactly what connecting writes, a backup before every write, a read-back
// after it, and an undo. Pure of Electron: main passes `home`, the hook
// `runtime` and (in tests) fakes for the filesystem probes.
const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const Adapters = require('../adapters/index.js');
const Runtime = require('../adapters/runtime.js');
const Hermes = require('../adapters/hermes-activity.js');
const Generic = require('./ai-tools-generic.js');
const MATRIX = require('./provider-capabilities.json');

// installUrl: each tool's own docs/repo, opened in the browser only when the
// person clicks "How to install".
const TOOLS = [
  { id: 'claude', adapter: 'claude', bins: ['claude'], installUrl: 'https://code.claude.com/docs/en/overview', auto: 'Connects by itself each time Plexiform starts.' },
  { id: 'codex', adapter: 'codex', bins: ['codex'], installUrl: 'https://github.com/openai/codex', after: 'Codex may ask you to trust the new hooks the first time it starts a turn; accept there, then start a new turn.' },
  { id: 'gemini', adapter: 'gemini', bins: ['gemini'], installUrl: 'https://geminicli.com/docs/' },
  { id: 'cursor', adapter: 'cursor', bins: ['cursor-agent'], installUrl: 'https://cursor.com/docs/cli/overview' },
  { id: 'hermes', adapter: null, bins: ['hermes'], installUrl: 'https://github.com/NousResearch/hermes-agent' },
];
const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));
const CHIPS = ['Live status', 'Answer prompts', 'Board cards', 'Handover', 'Cost'];

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const stamp = (now) => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const tilde = (p, home) => (p && (p === home || p.startsWith(`${home}/`) || p.startsWith(`${home}\\`)) ? `~${p.slice(home.length)}` : p);

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// Changed lines only, in file order. LCS on lines; a pair of config files is
// small, and past a size bound it degrades to a set difference.
function diffLines(before, after) {
  const a = before ? before.split('\n') : [], b = after.split('\n');
  const out = []; let same = 0;
  if (a.length * b.length > 4_000_000) {
    const had = new Set(a), has = new Set(b);
    for (const l of a) if (!has.has(l)) out.push({ kind: 'del', text: l });
    for (const l of b) if (!had.has(l)) out.push({ kind: 'add', text: l }); else same++;
    return { lines: out, unchanged: same };
  }
  const t = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { same++; i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) out.push({ kind: 'del', text: a[i++] }); else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return { lines: out, unchanged: same };
}

function friendly(err, file, home) {
  const where = tilde(file, home);
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return `Plexiform cannot write ${where} (permission denied). Check the file's owner and permissions, then try again.`;
  if (err?.code === 'EROFS') return `${where} is on a read-only disk, so it was left alone.`;
  if (err instanceof SyntaxError) return `${where} is not valid JSON (${err.message}). It was left alone; fix or move that file, then try again.`;
  if (/not a JSON object/.test(err?.message || '')) return `${where} is not a JSON object, so it was left alone.`;
  return `${err?.message || 'Unknown error'}`;
}

function create({
  home, runtime, fs = nodeFs, platform = process.platform, dataDir = runtime.dataDir, sessionsDir = path.join(dataDir, 'sessions'),
  claudeAskFromWidget = () => false, blocked = () => null, handoverSources = () => [], now = Date.now,
  pathDirs = () => String(process.env.PATH || '').split(path.delimiter), run = execFile,
  // A GUI app's PATH is short; tools usually live in these.
  extraBinDirs = [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'],
} = {}) {
  const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
  const storeFile = path.join(dataDir, 'ai-tools.json');
  const readStore = () => { try { const s = JSON.parse(fs.readFileSync(storeFile, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; } };
  const writeStore = (s) => { fs.mkdirSync(dataDir, { recursive: true }); Runtime.writeTextAtomic(storeFile, JSON.stringify(s, null, 2), fs, undefined, { newMode: 0o600 }); };
  const adapterOf = (t) => (t.adapter ? Adapters.get(t.adapter) : null);
  const optsFor = (t) => ({ home, runtime, fs, ...(t.id === 'claude' ? { askFromWidget: !!claudeAskFromWidget() } : {}) });

  function findBin(names) {
    const dirs = [...pathDirs(), ...extraBinDirs];
    for (const n of names) for (const d of dirs) { const p = path.join(d, n); try { fs.accessSync(p, nodeFs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
    return null;
  }
  const versions = new Map();
  function versionOf(bin) {
    const hit = versions.get(bin);
    if (hit && now() - hit.at < 60000) return hit.p;
    const p = new Promise((resolve) => {
      const child = run(bin, ['--version'], { timeout: 3000, maxBuffer: 8192, windowsHide: true }, (err, out) => resolve(err ? null : (/\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?/.exec(String(out)) || [null])[0])); // privacy-flow: tool-version-probe
      child?.stdin?.end?.();
    });
    versions.set(bin, { at: now(), p });
    return p;
  }

  const filesOf = (t) => {
    if (t.id === 'hermes') return [];
    const a = adapterOf(t);
    return [t.id === 'codex' ? a.lifecycleConfigPath(home) : a.configPath(home)];
  };

  function isConnected(t) {
    try {
      if (t.id === 'hermes') return Hermes.isInstalled({ home });
      const a = adapterOf(t);
      return t.id === 'codex' ? a.isActivityInstalled(optsFor(t)) : a.isInstalled(optsFor(t));
    } catch { return false; }
  }
  // Something of ours is in the file, but not what this app would write: an
  // older copy, another checkout, a moved app.
  function holdsOurs(t) {
    try {
      if (t.id === 'hermes') return Hermes.isInstalled({ home });
      const a = adapterOf(t);
      const [file] = filesOf(t);
      if (!exists(file)) return false;
      if (t.id === 'codex') { const data = Runtime.readJsonConfig(file, fs); return JSON.stringify(a.stripActivity(data)) !== JSON.stringify(data); }
      const cmds = [];
      (function walk(n) { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) { if (k === 'command' && typeof v === 'string') cmds.push(v); else walk(v); } })(Runtime.readJsonConfig(file, fs).hooks);
      return cmds.some((c) => a.isOurs(c));
    } catch { return false; }
  }
  const configProblem = (t) => {
    if (t.id === 'hermes') return null;
    const [file] = filesOf(t);
    try { Runtime.readJsonConfig(file, fs); if (t.id === 'codex') adapterOf(t).validateActivity(Runtime.readJsonConfig(file, fs)); return null; } catch (e) { return friendly(e, file, home); }
  };

  function lastSeen() {
    const by = {};
    let names = [];
    try { names = fs.readdirSync(sessionsDir); } catch { /* no sessions yet */ }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, n), 'utf8'));
        const at = Date.parse(s.updatedAt);
        const src = s.source || 'claude';
        if (Number.isFinite(at) && at > (by[src]?.at || 0)) by[src] = { at, sessionId: String(s.sessionId || '') };
      } catch { /* a half-written file */ }
    }
    const store = readStore();
    const kept = store.lastSeen || {};
    let dirty = false;
    for (const [src, v] of Object.entries(by)) if (v.at > (kept[src] || 0)) { kept[src] = v.at; dirty = true; }
    if (dirty) { try { writeStore({ ...store, lastSeen: kept }); } catch { /* best effort */ } }
    return { by, kept };
  }
  const eventText = (at) => (at ? ago(now() - at) : 'no events yet');

  function chipsFor(t, handover) {
    const m = MATRIX.platforms.find((p) => p.id === t.id)?.matrix || {};
    const caps = adapterOf(t)?.capabilities || {};
    const on = {
      'Live status': m.telemetry?.status === 'built' || m.discovery?.status === 'built',
      'Answer prompts': !!caps.answer,
      'Board cards': m.taskReporting?.status === 'built',
      Handover: handover.includes(t.id),
      Cost: !!caps.cost,
    };
    return CHIPS.filter((c) => on[c]);
  }

  // Everything but the version (which runs the tool): enough for the checklist.
  function toolRows() {
    const seen = lastSeen();
    const handover = handoverSources();
    return TOOLS.map((t) => {
      const label = MATRIX.platforms.find((p) => p.id === t.id)?.label || t.id;
      const bin = findBin(t.bins);
      const a = adapterOf(t);
      const configDir = t.id === 'hermes' ? exists(path.join(home, '.hermes')) : a.detect({ home, exists });
      const installed = !!bin || configDir;
      const connected = installed && isConnected(t);
      const problem = installed && !connected ? configProblem(t) : null;
      const stale = installed && !connected && !problem && holdsOurs(t);
      const at = seen.by[t.id]?.at || seen.kept[t.id] || null;
      let primary, state;
      if (!installed) { state = 'missing'; primary = { action: 'install', label: 'How to install' }; }
      else if (connected) { state = 'connected'; primary = { action: 'disconnect', label: 'Disconnect' }; }
      else if (problem) { state = 'fix'; primary = { action: 'fix', label: 'Fix' }; }
      else if (stale) { state = 'reconnect'; primary = { action: 'reconnect', label: 'Reconnect' }; }
      else { state = 'ready'; primary = { action: 'connect', label: 'Connect' }; }
      const detail = !installed ? 'Not installed' : problem || (state === 'reconnect' ? 'Hooks point at an older or different copy of Plexiform.' : state === 'ready' ? 'Found on this Mac, not connected yet.' : connected && !at ? 'Connected. Start a session in it to see it here.' : 'Connected.');
      const undo = readStore().undo?.[t.id] || null;
      return { id: t.id, label, kind: 'tool', installed, detected: installed, version: null, bin, connected, state, primary, detail, error: problem,
        lastEvent: { at, text: eventText(at) }, chips: chipsFor(t, handover), installUrl: t.installUrl, note: t.auto || null, canUndo: !!undo, files: filesOf(t).map((f) => tilde(f, home)) };
    });
  }

  function quick() { return toolRows().map(({ bin, ...r }) => r); }

  async function scan() {
    const rows = await Promise.all(toolRows().map(async ({ bin, ...r }) => ({ ...r, version: bin ? await versionOf(bin) : null })));
    const store = readStore();
    const generic = Generic.status({ home, runtime, fs, platform });
    const customRows = (store.custom || []).map((c) => {
      const key = Generic.keyOf(c.command);
      const prefix = `${key}-`;
      let at = null;
      try {
        for (const n of fs.readdirSync(sessionsDir)) {
          if (!n.endsWith('.json') || !n.includes(`generic-${prefix}`)) continue;
          const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, n), 'utf8'));
          const t = Date.parse(s.updatedAt);
          if (s.source === 'generic' && String(s.sessionId).startsWith(prefix) && Number.isFinite(t) && t > (at || 0)) at = t;
        }
      } catch { /* none yet */ }
      const stored = (store.customSeen || {})[key] || 0;
      if (at && at > stored) { try { writeStore({ ...readStore(), customSeen: { ...(readStore().customSeen || {}), [key]: at } }); } catch { /* best effort */ } }
      const last = at || stored || null;
      return { id: `custom:${c.name}`, label: c.name, kind: 'custom', installed: true, detected: true, version: null, connected: generic.ok, state: generic.ok ? 'connected' : 'fix',
        primary: generic.ok ? { action: 'copy', label: 'Copy command' } : { action: 'fix-custom', label: 'Fix' },
        detail: generic.ok ? `Run it as: ${generic.display} ${c.command}` : generic.problem, command: `${generic.display} ${c.command}`, error: generic.ok ? null : generic.problem,
        lastEvent: { at: last, text: eventText(last) }, chips: ['Live status'], note: 'Shows working and done only. It cannot answer prompts.', canUndo: false, files: [] };
    });
    const found = rows.filter((r) => r.kind === 'tool' && r.installed);
    const todo = found.filter((r) => !r.connected && r.state !== 'fix');
    return { rows: [...rows, ...customRows], runner: generic, found: found.map((r) => r.id), pending: todo.map((r) => r.id), platformOk: platform !== 'win32', home };
  }

  // What connecting would write, as a diff of the file as the adapter would
  // leave it. The after-text is the adapter's own pure apply(), not a guess.
  function afterObject(t, before) {
    const a = adapterOf(t);
    if (t.id === 'claude') return a.apply(before, runtime, { askFromWidget: !!claudeAskFromWidget(), home });
    if (t.id === 'codex') return a.applyActivity(before, runtime);
    return a.apply(before, runtime);
  }
  function preview(id) {
    const t = BY_ID.get(id);
    if (!t) return { ok: false, error: 'Unknown tool.' };
    const stop = blocked();
    if (stop) return { ok: false, error: stop };
    if (t.id === 'hermes' && runtime.node) return { ok: false, error: 'Hermes connects from the installed app: a development run has no app binary to give its plugin.' };
    if (t.id === 'hermes') {
      const dir = path.join(home, '.hermes', 'plugins', 'plexiform-activity');
      return { ok: true, id, already: isConnected(t), files: [], steps: [`Write the plexiform-activity plugin files into ${tilde(dir, home)}.`, 'Run `hermes plugins enable plexiform-activity` for your default profile.', 'No existing Hermes setting is edited. Undo removes the plugin folder.'] };
    }
    const [file] = filesOf(t);
    try {
      const text = exists(file) ? fs.readFileSync(file, 'utf8') : '';
      const before = Runtime.readJsonConfig(file, fs);
      if (t.id === 'codex') adapterOf(t).validateActivity(before);
      const beforeText = text ? JSON.stringify(before, null, 2) : '';
      const afterText = JSON.stringify(afterObject(t, before), null, 2);
      const d = diffLines(beforeText, afterText);
      const already = isConnected(t);
      return { ok: true, id, already, files: [{ file: tilde(file, home), existed: !!text, backup: text ? `${path.basename(file)}.plexiform-backup-<time>` : null, ...d }] };
    } catch (e) { return { ok: false, error: friendly(e, file, home) }; }
  }

  function backupAll(files) {
    const at = stamp(now());
    return files.map((file) => {
      if (!exists(file)) return { file, backup: null };
      const backup = `${file}.plexiform-backup-${at}`;
      fs.copyFileSync(file, backup);
      return { file, backup };
    });
  }
  const shaOf = (file) => { try { return sha(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const restore = (entries) => {
    for (const e of entries) {
      if (e.backup) fs.copyFileSync(e.backup, e.file);
      else fs.rmSync(e.file, { force: true });
    }
  };
  const remember = (id, entry) => { const s = readStore(); s.undo = { ...(s.undo || {}) }; if (entry) s.undo[id] = entry; else delete s.undo[id]; writeStore(s); };

  async function connect(id) {
    const t = BY_ID.get(id);
    if (!t) return { ok: false, id, error: 'Unknown tool.' };
    const stop = blocked();
    if (stop) return { ok: false, id, error: stop };
    if (isConnected(t)) return { ok: true, id, changed: false, message: 'Already connected.' };
    if (t.id === 'hermes' && runtime.node) return { ok: false, id, error: 'Hermes connects from the installed app: a development run has no app binary to give its plugin.' };
    if (t.id === 'hermes') {
      try {
        const r = await Hermes.connect({ home, runtime });
        if (!r.ok) return { ok: false, id, error: r.error };
        if (!isConnected(t)) return { ok: false, id, error: 'Hermes did not keep the plugin; nothing is connected.' };
        remember(id, { hermes: true, at: now(), files: [] });
        return { ok: true, id, changed: true, message: 'Connected. Start a new Hermes session; it appears after its first activity.' };
      } catch (e) { return { ok: false, id, error: e.message }; }
    }
    const files = filesOf(t);
    let entries;
    try { entries = backupAll(files); } catch (e) { return { ok: false, id, error: friendly(e, files[0], home) }; }
    try {
      const r = t.id === 'codex' ? adapterOf(t).installActivity(optsFor(t)) : adapterOf(t).install(optsFor(t));
      if (r && r.ok === false) throw Object.assign(new Error(r.error || 'Could not write the config.'), { handled: true });
      if (!isConnected(t)) throw Object.assign(new Error(`Wrote ${tilde(files[0], home)} but reading it back did not show the hooks.`), { handled: true });
    } catch (e) {
      try { restore(entries); } catch { /* the backup file still exists beside it */ }
      for (const en of entries) if (en.backup) try { fs.rmSync(en.backup, { force: true }); } catch { /* keep */ }
      return { ok: false, id, error: e.handled ? `${e.message} Your file is as it was.` : friendly(e, files[0], home) };
    }
    remember(id, { at: now(), files: entries.map((e) => ({ ...e, after: shaOf(e.file) })) });
    return { ok: true, id, changed: true, files: entries.map((e) => ({ file: tilde(e.file, home), backup: e.backup ? tilde(e.backup, home) : null })), message: `Connected. ${t.after || 'Restart open sessions to pick up the hooks.'}` };
  }

  async function connectAll() {
    const snap = await scan();
    const results = [];
    // A tool whose config cannot be read is still tried, so its error is in the report.
    for (const r of snap.rows.filter((x) => x.kind === 'tool' && x.installed && !x.connected)) results.push(await connect(r.id));
    return { ok: results.every((r) => r.ok), results };
  }

  function undo(id) {
    const t = BY_ID.get(id);
    const entry = readStore().undo?.[id];
    if (!t || !entry) return { ok: false, id, error: 'Nothing to undo.' };
    try {
      if (entry.hermes) { Hermes.uninstall({ home }); remember(id, null); return { ok: true, id, message: 'Hermes activity plugin removed.' }; }
      for (const e of entry.files) if (shaOf(e.file) !== e.after) return { ok: false, id, error: `${tilde(e.file, home)} has changed since Plexiform wrote it, so Undo left it alone.${e.backup ? ` Your original is at ${tilde(e.backup, home)}.` : ''}` };
      restore(entry.files);
      remember(id, null);
      return { ok: true, id, message: 'Restored your original config.' };
    } catch (e) { return { ok: false, id, error: e.message }; }
  }

  function disconnect(id) {
    const t = BY_ID.get(id);
    if (!t) return { ok: false, id, error: 'Unknown tool.' };
    try {
      const files = filesOf(t);
      const entries = files.length ? backupAll(files.filter((f) => exists(f))) : [];
      if (t.id === 'hermes') Hermes.uninstall({ home });
      else if (t.id === 'codex') { const r = adapterOf(t).uninstallActivity({ home, fs }); if (!r.ok) throw new Error(r.error); }
      else adapterOf(t).uninstall({ home, fs });
      if (isConnected(t)) return { ok: false, id, error: 'The hooks are still there after removing them.' };
      remember(id, entries.length ? { at: now(), files: entries.map((e) => ({ ...e, after: shaOf(e.file) })) } : null);
      return { ok: true, id, message: 'Disconnected. Only Plexiform\'s own entries were removed.' };
    } catch (e) { return { ok: false, id, error: friendly(e, filesOf(t)[0] || '', home) }; }
  }

  function addCustom(name, command) {
    const n = String(name || '').trim(), c = String(command || '').trim();
    if (!Adapters.get('generic').NAME.test(n)) return { ok: false, error: 'Give it a short name: letters, numbers, spaces, dots or dashes.' };
    if (!c || c.length > 200 || /[\0-\x1f\x7f]/.test(c) || !Generic.keyOf(c)) return { ok: false, error: 'Enter the command you run, for example: aider --model sonnet' };
    const r = Generic.installRunner({ home, runtime, fs, platform });
    if (!r.ok) return { ok: false, error: r.error };
    const store = readStore();
    const custom = (store.custom || []).filter((x) => x.name !== n);
    if (custom.length >= 20) return { ok: false, error: 'That is plenty of custom tools; remove one first.' };
    custom.push({ name: n, command: c });
    writeStore({ ...store, custom });
    return { ok: true, command: `${r.display} ${c}`, runner: r.file, onPath: r.onPath };
  }
  function removeCustom(name) {
    const store = readStore();
    writeStore({ ...store, custom: (store.custom || []).filter((x) => x.name !== name) });
    return { ok: true };
  }
  const fixRunner = () => { const r = Generic.installRunner({ home, runtime, fs, platform }); return r.ok ? { ok: true, message: 'Reinstalled plexiform-run.' } : { ok: false, error: r.error }; };

  return { scan, quick, preview, connect, connectAll, undo, disconnect, addCustom, removeCustom, fixRunner, installUrl: (id) => BY_ID.get(id)?.installUrl || null, ids: () => TOOLS.map((t) => t.id) };
}

module.exports = { create, diffLines, TOOLS };
