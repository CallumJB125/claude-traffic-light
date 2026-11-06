'use strict';
// Public diagnostics contain closed codes and product guidance only. Never
// expose the verified process, thread, folder or caller-supplied metadata.
function bindingStatus(result = {}) {
  if (result.bound === true) return { state: 'ready' };
  switch (result.reason) {
    case 'UNSUPPORTED': return { state: 'unsupported', next: 'Session identity is unavailable on this platform. Use a supported local session for notes.' };
    case 'NO_THREAD': return { state: 'missing-thread', next: 'This client did not identify the calling Codex chat. Update Codex and Plexiform, then reconnect the integration.' };
    case 'NO_SESSION': case 'UNOBSERVED': return { state: 'not-observed', next: 'No recent lifecycle event matches this caller. Check Plexiform activity hooks and their approval, then start a new turn in this chat.' };
    case 'HEADLESS': return { state: 'unsupported-thread', next: 'Plexiform classified this as a background or unsupported chat type. Update Plexiform for current desktop chat support; background runs cannot send session notes.' };
    case 'CWD': return { state: 'folder-mismatch', next: 'The integration and chat folders differ. Reconnect the integration from this chat; Plexiform will not guess another session.' };
    case 'CONTESTED': case 'OWNER': case 'THREAD_MISMATCH': return { state: 'ownership-conflict', next: 'More than one session owner or a different chat claimed this connection. Reconnect the intended chat; do not edit session identity files.' };
    default: return { state: 'unverified', next: 'Plexiform could not verify this integration as the chat’s own connection. Check Plexiform Health and reconnect the integration in the intended chat.' };
  }
}
module.exports = { bindingStatus };
