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

module.exports = { enterBlockedReason, available: () => typeof allowListReason === 'function' };
