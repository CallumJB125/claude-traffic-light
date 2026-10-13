// Settings → Privacy → Your data, main-process side: the inventory, Export
// my data (a folder the person picks), the activity log as CSV, and Delete
// my data, which records the request and quits so the next start removes
// the stores before anything opens them (src/data-delete.js). Settings is
// the only caller. Nothing here talks to the network.
'use strict';

const fs = require('fs');
const path = require('path');
const Inventory = require('./data-inventory.js');
const Export = require('./data-export.js');
const Delete = require('./data-delete.js');

function register({ utilityHandle, allowed, dialog, BrowserWindow, app, roots, isDevRun = false, log = () => {} }) {
  const win = (e) => BrowserWindow.fromWebContents(e.sender) || undefined;
  const rows = () => Inventory.inventory(roots()).map(({ paths, ...r }) => r);

  utilityHandle('data:inventory', allowed, () => ({
    stores: rows(),
    kept: Inventory.kept(roots()),
    lastReceipt: Delete.lastReceipt(roots()),
    pending: !!Delete.pending(roots()),
  }));

  utilityHandle('data:export', allowed, async (e) => {
    const r = await dialog.showOpenDialog(win(e), { title: 'Export my data', buttonLabel: 'Export here', defaultPath: app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths?.[0]) return { ok: false };
    try {
      const out = await Export.exportData({ ...roots(), outDir: r.filePaths[0], appVersion: app.getVersion() });
      log(`[data] exported ${out.stores.length} stores`);
      return { ok: true, path: out.dir, stores: out.stores.length, skipped: out.skipped };
    } catch (err) { return { error: err.message }; }
  });

  utilityHandle('data:export-activity', allowed, async (e) => {
    const r = await dialog.showSaveDialog(win(e), {
      title: 'Export activity log',
      defaultPath: path.join(app.getPath('documents'), `plexiform-activity-${new Date().toISOString().slice(0, 10)}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    try { fs.writeFileSync(r.filePath, Export.activityCsv(roots().dataDir), { mode: 0o600 }); } catch (err) { return { error: err.message }; }
    return { ok: true, path: r.filePath };
  });

  utilityHandle('data:delete', allowed, (_e, req) => {
    const r = Delete.requestDeletion({ ids: req?.ids, confirm: req?.confirm, dataDir: roots().dataDir });
    if (r.error) return r;
    log(`[data] deletion of ${r.ids.join(', ')} asked for; quitting to run it`);
    if (isDevRun) return { ...r, restart: false };
    setTimeout(() => { app.relaunch(); app.quit(); }, 1500);
    return { ...r, restart: true };
  });

  utilityHandle('data:cancel-delete', allowed, () => ({ ok: Delete.cancelDeletion(roots()) }));
}

module.exports = { register };
