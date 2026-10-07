'use strict';

// Standalone "What's in context" for any Claude Code session, without Burst:
// a breakdown of the session transcript JSONL by kind, with a token estimate.
// WP0 stub: WP3 fills it in.

// JSONL text -> { total: { bytes, tokens }, groups: [{ group, bytes, tokens }], reportedInputTokens }
function breakdownText(_text) { return { total: { bytes: 0, tokens: 0 }, groups: [], reportedInputTokens: 0 }; }

// transcript path -> Promise<breakdownText(...) | null>; reads at most maxBytes from the end.
async function breakdownFile(_file, _opts = { maxBytes: 8 * 1024 * 1024 }) { return null; }

module.exports = { breakdownText, breakdownFile };
