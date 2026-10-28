'use strict';
// T4a: the thread document's whole view of one of my own Plexiform-held sessions (plan-t4a §2.3).
// A fixed projection of one interaction-hub state read. Nothing here is a session, native, actor or
// board id, a capability or a handle; the renderer sets every string with textContent. The activity
// and message bounds are T2's own (shared-thread-view.js), so both thread kinds clean text the same way.
const { activityOf, deliveriesOf, line } = require('./shared-thread-view');
const { AI } = require('./session-title');

const TOP_KEYS = Object.freeze(['header', 'activity', 'deliveries', 'status']);
const HEADER_KEYS = Object.freeze(['title', 'provider', 'channel']);
const CHANNEL_TITLE = 'Plexiform channel';
const STATUSES = Object.freeze(['ready', 'working', 'compacting', 'ended']);

// The row and thread title (plan-t4a §3, §6 Q1): a terminal channel is always "Plexiform channel", so it never reads
// like the terminal's own Claude row; anything else is its reported task, else "‹AI› session".
function titleOf(s) {
  if (s?.provider?.id === 'claude-channel') return CHANNEL_TITLE;
  return line(s?.task_title, 120) || `${providerOf(s)} session`;
}
function providerOf(s) { return AI[s?.provider?.id] ?? (line(s?.provider?.label, 60) || 'AI'); }

function project({ state, now }) {
  const s = state && typeof state === 'object' ? state : {};
  const channel = s.provider?.id === 'claude-channel';
  return {
    header: { title: titleOf(s), provider: channel ? 'Claude Code' : providerOf(s), channel },
    activity: activityOf(s, now),
    deliveries: deliveriesOf(s),
    status: STATUSES.includes(s.status) ? s.status : 'ready',
  };
}

module.exports = { project, titleOf, providerOf, TOP_KEYS, HEADER_KEYS, CHANNEL_TITLE };
