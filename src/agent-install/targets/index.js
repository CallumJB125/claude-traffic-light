'use strict';
// The user-scope install targets for Find agents, one renderer per platform.
// A target whose format can't be confirmed in the platform's official docs
// ships with verified: false and a reason, and is offered greyed out.
const TARGETS = Object.freeze([require('./claude.js'), require('./codex.js'), require('./gemini.js'), require('./copilot.js'), require('./opencode.js'), require('./cursor-project.js')]);
const USER_TARGETS = Object.freeze(TARGETS.filter((t) => t.id !== 'cursor-project'));
const UNSUPPORTED = Object.freeze({
  goose: 'Goose doesn\'t support add-on agents yet.',
  cline: 'Cline only has always-on rules, which would apply to every task.',
  hermes: 'Hermes doesn\'t load agent files.',
  aider: 'Aider has one conventions file, not separate agents.',
});
module.exports = { TARGETS, USER_TARGETS, UNSUPPORTED };
