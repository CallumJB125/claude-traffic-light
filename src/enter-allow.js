// May Enter allow this permission request? Only what the phone could approve:
// the same compiled verdict (src/deny: the deny-list first, then the
// allow-list of read-only commands, edits inside the project, no credentials),
// and nothing main flagged as dangerous. Everything else needs a deliberate
// click. src/deny ships with the app, so this works in a packaged build; if it
// can't load, Enter never allows (fail closed).
'use strict';

const fs = require('fs');
const os = require('os');

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

module.exports = { enterBlockedReason, gestureAllowTarget, available: () => typeof verdict === 'function' };
