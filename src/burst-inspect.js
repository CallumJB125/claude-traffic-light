'use strict';

// Sessions "What's in context" from Burst's context inspector (/api/inspect).
// Group, name, tokens and flags only: previews (conversation text) never pass.
// WP0 stub: WP3 fills it in.

// scrubbed GET /api/inspect?session= -> { session, engine, totalTokens,
//   groups: [{ group, tokens, items: [{ id, name, turn, tokens, flags, removable, removed }] }] } | null
// opts: { engine: 'claude' | 'codex' }
function inspectView(_raw, _opts = {}) { return null; }

module.exports = { inspectView };
