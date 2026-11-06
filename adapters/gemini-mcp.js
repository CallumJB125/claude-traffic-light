'use strict';
// Gemini CLI's MCP registration: mcpServers.plexiform-bus in ~/.gemini/settings.json (JSON, edited as text so the
// rest of the file keeps its bytes), and Plexiform's instruction block in ~/.gemini/GEMINI.md, the global context file
// Gemini CLI loads into every session (BACKBONE-AUDIT-AND-PLAN §3.2, D1). Hooks stay with adapters/gemini.js.
const path = require('path');
const { TIERS } = require('../src/bus-contract.js');

module.exports = {
  id: 'gemini',
  label: 'Gemini CLI',
  format: 'json',
  key: ['mcpServers'],
  file: ({ home }) => path.join(home, '.gemini', 'settings.json'),
  detect: ({ home, exists }) => exists(path.join(home, '.gemini')),
  entry: (base) => ({ command: base.command, args: base.args, env: { ...base.env, PLEXIFORM_CLIENT: 'gemini' } }),
  instructions: ({ home }) => path.join(home, '.gemini', 'GEMINI.md'),
  hooksAdapter: 'gemini',
  // Plexiform cannot yet tell which Gemini session is calling, so Gemini is read-only on the bus until that exists.
  tier: TIERS.UNVERIFIED_CLIENT,
  reason: 'Gemini CLI can see the other sessions and add cards to My board. Plexiform cannot yet tell which Gemini session is calling, so it does not receive notes or start hand-offs.',
  restart: 'Start a new Gemini CLI session to load it.',
};
