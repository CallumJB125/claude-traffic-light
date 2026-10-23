'use strict';
// OpenCode: ~/.config/opencode/agents/<name>.md (the file name is the agent
// name), YAML frontmatter with required `description`, `mode: subagent`, and
// a `permission` map (read, edit, glob, grep, shell, webfetch, websearch,
// task: allow | ask | deny). A declared Claude Code tools list becomes "deny"
// for every permission the author did not grant. The shell is denied under
// both `shell` (current OpenCode) and `bash` (its name before the rename;
// current OpenCode maps both to the same action), so an older OpenCode can't
// ignore the limit.
// Docs: https://opencode.ai/docs/agents/ , https://opencode.ai/docs/permissions/
const { yamlString, body, slugOf, has, EDITS, frontmatterLines } = require('./common.js');

const PERMS = [['read', ['Read', 'NotebookRead']], ['edit', EDITS], ['glob', ['Glob']], ['grep', ['Grep']], ['shell', ['Bash']], ['bash', ['Bash']], ['webfetch', ['WebFetch']], ['websearch', ['WebSearch']], ['task', ['Task', 'Agent']]];

// Its frontmatter is description, mode: subagent and a one-level permission
// map of deny entries: line by line, nothing else.
function accepts(text) {
  const lines = frontmatterLines(text);
  if (!lines) return false;
  let inPerm = false, mode = false;
  for (const l of lines) {
    if (/^description: "(?:[^"\\]|\\.)*"$/.test(l)) { inPerm = false; continue; }
    if (l === 'mode: subagent') { inPerm = false; mode = true; continue; }
    if (l === 'permission:') { inPerm = true; continue; }
    if (inPerm && /^ {2}(?:read|edit|glob|grep|shell|bash|webfetch|websearch|task): deny$/.test(l)) continue;
    return false;
  }
  return mode;
}

module.exports = {
  id: 'opencode',
  label: 'OpenCode',
  dir: '.config/opencode/agents',
  ext: '.md',
  verified: true,
  accepts,
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
