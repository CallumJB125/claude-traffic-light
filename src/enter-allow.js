// May Enter allow this permission request? Only what the phone could approve
// (the remote allow-list: read-only commands, edits inside the project, no
// credentials) and nothing main flagged as dangerous. Everything else needs
// a deliberate click.
//
// allowListReason lives in remote/src/allowlist.js on this branch; after
// fix/deny-list-bypasses it is src/deny/allowlist.js. Repoint this one line.
// remote/ isn't packaged: if it can't load, Enter never allows (fail closed).
'use strict';

let allowListReason = null;
try { ({ allowListReason } = require('../remote/src/allowlist.js')); } catch { allowListReason = null; }

// → null when Enter may allow it, else why not.
function enterBlockedReason(req) {
  if (typeof allowListReason !== 'function') return 'the allow-list is not available here';
  try {
    return allowListReason({ toolName: req && req.tool, toolInput: (req && req.toolInput) || {}, cwd: req && req.cwd });
  } catch {
    return 'it could not be checked';
  }
}

// A click-rule or gesture "allow" can't show what it approves, so it may
// answer only what Enter could: exactly one waiting request, a permission,
// with main's danger === null and enterAllow === true.
// → { req } to allow, or { why } (go and look instead).
function gestureAllowTarget(pending, inputs) {
  const reqs = Array.isArray(pending) ? pending : [];
  if (!reqs.length) return { req: null };
  if (reqs.length !== 1) return { why: `${reqs.length} waiting: answer from the bubble` };
  const req = reqs[0];
  if (req.kind && req.kind !== 'permission') return { why: 'open it to answer' };
  const input = (Array.isArray(inputs) ? inputs : []).find((i) => i && i.id === req.id);
  if (!input || input.danger !== null || input.enterAllow !== true) return { why: 'look at it first: answer from the bubble' };
  return { req };
}

module.exports = { enterBlockedReason, gestureAllowTarget, available: () => typeof allowListReason === 'function' };
