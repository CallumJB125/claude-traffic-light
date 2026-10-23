#!/usr/bin/env node
// Plain-Node entry to adapters/uninstall-all.js, for places the app's GUI
// can't start (main.js --uninstall-hooks runs main() too): the .deb's prerm runs it per user as
//   ELECTRON_RUN_AS_NODE=1 <app binary> <resources>/hooks/uninstall-hooks.js
// mcp-install.js is inside app.asar when packaged (Electron's Node reads it)
// and next to this folder in a checkout.
const os = require('os');
const path = require('path');
const UninstallAll = require('../adapters/uninstall-all.js');

function loadMcp() {
  for (const p of [path.join(__dirname, '..', 'app.asar', 'mcp-install.js'), path.join(__dirname, '..', 'mcp-install.js')]) {
    try { return require(p); } catch { /* try the next */ } // privacy-flow: own-code
  }
  return null;
}

// The Codex CLI, for removing the bus tools Plexiform registered with it (src/codex-app-server.js findCodexBin).
function loadCodexBin() {
  for (const p of [path.join(__dirname, '..', 'app.asar', 'src', 'codex-app-server.js'), path.join(__dirname, '..', 'src', 'codex-app-server.js')]) {
    try { return require(p).findCodexBin(); } catch { /* try the next */ } // privacy-flow: own-code
  }
  return null;
}

// Shared with main.js --uninstall-hooks (the Windows uninstaller).
function main({ home = os.homedir(), mcp = loadMcp(), codexBin = loadCodexBin(), log = console.log } = {}) {
  const results = UninstallAll.run({ home, mcp, codexBin });
  if (!mcp) results.push({ id: 'mcp', file: path.join(home, '.claude.json'), changed: false, error: 'MCP uninstall helper unavailable' });
  for (const r of results) log(`[uninstall-hooks] ${r.id}: ${Object.hasOwn(r, 'error') ? `left alone (${r.error})` : r.kept ? `left in place (${r.kept})` : r.changed ? 'removed' : 'nothing to remove'} ${r.file}`);
  return results;
}

function exitCode(results) {
  return Array.isArray(results) && results.every(r => r && typeof r === 'object' && !Object.hasOwn(r, 'error')) ? 0 : 1;
}

if (require.main === module) process.exitCode = exitCode(main());

module.exports = { main, loadMcp, loadCodexBin, exitCode };
