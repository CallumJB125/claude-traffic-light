'use strict';
// Isolated native window using the production timeline IPC and renderer.
// Synthetic transcripts only; no installed app, live account or provider work.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const root = path.join(__dirname, '..');
const fixture = process.env.PLEXIFORM_TIMELINE_FIXTURE;
if (!fixture || !path.isAbsolute(fixture)) throw new Error('A fixture directory is required');
app.setPath('userData', path.join(fixture, 'electron'));
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1100, height: 900, webPreferences: { preload: path.join(root, 'timeline-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  require('../src/session-timeline-main.js').register({
    ipcMain, rootDir: fixture, home: fixture, openPage() {},
    sessions: () => ({ live: [{ sessionId: 'fixture-one', cwd: '/fixture/sample-project', updatedAt: '2026-10-16T12:00:00Z' }] }),
    sessionsAllowed: () => false,
    pageAllowed: e => e.sender === window.webContents && e.senderFrame === window.webContents.mainFrame && e.senderFrame.url === new URL(`file://${path.join(root, 'timeline.html')}`).href,
    transitions: () => [], checkpointTurns: async () => [], locator: { find: () => path.join(fixture, 'transcript.jsonl') },
    dialog: { showSaveDialog: async () => ({ filePath: path.join(fixture, 'replay.html') }) },
    BrowserWindow,
  });
  window.loadFile(path.join(root, 'timeline.html'));
});
app.on('window-all-closed', () => app.quit());
