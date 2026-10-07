'use strict';
// Burst has no event stream yet, so alerts are derived by diffing successive
// polled status view models (src/burst-view.js statusView). Pure: the clock
// and the quiet config are passed in. Quiet hours, snooze and project mutes
// (src/quiet.js) decide whether an event may notify; they never change the view.
const Quiet = require('./quiet.js');

const COOLDOWN_MS = 15 * 60000;

const EVENTS = {
  failover: { title: 'Claude Burst switched to your secondary provider', body: 'Your Claude limit was reached, so requests now go through the provider you set up. That is billed by that provider.' },
  'limit-near': { title: 'Claude limit is getting close', body: 'Claude Burst has seen your Claude plan push back. It will switch to your secondary provider if the limit is reached.' },
  bypass: { title: 'Claude Burst is out of Claude Code\'s path', body: 'Claude Code is talking to Anthropic directly again, so Burst is not protecting you from limits.' },
};

// 'secondary' (failed over) outranks 'near' (a refused window or failures).
function levelOf(view) {
  if (!view || view.kind !== 'on') return null;
  if (view.route === 'SECONDARY') return 'secondary';
  return view.chip && view.chip.label === 'Limit near' ? 'near' : null;
}

function createBurstEvents() {
  let prev = null;
  const lastAt = new Map();

  // Returns the events this poll adds, at most one per transition and never
  // the same kind twice within COOLDOWN_MS. The first view is only a baseline.
  function observe(view, now) {
    if (!view || view.kind === 'unsupported') return [];
    const cur = { kind: view.kind, level: levelOf(view) };
    const before = prev;
    prev = cur;
    if (!before) return [];
    const out = [];
    if (cur.level === 'secondary' && before.level !== 'secondary') out.push('failover');
    else if (cur.level === 'near' && before.level === null) out.push('limit-near');
    if (before.kind === 'on' && cur.kind === 'off') out.push('bypass');
    return out.filter((kind) => {
      if (now - (lastAt.get(kind) ?? -Infinity) < COOLDOWN_MS) return false;
      lastAt.set(kind, now);
      return true;
    }).map((kind) => ({ kind, key: `burst:${kind}`, ...EVENTS[kind] }));
  }

  return { observe };
}

// Splits events into those that may notify now and those quiet holds back.
function gate(events, config, now) {
  const why = Quiet.reason(config, { now });
  return why ? { send: [], held: events, why } : { send: events, held: [], why: null };
}

module.exports = { createBurstEvents, gate, levelOf, COOLDOWN_MS, EVENTS };
