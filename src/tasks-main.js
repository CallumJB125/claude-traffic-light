'use strict';
// Main-only document authority for Tasks effects. A retained WebContents is
// insufficient: the exact document, active workspace/account and visible
// focused owner must survive every asynchronous review/confirmation boundary.
function register({ ipcMain, buddy, service }) {
  function owner() {
    const b = buddy(), c = b?.tasksContext?.();
    if (!c?.foreground || !c.window || !c.contents || c.window.isDestroyed() || c.contents.isDestroyed() || !c.contents.mainFrame
      || !Number.isSafeInteger(c.generation) || !Number.isSafeInteger(c.document) || !Number.isSafeInteger(c.account)) return null;
    return { buddy: b, window: c.window, contents: c.contents, frame: c.contents.mainFrame, generation: c.generation, document: c.document, account: c.account, workspace: c.workspace };
  }
  function same(before) {
    const after = owner();
    return !!before && !!after && Object.keys(before).every(key => before[key] === after[key]);
  }
  for (const action of ['preflight', 'create']) ipcMain.handle(`tasks:${action}`, async (event, ...args) => {
    const before = owner();
    if (!before || event.sender !== before.contents || event.senderFrame !== before.frame || args.length !== 1) return { ok: false, code: 'ILLEGAL_TRANSITION', text: 'Focus the current Tasks page and review again.' };
    const result = await service()[action](args[0], { wcId: event.sender.id, current: () => same(before) });
    if (!same(before)) return { ok: false, code: 'CONFLICT', text: action === 'create' ? 'The Tasks view changed. Check existing Tasks before starting again.' : 'The Tasks view changed. Check this folder again.' };
    return result;
  });
  ipcMain.handle('tasks:act', async (event, ...args) => {
    const before = owner();
    if (!before || event.sender !== before.contents || event.senderFrame !== before.frame || args.length !== 1) return { ok: false, code: 'ILLEGAL_TRANSITION', text: 'Focus the current Tasks page and review again.' };
    const result = await service().act(args[0], event.sender.id, () => same(before));
    if (!same(before)) return { ok: false, code: 'CONFLICT', text: 'The Tasks view changed. Inspect the task and your branch before reviewing another action.' };
    return result;
  });
}
module.exports = { register };
