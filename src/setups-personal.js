'use strict';
// Personal setups: export my reviewed rules, skills, MCP entries and a hook-free
// settings subset to a file, and import one (mine, or a teammate's team setup)
// with a full preview, a backup before Apply and an Undo that restores it.
//
// Everything imported is untrusted input. Nothing here runs a command, spawns a
// process or opens a network channel: MCP entries are written as JSON text the
// person confirmed item by item, shown verbatim first. Writes stay under the
// home folder at a fixed set of relative paths, never through a link.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { scan } = require('./borrow/scan.js');
const { scrubFile } = require('./borrow/scrub.js');
const schema = require('./borrow/payload.js');
const { findSecrets, redactSecrets } = require('./secret-patterns.js');

const ENVELOPE_KIND = 'plexiform.setup';
const SOURCES = Object.freeze(['claude-code', 'codex', 'gemini-cli']);
const TARGETS = Object.freeze([
  { re: /^\.claude\/CLAUDE\.md$/, kind: 'rules' },
  { re: /^\.codex\/AGENTS\.md$/, kind: 'rules' },
  { re: /^\.gemini\/GEMINI\.md$/, kind: 'rules' },
  { re: /^\.claude\/skills\/[^/]+(?:\/[^/]+){1,3}$/, kind: 'skill' },
  { re: /^\.claude\/commands\/[^/]+(?:\/[^/]+){0,3}$/, kind: 'command' },
  { re: /^\.claude\/agents\/[^/]+(?:\/[^/]+){0,3}$/, kind: 'agent' },
  { re: /^\.claude\/settings\.json$/, kind: 'settings' },
  { re: /^\.claude\.json#mcpServers$/, kind: 'mcp' },
]);
// The hook-free settings subset. true = changes what runs without asking, so
// it needs its own tick. Everything else (hooks, statusLine, apiKeyHelper, env,
// enableAllProjectMcpServers, plugins…) is dropped on export and on import.
const SAFE_SETTINGS = Object.freeze({ model: false, outputStyle: false, includeCoAuthoredBy: false, cleanupPeriodDays: false, alwaysThinkingEnabled: false, spinnerTipsEnabled: false, language: false, theme: false, permissions: true });
const PLAIN_TEXT = /\.(?:md|markdown|txt)$/i;
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.@+ -]{1,128}$/;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PH = /\{\{(HOME|USER|HOSTNAME|NAME|EMAIL(?::\d+)?|IP:\d+|HOST:\d+|PRIVATE:\d+|SSH_USER|SECRET:[\w.-]{1,64})\}\}/g;
const LIMITS = Object.freeze({ importBytes: schema.SETUP_BODY_MAX, targetBytes: 16 * 1024 * 1024, mcpServers: 64, mcpBytes: 16 * 1024, valueBytes: 4096, valuesBytes: 16 * 1024, values: 128, backups: 50, manifestBytes: 40 * 1024 * 1024, diffCells: 2_250_000, ttl: 10 * 60_000 });
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sha = (text) => createHash('sha256').update(text ?? '\0absent').digest('hex');
const refuse = (status, error) => ({ ok: false, status, error });
const unavailable = () => refuse('unavailable', 'This setup is no longer available. Import or review it again.');
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pretty = (v) => JSON.stringify(v, null, 2);
const shown = (text) => (text == null ? null : redactSecrets(text, { standIns: true, docExamples: false, replace: (h) => `<redacted:${h.kind}>` }));
const ownKeys = (o) => Object.keys(o).filter((k) => k !== '__proto__');

function targetOf(rel) {
  if (typeof rel !== 'string') return null;
  const t = TARGETS.find((x) => x.re.test(rel));
  if (!t) return null;
  const file = rel.split('#')[0];
  if (!file.split('/').every((s, i) => (i === 0 ? /^\.[a-z]+(?:\.json)?$/.test(s) : SEGMENT.test(s)))) return null;
  const code = ['skill', 'command', 'agent'].includes(t.kind) && !PLAIN_TEXT.test(file);
  return { kind: t.kind, file, code };
}

// Line diff for review. Exact LCS while small; past that, the whole old text
// out and the whole new text in, which is still complete and honest.
function diffLines(before, after) {
  const a = before == null ? [] : before.split('\n'), b = after == null ? [] : after.split('\n');
  if (a.length * b.length > LIMITS.diffCells) return [...a.map((text) => ({ op: '-', text })), ...b.map((text) => ({ op: '+', text }))];
  const n = a.length, m = b.length, w = m + 1, dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

function placeholders(text) { return [...new Set([...String(text).matchAll(PH)].map((m) => m[1]))].filter((n) => n !== 'HOME' && n !== 'USER'); }
function fill(text, vars) { return text.replace(PH, (whole, name) => (Object.hasOwn(vars, name) ? vars[name] : whole)); }
function fillJson(value, vars) {
  if (typeof value === 'string') return fill(value, vars);
  if (Array.isArray(value)) return value.map((v) => fillJson(v, vars));
  if (isObject(value)) return Object.fromEntries(ownKeys(value).map((k) => [k, fillJson(value[k], vars)]));
  return value;
}
const leftover = (text) => new RegExp(PH.source).test(text);

function checkValues(values) {
  if (values === undefined) return {};
  if (!isObject(values)) return null;
  const entries = Object.entries(values);
  if (entries.length > LIMITS.values) return null;
  let total = 0;
  for (const [k, v] of entries) {
    if (!new RegExp(`^${PH.source.slice(4, -4)}$`).test(k) || k === 'HOME' || k === 'USER' || typeof v !== 'string' || v.includes('\0') || Buffer.byteLength(v) > LIMITS.valueBytes) return null;
    total += Buffer.byteLength(v);
  }
  return total > LIMITS.valuesBytes ? null : Object.fromEntries(entries);
}

function createPersonalSetups({ home, dataRoot, user = () => os.userInfo().username, machine = () => ({}), fsApi = fs, scanImpl = scan, now = Date.now } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw new Error('personal setups need an absolute home and data folder');
  const HOME = path.resolve(home);
  const BACKUPS = path.join(path.resolve(dataRoot), 'setups-backups');
  const drafts = new Map(), plans = new Map();
  const invalidate = () => { drafts.clear(); plans.clear(); };
  const keep = (map, value) => { if (map.size >= 16) map.delete(map.keys().next().value); const handle = randomUUID(); map.set(handle, { ...value, expires: now() + LIMITS.ttl }); return handle; };
  const live = (map, handle) => { const e = typeof handle === 'string' ? map.get(handle) : null; if (!e) return null; if (e.expires <= now()) { map.delete(handle); return null; } return e; };

  // Walks the relative path from home one component at a time with lstat and
  // refuses any link, any non-folder parent and any non-file target.
  function locate(file) {
    const parts = file.split('/');
    const full = path.join(HOME, ...parts);
    if (!full.startsWith(HOME + path.sep)) throw new Error('outside home');
    let cur = HOME;
    for (let i = 0; i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      let st;
      try { st = fsApi.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return { full, exists: false }; throw e; }
      if (st.isSymbolicLink()) throw new Error('link');
      if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) throw new Error('not a regular file');
    }
    return { full, exists: true };
  }
  function readTarget(file) {
    const { full, exists } = locate(file);
    if (!exists) return { full, text: null, mode: null };
    let fd;
    try {
      fd = fsApi.openSync(full, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
      const st = fsApi.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > LIMITS.targetBytes) throw new Error('unsupported target');
      const buf = Buffer.alloc(st.size);
      let at = 0;
      while (at < buf.length) { const n = fsApi.readSync(fd, buf, at, buf.length - at, at); if (n < 1) break; at += n; }
      return { full, text: buf.subarray(0, at).toString('utf8'), mode: st.mode & 0o777 };
    } finally { if (fd !== undefined) fsApi.closeSync(fd); }
  }
  function writeTarget(file, text, mode) {
    const parts = file.split('/');
    let cur = HOME;
    for (const part of parts.slice(0, -1)) {
      cur = path.join(cur, part);
      try { fsApi.mkdirSync(cur, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const st = fsApi.lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('link');
    }
    const full = path.join(cur, parts.at(-1));
    const tmp = path.join(cur, `.${parts.at(-1)}.plexiform-${randomUUID()}.tmp`);
    let fd;
    try {
      // Never executable: an imported file keeps at most read/write bits.
      fd = fsApi.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, (Number.isInteger(mode) ? mode : 0o600) & 0o666);
      fsApi.fchmodSync(fd, (Number.isInteger(mode) ? mode : 0o600) & 0o666);
      fsApi.writeFileSync(fd, text, 'utf8');
      fsApi.fsyncSync(fd);
      fsApi.closeSync(fd); fd = undefined;
      locate(file);
      fsApi.renameSync(tmp, full);
    } catch (e) {
      if (fd !== undefined) try { fsApi.closeSync(fd); } catch { /* already closed */ }
      try { fsApi.unlinkSync(tmp); } catch { /* never created */ }
      throw e;
    }
  }
  function removeTarget(file) { const { full, exists } = locate(file); if (exists) fsApi.unlinkSync(full); }

  // ── Export ────────────────────────────────────────────────────────────────
  function collect() {
    let result;
    try { result = scanImpl({ home: HOME, fsApi, exec: null, only: [...SOURCES], optIn: [] }); } catch { return unavailable(); }
    const files = [], withheld = [], dropped = [];
    let bytes = 0, limited = false;
    for (const source of result.sources ?? []) for (const file of source.files ?? []) {
      const rel = String(file.path ?? '').slice(2), target = targetOf(rel);
      if (!target) { withheld.push({ path: rel, reason: rel.startsWith('.claude/hooks') ? 'hooks run commands and are never exported' : 'not part of a personal setup' }); continue; }
      let content = file.content;
      if (target.kind === 'settings') {
        let parsed; try { parsed = JSON.parse(content); } catch { withheld.push({ path: rel, reason: 'settings are not valid JSON' }); continue; }
        if (!isObject(parsed)) { withheld.push({ path: rel, reason: 'settings are not a JSON object' }); continue; }
        for (const key of ownKeys(parsed)) if (!Object.hasOwn(SAFE_SETTINGS, key)) dropped.push(key);
        const kept = Object.fromEntries(ownKeys(parsed).filter((k) => Object.hasOwn(SAFE_SETTINGS, k)).map((k) => [k, parsed[k]]));
        if (!Object.keys(kept).length) { withheld.push({ path: rel, reason: 'no shareable settings (hooks and commands are never exported)' }); continue; }
        content = pretty(kept) + '\n';
      }
      const scrubbed = scrubFile({ ...file, content, machine: { ...machine(), home: HOME } });
      if (scrubbed.status !== 'ok') { withheld.push({ path: rel, reason: 'blocked by the privacy check' }); continue; }
      const stripped = redactSecrets(scrubbed.content, { standIns: true, docExamples: false, replace: (h) => `{{SECRET:${h.kind.replace(/[^\w.-]/g, '_').slice(0, 64)}}}` });
      const entry = { id: randomUUID(), source_id: source.id, relative_path: rel, format: file.format, content: stripped, note: '' };
      try { schema.validatePayload({ schema: 1, files: [entry], items: [], note: '' }); } catch { withheld.push({ path: rel, reason: 'blocked by the privacy check' }); continue; }
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (files.length >= schema.SETUP_LIMITS.files || bytes + size > schema.SETUP_LIMITS.profileBytes - 4096) { limited = true; withheld.push({ path: rel, reason: 'over the setup size limit' }); continue; }
      bytes += size;
      files.push({ ...entry, kind: target.kind, code: target.code });
    }
    if (!files.length) return { ...refuse('empty', 'Nothing shareable was found: rules, skills, commands, agents, MCP entries or hook-free settings.'), withheld };
    const handle = keep(drafts, { files });
    return { ok: true, handle, files: files.map(({ id, relative_path, kind, code, content }) => ({ id, relative_path, kind, code, content })), withheld, dropped_settings: [...new Set(dropped)].sort(), limited };
  }

  /** The reviewed file text for an export draft, minus the files the person excluded. */
  function exportText(handle, excluded = []) {
    const draft = live(drafts, handle);
    if (!draft || !Array.isArray(excluded) || excluded.length > 256 || excluded.some((id) => typeof id !== 'string')) return unavailable();
    const files = draft.files.filter((f) => !excluded.includes(f.id)).map(({ kind, code, ...f }) => f);
    if (!files.length) return refuse('empty', 'Choose at least one file to export.');
    let checked; try { checked = schema.validatePayload({ schema: 1, files, items: [], note: '' }); } catch { return unavailable(); }
    const text = JSON.stringify({ kind: ENVELOPE_KIND, schema: 1, exported_at: new Date(now()).toISOString(), content_hash: checked.content_hash, payload: checked.payload }, null, 2) + '\n';
    return { ok: true, text, files: files.length };
  }

  // ── Import / plan ─────────────────────────────────────────────────────────
  function parseEnvelope(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.importBytes) return null;
    let env; try { env = JSON.parse(text); } catch { return null; }
    if (!isObject(env) || Object.keys(env).sort().join() !== 'content_hash,exported_at,kind,payload,schema' || env.kind !== ENVELOPE_KIND || env.schema !== 1 || typeof env.exported_at !== 'string' || env.exported_at.length > 40) return null;
    try { const checked = schema.validatePayload(env.payload); return checked.content_hash === env.content_hash ? checked : null; } catch { return null; }
  }

  function unitsFor(payload) {
    const units = [], dropped = [], targets = new Map();
    const vars = { HOME, USER: user() };
    const current = (file) => {
      if (!targets.has(file)) { try { const r = readTarget(file); targets.set(file, { text: r.text, mode: r.mode, ok: true }); } catch { targets.set(file, { ok: false }); } }
      return targets.get(file);
    };
    const jsonOf = (t) => { if (t.text == null) return {}; try { const v = JSON.parse(t.text); return isObject(v) ? v : null; } catch { return null; } };
    for (const file of payload.files) {
      const target = targetOf(file.relative_path), base = { id: `file:${file.id}`, target: file.relative_path, kind: target?.kind ?? 'unsupported' };
      if (!target) { units.push({ ...base, label: file.relative_path, status: 'unsupported', reason: 'Not a personal setup target. Shown for review only.', after: file.content }); continue; }
      if (findSecrets(file.content, { classes: ['credential'], standIns: true, docExamples: false }).length) { units.push({ ...base, label: file.relative_path, status: 'invalid', reason: 'Contains a credential. Secrets are never imported.' }); continue; }
      const t = current(target.file);
      if (!t.ok) { units.push({ ...base, label: file.relative_path, status: 'invalid', reason: 'The local file is a link, a folder or too large to change safely.' }); continue; }
      if (target.kind === 'settings' || target.kind === 'mcp') {
        let incoming; try { incoming = JSON.parse(file.content); } catch { incoming = null; }
        const local = jsonOf(t);
        if (!isObject(incoming)) { units.push({ ...base, label: file.relative_path, status: 'invalid', reason: 'Not a JSON object.' }); continue; }
        if (!local) { units.push({ ...base, label: file.relative_path, status: 'invalid', reason: 'Your local file is not valid JSON, so it is left alone.' }); continue; }
        if (target.kind === 'settings') {
          for (const key of ownKeys(incoming)) {
            if (!Object.hasOwn(SAFE_SETTINGS, key)) { dropped.push({ target: file.relative_path, key, reason: key === 'hooks' ? 'hooks run commands and are never imported' : 'not in the hook-free settings subset' }); continue; }
            units.push(jsonUnit({ id: `setting:${key}`, target: file.relative_path, file: target.file, kind: 'setting', label: `Setting: ${key}`, path: [key], value: incoming[key], local, t, confirm: SAFE_SETTINGS[key], reason: SAFE_SETTINGS[key] ? 'Changes which tools and commands run without asking.' : null }));
          }
        } else {
          const servers = incoming.mcpServers;
          if (!isObject(servers) || ownKeys(servers).length > LIMITS.mcpServers) { units.push({ ...base, label: file.relative_path, status: 'invalid', reason: `MCP entries must be an object of at most ${LIMITS.mcpServers} servers.` }); continue; }
          const localServers = local.mcpServers === undefined ? {} : local.mcpServers;
          for (const name of Object.keys(servers)) {
            const value = servers[name];
            if (!MCP_NAME.test(name) || !isObject(value) || Buffer.byteLength(JSON.stringify(value)) > LIMITS.mcpBytes) { units.push({ ...base, id: `mcp:${name.slice(0, 64)}`, label: `MCP server: ${name.slice(0, 64)}`, status: 'invalid', reason: 'Unsupported MCP server name or entry.' }); continue; }
            if (!isObject(localServers)) { units.push({ ...base, id: `mcp:${name}`, label: `MCP server: ${name}`, status: 'invalid', reason: 'Your local mcpServers is not an object, so it is left alone.' }); continue; }
            units.push(jsonUnit({ id: `mcp:${name}`, target: file.relative_path, file: target.file, kind: 'mcp', label: `MCP server: ${name}`, path: ['mcpServers', name], value, local, t, confirm: true, reason: 'Claude Code starts this command when it loads MCP servers. Nothing runs during import.', command: commandLine(value) }));
          }
        }
        continue;
      }
      const after = fill(file.content, vars);
      units.push({ ...base, file: target.file, label: file.relative_path, status: t.text === after ? 'unchanged' : 'ready', requires_confirm: target.code, reason: target.code ? 'Not plain text: an AI tool may run this file later. It is written without execute permission.' : null, before: t.text, after, before_hash: sha(t.text), template: file.content, placeholders: placeholders(file.content) });
    }
    return { units, dropped };
  }
  function jsonUnit({ id, target, file, kind, label, path: at, value, local, t, confirm, reason, command }) {
    const vars = { HOME, USER: user() };
    const filled = fillJson(value, vars), template = pretty(value);
    const parent = at.length === 2 ? (isObject(local[at[0]]) ? local[at[0]] : {}) : local;
    const had = Object.hasOwn(parent, at.at(-1));
    const before = had ? pretty(parent[at.at(-1)]) : null, after = pretty(filled);
    return { id, target, file, kind, label, status: before === after ? 'unchanged' : 'ready', requires_confirm: confirm, reason, command, path: at, value, before, after, before_hash: sha(t.text), template, placeholders: placeholders(template) };
  }
  function commandLine(v) {
    const parts = [];
    if (typeof v.command === 'string') parts.push(v.command);
    if (Array.isArray(v.args)) parts.push(...v.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))));
    if (typeof v.url === 'string') parts.push(`(${v.type ?? 'remote'}) ${v.url}`);
    return parts.join(' ');
  }

  function planFromPayload(payload, origin) {
    let checked; try { checked = schema.validatePayload(payload); } catch { return refuse('invalid', 'This setup is not a valid reviewed setup.'); }
    const { units, dropped } = unitsFor(checked.payload);
    const handle = keep(plans, { origin, content_hash: checked.content_hash, units });
    const plan = live(plans, handle);
    return {
      ok: true, handle, origin, content_hash: checked.content_hash, expires_at: plan.expires, dropped,
      units: units.map((u) => ({ id: u.id, kind: u.kind, label: u.label, target: u.target, status: u.status, requires_confirm: !!u.requires_confirm, reason: u.reason ?? null, command: u.command ?? null, placeholders: u.placeholders ?? [], before: shown(u.before ?? null), after: u.after ?? null, diff: u.status === 'ready' || u.status === 'unchanged' ? diffLines(shown(u.before ?? null), u.after) : [] })),
    };
  }
  function planFromText(text) { const checked = parseEnvelope(text); return checked ? planFromPayload(checked.payload, 'file') : refuse('invalid', 'This file is not a Plexiform setup export, or it was changed or is too large.'); }

  // ── Apply / backups / Undo ────────────────────────────────────────────────
  function summary(handle, selected) {
    const plan = live(plans, handle);
    if (!plan || !Array.isArray(selected)) return null;
    return plan.units.filter((u) => selected.includes(u.id)).map((u) => ({ id: u.id, label: u.label, target: u.target, requires_confirm: !!u.requires_confirm, command: u.command ?? null }));
  }

  function apply(handle, { selected, confirmed = [], values } = {}) {
    const plan = live(plans, handle);
    if (plan) plans.delete(handle); // one use
    const vals = checkValues(values);
    if (!plan || !Array.isArray(selected) || !selected.length || selected.length > 512 || !Array.isArray(confirmed) || confirmed.length > 512 || vals === null) return unavailable();
    if (new Set(selected).size !== selected.length || selected.some((id) => typeof id !== 'string')) return unavailable();
    const chosen = selected.map((id) => plan.units.find((u) => u.id === id));
    if (chosen.some((u) => !u || u.status !== 'ready')) return refuse('invalid', 'Choose only changes that are ready to apply.');
    if (chosen.some((u) => u.requires_confirm && !confirmed.includes(u.id))) return refuse('confirm', 'Confirm each MCP server, permission and runnable file one by one before Apply.');
    const vars = { ...vals, HOME, USER: user() };
    const byFile = new Map();
    for (const u of chosen) {
      if (u.placeholders.some((p) => !Object.hasOwn(vals, p))) return refuse('values', `Fill in your own value for ${u.placeholders.filter((p) => !Object.hasOwn(vals, p)).join(', ')} first.`);
      if (!byFile.has(u.file)) byFile.set(u.file, []);
      byFile.get(u.file).push(u);
    }
    // Recheck every target against the previewed state, then build the new text.
    const writes = [];
    for (const [file, list] of byFile) {
      let t; try { t = readTarget(file); } catch { return refuse('changed', 'A target became a link or an unsupported file. Nothing was changed.'); }
      if (sha(t.text) !== list[0].before_hash) return refuse('changed', `${list[0].target} changed since the preview. Nothing was changed; import again to review.`);
      if (list[0].path) {
        const doc = t.text == null ? {} : JSON.parse(t.text), records = [], created = new Set();
        for (const u of list) {
          const value = fillJson(u.value, vars);
          if (leftover(JSON.stringify(value))) return refuse('values', 'Some placeholders have no value yet.');
          let parent = doc;
          if (u.path.length === 2) { if (!Object.hasOwn(doc, u.path[0])) { doc[u.path[0]] = {}; created.add(u.path[0]); } parent = doc[u.path[0]]; }
          const key = u.path.at(-1), had = Object.hasOwn(parent, key);
          records.push({ type: 'json', id: u.id, path: u.path, had, before: had ? parent[key] : null, after: value, created_parent: created.has(u.path[0]) });
          parent[key] = value;
        }
        writes.push({ file, existed: t.text != null, before: t.text, mode: t.mode, text: pretty(doc) + '\n', units: records });
      } else {
        const u = list[0], text = fill(u.template, vars);
        if (leftover(text)) return refuse('values', 'Some placeholders have no value yet.');
        writes.push({ file, existed: t.text != null, before: t.text, mode: t.mode ?? 0o600, text, units: [{ type: 'file', id: u.id }] });
      }
    }
    const id = randomUUID(), dir = path.join(BACKUPS, id);
    const manifest = { schema: 1, id, created_at: new Date(now()).toISOString(), origin: plan.origin, content_hash: plan.content_hash, status: 'applying', targets: writes.map((w) => ({ file: w.file, existed: w.existed, before: w.before, after_hash: sha(w.text), mode: w.mode, units: w.units })) };
    try { writeManifest(dir, manifest, true); } catch { return refuse('backup', 'Could not save a backup first, so nothing was changed.'); }
    const done = [];
    try {
      for (const w of writes) { writeTarget(w.file, w.text, w.mode); done.push(w); }
    } catch {
      for (const w of done.reverse()) { try { if (w.existed) writeTarget(w.file, w.before, w.mode); else removeTarget(w.file); } catch { /* left for Undo */ } }
      try { writeManifest(dir, { ...manifest, status: 'rolled_back' }); } catch { /* the backup still holds the originals */ }
      return refuse('failed', 'A file could not be written. Every change was rolled back from the backup.');
    }
    try { writeManifest(dir, { ...manifest, status: 'applied' }); } catch { /* applying status still allows Undo */ }
    return { ok: true, backup_id: id, applied: chosen.length, files: writes.length };
  }

  function writeManifest(dir, manifest, create = false) {
    if (create) {
      fsApi.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
      if (fsApi.lstatSync(BACKUPS).isSymbolicLink()) throw new Error('link');
      fsApi.mkdirSync(dir, { mode: 0o700 });
    }
    const tmp = path.join(dir, `manifest.${randomUUID()}.tmp`);
    const fd = fsApi.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    try { fsApi.writeFileSync(fd, JSON.stringify(manifest), 'utf8'); fsApi.fsyncSync(fd); } finally { fsApi.closeSync(fd); }
    fsApi.renameSync(tmp, path.join(dir, 'manifest.json'));
  }
  function readManifest(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const file = path.join(BACKUPS, id, 'manifest.json');
    let fd;
    try {
      if (fsApi.lstatSync(BACKUPS).isSymbolicLink() || fsApi.lstatSync(path.join(BACKUPS, id)).isSymbolicLink()) return null;
      fd = fsApi.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
      const st = fsApi.fstatSync(fd);
      if (!st.isFile() || st.size > LIMITS.manifestBytes) return null;
      const m = JSON.parse(fsApi.readFileSync(fd, 'utf8'));
      if (!isObject(m) || m.schema !== 1 || m.id !== id || !Array.isArray(m.targets) || m.targets.some((t) => !isObject(t) || !targetOf(t.file === '.claude.json' ? '.claude.json#mcpServers' : t.file) || !Array.isArray(t.units) || t.units.some((u) => !isObject(u) || (u.type !== 'file' && !(Array.isArray(u.path) && u.path.length >= 1 && u.path.length <= 2 && u.path.every((k) => typeof k === 'string' && (Object.hasOwn(SAFE_SETTINGS, k) || k === 'mcpServers' || MCP_NAME.test(k)))))))) return null;
      return m;
    } catch { return null; } finally { if (fd !== undefined) try { fsApi.closeSync(fd); } catch { /* closed */ } }
  }

  function backups() {
    let names = [];
    try { if (!fsApi.lstatSync(BACKUPS).isSymbolicLink()) names = fsApi.readdirSync(BACKUPS).filter((n) => UUID.test(n)); } catch { names = []; }
    const list = names.map(readManifest).filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, LIMITS.backups);
    return { ok: true, backups: list.map((m) => ({ id: m.id, created_at: m.created_at, origin: m.origin, status: m.status, files: m.targets.map((t) => t.file), changes: m.targets.reduce((n, t) => n + t.units.length, 0) })) };
  }

  // Restores only what still matches what Apply wrote: a whole file by hash, a
  // JSON key by value. Anything changed since is left alone and reported.
  function undo(id) {
    const m = readManifest(id);
    if (!m || !['applied', 'applying'].includes(m.status)) return unavailable();
    const restored = [], conflicts = [];
    for (const t of m.targets) {
      let cur; try { cur = readTarget(t.file); } catch { conflicts.push(t.file); continue; }
      try {
        if (t.units.length === 1 && t.units[0].type === 'file') {
          if (sha(cur.text) !== t.after_hash) { conflicts.push(t.file); continue; }
          if (t.existed) writeTarget(t.file, t.before, t.mode); else removeTarget(t.file);
          restored.push(t.file);
          continue;
        }
        let doc; try { doc = cur.text == null ? null : JSON.parse(cur.text); } catch { doc = null; }
        if (!isObject(doc)) { conflicts.push(t.file); continue; }
        let changed = false;
        for (const u of t.units) {
          const parent = u.path.length === 2 ? doc[u.path[0]] : doc, key = u.path.at(-1);
          if (!isObject(parent) || !Object.hasOwn(parent, key) || schema.canonical(parent[key]) !== schema.canonical(u.after)) { conflicts.push(`${t.file}: ${u.path.join('.')}`); continue; }
          if (u.had) parent[key] = u.before; else delete parent[key];
          changed = true;
          restored.push(`${t.file}: ${u.path.join('.')}`);
        }
        for (const u of t.units) if (u.created_parent === true && isObject(doc[u.path[0]]) && !Object.keys(doc[u.path[0]]).length) delete doc[u.path[0]];
        if (changed) { if (!t.existed && !Object.keys(doc).length) removeTarget(t.file); else writeTarget(t.file, pretty(doc) + '\n', cur.mode); }
      } catch { conflicts.push(t.file); }
    }
    try { writeManifest(path.join(BACKUPS, id), { ...m, status: conflicts.length ? 'partly_undone' : 'undone' }); } catch { /* restore already happened */ }
    return { ok: true, restored, conflicts };
  }

  return { collect, exportText, parseEnvelope, planFromText, planFromPayload, summary, apply, backups, undo, invalidate };
}

// ── Electron wiring (paid-wiring package contract) ─────────────────────────
const READ_MAX = LIMITS.importBytes;
function readChosen(file) {
  let fd;
  try {
    const st0 = fs.lstatSync(file);
    if (st0.isSymbolicLink() || !st0.isFile() || st0.size > READ_MAX) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > READ_MAX || st.ino !== st0.ino) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeChosen(file, text) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600); fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function register(ctx) {
  if (!ctx?.entitlements?.has?.('setups.personal') || !ctx.ipcMain) return;
  const { dialog } = require('electron');
  const engine = createPersonalSetups({ home: os.homedir(), dataRoot: ctx.rootDir, machine: () => ({ user: os.userInfo().username, hostname: os.hostname() }) });
  const ok = (e) => { try { return ctx.fromPage(e, 'setups') === true; } catch { return false; } };
  const ask = async (opts) => (await dialog.showMessageBox({ type: 'warning', defaultId: 0, cancelId: 0, noLink: true, ...opts })).response === 1;
  const handle = (channel, fn) => ctx.ipcMain.handle(channel, async (e, ...args) => { if (!ok(e)) return null; try { return await fn(...args); } catch { return unavailable(); } });
  handle('setups:personal-collect', () => engine.collect());
  handle('setups:personal-export', async (draft, excluded) => {
    const out = engine.exportText(draft, excluded);
    if (!out.ok) return out;
    const r = await dialog.showSaveDialog({ title: 'Export my setup', defaultPath: 'my-plexiform-setup.json', filters: [{ name: 'Plexiform setup', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return refuse('cancelled', 'Export cancelled.');
    try { writeChosen(r.filePath, out.text); } catch { return refuse('failed', 'Choose a new file name. Existing files and links are never overwritten.'); }
    return { ok: true, exported: true, files: out.files };
  });
  handle('setups:personal-import', async () => {
    const r = await dialog.showOpenDialog({ title: 'Import a setup', properties: ['openFile'], filters: [{ name: 'Plexiform setup', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths?.[0]) return refuse('cancelled', 'Import cancelled.');
    const text = readChosen(r.filePaths[0]);
    return text == null ? refuse('invalid', 'Choose a regular setup file under 2 MB.') : engine.planFromText(text);
  });
  handle('setups:team-plan', async (profileHandle) => {
    if (typeof profileHandle !== 'string' || profileHandle.length > 100 || typeof ctx.setups?.readForPlan !== 'function') return unavailable();
    const source = await ctx.setups.readForPlan(profileHandle);
    return source ? engine.planFromPayload(source.payload, 'team') : refuse('unavailable', 'This team setup is unavailable. Team setups need the Team plan and current team access.');
  });
  handle('setups:personal-apply', async (planHandle, input) => {
    if (!isObject(input) || Object.keys(input).some((k) => !['selected', 'confirmed', 'values'].includes(k))) return unavailable();
    const items = engine.summary(planHandle, input.selected);
    if (!items?.length) return unavailable();
    const risky = items.filter((i) => i.requires_confirm);
    const detail = [`${items.length} change${items.length === 1 ? '' : 's'} to: ${[...new Set(items.map((i) => i.target))].join(', ')}.`, 'A backup is saved first; Undo restores it. Nothing runs now.', ...(risky.length ? ['', 'You confirmed these one by one:', ...risky.map((i) => `• ${i.label}${i.command ? `\n  ${i.command}` : ''}`)] : [])].join('\n');
    if (!(await ask({ title: 'Apply setup', message: 'Apply the reviewed setup changes?', detail, buttons: ['Cancel', 'Apply'] }))) return refuse('cancelled', 'Apply cancelled. Nothing was changed.');
    return engine.apply(planHandle, input);
  });
  handle('setups:personal-backups', () => engine.backups());
  handle('setups:personal-undo', async (id) => {
    if (typeof id !== 'string' || !UUID.test(id)) return unavailable();
    if (!(await ask({ title: 'Undo setup change', message: 'Restore the backup from before this Apply?', detail: 'Only files and entries still exactly as Apply left them are restored. Anything changed since is kept and listed.', buttons: ['Cancel', 'Undo'] }))) return refuse('cancelled', 'Undo cancelled.');
    return engine.undo(id);
  });
  ctx.onQuit?.(() => engine.invalidate());
}

module.exports = { createPersonalSetups, register, diffLines, targetOf, SAFE_SETTINGS, ENVELOPE_KIND, LIMITS };
