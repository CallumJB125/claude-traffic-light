'use strict';
// Fails when a packaged app is missing any production dependency (or a
// dependency of one) from app.asar.unpacked/node_modules. A build made from a
// symlinked or partial node_modules silently drops transitive packages, and the
// app then dies at launch with ERR_MODULE_NOT_FOUND inside the embedded hub.
// usage: node scripts/verify-packaged-deps.js /path/to/Plexiform.app
const fs = require('node:fs');
const path = require('node:path');

const app = process.argv[2];
if (!app) { console.error('usage: verify-packaged-deps.js <Plexiform.app | unpacked resources dir>'); process.exit(2); }
const resources = fs.existsSync(path.join(app, 'Contents', 'Resources')) ? path.join(app, 'Contents', 'Resources') : app;
const unpacked = path.join(resources, 'app.asar.unpacked', 'node_modules');
const root = require(path.join(__dirname, '..', 'package.json'));

const missing = new Set();
const seen = new Set();
function visit(name, from) {
  if (seen.has(name + '@' + from)) return;
  seen.add(name + '@' + from);
  const dirs = [path.join(from, 'node_modules', name), path.join(unpacked, name)];
  const dir = dirs.find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!dir) { missing.add(name); return; }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies || {})) visit(dep, dir);
}
for (const dep of Object.keys(root.dependencies || {})) visit(dep, unpacked.replace(/node_modules$/, ''));
if (missing.size) { console.error('packaged app is missing dependencies:', [...missing].sort().join(', ')); process.exit(1); }
console.log(`packaged dependency closure complete (${fs.readdirSync(unpacked).length} top-level packages)`);
