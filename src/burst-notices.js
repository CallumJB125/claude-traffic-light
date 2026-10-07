'use strict';

// Burst's on-screen events (~/.config/claude-burst/notices.json) as Plexiform
// notifications, and its audit as a Health list. Local file reads only.
// WP0 stub: the signatures main.js and burst-ipc.js are wired against; WP1 fills them in.

const os = require('node:os');
const path = require('node:path');

const noticesPath = (home = os.homedir()) => path.join(home, '.config', 'claude-burst', 'notices.json');

// notices.json -> [{ id, kind, severity: 'info'|'warn'|'error', title, detail, at, session, resolves, auditOnly }]
function normalizeNotices(_raw) { return []; }

// GET /api/audit (scrubbed) -> [{ at, kind, severity, title, detail, source }] newest first, at most 50.
function normalizeAudit(_raw) { return []; }

// onEvents([{ key: 'burst:'+id, title, body, severity, session }]) for new events; onResolve(key) closes one.
// config() is Plexiform's config (budgets, quiet hours); burst() returns the BurstIpc object (read('modStatus') etc.).
// active() is true while notices.json is being watched: main then skips the poll-diff events.
// Options: { file = noticesPath(), isMac, onEvents, onResolve, config, burst, now = Date.now, log }.
function createBurstNotices(_opts = {}) {
  return {
    start() {},
    stop() {},
    active: () => false,
  };
}

module.exports = { createBurstNotices, normalizeNotices, normalizeAudit, noticesPath };
