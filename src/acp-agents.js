'use strict';
// Agents that document an Agent Client Protocol (ACP) server on stdio, driven by
// the same owned-session ACP client as Gemini (src/gemini-acp.js). Each stays
// unavailable until a human has verified on a real install that Plexiform can
// isolate it (no user tools/MCP/hooks/memory reaching the owned session); the
// exact reason comes from src/provider-capabilities.json. Evidence per agent:
// board/PROVIDERS.md.
const fs = require('node:fs');
const path = require('node:path');
const { createGeminiAcp } = require('./gemini-acp');
const MATRIX = require('./provider-capabilities.json');

const ACP_AGENTS = Object.freeze({
  // Cursor CLI: `agent acp` (https://cursor.com/docs/cli/acp); installs as ~/.local/bin/agent with a cursor-agent alias.
  cursor: { label: 'Cursor CLI', args: ['acp'], bins: ['.local/bin/cursor-agent', '.local/bin/agent', '/opt/homebrew/bin/cursor-agent', '/usr/local/bin/cursor-agent'] },
  // GitHub Copilot CLI: `copilot --acp --stdio` (public preview).
  copilot: { label: 'Copilot CLI', args: ['--acp', '--stdio'], bins: ['.local/bin/copilot', '/opt/homebrew/bin/copilot', '/usr/local/bin/copilot'] },
  // OpenCode: `opencode acp`.
  opencode: { label: 'OpenCode', args: ['acp'], bins: ['.opencode/bin/opencode', '.local/bin/opencode', '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'] },
  // Hermes Agent: `hermes acp`.
  hermes: { label: 'Hermes Agent', args: ['acp'], bins: ['.local/bin/hermes', '/opt/homebrew/bin/hermes', '/usr/local/bin/hermes'] },
});

const executable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
function findAcpBin(id, { env = process.env, exists = executable } = {}) {
  const spec = ACP_AGENTS[id];
  if (!spec) return null;
  return spec.bins.map((b) => (path.isAbsolute(b) ? b : env.HOME ? path.join(env.HOME, b) : null)).filter(Boolean).find(exists) ?? null;
}
function reasonsFor(id) {
  const p = MATRIX.platforms.find((x) => x.id === id);
  if (!p?.reasons?.owned || !p?.reasons?.notInstalled || !p?.reasons?.existing) throw new Error(`provider-capabilities.json has no reasons for ${id}`);
  return p.reasons;
}

// Never `verified`: each one is listed with its exact unavailable reason.
function createAcpAgent(id, { env = process.env, exists, ...rest } = {}) {
  const spec = ACP_AGENTS[id], reasons = reasonsFor(id);
  return createGeminiAcp({ bin: findAcpBin(id, { env, exists }), args: spec.args, env, provider: id, label: spec.label,
    notInstalled: reasons.notInstalled, notVerified: reasons.owned, existingSessionsReason: reasons.existing, ...rest, verified: false });
}

module.exports = { ACP_AGENTS, findAcpBin, createAcpAgent };
