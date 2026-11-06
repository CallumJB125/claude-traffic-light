'use strict';
// Cursor's MCP registration: mcpServers.plexiform-bus in ~/.cursor/mcp.json, the global file both the Cursor app and
// cursor-agent read. No instruction block: Cursor keeps its global rules in its own settings store, not in a file
// Plexiform can edit safely; it gets the MCP server's own instructions instead.
const path = require('path');
const { TIERS } = require('../src/bus-contract.js');

module.exports = {
  id: 'cursor',
  label: 'Cursor',
  format: 'json',
  key: ['mcpServers'],
  file: ({ home }) => path.join(home, '.cursor', 'mcp.json'),
  detect: ({ home, exists }) => exists(path.join(home, '.cursor')),
  entry: (base) => ({ command: base.command, args: base.args, env: { ...base.env, PLEXIFORM_CLIENT: 'cursor' } }),
  instructions: null,
  instructionsVia: 'mcp',
  hooksAdapter: 'cursor',
  tier: TIERS.UNVERIFIED_CLIENT,
  reason: 'Cursor can see the other sessions and add cards to My board. Plexiform cannot tell which Cursor chat is calling, so it does not receive notes or start hand-offs.',
  restart: 'Cursor picks it up in a new chat; turn it on under Settings > MCP if Cursor asks.',
};
