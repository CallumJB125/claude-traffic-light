'use strict';
// Codex's person-owned desktop chats have more than one creation source.
// These are thread kinds, not permission grants: main still verifies the
// signed parent, stdio, open rollout, folder and unique thread ownership.
const DESKTOP_SOURCES = new Set(['user', 'voice_chat', 'agent_created_thread']);

function isInteractive({ source, originator, threadSource, ephemeral, parentThreadId, agentRole, agentNickname } = {}) {
  if (ephemeral === true || parentThreadId || agentRole || agentNickname || source !== 'vscode') return false;
  if (originator === 'codex-tui') return threadSource === 'user';
  return originator === 'codex_work_desktop' && DESKTOP_SOURCES.has(threadSource);
}

module.exports = { isInteractive };
