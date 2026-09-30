// Where the hook commands and the MCP entry point. Normally that is the app
// itself: its binary and the hooks/ it ships in Resources. A Linux AppImage is
// different: it runs from a fresh /tmp/.mount_XXXX every launch, so a path into
// it stops working the moment the app quits, and the agent configs would be
// rewritten on every start. There the commands run the .AppImage file itself
// ($APPIMAGE, which does not move) against a copy of hooks/ and adapters/ kept
// in the data folder, one copy per app version.
const fs = require('fs');
const path = require('path');

const STABLE_PREFIX = 'hooks-';

// The MCP server needs the app's node_modules, which live in app.asar inside
// the mount; this stub finds the current mount from the binary running it.
const MCP_STUB = `// Plexiform AppImage: the MCP server lives inside the AppImage, which mounts
// somewhere new every launch. This runs as the AppImage's own binary, so the
// server is found next to it.
require(require('path').join(require('path').dirname(process.execPath), 'resources', 'app.asar', 'mcp-server.js')); // privacy-flow: own-code
`;

// → { execPath, hooksDir, mcpAppPath, stableDir, copyFrom }. execPath null is
// the dev fallback to plain node (adapters/runtime.js).
function choose({ packaged, platform, env = {}, execPath, resourcesPath, appDir, appPath, rootDir, version }) {
  if (!packaged) return { execPath: null, hooksDir: path.join(appDir, 'hooks'), mcpAppPath: appPath, stableDir: null, copyFrom: null };
  if (platform === 'linux' && env.APPIMAGE) {
    const stableDir = path.join(rootDir, `${STABLE_PREFIX}${version}`);
    return { execPath: env.APPIMAGE, hooksDir: path.join(stableDir, 'hooks'), mcpAppPath: stableDir, stableDir, copyFrom: resourcesPath };
  }
  return { execPath, hooksDir: path.join(resourcesPath, 'hooks'), mcpAppPath: appPath, stableDir: null, copyFrom: null };
}

// Copies hooks/ and adapters/ into stableDir, writes the MCP stub, and removes
// the copies older versions left behind.
function materialize({ stableDir, copyFrom }, fsImpl = fs) {
  for (const dir of ['hooks', 'adapters']) {
    fsImpl.rmSync(path.join(stableDir, dir), { recursive: true, force: true });
    fsImpl.cpSync(path.join(copyFrom, dir), path.join(stableDir, dir), { recursive: true });
  }
  fsImpl.writeFileSync(path.join(stableDir, 'mcp-server.js'), MCP_STUB);
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
    log(`[hooks] could not copy the hooks out of the AppImage (${err.message}); using the mounted copy`);
    return choose({ ...opts, env: {} });
  }
}

module.exports = { choose, materialize, resolve, MCP_STUB, STABLE_PREFIX };
