'use strict';
// Cost guard (paid tier W1-B), app side. spend.js already works out budgets
// and runaway sessions and main.js already notifies about them; this adds
// only what was missing:
//   - enforced caps: with "Enforce" on, an exceeded daily/weekly budget is
//     written to spend-gate.json, and hooks/spend-gate.js answers every
//     PreToolUse with a deny (Claude stops on its own; nothing is killed)
//   - runaway stopping: a latched runaway session's tool calls are denied the
//     same way, and a Plexiform-owned Claude session is interrupted
//   - a Stop button for owned Claude sessions: they register in main's
//     runawayStoppers, which the runaway notification already looks up
//   - the Usage & cost page's waste callouts and monthly receipt (IPC)
// Fail-open everywhere: any error removes the gate file, and the hook treats
// a missing or stale gate as "allow". Enforcement and waste need Plus
// (costguard.enforce / costguard.waste); the receipt is a teaser on free.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Gate = require('../hooks/spend-gate.js');
const Waste = require('./waste.js');
const Receipt = require('./receipt.js');

const SETTINGS_FILE = 'cost-guard.json';
const LOG_FILE = 'cost-guard-log.json';
const TICK_MS = 5000;
const GATE_TTL_MS = 60 * 1000;
const LOG_MAX = 500;
const WASTE_DAYS = 7;
const WASTE_TTL_MS = 5 * 60 * 1000;
const RECEIPT_TTL_MS = 10 * 60 * 1000;
const WHERE = 'Plexiform → Usage & cost';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

function readSettings(rootDir) {
  const s = readJson(path.join(rootDir, SETTINGS_FILE), {});
  return { enforceCaps: s?.enforceCaps === true, stopRunaways: s?.stopRunaways === true };
}
function saveSettings(rootDir, v) {
  const cur = readSettings(rootDir);
  const next = { enforceCaps: typeof v?.enforceCaps === 'boolean' ? v.enforceCaps : cur.enforceCaps, stopRunaways: typeof v?.stopRunaways === 'boolean' ? v.stopRunaways : cur.stopRunaways };
  writeAtomic(path.join(rootDir, SETTINGS_FILE), next);
  return next;
}

function readLog(rootDir) {
  const l = readJson(path.join(rootDir, LOG_FILE), []);
  return Array.isArray(l) ? l : [];
}
function appendLog(rootDir, entries) {
  if (!entries.length) return;
  writeAtomic(path.join(rootDir, LOG_FILE), readLog(rootDir).concat(entries).slice(-LOG_MAX));
}

/** → the gate to write ({v, at, ttlMs, cap, sessions}), or null when nothing is refused. */
function gateFor({ snapshot, settings, now = Date.now() }) {
  if (!snapshot) return null;
  const cap = settings.enforceCaps && snapshot.budget?.level === 'exceeded'
    ? `Plexiform budget cap reached (${snapshot.budgetText || 'over budget'}). Raise or turn off the cap in ${WHERE}.` : null;
  const sessions = {};
  if (settings.stopRunaways) {
    for (const r of Array.isArray(snapshot.runaway) ? snapshot.runaway : []) {
      if (typeof r?.sessionId !== 'string') continue;
      sessions[r.sessionId] = `Plexiform stopped this runaway session (${r.burn}). It resumes once its recent spend falls back under half the runaway limit, or turn runaway stopping off in ${WHERE}.`;
    }
  }
  if (!cap && !Object.keys(sessions).length) return null;
  return { v: 1, at: now, ttlMs: GATE_TTL_MS, cap, sessions };
}

function writeGate(rootDir, gate) {
  const file = path.join(rootDir, Gate.GATE_FILE);
  if (!gate) { fs.rmSync(file, { force: true }); return; }
  writeAtomic(file, gate);
}

// Owned Claude sessions (claude -p, started by Plexiform) get a Stop: their
// interrupt, through the interaction hub as the document that owns them.
// `mine` holds the ids this module registered, so it never removes another's.
function syncOwnedStoppers(stoppers, owned, mine) {
  if (!stoppers || !owned || typeof owned.list !== 'function') return;
  const live = new Set();
  for (const o of owned.list() || []) {
    const s = o?.state;
    const id = o?.nativeSessionId;
    if (!s || s.ownership !== 'plexiform-owned' || s.provider?.id !== 'claude' || s.status !== 'working' || !s.activeTurn || typeof id !== 'string' || !id) continue;
    live.add(id);
    if (stoppers.has(id) && !mine.has(id)) continue;
    const { session, generation, activeTurn } = s;
    stoppers.set(id, async () => {
      const t = owned.target(session);
      if (!t) throw new Error('that session is no longer open');
      const r = await t.hub.interrupt({ session, generation, turn: activeTurn }, t.actor);
      if (!r?.ok) throw new Error(r?.error || 'the interrupt was refused');
      return r;
    });
    mine.add(id);
  }
  for (const id of [...mine]) if (!live.has(id)) { stoppers.delete(id); mine.delete(id); }
}

/**
 * {rootDir, entitlements, spend: () => snapshot|null, stoppers: () => Map|null,
 *  owned?: {list, target}, now?, log?}
 */
function createEnforcer({ rootDir, entitlements, spend = () => null, stoppers = () => null, owned = null, now = Date.now, log = () => {} }) {
  const mine = new Set();
  const seen = new Set();
  let gate = null;

  function tick() {
    try { syncOwnedStoppers(stoppers(), owned, mine); } catch (e) { log(`[cost-guard] stoppers: ${e?.message ?? e}`); }
    try {
      const settings = readSettings(rootDir);
      if (!entitlements.has('costguard.enforce') || (!settings.enforceCaps && !settings.stopRunaways)) { gate = null; writeGate(rootDir, null); return gate; }
      const snapshot = spend();
      const t = now();
      gate = gateFor({ snapshot, settings, now: t });
      writeGate(rootDir, gate);
      const events = [];
      if (gate?.cap) {
        const b = snapshot.budget;
        const key = `cap:${b.which}:${b.which === 'day' ? b.dayKey : b.weekKey}`;
        if (!seen.has(key)) { seen.add(key); events.push({ kind: 'cap', at: t, which: b.which, spent: (b.which === 'day' ? b.day : b.week)?.spent ?? null }); }
      }
      for (const r of gate ? snapshot.runaway || [] : []) {
        if (!gate.sessions[r.sessionId]) continue;
        const key = `runaway:${r.sessionId}:${r.firedAt ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({ kind: 'runaway', at: t, sessionId: r.sessionId, cost: r.cost, stopped: true });
        const stop = stoppers()?.get(r.sessionId);
        if (stop) Promise.resolve().then(stop).catch((e) => log(`[cost-guard] stop failed: ${e?.message ?? e}`));
      }
      appendLog(rootDir, events);
      return gate;
    } catch (e) {
      // Fail-open: no gate file means the hook allows everything.
      gate = null;
      try { writeGate(rootDir, null); } catch { /* the hook's TTL lets it lapse */ }
      log(`[cost-guard] ${e?.message ?? e}`);
      return null;
    }
  }

  return {
    tick,
    gate: () => gate,
    close() { try { writeGate(rootDir, null); } catch { /* lapses by TTL */ } },
  };
}

/**
 * What the Usage & cost page shows. Waste and enforcement only with their
 * features; the receipt is full or a teaser per limits().receipt.
 */
function createReport({ rootDir, entitlements, enforcer, projectsDir, usageTurns = async () => [], burst = () => null, now = Date.now }) {
  let waste = { at: -Infinity, value: null };
  let receipt = { at: -Infinity, key: null, value: null };
  return async function report() {
    const has = (k) => entitlements.has(k);
    const t = now();
    let wasteOut = null;
    if (has('costguard.waste')) {
      if (t - waste.at > WASTE_TTL_MS) waste = { at: t, value: await Waste.scan({ root: projectsDir, since: t - WASTE_DAYS * 86400000 }) };
      wasteOut = { days: WASTE_DAYS, ...waste.value };
    }
    let receiptOut = null;
    if (has('costguard.receipt')) {
      const full = entitlements.limits()?.receipt === 'full';
      if (t - receipt.at > RECEIPT_TTL_MS || receipt.key !== full) {
        receipt = { at: t, key: full, value: await Receipt.build({ now: t, turns: await usageTurns(), log: readLog(rootDir), burst: burst(), full }) };
      }
      receiptOut = receipt.value;
    }
    const g = enforcer.gate();
    return {
      plan: typeof entitlements.plan === 'function' ? entitlements.plan() : 'free',
      enforce: { available: has('costguard.enforce'), settings: readSettings(rootDir), capActive: !!g?.cap, sessionsStopped: g ? Object.keys(g.sessions).length : 0 },
      waste: wasteOut,
      receipt: receiptOut,
    };
  };
}

// paid-wiring.js calls this once at startup. Every main.js accessor is read
// lazily (some are declared later in main.js than the wiring call).
function register(ctx) {
  const { rootDir, entitlements, ipcMain, fromPage, log = () => {} } = ctx;
  const enforcer = createEnforcer({
    rootDir, entitlements, log,
    spend: () => (typeof ctx.spend === 'function' ? ctx.spend() : null),
    stoppers: () => (typeof ctx.runawayStoppers === 'function' ? ctx.runawayStoppers() : null),
    owned: ctx.ownedSessions || null,
  });
  let client;
  const burst = () => {
    if (process.platform !== 'darwin') return null;
    if (client === undefined) { try { client = require('./burst-client.js').createBurstClient(); } catch { client = null; } }
    return client;
  };
  const report = createReport({
    rootDir, entitlements, enforcer, burst,
    projectsDir: process.env.CLAUDE_TRAFFIC_LIGHT_PROJECTS || path.join(os.homedir(), '.claude', 'projects'),
    usageTurns: async () => (typeof ctx.usageTurns === 'function' ? await ctx.usageTurns() : []),
  });
  const timer = setInterval(() => enforcer.tick(), TICK_MS);
  timer.unref?.();
  ctx.onQuit?.(() => { clearInterval(timer); enforcer.close(); });
  const fromUsage = (e) => { try { return !!fromPage(e, 'usage'); } catch { return false; } };
  // The Usage optimiser's tool list reads the same report for the waste finder's totals.
  const fromOptimiser = (e) => { try { return !!fromPage(e, 'optimiser'); } catch { return false; } };
  ipcMain.handle('cost-guard:report', async (e) => {
    if (!fromUsage(e) && !fromOptimiser(e)) return null;
    try { return await report(); } catch (err) { log(`[cost-guard] report: ${err?.message ?? err}`); return null; }
  });
  ipcMain.handle('cost-guard:set', (e, v) => {
    if (!fromUsage(e)) return null;
    if (!entitlements.has('costguard.enforce')) return { error: 'Enforced caps come with Plexiform Plus.' };
    try { const settings = saveSettings(rootDir, v); enforcer.tick(); return { settings }; } catch (err) { return { error: err?.message ?? String(err) }; }
  });
  return { enforcer, report };
}

module.exports = { register, createEnforcer, createReport, gateFor, writeGate, syncOwnedStoppers, readSettings, saveSettings, readLog, appendLog, SETTINGS_FILE, LOG_FILE, GATE_TTL_MS };
