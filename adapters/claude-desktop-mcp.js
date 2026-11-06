'use strict';
// The Claude desktop app's MCP registration: mcpServers.plexiform-bus in
// ~/Library/Application Support/Claude/claude_desktop_config.json. The app writes its own preferences to the same
// file, so the edit is text-only and compare-and-swap (registry.js). Claude shows the server's instructions itself.
const path = require('path');
const { TIERS } = require('../src/bus-contract.js');

module.exports = {
  id: 'claude-desktop',
  label: 'Claude desktop app',
  format: 'json',
  key: ['mcpServers'],
  file: ({ home }) => path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  detect: ({ home, exists }) => exists(path.join(home, 'Library', 'Application Support', 'Claude')),
  entry: (base) => ({ command: base.command, args: base.args, env: { ...base.env, PLEXIFORM_CLIENT: 'claude-desktop' } }),
  instructions: null,
  instructionsVia: 'mcp',
  hooksAdapter: null,
  tier: TIERS.UNVERIFIED_CLIENT,
  reason: 'The Claude desktop app can see the other sessions and add cards to My board. It is not a session Plexiform can verify, so it does not receive notes or start hand-offs.',
  restart: 'Quit and reopen the Claude desktop app to load it.',
};
