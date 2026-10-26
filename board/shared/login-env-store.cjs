'use strict';

// The receiving end of the login-shell values (PR 2b). Main reads a few allowlisted variables from the user's login
// shell (src/login-shell-env.js) and sends them to the two helper processes over their parentPort as
// {type:'login.env', values}. The helper keeps them in memory only, hands them to createClaudeCarry({loginShellEnv}),
// and never puts them in argv, env or a log line. Nothing here logs.
const LOGIN_ENV_MESSAGE = 'login.env';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENTRIES = 64;
const MAX_VALUE = 8192;

// Exact names, or a prefix ending in `*`, the same as src/login-shell-env.js filter().
function matches(name, names) {
  for (const n of Array.isArray(names) ? names : []) {
    if (typeof n !== 'string' || n === '') continue;
    if (n.endsWith('*') ? n.length > 1 && name.startsWith(n.slice(0, -1)) : n === name) return true;
  }
  return false;
}

function createLoginEnvStore() {
  let values = Object.freeze({});
  return {
    /** true when `msg` was a login.env message (accepted or refused), so the caller stops handling it. */
    accept(msg) {
      if (!msg || msg.type !== LOGIN_ENV_MESSAGE) return false;
      const next = {};
      const raw = msg.values;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw).slice(0, MAX_ENTRIES)) {
          if (NAME.test(k) && typeof v === 'string' && v.length <= MAX_VALUE) next[k] = v;
        }
      }
      values = Object.freeze(next);
      return true;
    },
    /** The createClaudeCarry({loginShellEnv}) seam: only the names the carry asks for. */
    async loginShellEnv({ names } = {}) {
      const out = {};
      for (const [k, v] of Object.entries(values)) if (matches(k, names)) out[k] = v;
      return out;
    },
  };
}

module.exports = { createLoginEnvStore, LOGIN_ENV_MESSAGE };
