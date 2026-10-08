'use strict';

// Sessions "What's in context" from Burst's context inspector (/api/inspect).
// Group, name, tokens and flags only: previews (conversation text) never pass,
// whatever the client's scrub let through. Pure; no I/O.

// Burst's dashboard order (internal/router/inspect.go); unknown groups follow.
const ORDER = ['Instruction files', 'Skills', 'Other reminders', 'System prompt', 'Built-in tools', 'MCP tools', 'Your prompts', "Claude's replies", 'Tool results'];
const MAX_ITEMS = 1000;
const GROUP_ITEMS = 40;
const ITEM_ID = /^[0-9a-f]{16}$/;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');
const count = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

function item(raw) {
  const removable = raw.removable === true && typeof raw.id === 'string' && ITEM_ID.test(raw.id);
  return {
    id: removable ? raw.id : null,
    name: str(raw.name, 200) || 'Unnamed item',
    turn: count(raw.turn),
    tokens: count(raw.tokens),
    flags: (Array.isArray(raw.flags) ? raw.flags : []).filter((f) => typeof f === 'string').slice(0, 5).map((f) => str(f, 120)),
    removable,
    removed: removable && raw.removed === true,
  };
}

// scrubbed GET /api/inspect?session= -> { session, engine, totalTokens, reportedTokens, estimate,
//   groups: [{ group, tokens, more, items: [{ id, name, turn, tokens, flags, removable, removed }] }] } | null
// opts: { engine: 'claude' | 'codex' }
function inspectView(raw, opts = {}) {
  const r = obj(raw);
  if (!r || !Array.isArray(r.items) || typeof r.session !== 'string' || !r.session) return null;
  const byGroup = new Map();
  for (const x of r.items.slice(0, MAX_ITEMS)) {
    if (!obj(x)) continue;
    const group = str(x.group, 60) || 'Other';
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(item(x));
  }
  const rank = (g) => { const i = ORDER.indexOf(g); return i === -1 ? ORDER.length : i; };
  const groups = [...byGroup.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([group, items]) => {
    const sorted = items.slice().sort((a, b) => b.tokens - a.tokens);
    return { group, tokens: items.reduce((s, i) => s + i.tokens, 0), more: Math.max(0, sorted.length - GROUP_ITEMS), items: sorted.slice(0, GROUP_ITEMS) };
  });
  return {
    session: str(r.session, 200),
    engine: opts.engine === 'codex' ? 'codex' : 'claude',
    totalTokens: groups.reduce((s, g) => s + g.tokens, 0),
    reportedTokens: count(r.context),
    estimate: r.estimate === true,
    groups,
  };
}

module.exports = { inspectView };
