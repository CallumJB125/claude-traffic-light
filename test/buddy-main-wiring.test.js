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
  assert.match(src, /label: BRAND\.OPEN_MENU_LABEL, accelerator: 'CmdOrCtrl\+B'/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.mac.protocols, [{ name: 'Plexiform', schemes: ['plexiform', 'claudebuddy'] }]);
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
