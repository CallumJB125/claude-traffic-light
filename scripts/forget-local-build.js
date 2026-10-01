// After a local macOS build, take its app copies back out of LaunchServices:
// macOS registers every .app it sees, so each build in a worktree, /tmp or
// the Bin otherwise adds another "Plexiform" to Open With and the Dock search.
// Unregisters every .app under dist/ (helpers included), then moves each to
// the Bin. A no-op on CI and on Windows/Linux.
//   node scripts/forget-local-build.js [dist dir]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

// The top-level .app bundles in dist/<platform dir>/, never anything outside dist.
function appsIn(dist, fsImpl = fs) {
  if (!fsImpl.existsSync(dist)) return [];
  return fsImpl.readdirSync(dist, { withFileTypes: true }).filter((d) => d.isDirectory())
    .flatMap((d) => fsImpl.readdirSync(path.join(dist, d.name)).filter((f) => f.endsWith('.app')).map((f) => path.join(dist, d.name, f)));
}

// An app and every .app nested in it (Electron's helpers are registered too).
function bundlesOf(app, fsImpl = fs) {
  const out = [app];
  const walk = (dir) => {
    for (const e of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink?.()) continue;
      const p = path.join(dir, e.name);
      if (e.name.endsWith('.app')) out.push(p);
      walk(p);
    }
  };
  walk(path.join(app, 'Contents'));
  return out;
}

function forgetLocalBuild({ dist = path.join(__dirname, '..', 'dist'), platform = process.platform, env = process.env,
  fsImpl = fs, run = (file, args) => execFileSync(file, args, { stdio: 'ignore' }), trash = path.join(os.homedir(), '.Trash'), now = Date.now, log = console.log } = {}) {
  if (platform !== 'darwin' || env.CI) return { skipped: true, apps: [] };
  const apps = appsIn(dist, fsImpl);
  for (const app of apps) {
    for (const b of bundlesOf(app, fsImpl).reverse()) {
      try { run(LSREGISTER, ['-u', b]); } catch (e) { log(`forget-build: could not unregister ${b}: ${e.message}`); }
    }
    const to = path.join(trash, `${path.basename(app, '.app')}-build-${now()}.app`);
    fsImpl.renameSync(app, to);
    log(`forget-build: unregistered ${app} and moved it to the Bin`);
  }
  return { skipped: false, apps };
}

module.exports = { forgetLocalBuild, appsIn, bundlesOf, LSREGISTER };

if (require.main === module) forgetLocalBuild(process.argv[2] ? { dist: path.resolve(process.argv[2]) } : {});
