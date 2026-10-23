'use strict';
// Claude Code: ~/.claude/agents/<slug>.md, Markdown with YAML frontmatter
// (`name` and `description` required; unknown fields are ignored; no `tools`
// means every tool). Installed exactly as upstream wrote it.
// Docs: https://code.claude.com/docs/en/sub-agents
const { slugOf, yamlString } = require('./common.js');

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  dir: '.claude/agents',
  verified: true,
  render(agent, { alt = false } = {}) {
    if (agent.name.includes(':') || agent.name.startsWith('-') || agent.name.length > 256) return { ok: false, reason: 'Claude Code does not accept this agent\'s name.' };
    if (!alt) return { ok: true, file: `${agent.slug}.md`, text: agent.raw };
    // A separately named copy: only the name line changes, so both can load.
    const head = agent.raw.slice(0, agent.bodyOffset);
    const renamed = head.replace(/^name:.*$/m, `name: ${yamlString(`${agent.name}-plexiform`)}`);
    if (renamed === head) return { ok: false, reason: 'Could not rename this agent.' };
    return { ok: true, file: `${slugOf(agent, true)}.md`, text: renamed + agent.raw.slice(agent.bodyOffset), notes: [`Named "${agent.name}-plexiform" so it does not clash with yours.`] };
  },
};
