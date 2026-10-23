'use strict';
// GitHub Copilot CLI: ~/.copilot/agents/<id>.agent.md (the file name is the
// agent's id), YAML frontmatter with required `description`, optional `name`
// and `tools`. Claude Code tool names are documented aliases and unknown tool
// names are ignored, so a declared tools list is kept as written. No `tools`
// means every tool. The prompt body is capped at 30,000 characters.
// Docs: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli ,
// https://docs.github.com/en/copilot/reference/custom-agents-configuration
const { yamlString, body, slugOf, frontmatterKeysWithin } = require('./common.js');

const KEYS = new Set(['name', 'description', 'tools']);

module.exports = {
  id: 'copilot',
  label: 'Copilot CLI',
  dir: '.copilot/agents',
  ext: '.agent.md',
  verified: true,
  accepts: (text) => frontmatterKeysWithin(text, KEYS),
  render(agent, { alt = false } = {}) {
    const slug = slugOf(agent, alt);
    const text = body(agent);
    if (text.length > 30000) return { ok: false, reason: 'Its prompt is longer than Copilot\'s 30,000-character limit.' };
    const fm = [`name: ${yamlString(alt ? `${agent.name}-plexiform` : agent.name)}`, `description: ${yamlString(agent.description)}`];
    if (agent.tools.declared) {
      // Only plain tool names are kept: whether Copilot honours a scoped grant
      // such as Bash(git status:*) is not documented, so it is dropped.
      const tools = agent.tools.declared.map((t) => t.trim()).filter((t) => !t.includes('('));
      if (!tools.length) return { ok: false, reason: 'None of the tools its author gave it can be kept in Copilot CLI.' };
      fm.push(`tools: [${tools.map(yamlString).join(', ')}]`);
    }
    return { ok: true, file: `${slug}.agent.md`, text: `---\n${fm.join('\n')}\n---\n${text}` };
  },
};
