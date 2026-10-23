'use strict';
// GitHub Copilot CLI: ~/.copilot/agents/<id>.agent.md (the file name is the
// agent's id), YAML frontmatter with required `description`, optional `name`
// and `tools`. Claude Code tool names are documented aliases and unknown tool
// names are ignored, so a declared tools list is kept as written. No `tools`
// means every tool. The prompt body is capped at 30,000 characters.
// Docs: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli ,
// https://docs.github.com/en/copilot/reference/custom-agents-configuration
const { yamlString, body, slugOf } = require('./common.js');

module.exports = {
  id: 'copilot',
  label: 'Copilot CLI',
  dir: '.copilot/agents',
  verified: true,
  render(agent, { alt = false } = {}) {
    const slug = slugOf(agent, alt);
    const text = body(agent);
    if (text.length > 30000) return { ok: false, reason: 'Its prompt is longer than Copilot\'s 30,000-character limit.' };
    const fm = [`name: ${yamlString(alt ? `${agent.name}-plexiform` : agent.name)}`, `description: ${yamlString(agent.description)}`];
    if (agent.tools.declared) fm.push(`tools: [${agent.tools.declared.map(yamlString).join(', ')}]`);
    return { ok: true, file: `${slug}.agent.md`, text: `---\n${fm.join('\n')}\n---\n${text}` };
  },
};
