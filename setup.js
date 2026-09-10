// A whole customisation as one portable file: rules, presets, router
// settings, the agent display and the user's own cameo photos (base64 PNGs,
// never the shipped built-ins). Pure: main.js does the dialogs and hands the
// plan to saveConfig and Cameos.importPhoto/removePhoto, which keep their own
// invariants.
const Rules = require('./rules.js');
const Cameos = require('./cameos.js');
const Delegate = require('./hooks/delegate.js');
const Router = require('./router.js');

const KIND = 'claude-buddy-setup';
// Bump with an entry in UPGRADES when the bundle's shape changes. Rules carry
// their own version (Rules.RULES_VERSION) and migrate through migrateRules.
const SETUP_VERSION = 1;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RULES = 300;
const MAX_PRESETS = 100;
const MAX_CAMEOS = 64;
const MAX_PNG_BYTES = 1024 * 1024;
const MAX_PROJECTS = 500;
const CHIP_SIZES = ['small', 'normal', 'large'];
const PROJECT_MODELS = ['opus', 'sonnet', 'haiku'];
const ITEM_ID = /^[\w-]{1,40}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);

// normalizeRule trusts its input's types (it .trim()s when.tool), so strings
// are made strings first.
function cleanRules(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const r of list.slice(0, MAX_RULES)) {
    if (!isObj(r)) continue;
    const when = isObj(r.when) ? r.when : {};
    const signal = (Array.isArray(when.signal) ? when.signal : [when.signal]).filter((s) => typeof s === 'string' && s && s.length <= 40).slice(0, 20);
    const rule = Rules.normalizeRule({
      ...r,
      id: typeof r.id === 'string' && ITEM_ID.test(r.id) ? r.id : undefined,
      name: str(r.name, 60),
      when: { signal, tool: str(when.tool, 200), cwd: str(when.cwd, 200), source: str(when.source, 40) },
      then: isObj(r.then) ? r.then : {},
    });
    while (seen.has(rule.id)) rule.id = Rules.uid();
    seen.add(rule.id);
    out.push(rule);
  }
  return out;
}

function cleanPresets(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.slice(0, MAX_PRESETS)
    .filter((p) => isObj(p) && typeof p.name === 'string' && p.name.trim() && Array.isArray(p.rules))
    .map((p) => {
      let id = typeof p.id === 'string' && ITEM_ID.test(p.id) ? p.id : Rules.uid();
      while (seen.has(id)) id = Rules.uid();
      seen.add(id);
      return { id, name: p.name.trim().slice(0, 30), rules: cleanRules(p.rules) };
    });
}

function cleanConfig(c) {
  const out = {};
  if (!isObj(c)) return out;
  const rules = cleanRules(c.rules);
  // A file whose rules all fail to parse must not wipe the user's.
  if (rules.length) out.rules = rules;
  if (Array.isArray(c.presets)) out.presets = cleanPresets(c.presets);
  if (Router.POLICIES.includes(c.routerPolicy)) out.routerPolicy = c.routerPolicy;
  if (isObj(c.routerProjects)) {
    out.routerProjects = {};
    for (const [k, v] of Object.entries(c.routerProjects).slice(0, MAX_PROJECTS)) if (k.length <= 1024 && PROJECT_MODELS.includes(v)) out.routerProjects[k] = v;
  }
  if (isObj(c.routerDelegation)) {
    const d = c.routerDelegation;
    const allow = Array.isArray(d.allow) ? d.allow.filter((s) => typeof s === 'string' && s.length <= 200) : [];
    out.routerDelegation = Delegate.normalize({ ...Delegate.DEFAULTS, ...d, allow });
  }
  for (const k of ['showAgents', 'agentRoster']) if (typeof c[k] === 'boolean') out[k] = c[k];
  if (isObj(c.agentKinds)) {
    out.agentKinds = {};
    for (const k of Rules.AGENT_KINDS) if (typeof c.agentKinds[k] === 'boolean') out.agentKinds[k] = c.agentKinds[k];
  }
  if (CHIP_SIZES.includes(c.agentChipSize)) out.agentChipSize = c.agentChipSize;
  return out;
}

function cleanCameos(list) {
  const cameos = [];
  let dropped = 0;
  if (!Array.isArray(list)) return { cameos, dropped };
  dropped = Math.max(0, list.length - MAX_CAMEOS);
  for (const c of list.slice(0, MAX_CAMEOS)) {
    const id = isObj(c) && typeof c.id === 'string' ? c.id : '';
    const entry = id !== 'none' && !cameos.some((x) => x.id === id) ? Cameos.normalizeEntry(id, c) : null;
    const png = entry && typeof c.png === 'string' && c.png.length <= Math.ceil(MAX_PNG_BYTES / 3) * 4 ? Buffer.from(c.png, 'base64') : null;
    if (png && Cameos.isCameoPng(png)) cameos.push({ id, entry, png });
    else dropped += 1;
  }
  return { cameos, dropped };
}

// Older bundle shapes, oldest first: UPGRADES[v] turns a v bundle into v+1.
// v0 is the rules-only file Lights' "Export to file…" writes.
const UPGRADES = [
  (raw) => ({ kind: KIND, v: 1, rulesVersion: Number(raw.rulesVersion) || 0, config: { rules: raw.rules } }),
];

function exportSetup({ config, cameoIndex = {}, readPng, now = Date.now() }) {
  const cfg = cleanConfig(config);
  const cameos = [];
  for (const [id, e] of Object.entries(cameoIndex)) {
    let png;
    try { png = readPng(id); } catch { continue; }
    cameos.push({ id, ...Cameos.normalizeEntry(id, e), png: png.toString('base64') });
  }
  return { kind: KIND, v: SETUP_VERSION, rulesVersion: Rules.RULES_VERSION, exportedAt: new Date(now).toISOString(), config: cfg, cameos };
}

// text → { v, rulesVersion, config (a saveConfig partial), cameos, hasCameos, dropped } or { error }.
function readSetup(text) {
  if (typeof text !== 'string') return { error: 'Not a setup file.' };
  if (Buffer.byteLength(text) > MAX_BYTES) return { error: 'That file is over 32 MB — too big to be a setup.' };
  let raw;
  try { raw = JSON.parse(text); } catch { return { error: 'That file is not valid JSON.' }; }
  if (!isObj(raw)) return { error: 'Not a Claude Buddy setup file.' };
  let from;
  if (raw.kind === KIND) from = Number.isInteger(raw.v) && raw.v >= 1 ? raw.v : null;
  else if (Array.isArray(raw.rules)) from = 0;
  else return { error: 'Not a Claude Buddy setup file.' };
  if (from === null) return { error: 'That setup file has no version.' };
  if (from > SETUP_VERSION) return { error: 'That setup was made by a newer Claude Buddy — update to import it.' };
  let bundle = raw;
  for (let v = from; v < SETUP_VERSION; v += 1) bundle = UPGRADES[v](bundle);
  const rulesVersion = Number.isFinite(Number(bundle.rulesVersion)) ? Number(bundle.rulesVersion) : 0;
  const config = cleanConfig(bundle.config);
  // As an old config.json does on load: default rules added since slot in.
  if (config.rules) config.rules = Rules.migrateRules(config.rules, rulesVersion);
  const { cameos, dropped } = cleanCameos(bundle.cameos);
  return { v: from, rulesVersion, config, cameos, hasCameos: Array.isArray(bundle.cameos), dropped };
}

// What the renderer shows before asking replace-or-merge, including every
// command a click in the file would run, since it came from someone else.
function summarize(parsed) {
  const all = [...(parsed.config.rules || []), ...(parsed.config.presets || []).flatMap((p) => p.rules)];
  const commands = [...new Set(all.flatMap((r) => Object.values(r.then.clicks || {}))
    .filter((a) => (a.type === 'shell' || a.type === 'shortcut') && a.arg).map((a) => a.arg))];
  return {
    rules: parsed.config.rules ? parsed.config.rules.length : null,
    presets: parsed.config.presets ? parsed.config.presets.length : null,
    cameos: parsed.cameos.length,
    settings: Object.keys(parsed.config).filter((k) => k !== 'rules' && k !== 'presets'),
    commands,
    dropped: parsed.dropped,
    old: parsed.v < SETUP_VERSION || parsed.rulesVersion < Rules.RULES_VERSION,
  };
}

// → { partial (for saveConfig), remove (cameo ids), add ([{ id, entry, png }]) }.
// replace: the file's settings, rules, presets and faces become the user's.
// merge: only its presets and faces are added; rules and settings stay.
// Either way a file never switches delegation on or off: that edits Claude
// Code's hooks, which the user does from the Router tab.
function planImport(parsed, { config, cameoIndex = {}, readPng = () => null }, mode) {
  const enabled = !!config.routerDelegation?.enabled;
  if (mode === 'replace') {
    const partial = { ...parsed.config };
    if (partial.routerDelegation) partial.routerDelegation = { ...partial.routerDelegation, enabled };
    const incoming = new Set(parsed.cameos.map((c) => c.id));
    const remove = parsed.hasCameos ? Object.keys(cameoIndex).filter((id) => !incoming.has(id)) : [];
    return { partial, remove, add: parsed.cameos };
  }

  const index = { ...cameoIndex };
  const mine = [];
  for (const id of Object.keys(cameoIndex)) {
    try { mine.push([id, readPng(id)]); } catch { /* unreadable: can't be a duplicate */ }
  }
  // Presets in the file follow its faces to wherever they land.
  const renamed = {};
  const add = [];
  for (const c of parsed.cameos) {
    let { id } = c;
    const same = mine.find(([, png]) => png && Buffer.compare(png, c.png) === 0);
    if (same) { renamed[c.id] = same[0]; continue; }
    if (index[id]) {
      // A built-in the user replaced themselves: keep theirs.
      if (Cameos.BUILTINS.includes(id)) continue;
      id = Cameos.resolveId(index, { name: id }).id;
      renamed[c.id] = id;
    }
    index[id] = c.entry;
    add.push({ ...c, id });
  }

  const partial = {};
  if (parsed.config.presets) {
    const presets = [...(config.presets || [])];
    const key = (p) => p.name.toLowerCase();
    for (const p of parsed.config.presets) {
      if (presets.length >= MAX_PRESETS) break;
      const rules = p.rules.map((r) => (renamed[r.then.cameo] ? { ...r, then: { ...r.then, cameo: renamed[r.then.cameo] } } : r));
      // Same rules under any name is a preset the user already has.
      if (presets.some((m) => JSON.stringify(m.rules) === JSON.stringify(rules))) continue;
      let { name } = p;
      for (let n = 2; presets.some((m) => key(m) === name.toLowerCase()); n += 1) name = `${p.name.slice(0, 29 - String(n).length)} ${n}`;
      let { id } = p;
      while (presets.some((m) => m.id === id)) id = Rules.uid();
      presets.push({ id, name, rules });
    }
    partial.presets = presets;
  }
  return { partial, remove: [], add };
}

module.exports = {
  KIND, SETUP_VERSION, MAX_BYTES, MAX_RULES, MAX_PRESETS, MAX_CAMEOS, MAX_PNG_BYTES,
  cleanRules, cleanPresets, cleanConfig, cleanCameos, exportSetup, readSetup, summarize, planImport,
};
