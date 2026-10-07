'use strict';

// "2 sessions share this working tree": live sessions (any tool) whose cwd is
// in the same git toplevel while it has uncommitted work. Uses local
// `git rev-parse --show-toplevel` / `git status --porcelain` only.
// WP0 stub: WP3 fills it in.

// sessions: Sessions rows ({ sessionId, cwd, ... }) -> [{ toplevel, sessions: [sessionId], dirty: n }]
// shared() answers synchronously from a cache and refreshes it in the background.
// Options: { ttlMs = 30000, now = Date.now, log }.
function createWorktreeShare(_opts = {}) {
  return { shared: (_sessions) => [] };
}

module.exports = { createWorktreeShare };
