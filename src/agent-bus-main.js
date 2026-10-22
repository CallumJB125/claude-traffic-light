'use strict';
// Main's side of the agent bus (board/AGENT-BUS.md): an async relay to the
// tasks utilityProcess, where bus.db, the guard and the dispatcher live. Nothing
// here opens SQLite or touches the filesystem: Electron main must never block
// on the bus (test/bus-main-thread.test.js).

const DEFAULTS = Object.freeze({
  // scope 'auto': any checkout a Claude or Codex session here works in; 'listed', or any repos listed: only these.
  // exclude always wins.
  enabled: true, autoAccept: true, scope: 'auto', repos: [], exclude: [], wallClockMin: 20,
  // Owner decision 2026-10-22: spend caps exist and default off.
  caps: { enabled: false, memberUsd: 20, handoffUsd: 5 },
});

function normalize(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const num = (v, d, lo, hi) => (Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d);
  const caps = c.caps && typeof c.caps === 'object' ? c.caps : {};
  const list = (l) => (Array.isArray(l) ? l : []).filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim().slice(0, 1024)).slice(0, 100);
  return {
    enabled: c.enabled !== false, autoAccept: c.autoAccept !== false, scope: c.scope === 'listed' ? 'listed' : 'auto',
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
    scope: n.scope, repos: n.repos, exclude: n.exclude, folders: [...new Set(folders.filter((f) => typeof f === 'string' && f))].slice(0, 200),
  };
}

/** tasks(): the started tasks service; started(): whether it exists yet (settings changes never start the helper). */
function register({ ipcMain, sessionsAllowed, tasks, started = () => true, config, folders = () => [], onChange = () => {} }) {
  // The tray keeps its default size: Stop appears once an AI has handed off this session, or while halted.
  // known: the helper has said whether it is halted (refresh() asks at its start); until then halted() is 'unknown'.
  let halted = false, known = false, used = false, sent = null;
  const call = (op, args, caller) => tasks().bus(op, args, caller);
  const context = () => contextOf(config().agentBus, folders());
  // Marked sent only once the helper has it, so a failed push is retried on the next hello or handoff.
  const push = (ctx = context()) => call('busSetContext', ctx).then((r) => { sent = JSON.stringify(ctx); return r; });
  const track = (r) => { if (r && typeof r.halted === 'boolean') { known = true; if (r.halted !== halted) { halted = r.halted; onChange(); } } return r; };
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
    // Last known; 'unknown' counts as halted wherever it matters (plan §3.3).
    halted: () => (known ? halted : 'unknown'),
    trayItems: () => (normalize(config().agentBus).enabled && (used || halted)
      ? [halted ? { label: 'Resume agent bus', click: () => resume().catch(() => {}) } : { label: 'Stop agent bus', sublabel: 'Stops every run AIs handed to each other', click: () => halt().catch(() => {}) }]
      : []),
  };
}

// One-time, for configs saved before automatic mode (no exclude key): an empty list with policy.json bus_auto keys
// meant "only those", so it stays listed. Returns the agentBus to save, or null when nothing changes.
function migrate(saved, policy) {
  if (!saved || typeof saved !== 'object' || 'exclude' in saved) return null;
  const repos = policy && typeof policy.repos === 'object' && policy.repos ? policy.repos : {};
  const listed = !(Array.isArray(saved.repos) && saved.repos.length) && Object.values(repos).some((v) => v?.bus_auto === true);
  return normalize({ ...saved, exclude: [], scope: listed ? 'listed' : saved.scope });
}

module.exports = { register, normalize, contextOf, migrate, DEFAULTS };
