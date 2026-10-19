'use strict';

// Slack presence sync (Wave 2 lane 6), optional and off by default: sets your
// Slack status to Working / Waiting on you / Away from Plexiform's aggregate
// state, at most once every 2 minutes, and puts back the status you had when
// you turn it off.
//
// Setting a person's Slack status needs a USER token with the
// users.profile:write scope. The team hub's Slack connector is bot-only (it
// refuses user scopes at install, board/hub/integrations/slack/spec.js), so
// there is no client today: `client` is null and the state is
// 'needs_user_scope' (docs/SLACK-RUNBOOK.md, "Presence sync"). Nothing is
// faked: with no client nothing is sent and nothing pretends it was.
//
// client: { getStatus() → {text, emoji}, setStatus({text, emoji}) } | null.

const MIN_GAP_MS = 2 * 60_000;
const STATUSES = Object.freeze({
  working: { text: 'Working with AI', emoji: ':large_green_circle:' },
  waiting: { text: 'AI waiting on me', emoji: ':hourglass_flowing_sand:' },
  away: { text: 'Away', emoji: ':zzz:' },
});
const WAITING = new Set(['permission-ask', 'user-question', 'question-ask']);

// The aggregate → 'working' | 'waiting' | 'away'. Pure.
function presenceOf({ sessions = [], pending = [], busy = false } = {}) {
  if (busy) return 'away';
  const list = Array.isArray(sessions) ? sessions : [];
  if ((Array.isArray(pending) && pending.length) || list.some((s) => WAITING.has(s?.signal))) return 'waiting';
  if (list.some((s) => s && s.signal && !['session-end', 'idle', 'idle-nudge'].includes(s.signal))) return 'working';
  return 'away';
}

function create({ client = null, now = () => Date.now(), minGapMs = MIN_GAP_MS, store = { get: () => null, set: () => {} }, log = () => {} } = {}) {
  let enabled = false;
  let applied = null; // the presence last sent
  let lastAt = -Infinity;
  let wanted = null;
  let busy = false;

  const state = () => ({ enabled, status: !enabled ? 'off' : client ? 'on' : 'needs_user_scope', current: client ? applied : null });

  async function push() {
    if (!enabled || !client || busy || !wanted || wanted === applied || now() - lastAt < minGapMs) return false;
    busy = true;
    try {
      await client.setStatus(STATUSES[wanted]); // privacy-flow: slack-presence
      applied = wanted; lastAt = now();
      return true;
    } catch (e) { log('[slack-presence] set failed', e?.code); return false; } finally { busy = false; }
  }

  async function setEnabled(on) {
    if (on === enabled) return state();
    enabled = on === true;
    if (!client) return state();
    if (enabled) {
      try { if (!store.get()) store.set(await client.getStatus()); } catch (e) { log('[slack-presence] read failed', e?.code); }
      await push();
    } else {
      const prev = store.get();
      try { await client.setStatus(prev && typeof prev === 'object' ? { text: String(prev.text ?? ''), emoji: String(prev.emoji ?? '') } : { text: '', emoji: '' }); store.set(null); } catch (e) { log('[slack-presence] restore failed', e?.code); }
      applied = null; lastAt = -Infinity;
    }
    return state();
  }

  // Called on every status broadcast; debounced by minGapMs between changes.
  function update(aggregate) {
    wanted = presenceOf(aggregate);
    return push();
  }

  return { setEnabled, update, state, flush: push };
}

module.exports = { create, presenceOf, STATUSES, MIN_GAP_MS };
