'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── main.js wiring (source checks: main.js needs a running Electron) ──────

test('L10: the dev mock hub is listening before anything can create the Buddy window', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /function getBuddy\(\) \{\n\s+if \(!devMockReady\) throw/);
  assert.match(src, /function openBuddy\(page = null\) \{\n\s+if \(!devMockReady\) return;/);
  const listen = src.indexOf('devAccountsHub = await devMock.listen()');
  assert.ok(listen > 0);
  assert.ok(listen < src.indexOf('linksReady = true;'), 'deep links wait for it');
  assert.ok(listen < src.indexOf('getBuddy().resumeDevices()'), 'runners wait for it');
  assert.ok(listen < src.indexOf('openBuddy(page);'));
});

test('L9: runners resume at launch only in a packaged app, or a dev run that opts in', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /const resumeRunners = app\.isPackaged \? !IS_DEV_RUN : process\.env\.BUDDY_RESUME_RUNNERS === '1';\n\s+if \(resumeRunners\) \{ try \{ getBuddy\(\)\.resumeDevices\(\);/);
  const side = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'sidebar.js'), 'utf8');
  assert.match(side, /HUB_TEXT\.running \?\? ''\)\.replace\('\{teams\}', runners\.join\(', '\)\)/);
  assert.equal(require('../buddy-window/brand').HUB_TEXT.running, 'This Mac is running cards for {teams}');
});

test('deep links: main registers plexiform:// and claudebuddy:// and routes both; the bundle lists both schemes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /if \(app\.isPackaged\) for \(const scheme of BRAND\.SCHEMES\) app\.setAsDefaultProtocolClient\(scheme\);/);
  assert.ok(!/claudebuddy/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'no hard-coded scheme outside comments');
  const re = new RegExp(`^(${require('../buddy-window/brand').SCHEMES.join('|')}):`, 'i');
  assert.ok(re.test('plexiform://invite/x') && re.test('claudebuddy://invite/x') && re.test('Plexiform://invite/x'));
  assert.ok(!re.test('plexi://invite/x') && !re.test('https://x/invite#y'));
  assert.match(src, /openLabel: BRAND\.OPEN_MENU_LABEL/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'app-menu.js'), 'utf8'), /openAccelerator = 'CmdOrCtrl\+B'/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.mac.protocols, [{ name: 'Plexiform', schemes: ['plexiform', 'claudebuddy'] }]);
});

test('the dev-only mock accounts hub and walk are left out of the package, and nothing a packaged build loads needs them', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = pkg.build.files;
  for (const f of ['!buddy-window/mock-accounts-hub.js', '!buddy-window/dev-walk.js']) {
    assert.ok(files.indexOf(f) > files.indexOf('buddy-window/**/*'), `${f} after the glob it narrows`);
  }
  const DEV = new Set(['mock-accounts-hub.js', 'dev-walk.js']);
  // Every relative require the window's modules make, followed from index.js.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
      let dep = path.resolve(path.dirname(file), m[1]);
      if (!dep.endsWith('.js')) dep += '.js';
      if (dep.startsWith(path.join(root, 'buddy-window') + path.sep)) walk(dep);
    }
  };
  walk(path.join(root, 'buddy-window', 'index.js'));
  assert.ok(seen.size > 3, 'the graph was walked');
  for (const f of seen) assert.ok(!DEV.has(path.basename(f)), `${path.basename(f)} is reachable from index.js`);
  // main.js loads each only lazily, behind !app.isPackaged.
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.equal(main.match(/require\('\.\/buddy-window\/mock-accounts-hub'\)/g).length, 1);
  assert.match(main, /const devMock = !app\.isPackaged && [^\n]*\? require\('\.\/buddy-window\/mock-accounts-hub'\)/);
  assert.equal(main.match(/require\('\.\/buddy-window\/dev-walk'\)/g).length, 1);
  assert.match(main, /const walkAt = app\.isPackaged \|\| !mock \? -1 : [^\n]*\n\s+if \(walkAt > 0 [^\n]*\{\n\s+require\('\.\/buddy-window\/dev-walk'\)/);
});

test('the runner and the board MCP ship in the app; what runs as its own process is unpacked from app.asar', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  for (const f of ['board/package.json', 'board/shared/**/*', 'board/runner/**/*', 'board/mcp/**/*', '!board/**/test/**', '!board/runner/scripts/**']) assert.ok(pkg.build.files.includes(f), f);
  for (const f of ['board/package.json', 'board/mcp/**', 'board/shared/**', 'board/runner/hook-shim.js', 'board/runner/procs.js', 'board/runner/ipc.js', 'board/runner/launch.js', 'node_modules/@modelcontextprotocol/sdk/**', 'node_modules/zod/**']) assert.ok(pkg.build.asarUnpack.includes(f), f);
  // What the runner and the MCP server import from npm is a root dependency (the package has no board/node_modules).
  for (const d of ['@modelcontextprotocol/sdk', 'ws', 'zod']) assert.ok(pkg.dependencies[d], d);
});

test('the runner points the hook shim and the MCP server at app.asar.unpacked in a packaged app', async () => {
  const { onDisk, HOOK_SHIM, MCP_SERVER } = await import('../board/runner/launch.js');
  assert.equal(onDisk('/A/Plexiform.app/Contents/Resources/app.asar/board/mcp/server.js'), '/A/Plexiform.app/Contents/Resources/app.asar.unpacked/board/mcp/server.js');
  assert.equal(onDisk('/repo/board/mcp/server.js'), '/repo/board/mcp/server.js', 'unchanged outside a package');
  assert.equal(onDisk('/x/app.asar.unpacked/board/y.js'), '/x/app.asar.unpacked/board/y.js', 'never doubled');
  assert.ok(HOOK_SHIM.endsWith(path.join('board', 'runner', 'hook-shim.js')) && fs.existsSync(HOOK_SHIM));
  assert.ok(MCP_SERVER.endsWith(path.join('board', 'mcp', 'server.js')) && fs.existsSync(MCP_SERVER));
});
