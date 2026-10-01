// Hermetic Electron fixture for the actual authenticated sandboxed client pane.
// Fake hub/user credentials come only from this test process, never a real account.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { hubKey } = require('../buddy-window/workspaces');
const { createBuddyWindow } = require('../buddy-window');
global.__clientTestLoads = [];
app.on('web-contents-created', (_e, wc) => {
  wc.on('did-fail-load', (_e, code, description, url) => global.__clientTestLoads.push({ code, description, url }));
});
app.whenReady().then(async () => {
  global.__clientTestInit = { stage: 'sealing' };
  const origin = process.env.PLEXIFORM_CLIENT_TEST_HUB;
  const saved = JSON.parse(process.env.PLEXIFORM_CLIENT_TEST_ACCOUNT);
  const dir = path.join(app.getPath('userData'), 'buddy-accounts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${hubKey(origin)}.bin`), safeStorage.encryptString(JSON.stringify(saved)), { mode: 0o600 });
  const buddy = createBuddyWindow({ isDev: true, devAccountsHub: origin, log: () => {} });
  global.__clientTestBuddy = buddy;
  buddy.open('account');
  global.__clientTestInit = { stage: 'connecting' };
  const result = await buddy.devConnect(origin);
  global.__clientTestInit = { stage: 'connected', result, status: buddy.status() };
}).catch((e) => { global.__clientTestInit = { stage: 'failed', error: e.message }; });
app.on('window-all-closed', () => app.quit());
