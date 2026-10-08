'use strict';

// Main-process side of the local session handovers: starts the writer, gives
// it the sessions Plexiform lists (the Sessions page's live rows and the
// Overview's "This Mac" capture rows, background ones left out), and answers
// the Sessions page's View / Copy path / Copy as prompt / Write now actions.
// The page only ever sends a key; the file it names must be one the writer made.

const SessionHandover = require('./session-handover.js');
const Transcripts = require('./handover-transcripts.js');
const Machine = require('../hooks/session-machine');
const { isBackgroundSession, BACKGROUND_TITLE } = require('./work-capture.js');

const STATUS = { 'permission-ask': 'Waiting on you', 'user-question': 'Waiting on you', 'question-ask': 'Waiting on you', stop: 'Turn stopped', 'idle-nudge': 'Idle', idle: 'Idle', 'turn-failed': 'Turn failed', 'session-end': 'Ended', 'session-start': 'Ready', 'limit-hit': 'Limit reached', compact: 'Compacting' };
const msOf = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

// What Plexiform's own state says about one live session (no prompt text).
function stateOf(s, now) {
  const question = s.askKind === 'question' || s.signal === 'user-question' || s.signal === 'question-ask';
  const pending = s.signal === 'permission-ask' || s.signal === 'user-question' || s.signal === 'question-ask' || Machine.claudeInputPending(s) || Machine.codexInputPending(s, now);
  return {
    status: pending ? 'Waiting on you' : STATUS[s.signal] || (typeof s.signal === 'string' && s.signal ? 'Working' : null),
    waiting: pending ? (question ? 'question' : 'permission') : null,
    tool: pending && typeof s.tool === 'string' ? s.tool.slice(0, 60) : null,
  };
}

// live: the local session store rows; capture: work-capture handoverRows().
function rowsFrom({ live = [], capture = [], now = Date.now() } = {}) {
  const out = new Map();
  for (const s of Array.isArray(live) ? live : []) {
    if (!s || typeof s.sessionId !== 'string' || !s.sessionId || s.remote || s.device || s.sessionId.startsWith('remote:') || isBackgroundSession(s)) continue;
    const adapter = SessionHandover.adapterOf(s.source);
    out.set(SessionHandover.keyOf(adapter, s.sessionId), { adapter, sessionId: s.sessionId, cwd: typeof s.cwd === 'string' ? s.cwd : '', lastActiveMs: Math.max(msOf(s.updatedAt), msOf(s.codexHookAt)), state: stateOf(s, now) });
  }
  for (const c of Array.isArray(capture) ? capture : []) {
    if (!c || typeof c.session_id !== 'string' || !c.session_id || BACKGROUND_TITLE.test(String(c.title ?? '').trim())) continue;
    const adapter = SessionHandover.adapterOf(c.provider);
    const key = SessionHandover.keyOf(adapter, c.session_id);
    if (!out.has(key)) out.set(key, { adapter, sessionId: c.session_id, cwd: '', lastActiveMs: Number(c.last_seen) || 0, state: null });
  }
  return [...out.values()];
}

function register({ ipcMain, rootDir, isExcluded, burstFor, home, sessionsAllowed, clipboard, shell, sessions = () => ({}), log = () => {}, start = true }) {
  const writer = SessionHandover.create({ rootDir, isExcluded, burstFor, home, log, transcripts: Transcripts.createLocator({ home }), rows: () => rowsFrom({ ...(sessions() || {}), now: Date.now() }) });
  if (start) writer.start();
  ipcMain.handle('sessions:handover', async (e, action, key) => {
    if (!sessionsAllowed(e)) return false;
    if (action === 'view') { const f = writer.pathOf(key); return f ? (await shell.openPath(f)) === '' : false; }
    if (action === 'copy-path') { const f = writer.pathOf(key); if (f) clipboard.writeText(f); return !!f; }
    if (action === 'copy-prompt') { const t = writer.promptOf(key); if (t) clipboard.writeText(t); return !!t; }
    if (action === 'write') return writer.refresh(key);
    return false;
  });
  // The widget / tray menu entry for the first local session: only when its handover exists.
  const menuItems = (row) => {
    const v = row && writer.view(row);
    return v && v.ready ? [{ label: 'Copy Handover as Prompt', click: () => { const t = writer.promptOf(v.key); if (t) clipboard.writeText(t); } }] : [];
  };
  return { writer, view: (row) => writer.view(row), menuItems };
}

module.exports = { register, rowsFrom, stateOf };
