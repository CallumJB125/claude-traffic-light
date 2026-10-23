// Registers mcp-server.js with Claude Code at user scope: the top-level
// `mcpServers` key of ~/.claude.json, which every project on this machine
// sees (https://code.claude.com/docs/en/mcp — "Where servers are saved").
//
// ~/.claude.json is Claude Code's own busy state file, so this touches exactly
// one key under mcpServers, refuses to write over a file it can't parse, and
// never replaces a same-named server that isn't ours.
const fs = require('fs');
const path = require('path');
const os = require('os');
const Runtime = require('./adapters/runtime.js');

const NAME = 'claude-buddy';
const SCRIPT = 'mcp-server.js';
// The bus-only profile Plexiform registers by itself (plan-agent-awareness §3.9): its own name, and a marker
// naming the channel, so a packaged app and a dev checkout never re-point each other's entry.
const BUS_NAME = 'plexiform-bus';
const MARKER = 'PLEXIFORM_MCP';
const markerFor = (channel) => `bus-v1:${channel === 'dev' ? 'dev' : 'packaged'}`;

const configPath = (home = os.homedir()) => path.join(home, '.claude.json');

// How Claude Code should launch the server. A packaged app has no plain-node
// copy of the SDK: mcp-server.js and its node_modules live inside app.asar,
// which only Electron's own node can read, so it runs the app binary as node
// (the same trick the hook commands use).
// --disable-sigusr1: main trusts this program to act only on its parent's requests (src/agent-awareness.js
// bindOnce), and SIGUSR1 would start an inspector any program running as the person could drive; the
// listener in mcp-server.js comes too late for the first few milliseconds after start.
const NODE_FLAGS = Object.freeze(['--disable-sigusr1']);
// Node has --disable-sigusr1 from 22.14 and 23.7 (every later major too); an older node refuses to start with it.
// The packaged app runs Electron's own node, which has it.
function nodeHasFlags(version) {
  const m = /^v?(\d+)\.(\d+)\.\d+/.exec(String(version || ''));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 23 || (major === 23 && minor >= 7) || (major === 22 && minor >= 14);
}
// nodeVersion: `node --version` of the node a dev launch runs. Without the flag the server still starts, and main
// never binds a caller to it (src/agent-awareness.js ourServers); Health says why (health.js checkMcpNode).
function launch({ packaged, execPath, appPath, dir, root, profile = null, nodeVersion = null }) {
  const env = { ...(root ? { CLAUDE_TRAFFIC_LIGHT_HOME: root } : {}), ...(profile === 'bus' ? { [MARKER]: markerFor(packaged ? 'packaged' : 'dev') } : {}) };
  const extra = profile === 'bus' ? ['--profile', 'bus'] : [];
  return packaged
    ? { type: 'stdio', command: execPath, args: [...NODE_FLAGS, path.join(appPath, SCRIPT), ...extra], env: { ELECTRON_RUN_AS_NODE: '1', ...env } }
    : { type: 'stdio', command: 'node', args: [...(nodeHasFlags(nodeVersion) ? NODE_FLAGS : []), path.join(dir, SCRIPT), ...extra], env };
}

// The full server: any entry running our script. The bus profile: only an entry carrying the marker.
const markerOf = (entry) => (entry && entry.env && typeof entry.env === 'object' && typeof entry.env[MARKER] === 'string' && /^bus-v1:(?:packaged|dev)$/.test(entry.env[MARKER]) ? entry.env[MARKER] : null);
const isOurs = (entry, name = NAME) => (name === NAME
  ? !!entry && Array.isArray(entry.args) && entry.args.some((a) => path.basename(String(a)) === SCRIPT)
  : !!markerOf(entry));

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } };

function parse(text, file) {
  if (text === null) return {};
  const data = JSON.parse(text); // a parse failure must abort, not clobber
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} is not a JSON object`);
  return data;
}

const read = (file) => parse(readText(file), file);

// Atomic, through a dotfiles symlink, in the file's own indent and newline
// style, and only if nobody (Claude Code) wrote in between (Runtime.writeTextAtomic).
function edit(home, change) {
  const file = configPath(home);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const readAt = Runtime.mtimeOf(file);
    const text = readText(file);
    const data = parse(text, file);
    const out = change(data);
    if (!out.changed) return { ...out, path: file };
    const next = text === null ? `${JSON.stringify(data, null, 2)}\n` : Runtime.jsonTextLike(text, data);
    if (Runtime.writeTextAtomic(file, next, fs, readAt, { newMode: 0o600 })) return { ...out, path: file };
  }
  throw new Error(`${file} kept changing under us; try again`);
}

// A bus-profile entry of the other channel is someone else's (a dev checkout vs the installed app): left alone.
const sameChannel = (cur, entry, name) => name === NAME || markerOf(cur) === markerOf(entry);

function install({ home, entry, name = NAME }) {
  return edit(home, (data) => {
    const servers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {};
    const cur = servers[name];
    if (cur && !isOurs(cur, name)) throw Object.assign(new Error(`an MCP server named "${name}" already exists and isn't Plexiform's`), { code: 'FOREIGN' });
    if (cur && !sameChannel(cur, entry, name)) throw Object.assign(new Error(`"${name}" belongs to another copy of Plexiform`), { code: 'OTHER_CHANNEL' });
    if (JSON.stringify(cur) === JSON.stringify(entry)) return { changed: false };
    data.mcpServers = { ...servers, [name]: entry };
    return { changed: true };
  });
}

// marker: remove a bus-profile entry only while it still carries exactly this marker.
function uninstall({ home, name = NAME, marker = null }) {
  return edit(home, (data) => {
    const cur = data.mcpServers && data.mcpServers[name];
    if (!isOurs(cur, name) || (marker && markerOf(cur) !== marker)) return { changed: false };
    const { [name]: _gone, ...rest } = data.mcpServers;
    data.mcpServers = rest;
    return { changed: true };
  });
}

// Our entry, rewritten in place: to(cur) → the new entry, or null to leave it. Decided on what this atomic edit read,
// so a change landing in between is never overwritten.
function rewrite({ home, name = NAME, to }) {
  return edit(home, (data) => {
    const cur = data.mcpServers && data.mcpServers[name];
    if (!isOurs(cur, name)) return { changed: false };
    const next = to(cur);
    if (!next || JSON.stringify(next) === JSON.stringify(cur)) return { changed: false };
    data.mcpServers = { ...data.mcpServers, [name]: next };
    return { changed: true };
  });
}

function status({ home, entry, name = NAME }) {
  let cur = null;
  let error = null;
  try { cur = (read(configPath(home)).mcpServers || {})[name] || null; } catch (err) { error = err.message; }
  return { installed: isOurs(cur, name), current: !!entry && JSON.stringify(cur) === JSON.stringify(entry), name, path: configPath(home), entry: cur, error };
}

module.exports = { NAME, BUS_NAME, MARKER, NODE_FLAGS, nodeHasFlags, markerFor, markerOf, configPath, launch, isOurs, install, uninstall, rewrite, status };
