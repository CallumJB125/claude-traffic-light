'use strict';
// Helpers shared by the per-platform renderers. Each renderer is pure:
// render(agent, { alt }) → { ok, file, text, notes } or { ok: false, reason }.

const YAML_ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
const TOML_ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r', '\b': '\\b', '\f': '\\f' };
const hex4 = (c) => c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase();

// A YAML double-quoted scalar: escapes backslash, quote and every control character.
function yamlString(s) {
  return `"${String(s).replace(/[\\"\u0000-\u001F\u007F-\u009F\u2028\u2029\ufeff]/gu, (c) => YAML_ESC[c] ?? `\\u${hex4(c)}`)}"`;
}
// A TOML basic string (one line): escapes backslash, quote and every control character.
function tomlString(s) {
  return `"${String(s).replace(/[\\"\u0000-\u001F\u007F]/gu, (c) => TOML_ESC[c] ?? `\\u${hex4(c)}`)}"`;
}
const body = (agent) => agent.raw.slice(agent.bodyOffset);

// What a target accepts back when Plexiform restores bytes it kept (Undo,
// rollback): only the shape its own renderer writes, so a planted copy can't
// carry hooks, permission modes or other settings into an agent folder.
const { parseFrontmatter } = require('../../agent-frontmatter.js');
function frontmatterKeysWithin(text, keys) {
  try { return Object.keys(parseFrontmatter(text).fields).every((k) => keys.has(k)); } catch { return false; }
}
// The frontmatter lines of a Markdown file, or null when it has none.
function frontmatterLines(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1].split('\n') : null;
}
const slugOf = (agent, alt) => (alt ? `${agent.slug}-plexiform` : agent.slug);
// Claude Code tool names → what each platform calls them. A declared tool
// with no counterpart is dropped, which only ever narrows what the agent gets.
// A scoped grant such as Bash(git status:*) counts as not granted: no other
// platform can hold the same limit, and the full tool would widen it.
const has = (agent, ...names) => agent.tools.declared.some((t) => names.includes(t.trim()));
// One line of comment text: no control or line-break characters.
const oneLine = (s) => String(s).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu, ' ');
const EDITS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

module.exports = { yamlString, tomlString, body, slugOf, has, oneLine, EDITS, frontmatterKeysWithin, frontmatterLines };
