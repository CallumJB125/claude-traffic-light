'use strict';
// OpenCode: ~/.config/opencode/agents/<name>.md (the file name is the agent
// name), YAML frontmatter with required `description`, `mode: subagent`, and
// a `permission` map (read, edit, glob, grep, shell, webfetch, websearch,
// task: allow | ask | deny). A declared Claude Code tools list becomes "deny"
// for every permission the author did not grant.
// Docs: https://opencode.ai/docs/agents/ , https://opencode.ai/docs/permissions/
const { yamlString, body, slugOf, has, EDITS } = require('./common.js');

const PERMS = [['read', ['Read', 'NotebookRead']], ['edit', EDITS], ['glob', ['Glob']], ['grep', ['Grep']], ['shell', ['Bash']], ['webfetch', ['WebFetch']], ['websearch', ['WebSearch']], ['task', ['Task', 'Agent']]];

module.exports = {
  id: 'opencode',
  label: 'OpenCode',
  dir: '.config/opencode/agents',
  ext: '.md',
  verified: true,
  render(agent, { alt = false } = {}) {
    const slug = slugOf(agent, alt);
    const fm = [`description: ${yamlString(agent.description)}`, 'mode: subagent'];
    if (agent.tools.declared) {
      const denied = PERMS.filter(([, names]) => !has(agent, ...names)).map(([k]) => k);
      if (denied.length) fm.push('permission:', ...denied.map((k) => `  ${k}: deny`));
    }
    return { ok: true, file: `${slug}.md`, text: `---\n${fm.join('\n')}\n---\n${body(agent)}` };
  },
};
