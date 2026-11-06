'use strict';
// Hermes Agent's MCP registration: mcp_servers.plexiform-bus in ~/.hermes/config.yaml (command/args/env, the shape
// Hermes documents; it reloads MCP servers when that section changes). The file is YAML Plexiform has no parser for in
// the app, so the entry is one block of text in a fixed layout: added under mcp_servers (or a new mcp_servers section
// at the end), found again by its name line, and taken out as exactly the text that went in.
//
// D7: only the MCP entry. ~/.hermes stays excluded from the bus; the server tells a Hermes caller apart by
// PLEXIFORM_CLIENT and places it by the work folder Hermes reports, never by Hermes's own home.
const path = require('path');
const { TIERS } = require('../src/bus-contract.js');

const NAME = 'plexiform-bus';
const HEADER_RE = /^mcp_servers:[ \t]*(?:#[^\n]*)?$/m;
const MARKER_RE = /PLEXIFORM_MCP:[ \t]*["']?(bus-v1:(?:packaged|dev))["']?/;
const q = (s) => JSON.stringify(String(s));

// Our entry as YAML lines at indent `ind`, one unit deeper per level. JSON strings are valid YAML double-quoted scalars.
function render(entry, ind, unit = '  ') {
  const lines = [`${ind}${NAME}:`, `${ind}${unit}command: ${q(entry.command)}`, `${ind}${unit}args: [${entry.args.map(q).join(', ')}]`];
  const env = Object.entries(entry.env || {});
  if (env.length) { lines.push(`${ind}${unit}env:`); for (const [k, v] of env) lines.push(`${ind}${unit}${unit}${k}: ${q(v)}`); }
  return `${lines.join('\n')}\n`;
}

const lineAt = (src, at) => { const e = src.indexOf('\n', at); return e < 0 ? src.length : e + 1; };
const indentOf = (line) => /^[ \t]*/.exec(line)[0];
const blank = (line) => /^[ \t]*(?:#.*)?$/.test(line);

// The mcp_servers section: {headerEnd, end, childIndent}, or null. Throws SHAPE for a flow or scalar value.
function section(src) {
  const m = HEADER_RE.exec(src);
  if (!m) {
    if (/^mcp_servers:/m.test(src)) throw Object.assign(new Error('mcp_servers is not a block mapping'), { code: 'SHAPE' });
    return null;
  }
  const headerEnd = lineAt(src, m.index);
  let at = headerEnd, end = headerEnd, childIndent = null;
  while (at < src.length) {
    const next = lineAt(src, at);
    const line = src.slice(at, next).replace(/\r?\n$/, '');
    if (!blank(line)) {
      const ind = indentOf(line);
      if (!ind) break;
      if (childIndent === null) childIndent = ind;
      end = next;
    }
    at = next;
  }
  return { headerEnd, end, childIndent };
}

// Our name's block inside the section: {start, end, body, marker}, or null.
function find(src) {
  const sec = section(src);
  if (!sec || sec.childIndent === null) return null;
  let at = sec.headerEnd;
  while (at < sec.end) {
    const next = lineAt(src, at);
    const line = src.slice(at, next).replace(/\r?\n$/, '');
    if (indentOf(line) === sec.childIndent && new RegExp(`^[ \\t]*["']?${NAME}["']?:[ \\t]*(?:#.*)?$`).test(line)) {
      let end = next;
      let k = next;
      while (k < sec.end) {
        const n2 = lineAt(src, k);
        const l2 = src.slice(k, n2).replace(/\r?\n$/, '');
        if (!blank(l2) && indentOf(l2).length <= sec.childIndent.length) break;
        if (!blank(l2)) end = n2;
        k = n2;
      }
      const body = src.slice(at, end);
      const mk = MARKER_RE.exec(body);
      return { start: at, end, body, marker: mk ? mk[1] : null, indent: sec.childIndent };
    }
    at = next;
  }
  return null;
}

// → {text, chunk}
function add(src, entry) {
  const s = String(src || '');
  const sec = section(s);
  if (sec) {
    const ind = sec.childIndent || '  ';
    const chunk = (sec.headerEnd === s.length && !s.endsWith('\n') ? '\n' : '') + render(entry, ind, ind.length >= 2 ? ind : '  ');
    return { text: s.slice(0, sec.headerEnd) + chunk + s.slice(sec.headerEnd), chunk };
  }
  const chunk = `${s && !s.endsWith('\n') ? '\n' : ''}mcp_servers:\n${render(entry, '  ')}`;
  return { text: s + chunk, chunk };
}

function replace(src, entry) {
  const hit = find(src);
  if (!hit) throw Object.assign(new Error('not there'), { code: 'MISSING' });
  const body = render(entry, hit.indent, hit.indent.length >= 2 ? hit.indent : '  ');
  return { text: src.slice(0, hit.start) + body + src.slice(hit.end), oldBody: hit.body, body };
}

// The recorded chunk when it is still there exactly once; otherwise only our own block. → {text, changed}
function remove(src, chunk = null) {
  const s = String(src);
  if (chunk && s.split(chunk).length === 2) {
    const at = s.indexOf(chunk);
    return { text: s.slice(0, at) + s.slice(at + chunk.length), changed: true };
  }
  const hit = find(s);
  if (!hit) return { text: s, changed: false };
  return { text: s.slice(0, hit.start) + s.slice(hit.end), changed: true };
}

module.exports = {
  id: 'hermes',
  label: 'Hermes Agent',
  format: 'yaml',
  file: ({ home }) => path.join(home, '.hermes', 'config.yaml'),
  detect: ({ home, exists }) => exists(path.join(home, '.hermes', 'config.yaml')),
  entry: (base) => ({ command: base.command, args: base.args, env: { ...base.env, PLEXIFORM_CLIENT: 'hermes' } }),
  instructions: null,
  instructionsVia: 'mcp',
  hooksAdapter: 'hermes',
  tier: TIERS.UNVERIFIED_CLIENT,
  reason: 'Hermes can see the other sessions and add cards to My board. It works from its own folder, which Plexiform keeps off the bus, so it does not receive notes or start hand-offs.',
  restart: 'Hermes reloads its MCP servers when its config changes; start a new Hermes chat if it does not show the bus tools.',
  yaml: { render, section, find, add, replace, remove },
  NAME,
};
