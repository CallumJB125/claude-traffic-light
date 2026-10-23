'use strict';
// A strict, bounded reader for the YAML frontmatter of third-party agent
// files. It is not a YAML library: it reads only the shapes agent files use
// (plain, quoted and block scalars; flow and block lists of plain strings) and
// refuses everything else. Nothing is evaluated, no tags, anchors or aliases.

const MAX_BYTES = 64 * 1024;
const MAX_FIELDS = 64;
const KEY = /^([A-Za-z_][A-Za-z0-9_-]{0,63}):(?:[ \t]+(.*))?$/;
// Control characters other than tab and newline (a CR before a newline is folded first).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
// The only keys a catalogue agent may carry. Anything else (hooks, mcpServers,
// permissionMode, disallowedTools, …) could change what the AI tool does
// beyond the prompt, so such an agent is left out at build and refused at install.
const ALLOWED_KEYS = new Set(['name', 'description', 'model', 'color', 'emoji', 'vibe', 'tools', 'author', 'services']);
const NESTED_KEY = /^\s*(?:-\s+)?[A-Za-z_][\w-]*:(?:\s|$)/;
// agency-agents lists services as `- name: … / url: … / tier: …`: the one
// nested shape read, as a list of one-level maps of plain values.
const MAP_LIST_KEYS = new Set(['services']);
const MAP_ITEM = /^([ \t]*)-[ \t]+([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;
const MAP_FIELD = /^([ \t]+)([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;

function mapList(key, cont) {
  const out = [];
  let item = null, fieldIndent = null;
  const put = (k, val) => {
    if (k === '__proto__' || Object.hasOwn(item, k)) fail(`duplicate key ${k} in ${key}`);
    const s = (val ?? '').trim();
    if (!s || /^[[{|>]/.test(s)) fail(`nested maps are not supported (${key})`);
    item[k] = unquote(s);
  };
  for (const l of cont) {
    if (!l.trim()) continue;
    let m = l.match(MAP_ITEM);
    if (m) { item = Object.create(null); out.push(item); fieldIndent = m[1].length + 2; put(m[2], m[3]); continue; }
    m = l.match(MAP_FIELD);
    if (!m || !item || m[1].length !== fieldIndent) fail(`nested maps are not supported (${key})`);
    put(m[2], m[3]);
  }
  if (out.length > 32) fail(`too many items in ${key}`);
  return out;
}

class FrontmatterError extends Error {}
const fail = (msg) => { throw new FrontmatterError(msg); };

function unquote(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) fail('unterminated double-quoted value');
    return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) => {
      if (e[0] === 'u' || (e[0] === 'x' && e.length === 3)) return String.fromCharCode(parseInt(e.slice(1), 16));
      return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', 0: '\0', ' ': ' ' }[e] ?? fail(`unsupported escape \\${e}`);
    });
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) fail('unterminated single-quoted value');
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!|>]/.test(s) && s.length > 0 && !/^[|>][-+]?$/.test(s)) fail('anchors, aliases and tags are not supported');
  // A plain scalar ends at " #" (a comment).
  return s.replace(/\s+#.*$/, '');
}

function flowList(raw) {
  const s = raw.trim();
  if (!s.endsWith(']')) fail('unterminated list');
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  const out = [];
  let cur = '', q = null;
  for (const ch of inner) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') fail('nested lists are not supported');
    if (ch === ',') { out.push(unquote(cur)); cur = ''; continue; }
    cur += ch;
  }
  if (q) fail('unterminated quote in list');
  out.push(unquote(cur));
  return out;
}

/**
 * Splits `text` into { fields, frontmatter, bodyOffset } or throws a
 * FrontmatterError. `bodyOffset` is the index in `text` where the body starts
 * (just after the closing fence line). Values are strings or string arrays.
 */
function parseFrontmatter(text) {
  if (typeof text !== 'string') fail('not text');
  if (Buffer.byteLength(text) > MAX_BYTES) fail(`over ${MAX_BYTES} bytes`);
  if (CONTROL.test(text.replace(/\r\n/g, '\n'))) fail('control characters');
  const open = text.match(/^---[ \t]*\r?\n/);
  if (!open) fail('no frontmatter');
  const rest = text.slice(open[0].length);
  const close = rest.match(/(^|\r?\n)---[ \t]*(\r?\n|$)/);
  if (!close) fail('unterminated frontmatter');
  const frontmatter = rest.slice(0, close.index);
  const bodyOffset = open[0].length + close.index + close[0].length;
  const lines = frontmatter.split(/\r?\n/);
  const fields = Object.create(null);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(KEY);
    if (!m) fail(`unsupported line ${i + 1}`);
    const [, key, value = ''] = m;
    if (key === '__proto__' || Object.hasOwn(fields, key)) fail(`duplicate or reserved key ${key}`);
    if (++count > MAX_FIELDS) fail('too many fields');
    const cont = [];
    while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || !lines[i + 1].trim())) cont.push(lines[++i]);
    while (cont.length && !cont.at(-1).trim()) cont.pop();
    const v = value.trim();
    // Real YAML would read these lines as a nested map, so they are refused
    // rather than folded into a string.
    if (!v && MAP_LIST_KEYS.has(key) && cont.some((l) => MAP_ITEM.test(l))) { fields[key] = mapList(key, cont); continue; }
    if (!v && cont.some((l) => NESTED_KEY.test(l))) fail(`nested maps are not supported (${key})`);
    if (/^[|>][-+]?$/.test(v)) {
      const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length));
      const body = cont.map((l) => l.slice(Math.min(indent, l.length)));
      fields[key] = v[0] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
      if (v.endsWith('+')) fields[key] += '\n';
    } else if (!v && cont.length && cont.every((l) => !l.trim() || /^\s*-(\s|$)/.test(l))) {
      fields[key] = cont.filter((l) => l.trim()).map((l) => unquote(l.replace(/^\s*-\s?/, '')));
    } else if (v.startsWith('[')) {
      if (cont.length) fail(`multi-line list ${key}`);
      fields[key] = flowList(v);
    } else if (v.startsWith('{')) {
      fail(`maps are not supported (${key})`);
    } else if (cont.length) {
      if (v.startsWith('"') || v.startsWith("'")) fail(`multi-line quoted ${key}`);
      // A plain scalar folded across indented lines joins with single spaces.
      fields[key] = [v, ...cont.map((l) => l.trim())].filter(Boolean).join(' ').replace(/\s+#.*$/, '');
    } else {
      fields[key] = unquote(v);
    }
  }
  return { fields, frontmatter, bodyOffset };
}

/** The string value of a field, or null. Lists join with ", "; a map item gives its name. */
function str(fields, key) {
  const v = fields[key];
  if (v == null) return null;
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x.name ?? '')).join(', ') : String(v);
}

module.exports = { parseFrontmatter, str, FrontmatterError, MAX_BYTES, ALLOWED_KEYS };
