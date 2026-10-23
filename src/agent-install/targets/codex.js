'use strict';
// Codex: ~/.codex/agents/<name>.toml with required `name`, `description` and
// `developer_instructions`. A custom agent inherits the parent session's
// sandbox and approvals and cannot override them; it can only turn features
// off (features.shell_tool = false).
// Docs: https://developers.openai.com/codex/subagents (now served from
// https://learn.chatgpt.com/docs/agent-configuration/subagents)
const { tomlString, body, slugOf, has, oneLine, EDITS } = require('./common.js');

// The file it writes, line by line: an optional leading comment, the three
// one-line strings, and optionally [features] shell_tool = false.
const STR = String.raw`"(?:[^"\\\u0000-\u001F\u007F]|\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*"`;
const LINE = new RegExp(String.raw`^(name|description|developer_instructions) = ${STR}$`);
function accepts(text) {
  const lines = String(text).replace(/\n$/, '').split('\n');
  const seen = new Set();
  let i = 0;
  if (lines[0]?.startsWith('# ') && !/[\u0000-\u001F\u007F]/.test(lines[0])) i = 1;
  for (; i < lines.length; i++) {
    const m = lines[i].match(LINE);
    if (m && !seen.has(m[1])) { seen.add(m[1]); continue; }
    break;
  }
  if (seen.size !== 3) return false;
  const rest = lines.slice(i);
  return rest.length === 0 || (rest.length === 3 && rest[0] === '' && rest[1] === '[features]' && rest[2] === 'shell_tool = false');
}

module.exports = {
  id: 'codex',
  label: 'Codex',
  dir: '.codex/agents',
  ext: '.toml',
  verified: true,
  accepts,
  render(agent, { alt = false } = {}) {
    const slug = slugOf(agent, alt);
    const notes = [];
    const lines = [`# Added by Plexiform from ${oneLine(`${agent.id} (${agent.attribution})`)}`, `name = ${tomlString(slug)}`, `description = ${tomlString(agent.description)}`, `developer_instructions = ${tomlString(body(agent))}`];
    if (agent.tools.declared) {
      // Codex can't make one agent read-only, so an agent its author limited
      // to reading is not added there rather than given edit access.
      if (!has(agent, ...EDITS)) return { ok: false, reason: 'Its author limited it to reading, and Codex can\'t keep one agent read-only.' };
      if (!has(agent, 'Bash')) lines.push('', '[features]', 'shell_tool = false');
    }
    notes.push('Codex runs it with your current Codex sandbox and approval settings.');
    return { ok: true, file: `${slug}.toml`, text: `${lines.join('\n')}\n`, notes };
  },
};
