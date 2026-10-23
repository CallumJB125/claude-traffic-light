'use strict';
// Claude Code: ~/.claude/agents/<slug>.md, Markdown with YAML frontmatter
// (`name` and `description` required; unknown fields are ignored; no `tools`
// means every tool). Installed exactly as upstream wrote it.
// Docs: https://code.claude.com/docs/en/sub-agents
const { slugOf, yamlString } = require('./common.js');
const { parseFrontmatter, ALLOWED_KEYS } = require('../../agent-frontmatter.js');

// The file goes in as written, so its frontmatter is checked again here: a key
// outside the allowlist (hooks, mcpServers, permissionMode, …) would change
// what Claude Code does beyond the prompt.
function keysAllowed(raw) {
  try { return Object.keys(parseFrontmatter(raw).fields).every((k) => ALLOWED_KEYS.has(k)); } catch { return false; }
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  dir: '.claude/agents',
  ext: '.md',
  verified: true,
  accepts: (text) => keysAllowed(text),
  render(agent, { alt = false } = {}) {
    if (agent.name.includes(':') || agent.name.startsWith('-') || agent.name.length > 256) return { ok: false, reason: 'Claude Code does not accept this agent\'s name.' };
    if (!keysAllowed(agent.raw)) return { ok: false, reason: 'Its settings include more than a name, description, model and tools, so Plexiform does not add it to Claude Code.' };
    if (!alt) return { ok: true, file: `${agent.slug}.md`, text: agent.raw };
    // A separately named copy: only the name line changes, so both can load.
    const head = agent.raw.slice(0, agent.bodyOffset);
    // A block or multi-line name would leave its extra lines behind.
    if (!/^name:[ \t]*[^|>\s]/m.test(head)) return { ok: false, reason: 'Could not rename this agent.' };
    const renamed = head.replace(/^name:.*$/m, `name: ${yamlString(`${agent.name}-plexiform`)}`);
    if (renamed === head) return { ok: false, reason: 'Could not rename this agent.' };
    return { ok: true, file: `${slugOf(agent, true)}.md`, text: renamed + agent.raw.slice(agent.bodyOffset), notes: [`Named "${agent.name}-plexiform" so it does not clash with yours.`] };
  },
};
