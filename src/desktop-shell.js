// Windows and Linux desktop integration that macOS gets for free.
//
// AppUserModelID: Windows groups taskbar buttons and routes notifications by
// it. It must match the id the NSIS installer puts on the Start-menu shortcut
// (electron-builder uses appId), or notifications show up as "Electron" and
// clicking one does nothing. packaged package.json has no "build" block, so
// the id comes from brand.js; test/desktop-shell.test.js keeps it equal to appId.
//
// Menu: Electron's default menu bar (File/Edit/View with Reload and DevTools)
// shows on every window off macOS. On macOS the app menu stays as it is, since
// copy and paste in text fields go through its Edit items.
const APP_ID = require('../brand.js').appId;

function setup({ app, Menu, platform = process.platform }) {
  if (platform === 'win32') app.setAppUserModelId(APP_ID);
  if (platform !== 'darwin') app.whenReady().then(() => Menu.setApplicationMenu(null));
}

module.exports = { setup, APP_ID };
