'use strict';
// Usage › Today (redesign R7-2, chat-first preview only): what Home's Today, Savings and My day cards showed, as one
// read for the Today document (usage:today), with its own guard. It reads through Home's own gatherer (src/home-main.js
// register → snapshot), so My day and the cost guard are asked once per their TTL however many pages show them
// (review S2). The digest's channels for this page are digest-main's own bindings (usage-today:digest-*).
//   usage-today:state   read → { today, costs, myDay, empty }: numbers and the cost card's short texts; no card or
//                       decision titles, no paths
//   usage-today:open    effect → open Team or Board (a closed table), from this document only

const CHANNELS = Object.freeze({ state: 'usage-today:state', open: 'usage-today:open' });
const KEYS = Object.freeze(['today', 'costs', 'myDay', 'empty']);
const OPEN = Object.freeze(['team', 'board']);

const num = (v) => (Number.isFinite(v) ? v : null);

/** Home's snapshot → Today's reply. Pure. */
function todayOf(s) {
  const spend = s?.today?.spend;
  const today = {
    spend: spend ? { spent: num(spend.spent), budget: num(spend.budget), level: typeof spend.level === 'string' ? spend.level.slice(0, 20) : null, unpriced: num(spend.unpriced) ?? 0, equivalent: spend.equivalent === true } : null,
    longestWaitMs: num(s?.today?.longestWaitMs),
    running: Array.isArray(s?.running?.items) ? s.running.items.length : 0,
  };
  const c = s?.costs;
  const costs = c ? {
    receipt: c.receipt ? { month: String(c.receipt.month ?? ''), headline: String(c.receipt.headline ?? '') } : null,
    enforce: c.enforce ? { on: c.enforce.on === true, status: String(c.enforce.status ?? '') } : null,
    waste: c.waste ? { count: num(c.waste.count) ?? 0, top: c.waste.top == null ? null : String(c.waste.top) } : null,
  } : null;
  const t = s?.team;
  const myDay = t ? { decisions: Array.isArray(t.decisions) ? t.decisions.length : 0, cards: Array.isArray(t.cards) ? t.cards.length : 0, unavailable: t.unavailable === true } : null;
  const empty = !today.spend && today.running === 0 && today.longestWaitMs === null && !costs;
  return { today, costs, myDay, empty };
}

/** deps: { ipcMain, allowed(e), snapshot() → Promise<Home's snapshot> (shared), openPage(id) } */
function register({ ipcMain, allowed, snapshot, openPage }) {
  ipcMain.handle(CHANNELS.state, async (e, ...args) => {
    if (!allowed(e) || args.length !== 0) return null;
    let s = null;
    try { s = await snapshot(); } catch { s = null; }
    if (!allowed(e)) return null;
    return todayOf(s);
  });
  ipcMain.handle(CHANNELS.open, (e, ...args) => {
    if (!allowed(e) || args.length !== 1 || !OPEN.includes(args[0])) return false;
    openPage(args[0]);
    return true;
  });
}

module.exports = { register, todayOf, CHANNELS, KEYS, OPEN };
