'use strict';
// The new-chat screen, main's side (chat-first preview, redesign R2b-2; plan-r2b-auth §2.2). The same task box as
// Home's (src/compose-main.js createCompose), bound to the new-chat document, with its own channels and copy:
//   - newchat:create is the only channel that starts anything, sent only by Send or ⌘↩;
//   - no stop (§7 item 1, awaiting Callum) and no task card: it pushes newchat:changed only (review S3);
//   - it stays alive only while a create is in flight, never because the task is live (review S1);
//   - after a create, main (never the page) opens the new chat's thread, only if the document is still current
//     before and after the one refresh a lagging row model gets (review note 2). Then this instance retires, so the
//     page left behind holds no Tasks slot (S1). If the row still isn't listed, the page stays with
//     "Started." and Open in Tasks for that id only. Never Board.
// Registered by main.js only under CHAT_PREVIEW.
const Compose = require('./compose-main.js');

const CHANNELS = Object.freeze({ info: 'newchat:info', pickFolder: 'newchat:pick-folder', route: 'newchat:route', preflight: 'newchat:preflight',
  run: 'newchat:create', openInTasks: 'newchat:open-in-tasks' });
const PUSH = Object.freeze({ changed: 'newchat:changed' });
const COPY = Object.freeze({
  moved: 'The new chat changed while that was being checked. Nothing was started. Look again, then press Send.',
  focus: 'Focus the new chat and press Send again.',
  stopMoved: '',
});

/**
 * deps: compose-main's deps (ipcMain, buddy, service, config, sessions, homeDir, isDir, muted, pickFolder, openInTasks).
 * glue: { rowForTask(taskId) → thread row id | null, refreshTasks() → Promise }
 */
function createNewChat(deps, glue) {
  const buddy = () => deps.buddy();
  async function afterCreate({ id, current }) {
    if (!current()) return false;
    let row = null;
    try { row = glue.rowForTask(id); } catch { row = null; }
    if (!row) {
      // The row model lags the create: one refresh, and that await is another point where the document can move.
      try { await glue.refreshTasks(); } catch { /* resolve against what's there */ }
      if (!current()) return false;
      try { row = glue.rowForTask(id); } catch { row = null; }
    }
    if (!row || !current()) return false;
    return buddy()?.openThread?.(row) === true;
  }
  return Compose.createCompose({ ...deps, shortcut: () => null }, {
    channels: CHANNELS, push: PUSH, copy: COPY,
    pageWc: () => buddy()?.newChatWebContents?.() ?? null,
    docNow: () => buddy()?.newChatDocument?.() ?? null,
    context: () => buddy()?.newChatContext?.(),
    hidden: () => false,
    openCard: false, oneAtATime: true, keepAlive: 'create', afterCreate,
  });
}

module.exports = { createNewChat, CHANNELS, PUSH, COPY };
