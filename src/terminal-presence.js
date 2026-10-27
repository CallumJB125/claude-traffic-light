'use strict';
// Plexiform Terminal detection: the interface, its enums and a stub
// (plan-agent-terminal §R2.5, with §R3.11's states, reasons and codes).
// detect() always says 'not-installed' until T3 implements it, so nothing
// routes anywhere new. resolveOpenIn is the whole §R2.4 decision table with
// Revision 3's changes; nothing calls it before T3/R11.

const STATES = Object.freeze(['ready', 'not-installed', 'unverified', 'keeper-down', 'keeper-outdated', 'incompatible', 'unsupported-platform']);
const REASONS = Object.freeze({
  'not-installed': Object.freeze(['search-failed']),
  unverified: Object.freeze(['unsigned-release', 'signature', 'keeper-signature', 'socket-mode', 'socket-owner', 'keeper-build', 'peer-count']),
  'keeper-down': Object.freeze(['restart-cap']),
  incompatible: Object.freeze(['keeper-major', 'terminal-protocols', 'client-outdated']),
});
// The handoff result codes, 13 (§R3.11 replaces LAUNCH_UNCONFIRMED with TERMINAL_DIDNT_START).
const RESULT_CODES = Object.freeze(['OK', 'NOT_INSTALLED', 'UNVERIFIED', 'KEEPER_DOWN', 'INCOMPATIBLE', 'SPAWN_REFUSED', 'TERMINAL_DIDNT_START',
  'CANT_OPEN', 'HANDBACK_WHILE_RUNNING', 'SESSION_BUSY', 'CONFLICT', 'DECLINED', 'UNSUPPORTED_PLATFORM']);
const SPAWN_REFUSED_REASONS = Object.freeze(['unsigned-cli', 'shape', 'cwd-gone', 'not-found', 'session-locked']);
const PLEXIFORM = 'Plexiform Terminal';
const OPEN_IN = Object.freeze(['auto', 'plexiform', 'Terminal', 'iTerm', 'Ghostty', 'Ghostty Dock']);
const USUAL = Object.freeze(['Terminal', 'iTerm', 'Ghostty', 'Ghostty Dock']);
const DEFAULTS = Object.freeze({ openIn: 'auto', openInChosen: false, usual: 'Terminal' });

// config.terminal as saved (or absent) → the §R2.4 keys with their defaults.
// PR 0s writes none of them; T5 adds the setting and saves them.
function normalizeTerminalConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    openIn: OPEN_IN.includes(c.openIn) ? c.openIn : DEFAULTS.openIn,
    openInChosen: c.openInChosen === true,
    usual: USUAL.includes(c.usual) ? c.usual : DEFAULTS.usual,
  };
}

const CODE_OF = Object.freeze({ unverified: 'UNVERIFIED', 'keeper-down': 'KEEPER_DOWN', incompatible: 'INCOMPATIBLE', 'not-installed': 'NOT_INSTALLED' });

// → { app, quiet, code, offerGet }. app is where the chat opens, or null when
// nothing opens until the person picks (code says why, in R11's words).
function resolveOpenIn(config, presence, { platform = process.platform } = {}) {
  const c = normalizeTerminalConfig(config);
  if (platform !== 'darwin') return { app: null, quiet: false, code: 'UNSUPPORTED_PLATFORM', offerGet: false };
  if (c.openIn !== 'auto' && c.openIn !== 'plexiform') return { app: c.openIn, quiet: false, code: null, offerGet: false };
  const state = STATES.includes(presence?.state) ? presence.state : 'not-installed';
  const auto = c.openIn === 'auto';
  if (state === 'ready' || state === 'keeper-outdated') return { app: PLEXIFORM, quiet: false, code: null, offerGet: false };
  if (state === 'unsupported-platform') return { app: null, quiet: false, code: 'UNSUPPORTED_PLATFORM', offerGet: false };
  // Under auto, a Terminal that isn't there (or a build without the feature) falls back quietly.
  if (auto && state === 'not-installed') return { app: c.usual, quiet: true, code: null, offerGet: true };
  if (auto && state === 'unverified' && presence?.reason === 'unsigned-release') return { app: c.usual, quiet: true, code: null, offerGet: false };
  // An explicit choice is never dropped quietly, and a failed check never falls back quietly.
  return { app: null, quiet: false, code: CODE_OF[state], offerGet: false };
}

// The stub (T3 implements both).
async function detect({ fresh = false, now = Date.now } = {}) {
  void fresh;
  return { state: 'not-installed', reason: null, app: null, keeper: null, checkedAt: now() };
}
async function reveal(sessionId) {
  void sessionId;
  return { ok: false, code: 'NOT_INSTALLED' };
}

module.exports = { STATES, REASONS, RESULT_CODES, SPAWN_REFUSED_REASONS, OPEN_IN, USUAL, DEFAULTS, PLEXIFORM, normalizeTerminalConfig, resolveOpenIn, detect, reveal };
