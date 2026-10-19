'use strict';

// "Search past sessions" from the ⌘K palette on the Sessions page: opens the
// Search everything page (src/memory/search.js owns the index and its IPC).
// Carries no query and no session data; only the Overview page may ask.

function register({ ipcMain, allowed, openPage }) {
  ipcMain.handle('search:open-page', (e, ...args) => {
    if (args.length !== 0 || !allowed(e)) return false;
    openPage('memory');
    return true;
  });
}

module.exports = { register };
