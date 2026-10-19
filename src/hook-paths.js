// Where the hook commands and the MCP entry point. Normally that is the app
// itself: its binary and the hooks/ it ships in Resources. An AppImage or Windows portable copy is
// different: it runs from a fresh /tmp/.mount_XXXX every launch, so a path into
// it stops working the moment the app quits, and the agent configs would be
// rewritten on every start. There the commands run the original launcher
// ($APPIMAGE) against stable scripts. Windows keeps its extracted runtime as
// well: unpacking the portable launcher for every hook exceeds hook deadlines.
// Both caches live in the data folder, one copy per app version.
const fs = require('fs');
const path = require('path');

const STABLE_PREFIX = 'hooks-';

// The MCP server needs app.asar beside the executing binary, whether that
// binary is in a live AppImage mount or the cached Windows runtime.
const MCP_STUB = `// Plexiform AppImage: the MCP server lives inside the AppImage, which mounts
// somewhere new every launch. This runs as the AppImage's own binary, so the
// server is found next to it.
require(require('path').join(require('path').dirname(process.execPath), 'resources', 'app.asar', 'mcp-server.js')); // privacy-flow: own-code
`;
const NATIVE_BOARD_MCP_STUB = `// Plexiform AppImage: resolve the board server from this launch's mount.
require(require('path').join(require('path').dirname(process.execPath), 'resources', 'app.asar', 'native-board', 'server.js')); // privacy-flow: own-code
`;

// → { execPath, hooksDir, mcpAppPath, stableDir, copyFrom }. execPath null is
// the dev fallback to plain node (adapters/runtime.js).
function choose({ packaged, platform, env = {}, execPath, resourcesPath, appDir, appPath, rootDir, version }) {
  if (!packaged) return { execPath: null, hooksDir: path.join(appDir, 'hooks'), mcpAppPath: appPath, stableDir: null, copyFrom: null };
  const launcher = platform === 'linux' ? env.APPIMAGE : platform === 'win32' ? env.PORTABLE_EXECUTABLE_FILE : null;
  if (launcher) {
    const stableDir = path.join(rootDir, `${STABLE_PREFIX}${version}`);
    if (platform === 'win32') {
      const runtimeFrom = path.dirname(execPath);
      return { execPath: path.join(stableDir, 'runtime', path.basename(execPath)), hooksDir: path.join(stableDir, 'hooks'), mcpAppPath: stableDir, stableDir, copyFrom: resourcesPath, runtimeFrom };
    }
    return { execPath: launcher, hooksDir: path.join(stableDir, 'hooks'), mcpAppPath: stableDir, stableDir, copyFrom: resourcesPath };
  }
  return { execPath, hooksDir: path.join(resourcesPath, 'hooks'), mcpAppPath: appPath, stableDir: null, copyFrom: null };
}

const OK = '.ok';

// Makes stableDir hold hooks/, adapters/, the MCP stub and, on Windows, the
// complete portable runtime. A finished copy
// carries .ok and is left alone, so a second launch never touches the files
// the running app's hooks are using; otherwise it is built in a temp folder
// and renamed into place, so nobody sees half a copy. → whether it copied.
function materialize({ stableDir, copyFrom, runtimeFrom }, fsImpl = fs, pid = process.pid) {
  // Upgrade old portable caches that held scripts alone, even at the same version.
  const stamp = path.basename(stableDir) + (runtimeFrom ? '/windows-runtime-v1' : '');
  try { if (fsImpl.readFileSync(path.join(stableDir, OK), 'utf8') === stamp) return false; } catch { /* not there yet */ }
  const tmp = `${stableDir}.tmp-${pid}`;
  fsImpl.rmSync(tmp, { recursive: true, force: true });
  if (runtimeFrom) fsImpl.cpSync(runtimeFrom, path.join(tmp, 'runtime'), { recursive: true });
  for (const dir of ['hooks', 'adapters']) fsImpl.cpSync(path.join(copyFrom, dir), path.join(tmp, dir), { recursive: true });
  fsImpl.writeFileSync(path.join(tmp, 'mcp-server.js'), MCP_STUB);
  fsImpl.mkdirSync(path.join(tmp, 'native-board'), { recursive: true });
  fsImpl.writeFileSync(path.join(tmp, 'native-board', 'server.js'), NATIVE_BOARD_MCP_STUB);
  fsImpl.writeFileSync(path.join(tmp, OK), stamp);
  fsImpl.rmSync(stableDir, { recursive: true, force: true });
  fsImpl.renameSync(tmp, stableDir);
  return true;
}

// The copies other versions left behind (and unfinished temp copies). Only
// the instance holding the single-instance lock calls this.
function prune({ stableDir }, fsImpl = fs) {
  if (!stableDir) return;
  const root = path.dirname(stableDir);
  for (const name of fsImpl.readdirSync(root)) {
    if (name.startsWith(STABLE_PREFIX) && path.join(root, name) !== stableDir) fsImpl.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

// choose() plus the copy; if the copy fails the app's own paths are used, as
// before this existed.
function resolve(opts, fsImpl = fs, log = console.warn) {
  const chosen = choose(opts);
  if (!chosen.copyFrom) return chosen;
  try {
    materialize(chosen, fsImpl);
    return chosen;
  } catch (err) {
    log(`[hooks] could not copy the hooks out of the temporary app (${err.message}); using the mounted copy`);
    return choose({ ...opts, env: {} });
  }
}

// resolve() for the running Electron app.
function forApp(app, rootDir, { platform = process.platform, env = process.env, execPath = process.execPath, resourcesPath = process.resourcesPath, appDir = path.join(__dirname, '..') } = {}) {
  return resolve({ packaged: app.isPackaged, platform, env, execPath, resourcesPath, appDir, appPath: app.getAppPath(), rootDir, version: app.getVersion() });
}

module.exports = { choose, materialize, prune, resolve, forApp, MCP_STUB, NATIVE_BOARD_MCP_STUB, STABLE_PREFIX };
