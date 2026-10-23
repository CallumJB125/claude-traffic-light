'use strict';
// Gemini CLI: ~/.gemini/agents/<name>.md, YAML frontmatter with required
// `name` (a slug: lowercase letters, numbers, hyphens, underscores) and
// `description`; `tools` lists Gemini tool names and, if omitted, inherits
// every tool. Claude-only keys are left out.
// Docs: https://geminicli.com/docs/core/subagents/ ,
// https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md,
// tool names: https://github.com/google-gemini/gemini-cli/tree/main/docs/tools
const { yamlString, body, slugOf, frontmatterKeysWithin } = require('./common.js');

const KEYS = new Set(['name', 'description', 'tools']);

const TOOLS = { Read: ['read_file'], Write: ['write_file'], Edit: ['replace'], MultiEdit: ['replace'], Bash: ['run_shell_command'], Grep: ['grep_search'], Glob: ['glob'], LS: ['list_directory'], WebFetch: ['web_fetch'], WebSearch: ['google_web_search'] };

module.exports = {
  id: 'gemini',
  label: 'Gemini CLI',
  dir: '.gemini/agents',
  ext: '.md',
  verified: true,
  TOOLS,
  accepts: (text) => frontmatterKeysWithin(text, KEYS),
  render(agent, { alt = false } = {}) {
    const name = slugOf(agent, alt);
    if (!/^[a-z0-9_-]+$/.test(name)) return { ok: false, reason: 'Gemini CLI does not accept this agent\'s name.' };
    const fm = [`name: ${name}`, `description: ${yamlString(agent.description)}`];
    if (agent.tools.declared) {
      const mapped = [...new Set(agent.tools.declared.flatMap((t) => TOOLS[t.trim()] ?? []))];
      // An empty list could read as "every tool", so such an agent is not added.
      if (!mapped.length) return { ok: false, reason: 'None of the tools its author gave it exist in Gemini CLI.' };
      fm.push(`tools: [${mapped.join(', ')}]`);
    }
    return { ok: true, file: `${name}.md`, text: `---\n${fm.join('\n')}\n---\n${body(agent)}` };
  },
};
