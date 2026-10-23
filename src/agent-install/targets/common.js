'use strict';
// Helpers shared by the per-platform renderers. Each renderer is pure:
// render(agent, { alt }) → { ok, file, text, notes } or { ok: false, reason }.

const YAML_ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
const TOML_ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r', '\b': '\\b', '\f': '\\f' };
const hex4 = (c) => c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase();

// A YAML double-quoted scalar: escapes backslash, quote and every control character.
function yamlString(s) {
  return `"${String(s).replace(/[\\"\u0000-\u001F\u007F\u2028\u2029]/gu, (c) => YAML_ESC[c] ?? `\\u${hex4(c)}`)}"`;
}
// A TOML basic string (one line): escapes backslash, quote and every control character.
function tomlString(s) {
  return `"${String(s).replace(/[\\"\u0000-\u001F\u007F]/gu, (c) => TOML_ESC[c] ?? `\\u${hex4(c)}`)}"`;
}
const body = (agent) => agent.raw.slice(agent.bodyOffset);
const slugOf = (agent, alt) => (alt ? `${agent.slug}-plexiform` : agent.slug);
// Claude Code tool names → what each platform calls them. A declared tool
// with no counterpart is dropped, which only ever narrows what the agent gets.
const has = (agent, ...names) => agent.tools.declared.some((t) => names.includes(t.replace(/\(.*$/, '').trim()));
const EDITS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

module.exports = { yamlString, tomlString, body, slugOf, has, EDITS };
