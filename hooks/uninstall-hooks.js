#!/usr/bin/env node
// Plain-Node entry to adapters/uninstall-all.js, for places the app's GUI
// can't start: the .deb's prerm runs it per user as
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

if (require.main === module) {
  const results = UninstallAll.run({ home: os.homedir(), mcp: loadMcp() });
  for (const r of results) console.log(`[uninstall-hooks] ${r.id}: ${r.error ? `left alone (${r.error})` : r.changed ? 'removed' : 'nothing to remove'} ${r.file}`);
}
