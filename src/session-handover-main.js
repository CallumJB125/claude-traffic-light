'use strict';

// Main-process side of the local session handovers: starts the writer, and
// answers the Sessions page's View / Copy path / Copy as prompt actions. The
// page only ever sends a key; the file it names must be one the writer made.

const SessionHandover = require('./session-handover.js');

function register({ ipcMain, rootDir, isExcluded, burstFor, home, sessionsAllowed, clipboard, shell, log = () => {}, start = true }) {
  const writer = SessionHandover.create({ rootDir, isExcluded, burstFor, home, log });
  if (start) writer.start();
  ipcMain.handle('sessions:handover', async (e, action, key) => {
    if (!sessionsAllowed(e)) return false;
    if (action === 'view') { const f = writer.pathOf(key); return f ? (await shell.openPath(f)) === '' : false; }
    if (action === 'copy-path') { const f = writer.pathOf(key); if (f) clipboard.writeText(f); return !!f; }
    if (action === 'copy-prompt') { const t = writer.promptOf(key); if (t) clipboard.writeText(t); return !!t; }
    return false;
  });
  // The widget / tray menu entry for the first local session: only when its handover exists.
  const menuItems = (row) => {
    const v = row && writer.view(row);
    return v && v.ready ? [{ label: 'Copy Handover as Prompt', click: () => { const t = writer.promptOf(v.key); if (t) clipboard.writeText(t); } }] : [];
  };
  return { writer, view: (row) => writer.view(row), menuItems };
}

module.exports = { register };
