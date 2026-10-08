const test = require('node:test');
const assert = require('node:assert');
const { shouldOpenWindowOnLaunch: open, launchedAtLogin } = require('../src/window-launch.js');

test('a normal launch opens the window', () => assert.equal(open({ event: 'launch' }), true));
test('launch at login stays quiet', () => assert.equal(open({ event: 'launch', atLogin: true }), false));
test('hook-triggered and dev/demo runs never open it', () => {
  for (const event of ['launch', 'activate', 'second-instance']) {
    assert.equal(open({ event, hookLaunch: true }), false);
    assert.equal(open({ event, devRun: true }), false);
  }
});
test('activate opens only when no window is visible', () => {
  assert.equal(open({ event: 'activate' }), true);
  assert.equal(open({ event: 'activate', windowVisible: true }), false);
});
test('a login-time activate inside the grace period is ignored, a later dock click is not', () => {
  assert.equal(open({ event: 'activate', atLogin: true, sinceLaunchMs: 500 }), false);
  assert.equal(open({ event: 'activate', atLogin: true, sinceLaunchMs: 60000 }), true);
});
test('a second launch shows the window', () => {
  assert.equal(open({ event: 'second-instance' }), true);
  assert.equal(open({ event: 'second-instance', windowVisible: true }), true);
});
test('launchedAtLogin reads the login-item flag or an autostart arg', () => {
  const app = (v) => ({ getLoginItemSettings: () => ({ wasOpenedAtLogin: v }) });
  assert.equal(launchedAtLogin({ app: app(true), argv: [], platform: 'darwin' }), true);
  assert.equal(launchedAtLogin({ app: app(false), argv: [], platform: 'darwin' }), false);
  assert.equal(launchedAtLogin({ app: app(true), argv: [], platform: 'linux' }), false);
  assert.equal(launchedAtLogin({ app: app(false), argv: ['--hidden'], platform: 'linux' }), true);
});
