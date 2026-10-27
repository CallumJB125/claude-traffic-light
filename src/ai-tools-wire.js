'use strict';
// main.js composition for the AI tools page: the engine, its IPC, and the
// destinations Help and Preferences may send people to.
const path = require('node:path');
const AiTools = require('./ai-tools.js');
const AiToolsMain = require('./ai-tools-main.js');

// Handover chips appear once the handover writer is in this build.
function handoverSources() {
  try { require.resolve('./session-handover.js'); } catch { return []; }
  return ['claude', 'codex', 'gemini', 'cursor', 'hermes'];
}

function wire({ ipcMain, shell, clipboard, home, runtime, rootDir, fromPage, focusAllowed, askFromWidget, ephemeral, openPage, fs, onClaudeConsent = () => {}, onClaudeHooks }) {
  const tools = AiTools.create({
    home, runtime, ...(fs ? { fs } : {}), dataDir: rootDir, sessionsDir: path.join(rootDir, 'sessions'),
    claudeAskFromWidget: askFromWidget, ...(onClaudeHooks ? { onClaudeHooks } : {}), handoverSources,
    blocked: () => (ephemeral ? 'Plexiform is running from a temporary copy or a disk image. Move it to Applications first, or the hooks would point at a path that disappears.' : null),
  });
  // Connecting Claude Code on this page is consent to its re-connect; Disconnect or Undo withdraws it.
  const consent = (id, on) => async (r) => { const out = await r; if (id === 'claude' && out?.ok) onClaudeConsent(on); return out; };
  const page = {
    ...tools,
    connect: (id) => consent(id, true)(tools.connect(id)),
    disconnect: (id) => consent(id, false)(tools.disconnect(id)),
    undo: (id) => consent(id, false)(tools.undo(id)),
    connectAll: async () => { const r = await tools.connectAll(); if (r?.results?.some((x) => x.id === 'claude' && x.ok)) onClaudeConsent(true); return r; },
  };
  const ipc = AiToolsMain.register({ ipcMain, fromPage, focusAllowed, shell, clipboard, tools: page });
  return {
    tools,
    // 'aitools', 'aitools:<id>' or 'aitools:all' → opens the page (true), anything else false.
    open(destination) {
      const d = AiToolsMain.parseDestination(destination);
      if (!d) return false;
      ipc.setFocus(d.focus);
      openPage('aitools');
      return true;
    },
    quick: () => tools.quick(),
  };
}

module.exports = { wire };
