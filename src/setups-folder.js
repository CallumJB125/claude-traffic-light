'use strict';
// "Apply to a folder": main-side IPC for src/setup-apply.js. The renderer only
// ever holds opaque ids; the folder comes from main's own dialog, the file text
// from the team service, and Apply needs the token the dry run produced.
const { randomUUID } = require('node:crypto');
const setupApply = require('./setup-apply.js');

const MAX_PLANS = 8;
const SHA = /^[0-9a-f]{64}$/;
const refuse = (error) => ({ ok: false, error });
const message = (e) => (e instanceof setupApply.ApplyError ? e.message : 'The folder could not be changed.');

function register({ ipcMain, allowed, source, pickFolder, apply = setupApply }) {
  const plans = new Map();
  const undos = new Map();
  const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!allowed(e)) return null;
    try { return await fn(...args); } catch (err) { return refuse(message(err)); }
  });

  handle('setups:folder-plan', async (profileHandle) => {
    if (typeof profileHandle !== 'string' || profileHandle.length > 100) return refuse('This team setup is unavailable.');
    const folder = await pickFolder();
    if (!folder) return refuse('Cancelled. Nothing was changed.');
    const src = await source(profileHandle);
    const files = src?.payload?.files;
    if (!Array.isArray(files) || !files.length) return refuse('This team setup is unavailable. Refresh current team access.');
    const setup = { files: files.map((f) => ({ path: f.relative_path, content: f.content })) };
    const p = apply.plan(setup, folder);
    const id = randomUUID();
    plans.set(id, { setup, folder: p.folder, token: p.token });
    while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value);
    return { ok: true, planId: id, folder: p.folder, token: p.token, changes: p.changes, entries: p.entries.map(({ path, action, bytes, diff }) => ({ path, action, bytes, diff })) };
  });

  handle('setups:folder-apply', async (planId, token) => {
    const held = typeof planId === 'string' ? plans.get(planId) : null;
    if (!held) return refuse('Preview the changes again before applying.');
    if (typeof token !== 'string' || !SHA.test(token) || token !== held.token) return refuse('Confirmation does not match the previewed changes.');
    plans.delete(planId);
    const r = apply.apply(held.setup, held.folder, token);
    const undoId = randomUUID();
    undos.set(undoId, { folder: held.folder, id: r.id });
    return { ok: true, undoId, written: r.written };
  });

  handle('setups:folder-undo', async (undoId) => {
    const held = typeof undoId === 'string' ? undos.get(undoId) : null;
    if (!held) return refuse('There is nothing to undo.');
    const r = apply.undo(held.folder, held.id);
    undos.delete(undoId);
    return { ok: true, restored: r.restored, skipped: r.skipped };
  });
}

module.exports = { register };
