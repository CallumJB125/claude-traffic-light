// Switches delegation on and off: the buddy-reader/buddy-worker subagents in
// ~/.claude/agents, the delegate.js hooks in ~/.claude/settings.json and the
// flag file the hook reads. Like router-install.js every path is injectable,
// so tests run against a temp HOME, and it only ever touches its own files
// and entries.
const fs = require('fs');
const path = require('path');
const os = require('os');
const Hooks = require('./hooks/install.js');
const Delegate = require('./hooks/delegate.js');

const TEMPLATES = path.join(__dirname, 'agents');
// In each template's frontmatter: an agent file without it is the user's
// own and is never overwritten or removed.
const MARKER = '# claude-buddy: managed';

function paths({ home = os.homedir(), root } = {}) {
  const r = root || path.join(home, '.claude-traffic-light');
  return {
    home,
    root: r,
    settings: path.join(home, '.claude', 'settings.json'),
    agentsDir: path.join(home, '.claude', 'agents'),
    flag: path.join(r, 'router', 'delegation.json'),
    log: path.join(r, 'router', 'delegations.jsonl'),
  };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function templates(dir = TEMPLATES) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

// A settings file that won't parse is the user's to fix; overwriting it
// would lose everything in it.
function readSettings(file) {
  const text = readText(file);
  if (text == null || !text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new Error(`Could not parse ${file} — not touching it`); }
}

function writeSettings(file, before, settings) {
  const after = JSON.stringify(settings, null, 2);
  if (after === before) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  return true;
}

function readFlag(opts = {}) {
  try { return JSON.parse(fs.readFileSync(paths(opts).flag, 'utf8')); } catch { return null; }
}

function writeFlag(opts, config, enabled) {
  const p = paths(opts);
  fs.mkdirSync(path.dirname(p.flag), { recursive: true });
  const tmp = `${p.flag}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...Delegate.normalize(config), enabled: !!enabled }, null, 2));
  fs.renameSync(tmp, p.flag);
}

// opts: { home, root, scriptPath, templatesDir, config }.
function install(opts = {}) {
  const p = paths(opts);
  const settings = readSettings(p.settings);
  const before = JSON.stringify(settings, null, 2);
  const conflicts = [];
  fs.mkdirSync(p.agentsDir, { recursive: true });
  for (const t of templates(opts.templatesDir)) {
    const dest = path.join(p.agentsDir, t.name);
    const cur = readText(dest);
    if (cur != null && !cur.includes(MARKER)) { conflicts.push(dest); continue; }
    if (cur !== t.text) fs.writeFileSync(dest, t.text);
  }
  Hooks.installDelegation(settings, opts.scriptPath || Hooks.DELEGATE_SCRIPT);
  const settingsChanged = writeSettings(p.settings, before, settings);
  writeFlag(opts, opts.config, true);
  return { ...status(opts), conflicts, settingsChanged };
}

// Keeps the log and the thresholds (flag file, enabled:false) for next time.
function uninstall(opts = {}) {
  const p = paths(opts);
  const settings = readSettings(p.settings);
  const before = JSON.stringify(settings, null, 2);
  for (const t of templates(opts.templatesDir)) {
    const dest = path.join(p.agentsDir, t.name);
    if ((readText(dest) || '').includes(MARKER)) fs.rmSync(dest, { force: true });
  }
  Hooks.uninstallDelegation(settings);
  const settingsChanged = writeSettings(p.settings, before, settings);
  writeFlag(opts, readFlag(opts) || opts.config, false);
  return { ...status(opts), settingsChanged };
}

function status(opts = {}) {
  const p = paths(opts);
  let settings = {};
  try { settings = readSettings(p.settings); } catch { /* unparsable: not ours to judge */ }
  const agents = templates(opts.templatesDir).map((t) => ({ name: t.name.replace(/\.md$/, ''), installed: (readText(path.join(p.agentsDir, t.name)) || '').includes(MARKER) }));
  const hooks = Hooks.isDelegationInstalled(settings, opts.scriptPath || Hooks.DELEGATE_SCRIPT);
  const flag = readFlag(opts);
  return { installed: hooks && agents.every((a) => a.installed) && !!flag && flag.enabled === true, hooks, agents, flag: flag ? Delegate.normalize(flag) : null, settingsPath: p.settings, agentsDir: p.agentsDir };
}

// Every logged event, oldest first; `since` (ms) drops older ones.
function readLog(opts = {}, since = 0) {
  const text = readText(paths(opts).log) || '';
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (!since || Date.parse(e.at) >= since) out.push(e);
    } catch { /* partial line */ }
  }
  return out;
}

module.exports = { TEMPLATES, MARKER, paths, templates, install, uninstall, status, readFlag, writeFlag, readLog };
