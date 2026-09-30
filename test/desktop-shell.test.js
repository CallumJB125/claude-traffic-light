const test = require('node:test');
const assert = require('node:assert/strict');
const DesktopShell = require('../src/desktop-shell.js');

test('desktop shell: the AppUserModelID is the installer appId', () => {
  assert.equal(DesktopShell.APP_ID, require('../package.json').build.appId);
  const cfg = require('../electron-builder.config.js');
  assert.equal(cfg.appId, DesktopShell.APP_ID);
});

function fake() {
  const calls = [];
  const app = { setAppUserModelId: (id) => calls.push(['aumid', id]), whenReady: () => Promise.resolve() };
  const Menu = { setApplicationMenu: (m) => calls.push(['menu', m]) };
  return { calls, app, Menu };
}

test('desktop shell: Windows gets the AppUserModelID and no menu bar; Linux no menu bar; macOS nothing', async () => {
  const want = { win32: [['aumid', DesktopShell.APP_ID], ['menu', null]], linux: [['menu', null]], darwin: [] };
  for (const [platform, calls] of Object.entries(want)) {
    const f = fake();
    DesktopShell.setup({ app: f.app, Menu: f.Menu, platform });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(f.calls, calls, platform);
  }
});
