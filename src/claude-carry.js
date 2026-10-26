'use strict';
// Main-process wiring of board/shared/claude-carry.cjs for the no-tool Claude
// children (owned chat, one-shot helpers, voice): the user's own provider and
// auth, carried by allowlist. These children have no Bash tool, so a key may sit
// in their env (plan C14); a run that has a shell never gets one that way.
const { createClaudeCarry, burstOwnsPort, BURST_GATEWAY_PORT } = require('../board/shared/claude-carry.cjs');

// Seam for PR 1b (src/login-shell-env.js): main calls setLoginShellEnv(readFilteredLoginShellEnv) once it exists.
// Until then a Dock-launched app only sees its own env and the user's settings files.
let loginShellEnv = null;
function setLoginShellEnv(fn) { loginShellEnv = typeof fn === 'function' ? fn : null; shared = null; }

let shared = null;
function defaultCarry() {
  if (!shared) shared = createClaudeCarry({ env: process.env, loginShellEnv: (a) => (loginShellEnv ? loginShellEnv(a) : {}), burstOwnsPort });
  return shared;
}

// The carry for a given env: the app's own env gets the shared one. Any other env (a test's fixture) carries
// nothing unless the caller injects a carry, and tests run under the no-real-cli guard never read the
// developer's real Claude files.
function carryFor(env) {
  if (env && env !== process.env) return null;
  return globalThis.__plexiformNoRealCli ? null : defaultCarry();
}

const NONE = Object.freeze({ failure: null, env: {}, model: 'haiku', userModel: null });

/**
 * Prepares one no-tool child. → { failure: {kind, reason}|null, env (merge into the child env),
 * model (what a `haiku` default becomes on this provider), userModel }.
 * `carry` is injectable; null means carry nothing.
 */
async function prepareNoTool(carry) {
  if (!carry) return NONE;
  let c;
  try { c = await carry.prepare({ mode: 'notool' }); } catch { return NONE; }
  if (c.failure) return { failure: c.failure, env: {}, model: 'haiku', userModel: null, release: c.release };
  if (!c.carry) return NONE;
  return { failure: null, env: c.childEnv, model: c.oneShotModel, userModel: c.model, release: c.release };
}

/**
 * Prepares a writable owned chat: no shell, but file tools, so the key goes to a 0600 file in `keyDir` (a private dir
 * outside the project) behind apiKeyHelper, never into the child's env. → { failure, env, model, settings, disallowed, release }.
 * `settings` is the one --settings file's content ({apiKeyHelper?, env?}); null when nothing is carried.
 */
async function prepareChat(carry, keyDir, keyFile) {
  if (!carry) return { ...NONE, settings: null, disallowed: [], release() {} };
  let c;
  try { c = await carry.prepare({ mode: 'chat', keyFile }); } catch { return { ...NONE, settings: null, disallowed: [], release() {} }; }
  if (c.failure) return { failure: c.failure, env: {}, model: 'haiku', userModel: null, settings: null, disallowed: [], release: c.release };
  if (!c.carry) return { ...NONE, settings: null, disallowed: [], release: c.release };
  const settings = {
    ...(c.apiKeyFile ? { apiKeyHelper: `/bin/cat '${String(c.apiKeyFile).replace(/'/g, `'\\''`)}'` } : {}),
    ...(Object.keys(c.settingsEnv).length ? { env: c.settingsEnv } : {}),
  };
  return { failure: null, env: c.cliEnv, model: c.oneShotModel, userModel: c.model, settings, disallowed: c.disallowed, release: c.release };
}

module.exports = { prepareChat, NONE, prepareNoTool, defaultCarry, carryFor, setLoginShellEnv, burstOwnsPort, BURST_GATEWAY_PORT };
