'use strict';
// Production Overview/Interaction IPC and encrypted outbox in an isolated
// fixture. Provider and encryption key are synthetic. No user state is read.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path'), crypto = require('node:crypto'), { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..'), fixture = process.env.PLEXIFORM_FOLLOWUP_FIXTURE;
if (!fixture || !path.isAbsolute(fixture)) throw new Error('A fixture directory is required');
app.setPath('userData', path.join(fixture, 'profile'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ title: 'Plexiform synthetic follow-up test', width: 1100, height: 950, webPreferences: { preload: path.join(root, 'overview-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  let clock = Date.now(), overview;
  const now = () => clock, scope = () => 'a'.repeat(64), key = crypto.randomBytes(32), events = new EventEmitter(), sends = [];
  const context = () => ({ window, contents: window.webContents, document: 1, generation: 1, foreground: window.isFocused() && window.isVisible() });
  const buddy = { overviewContext: context, overviewReadContext: context };
  const storage = {
    encryptAsync: async clear => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(clear), c.final(), c.getAuthTag()]); },
    decryptAsync: async bytes => { const c = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12)); c.setAuthTag(bytes.subarray(-16)); return Buffer.concat([c.update(bytes.subarray(12,-16)),c.final()]).toString(); },
  };
  const queue = require('../src/session-followups').createSessionFollowups({ file: path.join(fixture, 'outbox.bin'), storage, scope, now, onChange: () => overview?.directoryChanged() });
  const adapter = { label: 'Synthetic Claude', capabilities: { newTurn: true, steer: false, interrupt: false }, open: async () => ({ target: 'synthetic-target' }),
    send: async request => { sends.push(request); return { turnId: `synthetic-turn-${sends.length}`, mode: 'new-turn' }; }, alive: () => true, on: fn => { events.on('event', fn); return () => events.off('event', fn); }, stop() {}, release: async () => {} };
  const interaction = require('../src/interaction-main').createInteractionMain({ context, readContext: context, owned: null, localModels: null, adapters: { claude: adapter }, currentBoard: () => 'synthetic-board', accountScope: scope, now });
  interaction.register(ipcMain);
  overview = require('../src/overview-main').createOverviewMain({ buddy: () => buddy, sessions: () => [], work: async () => ({ sources: [], capture: [] }), now, owned: () => interaction.listOwned(), followups: queue, followupScope: scope, followupLocal: { target: s => interaction.followupTarget(s), resolve: (target, fresh) => interaction.resolveFollowup(target, fresh) } });
  overview.register(ipcMain);
  global.followupFixture = { sends, items: () => queue.list(), advance: async () => { const items = await queue.list(); clock = Math.max(clock, ...items.items.map(i => i.schedule.atMs ?? clock)) + 1; }, focus: () => window.focus() };
  window.webContents.on('did-finish-load', () => window.webContents.send('overview:ready'));
  app.on('before-quit', () => { overview.close(); queue.close(); interaction.close(); });
  await window.loadFile(path.join(root, 'overview.html')); window.focus();
});
app.on('window-all-closed', () => app.quit());
