'use strict';
// Rule notifications (Wave 2 lane 3): a rule with then.notify raises a
// notification when it starts matching a session. Edge-triggered: once per
// session per activation (the rule must stop matching that session before it
// can fire for it again). At most one per rule every two minutes. Snooze,
// quiet hours, "Quiet for 30 minutes" and project mutes (src/quiet.js) hold
// it; a held one is dropped, not queued, so nothing stale pops up later.
//
// Desktop only. The hub's phone push (board/hub/push.js) carries content-free
// approval pings and nothing else, so `phone` stays in the rule schema but
// sends nothing until a paired-device path for other notifications exists;
// `both` sends the desktop half. The text never leaves this machine.

const Rules = require('../rules.js');
const Quiet = require('./quiet.js');

const RATE_MS = 2 * 60 * 1000;
const TICK_MS = 15 * 1000;

const sessionKey = (s) => s.sessionId || (s.virtual ? `${s.signal}|${s.cwd || ''}` : s.cwd || s.signal);

/**
 * deps: { config() → {rules, …quiet keys}, sessions() → raw session list, env?() → resolve env,
 *         desktop(title, body), phoneReady?() → bool, now?, quiet?, rules? }
 */
function createRuleNotify(deps) {
  const R = deps.rules || Rules;
  const Q = deps.quiet || Quiet;
  const now = deps.now || Date.now;
  const env = deps.env || (() => ({}));
  const phoneReady = deps.phoneReady || (() => false);
  let active = null; // Set of `${ruleId}\n${sessionKey}` live last tick; null until primed
  const lastFired = new Map();

  function label(signal) {
    const s = R.SIGNALS.find((x) => x.id === signal);
    return s ? s.label : signal;
  }

  function tick() {
    const c = deps.config() || {};
    const t = now();
    const rules = (Array.isArray(c.rules) ? c.rules : []).map(R.normalizeRule).filter((r) => r.enabled && r.then.notify);
    const live = rules.length ? R.liveSessions(deps.sessions() || [], t, env() || {}) : [];
    const next = new Set();
    const sent = [];
    for (const rule of rules) {
      for (const s of live) {
        if (!R.ruleMatches(rule, s, t)) continue;
        const key = `${rule.id}\n${sessionKey(s)}`;
        next.add(key);
        if (!active || active.has(key)) continue; // first tick primes; still active is not an edge
        if (Q.reason(c, { now: t, cwd: s.cwd || null })) continue;
        if (t - (lastFired.get(rule.id) ?? -Infinity) < RATE_MS) continue;
        lastFired.set(rule.id, t);
        const body = `${label(R.sessionSignal(s) || s.signal)}${s.cwd ? ` in ${R.folderOf(s.cwd)}` : ''}`;
        const target = rule.then.notify;
        if (target === 'desktop' || target === 'both') deps.desktop(rule.name, body);
        sent.push({ ruleId: rule.id, title: rule.name, body, target });
      }
    }
    active = next;
    return sent;
  }

  function status() {
    const ready = !!phoneReady();
    return { desktop: true, phone: ready, phoneNote: ready ? null : 'Pair a phone first' };
  }

  return { tick, status, RATE_MS };
}

// main.js: one line. Polls every 15 s and answers the Lights page's
// `rule-notify:status` so it can grey out the phone choices.
function install({ Notification, handle, allowed, config, sessions, env, log }) {
  const notifier = createRuleNotify({
    config, sessions, env,
    desktop: (title, body) => {
      try { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show(); } catch (err) { if (log) log('[rule-notify]', err.message); }
    },
  });
  handle('rule-notify:status', allowed, () => notifier.status());
  const timer = setInterval(() => { try { notifier.tick(); } catch (err) { if (log) log('[rule-notify]', err.message); } }, TICK_MS);
  if (timer.unref) timer.unref();
  return notifier;
}

module.exports = { createRuleNotify, install, RATE_MS, TICK_MS };
