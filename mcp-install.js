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

const NAME = 'claude-buddy';
const SCRIPT = 'mcp-server.js';

const configPath = (home = os.homedir()) => path.join(home, '.claude.json');

// How Claude Code should launch the server. A packaged app has no plain-node
// copy of the SDK: mcp-server.js and its node_modules live inside app.asar,
// which only Electron's own node can read, so it runs the app binary as node
// (the same trick the router shim falls back on).
function launch({ packaged, execPath, appPath, dir, root }) {
  const env = root ? { CLAUDE_TRAFFIC_LIGHT_HOME: root } : {};
  return packaged
    ? { type: 'stdio', command: execPath, args: [path.join(appPath, SCRIPT)], env: { ELECTRON_RUN_AS_NODE: '1', ...env } }
    : { type: 'stdio', command: 'node', args: [path.join(dir, SCRIPT)], env };
}

const isOurs = (entry) => !!entry && Array.isArray(entry.args) && entry.args.some((a) => path.basename(String(a)) === SCRIPT);

function read(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  const data = JSON.parse(text); // a parse failure must abort, not clobber
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} is not a JSON object`);
  return data;
}

const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };

// Temp file + rename, and only if nobody (Claude Code) wrote in between.
function writeUnchanged(file, data, readAt) {
  if (mtime(file) !== readAt) return false;
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* first write */ }
  const tmp = `${file}.${process.pid}.buddy.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  if (mtime(file) !== readAt) { fs.rmSync(tmp, { force: true }); return false; }
  fs.renameSync(tmp, file);
  return true;
}

function edit(home, change) {
  const file = configPath(home);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const readAt = mtime(file);
    const data = read(file);
    const out = change(data);
    if (!out.changed) return { ...out, path: file };
    if (writeUnchanged(file, data, readAt)) return { ...out, path: file };
  }
  throw new Error(`${file} kept changing under us; try again`);
}

function install({ home, entry }) {
  return edit(home, (data) => {
    const servers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {};
    const cur = servers[NAME];
    if (cur && !isOurs(cur)) throw new Error(`an MCP server named "${NAME}" already exists and isn't Claude Buddy's`);
    if (JSON.stringify(cur) === JSON.stringify(entry)) return { changed: false };
    data.mcpServers = { ...servers, [NAME]: entry };
    return { changed: true };
  });
}

function uninstall({ home }) {
  return edit(home, (data) => {
    if (!data.mcpServers || !isOurs(data.mcpServers[NAME])) return { changed: false };
    const { [NAME]: _gone, ...rest } = data.mcpServers;
    data.mcpServers = rest;
    return { changed: true };
  });
}

function status({ home, entry }) {
  let cur = null;
  let error = null;
  try { cur = (read(configPath(home)).mcpServers || {})[NAME] || null; } catch (err) { error = err.message; }
  return { installed: isOurs(cur), current: !!entry && JSON.stringify(cur) === JSON.stringify(entry), name: NAME, path: configPath(home), entry: cur, error };
}

module.exports = { NAME, configPath, launch, isOurs, install, uninstall, status };
