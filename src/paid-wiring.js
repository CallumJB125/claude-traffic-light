// The one place main.js hands the paid-tier packages their hooks. Each package
// lands on its own, in any order: a module that is not there yet is skipped,
// and one that throws is logged and skipped, so no package can stop startup.
//
// Contract for a package: its module exports register(ctx), where ctx is
//   {app, ipcMain, rootDir, entitlements, buddy: () => buddyWin|null,
//    fromPage: (e, pageId) => bool, onQuit: (fn) => void, log: (msg) => void,
//    setups: the team Setups service (main-only readForPlan)}
// register gates its own work with ctx.entitlements.has(feature).
'use strict';

const Entitlements = require('./entitlements');

// Literal requires only: the privacy tripwire treats a computed require as a channel.
const PACKAGES = [
  ['cost-guard', () => require.resolve('./spend-enforce'), () => require('./spend-enforce')],
  ['checkpoints', () => require.resolve('./checkpoints'), () => require('./checkpoints')],
  ['memory', () => require.resolve('./memory/search'), () => require('./memory/search')],
  ['morning-report', () => require.resolve('./morning-report'), () => require('./morning-report')],
  ['client-billing', () => require.resolve('./clients'), () => require('./clients')],
  ['setups-personal', () => require.resolve('./setups-personal'), () => require('./setups-personal')],
  ['entitlement-refresh', () => require.resolve('./entitlement-refresh'), () => require('./entitlement-refresh')],
  ['sync', () => require.resolve('./sync'), () => require('./sync')],
];

/** Calls every present package's register(ctx). → [{name, status:'absent'|'ok'|'skipped'|'failed'}]. Never throws. */
function registerAll(ctx = {}, packages = PACKAGES) {
  const log = typeof ctx.log === 'function' ? ctx.log : (m) => console.warn(m);
  const full = { ...ctx, entitlements: ctx.entitlements ?? Entitlements, log };
  const out = [];
  for (const [name, resolve, load] of packages) {
    try { resolve(); } catch { out.push({ name, status: 'absent' }); continue; }
    try {
      const mod = load();
      if (typeof mod?.register !== 'function') { out.push({ name, status: 'skipped' }); continue; }
      mod.register(full);
      out.push({ name, status: 'ok' });
    } catch (e) {
      log(`[paid] ${name} failed to register: ${e?.message ?? e}`);
      out.push({ name, status: 'failed' });
    }
  }
  return out;
}

module.exports = { registerAll, PACKAGES };
