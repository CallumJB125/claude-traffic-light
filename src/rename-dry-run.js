// `plexiform --rename-dry-run`: prints what the first launch after the rename
// would do on this machine (src/rename-migration.js planRename), and writes
// nothing. main.js runs it first thing, so no userData folder, log file,
// crash reporter or instance lock exists yet; paths come from appData and the
// app's name, as the real migration works them out. The runtime and MCP entry
// are made the way main.js makes them, minus the AppImage hooks copy (which
// writes): HookPaths.choose, which only works the paths out.
const fs = require('fs');
const os = require('os');
const path = require('path');

const writeAll = (text) => {
  const buf = Buffer.from(text);
  for (let off = 0; off < buf.length;) {
    try { off += fs.writeSync(1, buf, off); } catch (err) { if (err.code !== 'EAGAIN') throw err; }
  }
};

function main({ app = require('electron').app, home = os.homedir(), env = process.env, platform = process.platform, execPath = process.execPath, resourcesPath = process.resourcesPath, listProcesses, exists, out = writeAll } = {}) {
  const M = require('./rename-migration.js');
  const HookPaths = require('./hook-paths.js');
  const Runtime = require('../adapters/runtime.js');
  const McpInstall = require('../mcp-install.js');
  const appDir = path.join(__dirname, '..');
  const rootDir = env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(home, '.claude-traffic-light');
  const hp = HookPaths.choose({ packaged: app.isPackaged, platform, env, execPath, resourcesPath, appDir, appPath: app.getAppPath(), rootDir, version: app.getVersion() });
  const runtime = Runtime.make({ execPath: hp.execPath, platform, hooksDir: hp.hooksDir, dataDir: rootDir });
  const mcpEntry = McpInstall.launch({ packaged: app.isPackaged, execPath: hp.execPath || execPath, appPath: hp.mcpAppPath, dir: appDir, root: env.CLAUDE_TRAFFIC_LIGHT_HOME });
  let askFromWidget = false;
  try { askFromWidget = !!JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8')).askFromWidget; } catch { /* defaults */ }
  const plan = M.planRename({
    home, appData: app.getPath('appData'), newName: app.getName(), platform, runtime, mcpEntry, askFromWidget, rootDir, packaged: app.isPackaged, execPath,
    ...(listProcesses ? { listProcesses } : {}), ...(exists ? { exists } : {}),
  });
  out(M.formatPlan(plan));
  return plan;
}

module.exports = { main };
