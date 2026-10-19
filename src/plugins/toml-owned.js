'use strict';
// A bounded, lossless statement/range reader. It does not deserialize foreign
// values or treat semantic equality as permission to restore foreign bytes.
const { hash } = require('./index-verify');
const MAX_BYTES = 1024 * 1024, MAX_STATEMENTS = 20000, MAX_DEPTH = 32;
const fail = () => { throw new Error('Plugin configuration ownership is unavailable'); };
const space = c => c === ' ' || c === '\t';

function keyPath(text) {
  let at = 0; const result = [];
  while (at < text.length) {
    while (space(text[at])) at++;
    let key = '';
    const quote = text[at];
    if (quote === '"' || quote === "'") {
      at++; let ended = false;
      while (at < text.length) {
        const c = text[at++];
        if (c === quote) { ended = true; break; }
        if (c === '\\' && quote === '"') {
          const escaped = text[at++];
          const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
          if (Object.hasOwn(simple, escaped)) key += simple[escaped];
          else if (escaped === 'u' || escaped === 'U') {
            const length = escaped === 'u' ? 4 : 8, hex = text.slice(at, at + length);
            if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) fail();
            const point = parseInt(hex, 16);
            if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) fail();
            key += String.fromCodePoint(point); at += length;
          } else fail();
        } else { if (/[\r\n\x00-\x1f\x7f]/.test(c)) fail(); key += c; }
      }
      if (!ended) fail();
    } else {
      const found = /^[A-Za-z0-9_-]+/.exec(text.slice(at));
      if (!found) fail(); key = found[0]; at += key.length;
    }
    if (!key || key.length > 256 || /[\p{C}]/u.test(key)) fail();
    result.push(key); if (result.length > MAX_DEPTH) fail();
    while (space(text[at])) at++;
    if (at === text.length) break;
    if (text[at++] !== '.') fail();
    if (at === text.length) fail();
  }
  if (!result.length) fail();
  return result;
}

function decode(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) fail();
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(); }
  if (text.includes('\0') || text.startsWith('\ufeff')) fail();
  return text;
}

// Find the end of one value without interpreting its private content. Strings
// and nested containers prevent a table-looking line inside a value becoming
// a mutable configuration range. Unsupported or unbalanced input is refused.
function valueEnd(text, begin) {
  let quote = null, triple = false, escaped = false; const stack = [];
  for (let at = begin; at < text.length; at++) {
    const c = text[at];
    if (quote) {
      if (quote === '"' && escaped) { escaped = false; continue; }
      if (quote === '"' && c === '\\') { escaped = true; continue; }
      if (triple && text.slice(at, at + 3) === quote.repeat(3)) { at += 2; quote = null; triple = false; continue; }
      if (!triple && c === quote) { quote = null; continue; }
      if (!triple && /[\r\n]/.test(c)) fail();
      continue;
    }
    if (c === '"' || c === "'") { quote = c; triple = text.slice(at, at + 3) === c.repeat(3); if (triple) at += 2; continue; }
    if (c === '#') { const end = text.indexOf('\n', at); if (end < 0) { if (stack.length) fail(); return text.length; } at = end - 1; continue; }
    if (c === '[' || c === '{') { stack.push(c); if (stack.length > MAX_DEPTH) fail(); }
    if (c === ']' || c === '}') { if (stack.pop() !== (c === ']' ? '[' : '{')) fail(); }
    if (c === '\n' && !stack.length) return at + 1;
  }
  if (quote || stack.length) fail();
  return text.length;
}

function statements(bytes) {
  const text = decode(bytes), result = []; let at = 0, table = [];
  const keys = new Set(), tables = new Set(), valueParents = new Set();
  while (at < text.length) {
    const begin = at; while (space(text[at]) || text[at] === '\r') at++;
    if (text[at] === '\n') { at++; continue; }
    if (text[at] === '#') { const n = text.indexOf('\n', at); at = n < 0 ? text.length : n + 1; continue; }
    if (at >= text.length) break;
    if (result.length >= MAX_STATEMENTS) fail();
    if (text[at] === '[') {
      if (text[at + 1] === '[') fail(); // Array-table configurations need a separate adapter.
      let quote = null, escaped = false, end = -1;
      for (let i = at + 1; i < text.length; i++) {
        const c = text[i]; if (c === '\n' || c === '\r') fail();
        if (quote) { if (escaped) escaped = false; else if (c === '\\' && quote === '"') escaped = true; else if (c === quote) quote = null; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === ']') { end = i; break; }
      }
      if (end < 0) fail(); table = keyPath(text.slice(at + 1, end));
      const identity = JSON.stringify(table); if (tables.has(identity) || table.some((_v, i) => keys.has(JSON.stringify(table.slice(0, i + 1))))) fail(); tables.add(identity);
      let tail = end + 1; while (space(text[tail])) tail++;
      if (text[tail] === '#') { const n = text.indexOf('\n', tail); tail = n < 0 ? text.length : n; }
      if (text[tail] === '\r') tail++;
      if (tail < text.length && text[tail] !== '\n') fail();
      at = tail < text.length ? tail + 1 : tail;
      result.push({ kind: 'table', path: [...table], begin, end: at, comment: text.slice(end + 1, at).includes('#') }); continue;
    }
    let quote = null, escaped = false, equals = -1;
    for (let i = at; i < text.length; i++) {
      const c = text[i]; if (c === '\n' || c === '\r') fail();
      if (quote) { if (escaped) escaped = false; else if (c === '\\' && quote === '"') escaped = true; else if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '=') { equals = i; break; }
      else if (c === '#') fail();
    }
    if (equals < 0) fail();
    const relative = keyPath(text.slice(at, equals)), full = [...table, ...relative], identity = JSON.stringify(full);
    // Values cannot masquerade as parent tables, and duplicate decoded paths
    // are refused even when their quoting or dotted spelling differs.
    if (keys.has(identity) || tables.has(identity) || valueParents.has(identity) || full.some((_v, i) => keys.has(JSON.stringify(full.slice(0, i + 1))))) fail();
    keys.add(identity); at = valueEnd(text, equals + 1);
    for (let i = 1; i < full.length; i++) valueParents.add(JSON.stringify(full.slice(0, i)));
    const raw = text.slice(equals + 1, at).replace(/\r?\n$/, '');
    if (!raw.trim() || raw.trim().startsWith('#')) fail();
    result.push({ kind: 'value', path: full, relative, table: [...table], begin, end: at, raw });
  }
  return { text, rows: result };
}

function owned(bytes, pluginId) {
  if (typeof pluginId !== 'string' || !/^[a-z][a-z0-9-]{0,79}@[a-z][a-z0-9-]{0,79}$/.test(pluginId)) fail();
  const parsed = statements(bytes), ranges = []; let enabled = null;
  for (const row of parsed.rows) {
    if (row.path[0] !== 'plugins') continue;
    if (row.path.length === 1 && row.kind === 'value') fail(); // Inline parent could conceal an owned equivalent.
    if (row.path[1] !== pluginId) continue;
    if (row.kind === 'table') { if (row.path.length !== 2 || row.comment) fail(); ranges.push(row); continue; }
    if (row.path.length !== 3 || row.path[2] !== 'enabled' || enabled !== null) fail();
    // A person may have annotated the owned setting. That range is no longer
    // wholly ours; refuse rather than silently delete its comment on Undo.
    const literal = /^(true|false)[ \t]*$/.exec(row.raw.trim());
    if (!literal) fail(); enabled = literal[1] === 'true'; ranges.push(row);
  }
  if (ranges.length && enabled === null) fail();
  const remove = () => { let result = '', at = 0; for (const r of ranges.sort((a, b) => a.begin - b.begin)) { result += parsed.text.slice(at, r.begin); at = r.end; } return Buffer.from(result + parsed.text.slice(at)); };
  const foreign = remove();
  return { exists: enabled !== null, enabled, foreign_hash: hash(foreign), foreign, ranges: ranges.map(r => ({ begin: r.begin, end: r.end })), newline: parsed.text.includes('\r\n') ? '\r\n' : '\n' };
}

function replaceOwned(bytes, pluginId, expected, next) {
  const before = owned(bytes, pluginId);
  if ((expected === null ? before.exists : !before.exists || before.enabled !== expected) || ![null, true, false].includes(next)) fail();
  if (next === null) return before.foreign;
  // Adding a separator to an unterminated human line would become foreign
  // content on later Undo. Refuse that shape until a native format receipt can
  // prove ownership of the separator independently of the human's next edit.
  if (before.foreign.length && before.foreign.at(-1) !== 10) fail();
  return Buffer.concat([before.foreign, Buffer.from(`[plugins.${JSON.stringify(pluginId)}]${before.newline}enabled = ${next}${before.newline}`)]);
}
module.exports = { MAX_BYTES, keyPath, statements, owned, replaceOwned };
