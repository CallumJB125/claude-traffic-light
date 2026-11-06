'use strict';
// One member of a JSON or JSONC object (VS Code's mcp.json has comments), added, replaced or removed as text, so every
// other byte of the file stays as the person or the tool wrote it: comments, order, indentation, trailing commas.
// An addition is one contiguous chunk of text; taking that exact chunk out again gives back the original file.

// Significant tokens only: comments and whitespace are skipped. {t: '{' '}' '[' ']' ':' ',' 'str' 'lit', s, e}
function tokens(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\ufeff') { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); if (j < 0) throw new SyntaxError('unterminated comment'); i = j + 2; continue; }
    if ('{}[]:,'.includes(c)) { out.push({ t: c, s: i, e: i + 1 }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') { if (src[j] === '\\') j += 1; j += 1; }
      if (j >= n) throw new SyntaxError('unterminated string');
      out.push({ t: 'str', s: i, e: j + 1 }); i = j + 1; continue;
    }
    let j = i;
    while (j < n && !' \t\n\r{}[]:,"/'.includes(src[j])) j += 1;
    if (j === i) throw new SyntaxError(`unexpected character at ${i}`);
    out.push({ t: 'lit', s: i, e: j }); i = j;
  }
  return out;
}

// The file as plain JSON: comments gone, trailing commas gone.
function parse(src) {
  const s = String(src);
  const toks = tokens(s);
  if (!toks.length) return {};
  const parts = toks.filter((k, i) => !(k.t === ',' && toks[i + 1] && (toks[i + 1].t === '}' || toks[i + 1].t === ']'))).map((k) => s.slice(k.s, k.e));
  const data = JSON.parse(parts.join(' '));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
  return data;
}

function skipValue(toks, i) {
  const k = toks[i];
  if (!k) throw new SyntaxError('missing value');
  if (k.t === 'str' || k.t === 'lit') return i + 1;
  if (k.t !== '{' && k.t !== '[') throw new SyntaxError('unexpected token');
  let depth = 0;
  for (let j = i; j < toks.length; j += 1) {
    if (toks[j].t === '{' || toks[j].t === '[') depth += 1;
    else if (toks[j].t === '}' || toks[j].t === ']') { depth -= 1; if (depth === 0) return j + 1; }
  }
  throw new SyntaxError('unclosed value');
}

// The object whose '{' is toks[i]: its members with their key, value token span and trailing comma.
function objectAt(src, toks, i) {
  if (!toks[i] || toks[i].t !== '{') throw new SyntaxError('not an object');
  const members = [];
  let j = i + 1;
  while (toks[j] && toks[j].t !== '}') {
    if (toks[j].t !== 'str' || !toks[j + 1] || toks[j + 1].t !== ':') throw new SyntaxError('bad member');
    const key = JSON.parse(src.slice(toks[j].s, toks[j].e));
    const v = j + 2;
    const after = skipValue(toks, v);
    const m = { key, keyTok: j, valueTok: v, valueStart: toks[v].s, valueEnd: toks[after - 1].e, comma: null };
    j = after;
    if (toks[j] && toks[j].t === ',') { m.comma = toks[j]; j += 1; }
    members.push(m);
  }
  if (!toks[j]) throw new SyntaxError('unclosed object');
  return { open: toks[i], close: toks[j], members };
}

const lineStart = (src, at) => src.lastIndexOf('\n', at - 1) + 1;
const indentAt = (src, at) => /^[ \t]*/.exec(src.slice(lineStart(src, at)))[0];
const eolOf = (src) => (src.includes('\r\n') ? '\r\n' : '\n');
function unitOf(src) {
  const m = /\n([ \t]+)["}\]]/.exec(src);
  if (!m) return '  ';
  return m[1][0] === '\t' ? '\t' : ' '.repeat(Math.min(m[1].length, 8));
}
// How members of this object are indented: like its first member when that starts its own line, else one unit in.
function memberIndent(src, obj, unit) {
  const first = obj.members[0];
  if (first) {
    const at = first.keyStart;
    if (src.slice(lineStart(src, at), at).trim() === '') return src.slice(lineStart(src, at), at);
  }
  return indentAt(src, obj.open.s) + unit;
}
function render(value, ind, unit, eol) {
  return JSON.stringify(value, null, unit).split('\n').join(`${eol}${ind}`);
}

// A key written twice: JSON.parse keeps the last, a text edit would touch the first. Neither is safe to act on.
function only(members, key) {
  const hits = members.filter((x) => x.key === key);
  if (hits.length > 1) throw Object.assign(new Error(`"${key}" appears more than once`), { code: 'DUPLICATE' });
  return hits[0];
}

function walk(src, path) {
  const toks = tokens(src);
  if (!toks.length || toks[0].t !== '{') throw new Error('not a JSON object');
  let obj = objectAt(src, toks, 0);
  const chain = [obj];
  for (const key of path) {
    for (const m of obj.members) m.keyStart = toks[m.keyTok].s;
    const m = only(obj.members, key);
    if (!m) return { toks, chain, missing: key };
    if (toks[m.valueTok].t !== '{') throw Object.assign(new Error(`"${key}" is not an object`), { code: 'SHAPE' });
    obj = objectAt(src, toks, m.valueTok);
    chain.push(obj);
  }
  for (const m of obj.members) m.keyStart = toks[m.keyTok].s;
  return { toks, chain, obj };
}

// The value under path/name as JSON, or undefined. Throws DUPLICATE when a key on the way, or name, is written twice.
function get(src, path, name) {
  const data = parse(src);
  const s = String(src);
  const toks = tokens(s);
  let obj = toks.length ? objectAt(s, toks, 0) : { members: [] };
  for (const key of [...path, name]) {
    const m = only(obj.members, key);
    if (!m || toks[m.valueTok].t !== '{') break;
    obj = objectAt(s, toks, m.valueTok);
  }
  let node = data;
  for (const k of path) { node = node && typeof node === 'object' ? node[k] : undefined; }
  return node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, name) ? node[name] : undefined;
}

// One chunk for a new member at the end of obj. → {pos, chunk}
function chunkFor(src, obj, key, value) {
  const last = obj.members[obj.members.length - 1];
  // A file written on one line (the Claude desktop app's) stays on one line.
  if (!src.includes('\n')) {
    const member = `${JSON.stringify(key)}:${JSON.stringify(value)}`;
    if (last && last.comma) return { pos: last.comma.e, chunk: `${member},` };
    return last ? { pos: last.valueEnd, chunk: `,${member}` } : { pos: obj.open.e, chunk: member };
  }
  const unit = unitOf(src), eol = eolOf(src);
  const ind = memberIndent(src, obj, unit);
  const member = `${JSON.stringify(key)}: ${render(value, ind, unit, eol)}`;
  if (last && last.comma) {
    // After a comment that ends the last member's line, so the comment stays with its member.
    const rest = /^[ \t]*(?:\/\/[^\r\n]*|\/\*[^\n]*?\*\/[ \t]*)?(?=\r?\n)/.exec(src.slice(last.comma.e));
    return { pos: last.comma.e + (rest ? rest[0].length : 0), chunk: `${eol}${ind}${member},` };
  }
  if (last) return { pos: last.valueEnd, chunk: `,${eol}${ind}${member}` };
  const inner = src.slice(obj.open.e, obj.close.s);
  return { pos: obj.open.e, chunk: inner.includes('\n') ? `${eol}${ind}${member}` : `${eol}${ind}${member}${eol}${indentAt(src, obj.open.s)}` };
}

// Adds path/name = value. The file must not already have it. → {text, chunk}
function add(src, path, name, value) {
  const s = String(src);
  // VS Code leaves a zero-byte mcp.json behind; an empty (or comments-only) file means "no settings yet".
  if (!tokens(s).length) {
    const chunk = `${JSON.stringify(nest(path, name, value), null, 2)}\n`;
    return { text: (s.trim() ? `${s.replace(/\s*$/, '')}\n` : '') + chunk, chunk };
  }
  const w = walk(s, path);
  let r;
  if (w.missing) {
    r = chunkFor(s, w.chain[w.chain.length - 1], w.missing, nest(path.slice(path.indexOf(w.missing) + 1), name, value));
  } else {
    if (w.obj.members.some((m) => m.key === name)) throw Object.assign(new Error(`"${name}" already exists`), { code: 'EXISTS' });
    r = chunkFor(s, w.obj, name, value);
  }
  return { text: s.slice(0, r.pos) + r.chunk + s.slice(r.pos), chunk: r.chunk };
}
function nest(rest, name, value) {
  let v = { [name]: value };
  for (let k = rest.length - 1; k >= 0; k -= 1) v = { [rest[k]]: v };
  return v;
}

// Replaces the value of path/name in place (its key, comma and neighbours untouched). → {text, before, after}: the
// value's old and new text, so a recorded chunk can follow it.
function replace(src, path, name, value) {
  const s = String(src);
  const w = walk(s, path);
  if (w.missing) throw Object.assign(new Error('not there'), { code: 'MISSING' });
  const m = only(w.obj.members, name);
  if (!m) throw Object.assign(new Error('not there'), { code: 'MISSING' });
  const after = s.includes('\n') ? render(value, indentAt(s, m.keyStart), unitOf(s), eolOf(s)) : JSON.stringify(value);
  return { text: s.slice(0, m.valueStart) + after + s.slice(m.valueEnd), before: s.slice(m.valueStart, m.valueEnd), after };
}

// Past a comment that ends the line at `at` (and the spaces before it), else `at` itself.
function pastLineComment(s, at) {
  const m = /^[ \t]*(?:\/\/[^\r\n]*|\/\*[^\n]*?\*\/[ \t]*)?(?=\r?\n)/.exec(s.slice(at));
  return m ? at + m[0].length : at;
}

// Removes path/name: the recorded chunk when it is still there exactly once (byte-for-byte undo), else the member
// and one comma. → {text, changed}
function remove(src, path, name, chunk = null) {
  const s = String(src);
  if (chunk && s.split(chunk).length === 2) {
    const at = s.indexOf(chunk);
    const next = s.slice(0, at) + s.slice(at + chunk.length);
    try { if (get(next, path, name) === undefined) return { text: next, changed: true }; } catch { /* fall through */ }
  }
  const w = walk(s, path);
  if (w.missing) return { text: s, changed: false };
  if (!only(w.obj.members, name)) return { text: s, changed: false };
  const idx = w.obj.members.findIndex((x) => x.key === name);
  const m = w.obj.members[idx];
  const prev = w.obj.members[idx - 1];
  // Comments that end the previous member's line stay with it.
  const from = pastLineComment(s, prev ? prev.comma.e : w.obj.open.e);
  if (m.comma || !prev) return { text: s.slice(0, from) + s.slice(m.comma ? m.comma.e : m.valueEnd), changed: true };
  return { text: s.slice(0, prev.comma.s) + s.slice(prev.comma.e, from) + s.slice(m.valueEnd), changed: true };
}

module.exports = { tokens, parse, get, add, replace, remove };
