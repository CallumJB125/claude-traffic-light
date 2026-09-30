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
