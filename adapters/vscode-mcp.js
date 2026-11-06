'use strict';
// VS Code's user MCP registration (Copilot agent mode and other MCP hosts in VS Code): servers.plexiform-bus in
// ~/Library/Application Support/Code/User/mcp.json. That file is JSONC: it is edited as text, so comments stay.
const path = require('path');
const { TIERS } = require('../src/bus-contract.js');

module.exports = {
  id: 'vscode',
  label: 'VS Code',
  format: 'json',
  key: ['servers'],
  file: ({ home }) => path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
  detect: ({ home, exists }) => exists(path.join(home, 'Library', 'Application Support', 'Code', 'User')),
  entry: (base) => ({ type: 'stdio', command: base.command, args: base.args, env: { ...base.env, PLEXIFORM_CLIENT: 'vscode' } }),
  instructions: null,
  instructionsVia: 'mcp',
  hooksAdapter: null,
  tier: TIERS.UNVERIFIED_CLIENT,
  reason: 'VS Code can see the other sessions and add cards to My board. Plexiform cannot tell which VS Code chat is calling, so it does not receive notes or start hand-offs.',
  restart: 'VS Code asks you to start the server the first time a chat uses it.',
};
