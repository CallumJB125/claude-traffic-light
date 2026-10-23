'use strict';
// Which local session a "go to the one that needs you" click lands on, pure.
// A limit hit still jumps the whole queue. Otherwise: sessions blocked on the
// person (a permission ask, a failed turn, or one Ghostty Dock shows as
// waiting) longest-waiting first, then finished turns, longest-waiting first.
const { WAITING_ON_YOU } = require('../hooks/session-machine.js');

const FINISHED = new Set(['stop', 'idle-nudge']);
// Plexiform's own signals already settle these; Dock's view can't override them.
const ENDED = new Set(['session-end']);
const at = (s) => Date.parse(s && s.updatedAt) || 0;
const byAge = (a, b) => at(a) - at(b);

// `dockStatus`: Map<lowercase uuid, Dock status word> from
// src/ghostty-dock.js listStatus, or null. Only a session Plexiform already
// has under that exact id can be promoted; nothing is created from Dock output.
function dockWaiting(s, dockStatus) {
  if (!dockStatus || !s || typeof s.sessionId !== 'string') return false;
  if (WAITING_ON_YOU.has(s.signal) || ENDED.has(s.signal)) return false;
  return dockStatus.get(s.sessionId.toLowerCase()) === 'waiting';
}

function needingQueue(sessions, { dockStatus = null } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const limits = list.filter((s) => s.signal === 'limit-hit').sort(byAge);
  if (limits.length) return limits;
  const blocked = [];
  const finished = [];
  for (const s of list) {
    if (WAITING_ON_YOU.has(s.signal)) (FINISHED.has(s.signal) ? finished : blocked).push(s);
    else if (dockWaiting(s, dockStatus)) blocked.push(s);
  }
  return [...blocked.sort(byAge), ...finished.sort(byAge)];
}

// The widget's line after a jump. Says plainly when only the app came forward.
function jumpFeedback(folder, badge, activated) {
  if (activated && activated.cant) return `${folder}${badge}: ${activated.cant}`;
  if (!activated) return `→ ${folder}${badge} · path copied`;
  if (activated.exact) return `→ ${folder}${badge} · tab found · path copied`;
  if (activated.byFolder) return `→ ${folder}${badge} · the one ${activated.app} tab in that folder · path copied`;
  return `Opened ${activated.app} — couldn't pick the tab (${folder}${badge}) · path copied`;
}

module.exports = { needingQueue, jumpFeedback, dockWaiting, FINISHED };
