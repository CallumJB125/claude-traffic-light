// Actual production main/IPC/window against a synthetic real SQLite accounts hub.
// The existing dev mock entry supplies only the exact allowed loopback origin.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { hubKey } = require('../buddy-window/workspaces');
const origin = process.env.PLEXIFORM_PLANNER_TEST_HUB;
const saved = JSON.parse(process.env.PLEXIFORM_PLANNER_TEST_ACCOUNT);
app.getAppPath = () => path.resolve(__dirname, '..');
require('../buddy-window/mock-accounts-hub').createMockAccountsHub = () => ({ listen: async () => origin, close() {} });
app.whenReady().then(() => {
  const dir = path.join(app.getPath('userData'), 'buddy-accounts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${hubKey(origin)}.bin`), safeStorage.encryptString(JSON.stringify(saved)), { mode: 0o600 });
});
require('../main.js');
