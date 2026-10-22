'use strict';
// Main's side of the agent bus (board/AGENT-BUS.md): an async relay to the
// tasks utilityProcess, where bus.db, the guard and the dispatcher live. Nothing
// here opens SQLite or touches the filesystem: Electron main must never block
// on the bus (test/bus-main-thread.test.js).

const DEFAULTS = Object.freeze({
  // repos empty: automatic (any checkout a Claude or Codex session here works in); non-empty: only these. exclude always wins.
  enabled: true, autoAccept: true, repos: [], exclude: [], wallClockMin: 20,
  // Owner decision 2026-10-22: spend caps exist and default off.
  caps: { enabled: false, memberUsd: 20, handoffUsd: 5 },
});

function normalize(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const num = (v, d, lo, hi) => (Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d);
  const caps = c.caps && typeof c.caps === 'object' ? c.caps : {};
  const list = (l) => (Array.isArray(l) ? l : []).filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim().slice(0, 1024)).slice(0, 100);
  return {
    enabled: c.enabled !== false, autoAccept: c.autoAccept !== false,
    repos: list(c.repos), exclude: list(c.exclude),
    wallClockMin: Math.round(num(c.wallClockMin, DEFAULTS.wallClockMin, 1, 24 * 60)),
    caps: { enabled: caps.enabled === true, memberUsd: num(caps.memberUsd, DEFAULTS.caps.memberUsd, 0, 10000), handoffUsd: num(caps.handoffUsd, DEFAULTS.caps.handoffUsd, 0.01, 100) },
  };
}

// What the utility process gets: guard settings, the Preferences "only these" and exclude lists, and the folders
// main knows (task folders and the working folders of live Claude and Codex sessions on this Mac).
function contextOf(cfg, folders = []) {
  const n = normalize(cfg);
  return {
    settings: { enabled: n.enabled, auto_accept: n.autoAccept, wall_clock_min: n.wallClockMin, allow_pr: false,
      caps: { enabled: n.caps.enabled, member_usd: n.caps.memberUsd, handoff_usd: n.caps.handoffUsd } },
    repos: n.repos, exclude: n.exclude, folders: [...new Set(folders.filter((f) => typeof f === 'string' && f))].slice(0, 200),
  };
}

/** tasks(): the started tasks service; started(): whether it exists yet (settings changes never start the helper). */
function register({ ipcMain, sessionsAllowed, tasks, started = () => true, config, folders = () => [], onChange = () => {} }) {
  // The tray keeps its default size: Stop appears once an AI has handed off this session, or while halted.
  let halted = false, used = false, sent = null;
  const call = (op, args, caller) => tasks().bus(op, args, caller);
  const context = () => contextOf(config().agentBus, folders());
  const push = (ctx = context()) => { sent = JSON.stringify(ctx); return call('busSetContext', ctx); };
  const track = (r) => { if (r && typeof r.halted === 'boolean' && r.halted !== halted) { halted = r.halted; onChange(); } return r; };
  const halt = () => call('halt', {}).then(track);
  const resume = () => call('resume', {}).then(track);
  const unavailable = { available: false, reason: 'tasks_helper_unavailable' };
  // Opening Sessions never starts the Tasks helper just to show an empty panel.
  ipcMain.handle('bus:list', (e) => (!sessionsAllowed(e) ? null : started() ? call('list', { limit: 100 }).then(track, () => unavailable) : unavailable));
  ipcMain.handle('bus:halt', (e) => (sessionsAllowed(e) ? halt().catch(() => unavailable) : null));
  ipcMain.handle('bus:resume', (e) => (sessionsAllowed(e) ? resume().catch(() => unavailable) : null));
  return {
    context,
    relay: async (op, args, caller) => {
      if (op === 'handoff' && !used) { used = true; onChange(); }
      // Sessions come and go: the helper hears the current folders before it decides whether a repo is on the bus.
      if ((op === 'hello' || op === 'handoff') && started()) { const ctx = context(); if (JSON.stringify(ctx) !== sent) await push(ctx).catch(() => {}); }
      return call(op, args, caller);
    },
    sync: () => { if (started()) push().catch(() => {}); },
    // Once the helper is up (after a restart while halted the tray must offer Resume before Sessions is opened).
    refresh: () => call('status', {}).then(track, () => {}),
    halt, resume,
    trayItems: () => (normalize(config().agentBus).enabled && (used || halted)
      ? [halted ? { label: 'Resume agent bus', click: () => resume().catch(() => {}) } : { label: 'Stop agent bus', sublabel: 'Stops every run AIs handed to each other', click: () => halt().catch(() => {}) }]
      : []),
  };
}

module.exports = { register, normalize, contextOf, DEFAULTS };
