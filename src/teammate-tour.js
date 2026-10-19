'use strict';
// A four-step first-run tour for a new teammate, shown once per signed-in
// account. Pure state; the page renders a labelled, focus-trapped dialog and
// skips motion under prefers-reduced-motion.
(function (root) {
  const STEPS = Object.freeze([
    { id: 'home', title: 'Home', text: 'Your Inbox shows what needs a person: approvals, questions, blockers and teammates’ handoffs, each with one action.' },
    { id: 'projects', title: 'Projects', text: 'Boards, cards and durable results live with their project. Open a card to see the task, its agents and saved outputs.' },
    { id: 'team', title: 'Team', text: 'Teammates and the sessions they explicitly share. Private sessions stay private; you only see what someone chose to share.' },
    { id: 'inbox', title: 'Find a shared session and ask', text: 'Press ⌘K, type a teammate or task, open the exact session and use Ask for a status update or review. Receipts show when the agent acknowledges and answers.' },
  ]);
  const str = (v, max) => typeof v === 'string' && v.length <= max ? v : '';
  const parse = raw => { try { const v = JSON.parse(raw); return v && typeof v === 'object' && v.done && typeof v.done === 'object' ? { done: Object.fromEntries(Object.entries(v.done).filter(([k, t]) => str(k, 200) && Number.isSafeInteger(t))) } : { done: {} }; } catch { return { done: {} }; } };
  const serialize = s => JSON.stringify({ done: s.done });
  const accountKey = account => str(account, 200) || 'local';
  const shouldShow = (s, account) => !Object.hasOwn(s.done, accountKey(account));
  const dismiss = (s, account, now = Date.now()) => ({ done: { ...s.done, [accountKey(account)]: now } });
  const next = i => Math.min(STEPS.length - 1, i + 1);
  const api = { STEPS, parse, serialize, shouldShow, dismiss, next, accountKey };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformTour = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
