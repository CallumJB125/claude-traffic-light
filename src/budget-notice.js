// "Your run reached its budget": a Give-to-Claude run stopped at its spend cap
// and needs the person. Pure: validates the runner's event, keeps the active
// notices, and builds the text and the board fragment. Main wires it to the
// widget, the tray and a notification; the desktop never calls the hub, it
// only opens the signed-in board page with the fragment below.
'use strict';

// Provisional names (buddy-window's runner events, the board's fragment
// handler): everything that has to match the other side lives in this block.
const CONTRACT = Object.freeze({
  eventReached: 'run.budget_reached',
  eventsCleared: Object.freeze(['run.resumed', 'run.ended']),
  fragmentKey: 'plexiform-budget',
  fragmentVersion: 1,
  boardPage: 'board',
  subscribeMethod: 'onRunnerEvent',
  openMethod: 'openWithFragment',
});

const MAX_NOTICES = 10;
const MAX_REMEMBERED = 100;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,15}-[0-9]{1,9}$/;
const MAX_USD = 1000000;
const money = (n) => `$${n.toFixed(2)}`;
const amount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_USD;

// → { notice } for a budget stop, { clear: runId } for a resume/end, else null.
function classify(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null;
  if (CONTRACT.eventsCleared.includes(ev.type)) return typeof ev.run_id === 'string' && ID_RE.test(ev.run_id) ? { clear: ev.run_id } : null;
  if (ev.type !== CONTRACT.eventReached) return null;
  if (typeof ev.run_id !== 'string' || !ID_RE.test(ev.run_id) || typeof ev.card_id !== 'string' || !ID_RE.test(ev.card_id)) return null;
  if (!amount(ev.spent_usd) || !amount(ev.budget_usd)) return null;
  if (ev.card_key !== undefined && ev.card_key !== null && (typeof ev.card_key !== 'string' || !KEY_RE.test(ev.card_key))) return null;
  return { notice: { runId: ev.run_id, cardId: ev.card_id, spent: ev.spent_usd, budget: ev.budget_usd, cardKey: ev.card_key || null } };
}

function text(n) {
  const sums = `(${money(n.spent)} of ${money(n.budget)})`;
  return n.cardKey ? `Your run on ${n.cardKey} reached its budget ${sums}` : `Your Give to Claude run reached its budget ${sums}`;
}

function fragment(n) {
  return `${CONTRACT.fragmentKey}=${Buffer.from(JSON.stringify({ v: CONTRACT.fragmentVersion, card_id: n.cardId })).toString('base64url')}`;
}

// → { handle(ev), dismiss(runId), get(runId), list(), notifiedSize() }; list() is newest first.
// `notified` (one notification per stop) and `dismissed` (a re-emitted stop
// must not bring a dismissed row back) both end on run.resumed/run.ended.
function createNotices() {
  const byRun = new Map();
  const notified = new Set();
  const dismissed = new Set();
  const remember = (set, id) => { set.add(id); if (set.size > MAX_REMEMBERED) set.delete(set.values().next().value); };
  return {
    // → { changed, added, notify, notice } (notice only when added)
    handle(ev) {
      const c = classify(ev);
      if (!c) return { changed: false, added: false, notify: false };
      if (c.clear) {
        notified.delete(c.clear);
        dismissed.delete(c.clear);
        return { changed: byRun.delete(c.clear), added: false, notify: false };
      }
      if (dismissed.has(c.notice.runId)) return { changed: false, added: false, notify: false };
      const prev = byRun.get(c.notice.runId);
      if (prev) {
        const changed = prev.spent !== c.notice.spent || prev.budget !== c.notice.budget || prev.cardKey !== c.notice.cardKey;
        byRun.set(c.notice.runId, c.notice);
        return { changed, added: false, notify: false };
      }
      byRun.set(c.notice.runId, c.notice);
      if (byRun.size > MAX_NOTICES) byRun.delete(byRun.keys().next().value);
      const notify = !notified.has(c.notice.runId);
      if (notify) remember(notified, c.notice.runId);
      return { changed: true, added: true, notify, notice: c.notice };
    },
    dismiss(runId) { remember(dismissed, runId); return byRun.delete(runId); },
    get: (runId) => byRun.get(runId) || null,
    list: () => [...byRun.values()].reverse(),
    notifiedSize: () => notified.size,
  };
}

module.exports = { CONTRACT, MAX_NOTICES, classify, text, fragment, createNotices };
