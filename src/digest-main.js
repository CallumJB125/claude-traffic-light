'use strict';

// IPC for Home's Digest card (home-digest.js). Main builds the digest from
// local files and answers only the Home page. The renderer sends a period,
// a settings patch or a pasted webhook link; never a path or a URL to open.
// Copy, save and email go through the user's own clipboard, save dialog and
// mail app; Slack and the notification are set up in src/digest-delivery.js.

const fs = require('fs');
const path = require('path');
const { createDigest } = require('./digest.js');
const { createDelivery } = require('./digest-delivery.js');
const { createSecureStorage } = require('../buddy-window/secure-storage.js');

const MAILTO_BODY_MAX = 1800;
const period = (p) => (p === 'week' ? 'week' : 'day');

function register({ ipcMain, allowed, rootDir, userData, safeStorage, clipboard, dialog, shell, Notification, fetch, usageTurns, costGuard, workCost = async () => null, scheduledRuns = () => [], teamBrief = async () => null, openHome = () => {}, onQuit = () => {}, log = () => {} }) {
  const secure = createSecureStorage(safeStorage);
  const digest = createDigest({
    tasksStoreDir: path.join(userData, 'tasks', 'store'),
    recordsFile: path.join(userData, 'work-records.json'),
    turns: usageTurns, report: costGuard, scheduled: scheduledRuns,
    shipped: async () => { const r = await workCost(); return r?.week ? { cost: r.week } : null; },
    // The team brief is about one repository: the one you worked in most recently. Home only, never sent anywhere.
    team: async (turns) => {
      const last = (Array.isArray(turns) ? turns : []).reduce((a, t) => (t?.cwd && (!a || t.ts > a.ts) ? t : a), null);
      const r = last ? await teamBrief(last.cwd) : null;
      return r?.available && typeof r.brief === 'string' ? r.brief : null;
    },
  });
  const delivery = createDelivery({
    dir: rootDir, fetch, log,
    seal: (s) => secure.encrypt(s), unseal: (b) => secure.decrypt(b),
    digest: (p) => digest.build(p),
    notify: () => {
      if (!Notification.isSupported()) throw new Error('notifications unsupported');
      const note = new Notification({ title: 'Plexiform', body: 'Your digest is ready', silent: true });
      note.on('click', () => openHome());
      note.show();
    },
  });
  onQuit(delivery.start());

  const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!allowed(e)) return null;
    try { return await fn(...args); } catch (err) { log(`[digest] ${channel}: ${err?.message ?? err}`); return { ok: false, error: 'That did not work. Try again in a moment.' }; }
  });
  handle('digest:get', async (p) => ({ digest: await digest.build(period(p), { withTeam: true }), delivery: delivery.settings() }));
  handle('digest:copy', async (p, as) => {
    const d = await digest.build(period(p));
    clipboard.writeText(as === 'markdown' ? d.markdown : d.text);
    return { ok: true };
  });
  handle('digest:save', async (p) => {
    const d = await digest.build(period(p));
    const r = await dialog.showSaveDialog({ title: 'Save digest', defaultPath: `plexiform-digest-${d.period === 'week' ? 'week' : 'day'}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, d.markdown, { mode: 0o600 });
    return { ok: true };
  });
  handle('digest:email', async (p) => {
    const d = await digest.build(period(p));
    const body = d.text.length > MAILTO_BODY_MAX ? `${d.text.slice(0, MAILTO_BODY_MAX)}…` : d.text;
    await shell.openExternal(`mailto:?subject=${encodeURIComponent(d.title)}&body=${encodeURIComponent(body)}`); // privacy-flow: digest-email
    return { ok: true };
  });
  handle('digest:webhook-save', async (url) => {
    if (!secure.available()) return { ok: false, error: 'Secure storage is unavailable, so the webhook cannot be saved safely. Unlock your keychain and try again.' };
    return delivery.saveWebhook(url);
  });
  handle('digest:webhook-remove', async () => delivery.removeWebhook());
  handle('digest:test', async () => delivery.test());
  handle('digest:preview', async () => delivery.preview());
  handle('digest:set', async (patch) => delivery.set(patch));
  return { digest, delivery };
}

module.exports = { register };
