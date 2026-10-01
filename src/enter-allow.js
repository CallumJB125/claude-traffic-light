// May Enter allow this permission request? Only what the phone could approve:
// the same compiled verdict (src/deny: the deny-list first, then the
// allow-list of read-only commands, edits inside the project, no credentials),
// and nothing main flagged as dangerous. Everything else needs a deliberate
// click. src/deny ships with the app, so this works in a packaged build; if it
// can't load, Enter never allows (fail closed).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let verdict = null;
try {
  const { remoteVerdict } = require('./deny/allowlist.js');
  const { compileRules } = require('./deny/denylist.js');
  const compiled = compileRules();
  verdict = (args) => remoteVerdict(compiled, args, { home: os.homedir(), realpath: fs.realpathSync.native });
} catch { verdict = null; }

// → null when Enter may allow it, else why not.
function enterBlockedReason(req) {
  if (typeof verdict !== 'function') return 'the allow-list is not available here';
  // Relative paths in the request are resolved against the session folder,
  // so it must be a real, absolute folder (else a relative symlink escapes).
  const cwd = req && req.cwd;
  if (!(typeof cwd === 'string' && path.isAbsolute(cwd))) return 'no session folder';
  try { fs.realpathSync.native(cwd); } catch { return 'the session folder is not there'; }
  try {
    const v = verdict({ toolName: req && req.tool, toolInput: (req && req.toolInput) || {}, cwd: (req && req.cwd) || null, repoLabels: [] });
    return v && v.blocked === false ? null : (v && v.reason) || 'not on the allow-list';
  } catch {
    return 'it could not be checked';
  }
}

// A click-rule or gesture "allow" can't show what it approves, so it may
// answer only what Enter could: exactly one waiting request, a permission,
// with main's danger === null and enterAllow === true.
// → { req } to allow, or { why } (go and look instead).
const SETTLE_MS = 600;
function gestureAllowTarget(pending, inputs, now = Date.now()) {
  const reqs = Array.isArray(pending) ? pending : [];
  if (!reqs.length) return { req: null };
  if (reqs.length !== 1) return { why: `${reqs.length} waiting: answer from the bubble` };
  const req = reqs[0];
  if (req.kind && req.kind !== 'permission') return { why: 'open it to answer' };
  const input = (Array.isArray(inputs) ? inputs : []).find((i) => i && i.id === req.id);
  if (!input || input.danger !== null || input.enterAllow !== true) return { why: 'look at it first: answer from the bubble' };
  // Not one that appeared a moment ago, under the very click that answers it.
  const born = Date.parse(req.createdAt);
  if (!Number.isFinite(born) || now - born < SETTLE_MS) return { why: 'it just arrived: look at it first' };
  return { req };
}

module.exports = { enterBlockedReason, gestureAllowTarget, available: () => typeof verdict === 'function' };
