// The widget's size while something hangs under Claude (the waiting-input
// bubble, the budget notice or the "while you were away" recap). The widget's own rect is the
// base; a strip adds height, and for the bubble enough width to read it,
// split evenly so Claude stays put. The grown rect is kept on screen by
// moving it up or left, never by shrinking it. Pure: main applies the result.
'use strict';

const NONE = Object.freeze({ kind: null, px: 0, w: 0, dx: 0, dy: 0 });

// The widget's own rect, given its current rect and the strip applied to it.
function baseOf(current, strip = NONE) {
  return { x: current.x + strip.dx, y: current.y + strip.dy, width: current.width - strip.w, height: current.height - strip.px };
}

// next: { kind: 'bubble'|'budget'|'away'|'update'|null, px, minWidth }. → { bounds, strip }
function stripBounds(current, strip = NONE, next = {}, workArea = null) {
  const base = baseOf(current, strip);
  const px = next.kind ? Math.max(0, Math.round(next.px || 0)) : 0;
  if (!px) return { bounds: base, strip: NONE };
  const extra = next.minWidth ? Math.max(0, Math.round(next.minWidth) - base.width) : 0;
  const b = { x: base.x - Math.round(extra / 2), y: base.y, width: base.width + extra, height: base.height + px };
  if (workArea) {
    const right = workArea.x + workArea.width;
    const bottom = workArea.y + workArea.height;
    if (b.x + b.width > right) b.x = right - b.width;
    if (b.x < workArea.x) b.x = workArea.x;
    if (b.y + b.height > bottom) b.y = bottom - b.height;
    if (b.y < workArea.y) b.y = workArea.y;
  }
  return { bounds: b, strip: { kind: next.kind, px, minWidth: next.minWidth || 0, w: extra, dx: base.x - b.x, dy: base.y - b.y } };
}

// Whether `next` asks for something other than what is applied.
const sameStrip = (strip, next) => (strip.kind || null) === (next.kind || null) && strip.px === (next.kind ? Math.round(next.px || 0) : 0) && (strip.minWidth || 0) === (next.minWidth || 0);

// The bubble's height that still fits on the display under the widget's own
// rect: the cap, or less on a short display (the bubble then scrolls).
const bubbleRoom = (baseHeight, workArea, maxPx) => Math.max(0, Math.min(maxPx, Math.floor(workArea.height - baseHeight)));

// Whether main must tell the widget its bubble's room: the room changed, or the
// bubble asks for more than it (the widget hasn't heard yet, e.g. after a reload).
// The widget then caps the bubble at that room, so it scrolls and asks what fits.
const sendCap = (cap, sent, asked) => cap !== sent || asked > cap;

// Whether the widget may be told its bubble has its room. Past the cap the
// window was clamped, so the bubble may be clipped: don't vouch for it.
const shouldAck = (strip, asked, acked, maxPx) => !!strip && strip.kind === 'bubble' && asked <= maxPx && acked !== asked;

// Whether roam, glide, the garden and resizing must wait. The bubble and the
// recap change the window's width or hang a lot under Claude, so moving or
// resizing the grown rect would carry them along wrongly; the quiet update
// row (no extra width, no offset of its own) can ride along.
const blocksTravel = (strip) => !!strip && (strip.kind === 'bubble' || strip.kind === 'away' || strip.kind === 'budget');

// Resize the widget's own rect by `factor` about its centre, keeping its
// shape and limits, then hang the same strip under it again.
// limits: { minWidth, maxWidth, aspect }. → { bounds, strip }
function resizeBase(current, strip = NONE, factor, limits, workArea = null) {
  const base = baseOf(current, strip);
  const width = Math.round(Math.min(limits.maxWidth, Math.max(limits.minWidth, base.width * factor)));
  const height = Math.round(width / limits.aspect);
  const next = { x: Math.round(base.x + base.width / 2 - width / 2), y: Math.round(base.y + base.height / 2 - height / 2), width, height };
  if (!strip.kind) return { bounds: next, strip: NONE };
  return stripBounds(next, NONE, { kind: strip.kind, px: strip.px, minWidth: strip.minWidth }, workArea);
}

// ── Session rows (wave 1, lane A) ───────────────────────────────────────────
// The strip of session chips under Claude, as a model the renderer paints:
// the pinned session first, then active sessions, then idle ones, which fold
// into one "+N idle" chip once the strip would hold more than `collapseAfter`
// rows (default 4). Teammates' sessions (board presence) are a second row,
// every entry marked `team: true`. Pure: nothing here touches the DOM.
const { WAITING, IDLE } = require('./session-card-view.js');
const COLLAPSE_AFTER = 4;
const rowId = (s) => (s && typeof s.sessionId === 'string' && s.sessionId) || null;
const isIdle = (s) => IDLE.has(String(s && s.signal || '')) && !WAITING.has(String(s && s.signal || ''));
const byRecent = (a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0);

// sessions: the widget's own rows; teammates: [{name, sessions:[{agent, repo_short, branch, state}]}].
// → { rows: [{kind:'session', id, session, pinned, waiting, idle, team:false} | {kind:'idle', count, ids, team:false}],
//     team: [{kind:'session', id, session, name, team:true}], pinnedId, collapsed }
function sessionRows(sessions = [], { pinnedId = null, teammates = [], collapseAfter = COLLAPSE_AFTER } = {}) {
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && typeof s === 'object');
  const row = (s) => ({ kind: 'session', id: rowId(s), session: s, pinned: !!pinnedId && rowId(s) === pinnedId, waiting: WAITING.has(String(s.signal || '')), idle: isIdle(s), team: false });
  const pinned = pinnedId ? list.filter((s) => rowId(s) === pinnedId) : [];
  const rest = list.filter((s) => !pinned.includes(s));
  const active = rest.filter((s) => !isIdle(s)).sort((a, b) => Number(b.signal && WAITING.has(b.signal)) - Number(a.signal && WAITING.has(a.signal)) || byRecent(a, b));
  const idle = rest.filter(isIdle).sort(byRecent);
  const total = pinned.length + active.length + idle.length;
  const collapsed = idle.length > 1 && total > Math.max(0, collapseAfter);
  const rows = [...pinned.map(row), ...active.map(row)];
  if (collapsed) rows.push({ kind: 'idle', count: idle.length, ids: idle.map(rowId).filter(Boolean), team: false });
  else rows.push(...idle.map(row));
  const team = [];
  for (const m of Array.isArray(teammates) ? teammates : []) {
    if (!m || typeof m !== 'object') continue;
    const name = typeof m.name === 'string' ? m.name : '';
    for (const [i, s] of (Array.isArray(m.sessions) ? m.sessions : []).entries()) {
      if (!s || typeof s !== 'object') continue;
      team.push({ kind: 'session', id: `team:${m.member_id || name}:${i}`, session: { cwd: s.repo_short || '', tool: s.agent || '', signal: s.state === 'waiting' ? 'permission-ask' : s.state === 'idle' ? 'idle' : 'tool-use', branch: s.branch || null }, name, team: true });
    }
  }
  return { rows, team, pinnedId: pinned.length ? pinnedId : null, collapsed };
}

module.exports = { NONE, baseOf, stripBounds, sameStrip, blocksTravel, resizeBase, shouldAck, bubbleRoom, sendCap, sessionRows, COLLAPSE_AFTER };
