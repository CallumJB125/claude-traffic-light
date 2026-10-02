// Borrow a setup's dotfile scrubber: one file in, what may be shared out.
// Contract and guarantees: README.md next to this file.
//
// Layers, in order:
//   1. blocklist and sanity (path, size, binary, placeholder collisions,
//      anything shaped like a stand-in: {{GH:…}} could hide a token)
//   2. structure-aware: values that are always secret by position
//      (settings.json / MCP env and headers, Codex env tables, .npmrc auth,
//      gitconfig identity and signing key, SSH HostName/User)
//   3. the shared secret list (board/shared/secret-patterns.mjs), keeping
//      git SHAs where they are pins and references that fetch a secret
//   4. high-entropy tokens nothing else named
//   5. this machine's values → {{HOME}} {{USER}} {{HOSTNAME}} {{EMAIL}}, and
//      other emails, private IPs, internal hosts, private names → numbered
//   6. fail closed: detection runs again on the output, and machine values
//      are looked for again (also percent-decoded and inside longer words);
//      anything left blocks the whole file. So does any error.
//
// Every pass is linear in the file's size: 1 MB of any shape scrubs in well
// under two seconds (test/borrow-scrub.test.js).
//
// The original values never leave this function: redaction records carry a
// kind, a name and a placeholder only.
const { findSecrets } = require('../../board/shared/secret-patterns.mjs');
const { blockedReason } = require('./blocklist.js');

const MAX_BYTES = 1024 * 1024;
const PLACEHOLDER = /\{\{(?:HOME|USER|HOSTNAME|NAME|EMAIL(?::\d+)?|IP:\d+|HOST:\d+|PRIVATE:\d+|SSH_USER|SECRET:[\w.-]{1,64})\}\}/g;
const PLACEHOLDER_SPLIT = new RegExp(`(${PLACEHOLDER.source})`);
const RESERVED = /\{\{\s*(?:HOME|USER|HOSTNAME|NAME|EMAIL|IP|HOST|PRIVATE|SSH_USER|SECRET)\b/i;
// Anything a scrubber could take for a stand-in: {{NAME:…}} in any case, or {{CAPS}}.
const STAND_IN_LIKE = /\{\{\s*[A-Za-z_]{1,16}\s*:[^}]{0,64}\}\}|\{\{\s*[A-Z_]{2,16}\s*\}\}|<redacted:[^>]{0,40}>|\[redacted\]/i;
const CF = /\p{Cf}/gu;

const FORMATS = [
  [/\.jsonc$|(?:^|\/)(?:Code|Cursor)\/User\/[^/]+\.json$/i, 'jsonc'],
  [/\.json$/i, 'json'],
  [/\.toml$/i, 'toml'],
  [/\.ya?ml$/i, 'yaml'],
  [/(?:^|\/)\.?gitconfig$|(?:^|\/)git\/config$/i, 'gitconfig'],
  [/(?:^|\/)\.ssh\/config$/i, 'sshconfig'],
  [/(?:^|\/)\.npmrc$/i, 'npmrc'],
  [/\.lua$/i, 'lua'],
  [/(?:^|\/)\.?g?vimrc$|\.vim$/i, 'vim'],
  [/\.ini$|\.cfg$|\.conf$/i, 'ini'],
  [/(?:^|\/)\.(?:zsh|bash|z)?(?:rc|profile|env|login|logout|aliases|functions|exports)$|\.(?:sh|zsh|bash|fish)$|(?:^|\/)config\.fish$/i, 'shell'],
];

// The scanner reports extracted keys as "~/.claude.json#mcpServers".
function formatOf(p) {
  const file = String(p).replace(/#.*$/, '');
  for (const [re, f] of FORMATS) if (re.test(file)) return f;
  return 'text';
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Command substitutions that fetch a secret from a store: sharing the
// command shares no secret, and the borrower's own store answers it.
const SECRET_FETCH = /^(?:\$\(|`|\()\s*(?:security\s+find-(?:generic|internet)-password|op\s+(?:read|item\s+get|inject)|pass(?:\s+show)?\s|gopass\s|bw\s+get|lpass\s+show|secret-tool\s+lookup|keyring\s+get|gh\s+auth\s+token|aws-vault\s|vault\s+(?:kv\s+get|read)|doppler\s+secrets\s+get|gcloud\s+auth\s+print-(?:access|identity)-token|az\s+account\s+get-access-token|cat\s+["']?(?:~|\$HOME|\$\{HOME\})\/|<\s*["']?(?:~|\$HOME))/;
// A value that names where the secret comes from: $VAR (capitals only:
// $uperS3cret is a password), an env lookup in some language, a 1Password
// reference.
const REFERENCE = /^(?:\$\{?[A-Z_][A-Z0-9_]*\}?|op:\/\/\S+|(?:os\.getenv|getenv|vim\.env\.|vim\.fn\.getenv|process\.env|os\.environ|ENV\[|\$ENV\{|\$env:|env\()[\w.("'[\]{}:-]*\)?)$/;
// An env var's name is a reference only under a key that says so (codex
// env_key = "AZURE_OPENAI_API_KEY"); elsewhere MY_DOG_REX_2019 is a password.
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ENV_KEY = /(?:^|[_.-])env_?(?:key|var|name)$/i;
const isReference = (v, key) => REFERENCE.test(v) || (ENV_NAME.test(v) && key != null && ENV_KEY.test(key));
const PIN_KEY = /(?<![A-Za-z0-9])(?:commit|rev|revision|sha|hash|checksum|integrity|digest|lock|ref)["']?\s*[:=]\s*["']?$/i;
const LOCKFILE = /(?:lock(?:file)?\.json|\.lock|lazy-lock\.json|packer_compiled\.lua)$/i;
const BOOLISH = /^(?:true|false|0|1|yes|no|on|off)?$/i;
const PUBLIC_SSH = /^(?:git|(?:ssh\.)?github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com|git\.sr\.ht)$/i;
// Env keys whose values are settings, not secrets (MAX_THINKING_TOKENS: 31999).
const SECRET_KEY_NAME = /secret|passw|pwd|pin\b|api[_-]?key|token(?!s)|auth|credential|private|cookie|session|dsn/i;
// Objects whose every string value is secret: env and header tables, also
// dotted (VS Code "terminal.integrated.env.osx", TOML env.FOO).
const SECRET_TABLES = ['env', 'headers', 'http_headers', 'environment'];
const secretTable = (extra) => new RegExp(`^(?:[\\w.-]*\\.)?(?:${[...SECRET_TABLES, ...extra].map(escapeRe).join('|')})(?:\\.[\\w-]+)?$`, 'i');
// A value that is only a YAML block indicator: its lines were not joined.
const BLOCK_INDICATOR = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/;

// Line starts, once per text, so line numbers are a binary search.
function lineStarts(text) {
  const starts = [0];
  for (let k = text.indexOf('\n'); k !== -1; k = text.indexOf('\n', k + 1)) starts.push(k + 1);
  return starts;
}
function lineOf(starts, i) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= i) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// The key a value belongs to, from the text before it on its line, never
// reaching back past `floor` (the end of the span before it: a redacted
// secret must not become the next placeholder's name).
function keyBefore(text, index, floor = 0) {
  let before = text.slice(Math.max(floor, index - 200, 0), index);
  const nl = before.lastIndexOf('\n');
  if (nl !== -1) before = before.slice(nl + 1);
  if (/:\/\/[^\s/@:"'`]*:$/.test(before)) return 'url_password';
  const m = /(?:--)?([A-Za-z_][\w.-]{0,63})["']?\s*[:=]\s*["'`]?\s*(?:(?:bearer|basic|token)\s+)?$/i.exec(before)
    || /(?:set(?:\s+-\w+){1,3}|setenv)\s+(\w{1,64})\s+["']?$/.exec(before)
    || /--([\w-]{1,64})\s+["']?$/.exec(before);
  return m ? m[1] : null;
}

const safeName = (s) => String(s).replace(/[^\w.-]/g, '_').replace(/^[._-]+/, '').slice(0, 48) || 'secret';

function shannon(s) {
  const f = new Map();
  for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

// A random-looking token: mixed case and digits, dense enough.
function looksRandom(tok) {
  if (tok.length < 20) return false;
  if (!/[a-z]/.test(tok) || !/[A-Z]/.test(tok) || !/\d/.test(tok)) return false;
  // Identifiers (nvim-treesitter, AutoModelForCausalLM) rarely hold three digits.
  if (/^[A-Za-z]+(?:[-_.][A-Za-z0-9]+)*$/.test(tok) && (tok.match(/\d/g) || []).length < 3) return false;
  return shannon(tok) >= Math.min(4.2, Math.log2(tok.length) - 0.6);
}

// '=' only as base64 padding, so KEY=value splits into two tokens.
const ENTROPY_TOKEN = /(?<![\w+/=.-])[\w+/.-]{20,}={0,2}/g;

// ── layer 2: structure ──────────────────────────────────────────────────────

// Index just past the brace block that opens at `open` (a '{'), skipping
// strings and JSONC comments (a quote in `// don"t` opens nothing).
function blockEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { i++; while (i < text.length && text[i] !== '"' && text[i] !== '\n') { if (text[i] === '\\') i++; i++; } continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); if (e === -1) return text.length; i = e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e === -1) return text.length; i = e + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

function jsonKey(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

// Provenance of structured keys/properties is kept locally, never returned in
// redaction metadata. Scan JSON strings once so quoted values/comments do not
// get mistaken for keys; escaped key/value spellings are compared decoded.
const MAX_KEY_RANGES = 32768;
const MAX_KEY_FINGERPRINTS = 131072;
const blockedError = (reason) => Object.assign(new Error(reason), { blocked: true });

// A bounded lexical reader, not a TOML evaluator. Keys and string bodies share
// one decoded representation and their original ranges. Quoted/escaped table
// names therefore cannot change which values are secret. Ambiguous syntax is
// refused rather than falling back to a regex that might miss a container.
function tomlStructure(text, sensitiveKeys = []) {
  const keys = [], spans = [];
  const table = secretTable(sensitiveKeys);
  const fail = () => { throw blockedError('TOML structure could not be reviewed safely'); };
  let at = 0, nodes = 0;
  const count = () => { if (++nodes > MAX_KEY_RANGES) throw blockedError('too many structured keys or values to review safely'); };
  const horizontal = () => { while (text[at] === ' ' || text[at] === '\t') at++; };
  const whitespace = () => {
    while (at < text.length) {
      if (/\s/.test(text[at])) { at++; continue; }
      if (text[at] === '#') { const end = text.indexOf('\n', at); at = end === -1 ? text.length : end + 1; continue; }
      break;
    }
  };
  function string(key = false) {
    const quote = text[at], start = at;
    const triple = text.slice(at, at + 3) === quote.repeat(3);
    if (key && triple) fail();
    at += triple ? 3 : 1;
    const body = at;
    let decoded = '';
    const finish = end => {
      const plain = decoded.replace(CF, '');
      if (RESERVED.test(plain) || STAND_IN_LIKE.test(plain)) throw blockedError("already contains Buddy's placeholder syntax");
      return { start, end:at, index:body, length:end-body, decoded };
    };
    if (triple && text[at] === '\r' && text[at + 1] === '\n') at += 2;
    else if (triple && text[at] === '\n') at++;
    while (at < text.length) {
      const c = text[at];
      if (c === quote) {
        if (!triple) { const end = at++; return finish(end); }
        let run = 1; while (text[at + run] === quote) run++;
        if (run >= 3) {
          if (run > 5) fail();
          const extra = run - 3, end = at + extra;
          decoded += quote.repeat(extra); at += run;
          return finish(end);
        }
        decoded += quote.repeat(run); at += run; continue;
      }
      if (c === '\n' || c === '\r') {
        if (!triple) fail();
        if (c === '\r') { if (text[at + 1] !== '\n') fail(); at++; }
        decoded += '\n'; at++; continue;
      }
      if (c.charCodeAt(0) < 0x20 && c !== '\t') fail();
      if (quote === '"' && c === '\\') {
        at++;
        const escapes = { b:'\b', t:'\t', n:'\n', f:'\f', r:'\r', '"':'"', '\\':'\\' };
        if (Object.hasOwn(escapes, text[at])) { decoded += escapes[text[at++]]; continue; }
        if (text[at] === 'u' || text[at] === 'U') {
          const size = text[at++] === 'u' ? 4 : 8;
          const raw = text.slice(at, at + size);
          if (raw.length !== size || !/^[0-9A-Fa-f]+$/.test(raw)) fail();
          const point = parseInt(raw, 16);
          if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) fail();
          decoded += String.fromCodePoint(point); at += size; continue;
        }
        if (triple) {
          horizontal();
          if (text[at] === '\n' || (text[at] === '\r' && text[at + 1] === '\n')) {
            while (at < text.length && /\s/.test(text[at])) at++;
            continue;
          }
        }
        fail();
      }
      decoded += c; at++;
    }
    fail();
  }
  function keyPath() {
    const parts = [];
    let bytes = 0;
    while (at < text.length) {
      horizontal();
      let item;
      if (text[at] === '"' || text[at] === "'") item = string(true);
      else {
        const start = at;
        while (at < text.length && /[A-Za-z0-9_-]/.test(text[at])) at++;
        if (at === start) fail();
        item = { index:start, length:at-start, decoded:text.slice(start, at) };
      }
      bytes += Buffer.byteLength(item.decoded);
      if (parts.length >= 32 || bytes > 4096) throw blockedError('TOML key path exceeds the safe review budget');
      count(); keys.push({ index:item.index, length:item.length, decoded:item.decoded });
      parts.push(item.decoded);
      horizontal();
      if (text[at] !== '.') return parts;
      at++;
    }
    fail();
  }
  const keyPolicy = new Map();
  const dottedExtra = sensitiveKeys.some(key => key.includes('.'));
  const secretPath = parts => parts.some(part => {
    if (!keyPolicy.has(part)) keyPolicy.set(part, table.test(part));
    return keyPolicy.get(part);
  }) || (dottedExtra && table.test(parts.join('.')));
  function value(parts, inherited = false, depth = 0) {
    if (depth > 32 || parts.length > 32) throw blockedError('TOML structure exceeds the safe review budget');
    count(); horizontal();
    const name = parts[parts.length - 1] || 'structured';
    const sensitive = inherited || secretPath(parts) || /^(?:secret|pass|password|token|client_secret|access_key|secret_key)$/i.test(name);
    if (text[at] === '"' || text[at] === "'") {
      const item = string();
      if (sensitive && item.length > 0 && !BOOLISH.test(item.decoded) && !isReference(item.decoded, name)) {
        spans.push({ index:item.index, length:item.length, name, kind:'structured', decoded:item.decoded });
      }
      return;
    }
    if (text[at] === '{') {
      at++; whitespace();
      if (text[at] === '}') { at++; return; }
      while (at < text.length) {
        const child = keyPath();
        if (text[at++] !== '=') fail();
        value([...parts, ...child], sensitive, depth + 1); whitespace();
        if (text[at] === '}') { at++; return; }
        if (text[at++] !== ',') fail();
        whitespace();
        if (text[at] === '}') { at++; return; }
      }
      fail();
    }
    if (text[at] === '[') {
      at++; whitespace();
      if (text[at] === ']') { at++; return; }
      while (at < text.length) {
        value(parts, sensitive, depth + 1); whitespace();
        if (text[at] === ']') { at++; return; }
        if (text[at++] !== ',') fail();
        whitespace();
        if (text[at] === ']') { at++; return; }
      }
      fail();
    }
    const start = at;
    while (at < text.length && !/[\n\r#,}\]]/.test(text[at])) at++;
    const bare = text.slice(start, at).trim();
    // Scalar numbers, booleans and date/time spellings contain no string
    // values. Everything else is unsupported; do not guess at raw commands.
    if (!/^(?:true|false|[+-]?(?:inf|nan)|[+-]?(?:0x[\dA-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)|\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.test(bare)) fail();
  }
  let section = [];
  while (at < text.length) {
    whitespace(); if (at >= text.length) break;
    if (text[at] === '[') {
      at++; const array = text[at] === '['; if (array) at++;
      section = keyPath();
      if (text[at++] !== ']' || (array && text[at++] !== ']')) fail();
    } else {
      const parts = keyPath();
      if (text[at++] !== '=') fail();
      value([...section, ...parts]);
    }
    horizontal();
    if (text[at] === '#') { const end = text.indexOf('\n', at); at = end === -1 ? text.length : end; }
    if (at < text.length && text[at] !== '\n' && text[at] !== '\r') fail();
    if (text[at] === '\r' && text[at + 1] !== '\n') fail();
    if (at < text.length) at++;
  }
  return { keys, spans };
}

function structuredKeys(text, format) {
  const keys = [];
  const add = (index, length, decoded) => {
    if (keys.length >= MAX_KEY_RANGES) throw blockedError('too many structured keys to review safely');
    keys.push({ index, length, decoded });
  };
  if (format === 'json' || format === 'jsonc') {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '/' && text[i + 1] === '/') { const end = text.indexOf('\n', i + 2); if (end === -1) break; i = end; continue; }
      if (text[i] === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); if (end === -1) break; i = end + 1; continue; }
      if (text[i] !== '"') continue;
      const start = i + 1; let end = start;
      while (end < text.length && text[end] !== '"') { if (text[end] === '\\') end++; end++; }
      if (end >= text.length) break;
      let next = end + 1; while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === ':') add(start, end - start, jsonKey(text.slice(start, end)));
      i = end;
    }
  }
  // Anchors on a scalar whose body is redacted must not retain duplicated
  // secret material either. This also covers YAML embedded in shell heredocs.
  const properties = /^([ \t]*(?:-[ \t]+)*(?:"[^"\n]*"|'[^'\n]*'|[\w.-]+)[ \t]*:[ \t]*)((?:[!&][^ \t\r\n]+[ \t]+)+)[|>]/gm;
  let m; while ((m = properties.exec(text))) add(m.index + m[1].length, m[2].length, m[2]);
  return keys;
}
function keyContainsSecret(keys, spans, text) {
  if (!keys.length || !spans.length) return false;
  const parts = new Set();
  const collect = value => {
    for (let i = 0; i + 8 <= value.length; i++) {
      parts.add(value.slice(i, i + 8));
      if (parts.size > MAX_KEY_FINGERPRINTS) throw blockedError('secret comparison exceeds the safe review budget');
    }
  };
  const material = (initial, decoded) => {
    const pending = [{ value:initial, decoded, depth:0 }]; let nodes = 0;
    while (pending.length) {
      if (++nodes > MAX_KEY_RANGES) throw blockedError('secret comparison exceeds the safe review budget');
      const { value:raw, decoded:isDecoded, depth } = pending.pop();
      if (typeof raw !== 'string') continue;
      // Decoded strings are actual value bytes, not source-code wrappers.
      // Stripping their whitespace/quotes would discard an eight-byte prefix
      // that can still be duplicated verbatim in a decoded key.
      const value = isDecoded ? raw : raw.trim().replace(/^["']|["']$/g, '');
      const view = value.trim();
      if (/^[\[{]/.test(view)) {
        let parsed;
        try { parsed = JSON.parse(view); } catch {
          // Detection spans can be partial values (a TOML inline table or
          // even its opening brace). Preserve their literal comparison;
          // parsing is only an aid to exclude public JSON field names.
          try { parsed = JSON.parse(jsonKey(view)); } catch { collect(value); continue; }
        }
        if (depth >= 32) throw blockedError('secret comparison exceeds the safe review budget');
        const walk = [{ item:parsed, level:depth+1 }];
        while (walk.length) {
          const { item, level } = walk.pop();
          if (++nodes > MAX_KEY_RANGES || level > 32) throw blockedError('secret comparison exceeds the safe review budget');
          if (typeof item === 'string') pending.push({ value:item, decoded:true, depth:level });
          else if (item && typeof item === 'object') for (const child of Object.values(item)) walk.push({ item:child, level:level+1 });
        }
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(view)) {
        // The whole URI may be redacted, but public protocol/host words
        // are not secret material to compare against unrelated key names.
        let uri; try { uri = new URL(view); } catch { throw blockedError('a structured secret value could not be reviewed safely'); }
        for (const part of [uri.username,uri.password,uri.pathname,uri.hash,...uri.searchParams.keys(),...uri.searchParams.values()]) {
          try { collect(decodeURIComponent(part)); } catch { throw blockedError('a structured secret value could not be reviewed safely'); }
        }
      } else collect(value);
    }
  };
  for (const span of spans) material(typeof span.decoded === 'string' ? span.decoded : text.slice(span.index, span.index + span.length), typeof span.decoded === 'string');
  return keys.some(key => {
    for (let i = 0; i + 8 <= key.decoded.length; i++) if (parts.has(key.decoded.slice(i, i + 8))) return true;
    return false;
  });
}

function structuredSpans(text, format, sensitiveKeys = [], toml = null) {
  const spans = toml ? toml.spans.slice() : [];
  const add = (index, length, name, kind = 'structured', details = {}) => { if (length > 0) spans.push({ index, length, name, kind, ...details }); };
  const table = secretTable(sensitiveKeys);

  if (format === 'json' || format === 'jsonc') {
    // Any "key": { … } whose key, JSON escapes decoded, names a secret table.
    const open = /"((?:[^"\\\n]|\\.){1,128})"\s*:\s*\{/g;
    let m;
    while ((m = open.exec(text))) {
      if (!table.test(jsonKey(m[1]))) continue;
      const start = m.index + m[0].length - 1;
      const end = blockEnd(text, start);
      const pair = /"((?:[^"\\\n]|\\.)*)"\s*:\s*"((?:[^"\\\n]|\\.)*)"/g;
      pair.lastIndex = start;
      let p;
      while ((p = pair.exec(text)) && p.index < end) {
        const v = p[2];
        const k = jsonKey(p[1]);
        if (BOOLISH.test(v) || isReference(v, k) || (/^\d{1,9}$/.test(v) && !SECRET_KEY_NAME.test(k))) continue;
        add(p.index + p[0].length - 1 - v.length, v.length, k, 'structured', { decoded: jsonKey(v) });
      }
      open.lastIndex = Math.max(end, m.index + m[0].length);
    }
  }

  const lineRule = (re, onMatch) => {
    let at = 0;
    for (const line of text.split('\n')) {
      const m = re.exec(line);
      if (m) onMatch(m, at, line);
      at += line.length + 1;
    }
  };
  const addValue = (m, at, name, kind) => {
    const raw = m.groups.v.replace(/\s+$/, '');
    const quoted = /^(["']).*\1$/.test(raw);
    const v = quoted ? raw.slice(1, -1) : raw;
    add(at + m.index + m[0].length - m.groups.v.length + (quoted ? 1 : 0), v.length, name, kind);
  };

  if (format === 'ini' || format === 'toml' || format === 'text') {
    // A bare `key` is a keybinding in TOML (alacritty key = "V"); in ini/conf
    // (rclone) it is a secret when it is long enough to be one.
    const keys = format === 'toml' ? 'secret|pass|password|token|client_secret|access_key|secret_key' : 'key|secret|pass|password|token|client_secret|access_key|secret_key';
    lineRule(new RegExp(`^\\s*(?<k>${keys})\\s*=\\s*(?<v>\\S.*?)\\s*$`, 'i'), (m, at) => {
      const raw = m.groups.v.replace(/^["']|["']$/g, '');
      if (m.groups.k.toLowerCase() === 'key' && raw.length < 8) return;
      if (!BOOLISH.test(raw) && !isReference(raw, m.groups.k)) addValue(m, at, m.groups.k);
    });
  }

  if (format === 'npmrc') {
    lineRule(/(?:^|:)(?<k>_auth|_authToken|_password|username|email|certfile|keyfile)\s*=\s*(?<v>.+)$/, (m, at) => {
      if (isReference(m.groups.v.trim().replace(/^["']|["']$/g, ''), m.groups.k)) return;
      addValue(m, at, m.groups.k === 'email' ? 'npm_email' : m.groups.k);
    });
  }

  if (format === 'gitconfig') {
    let section = '';
    lineRule(/^.*$/, (m, at, line) => {
      const h = /^\s*\[\s*([\w.-]+)/.exec(line);
      if (h) { section = h[1].toLowerCase(); return; }
      const kv = /^\s*(?<k>[\w.-]+)\s*=\s*(?<v>.+)$/.exec(line);
      if (!kv) return;
      const k = kv.groups.k.toLowerCase();
      if (section === 'user' && k === 'name') addValue(kv, at, 'NAME', 'identity');
      else if (section === 'user' && k === 'signingkey' && !/^["']?(?:[~/$]|[0-9A-Fa-f]{8,40}["']?$)/.test(kv.groups.v)) addValue(kv, at, 'signingkey');
      else if (section === 'github' && (k === 'token' || k === 'oauth-token')) addValue(kv, at, 'github_token');
    });
  }

  if (format === 'sshconfig') {
    // A trailing comment is allowed: `HostName bastion.acme.co.za # jump box`.
    lineRule(/^(?<pre>\s*(?<k>HostName|User)\s*(?:=\s*|\s+))(?<v>[^\s#]+)\s*(?:#.*)?$/i, (m, at) => {
      if (PUBLIC_SSH.test(m.groups.v)) return;
      const user = m.groups.k.toLowerCase() === 'user';
      add(at + m.index + m.groups.pre.length, m.groups.v.length, user ? 'SSH_USER' : 'HOSTNAME_SSH', user ? 'ssh_user' : 'ssh_host');
    });
  }

  return spans;
}

// ── layer 3/4: detection ─────────────────────────────────────────────────────

// Detection reads a copy of the text, never the text itself:
//
// 1. joined: format characters (zero-width, BOM) and backslash-newline
//    continuations are removed, so a token split by either is whole again
//    (`sk-ant-api03-abcd\⏎EFGH…`). `map[i]` is the original offset of
//    joined[i]; after a non-space the next line's indent goes too.
// 2. view: the joined text, the same length, with multi-line values put on
//    one line, so a pattern sees the whole value:
//      `password: |⏎  line⏎  line`      YAML block scalars (|2, | # c, - key: |)
//      `password:⏎  value`              YAML plain value on the next line
//      `KEY="abc⏎def"`                  a quoted value left open on its line
//      `key = """⏎…⏎"""`                TOML / Python multi-line strings
//      `'abc'\''def'`                   shell quote joins
function joinedText(text) {
  const cut = /\p{Cf}+|\\\r?\n/gu;
  if (!cut.test(text)) return { joined: text, map: null };
  cut.lastIndex = 0;
  const parts = [];
  const map = [];
  let at = 0;
  let m;
  const keep = (from, to) => { parts.push(text.slice(from, to)); for (let i = from; i < to; i++) map.push(i); };
  while ((m = cut.exec(text))) {
    keep(at, m.index);
    at = m.index + m[0].length;
    if (m[0][0] === '\\' && m.index > 0 && /\S/.test(text[m.index - 1])) {
      while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at++;
    }
    cut.lastIndex = at;
  }
  keep(at, text.length);
  return { joined: parts.join(''), map };
}

const YAML_KEY = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[\w.-]+)`;
const YAML_BLOCK = new RegExp(String.raw`^([ \t]*)(?:-[ \t]+)*${YAML_KEY}[ \t]*:[ \t]*[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?$`);
const YAML_PROPERTY_BLOCK = new RegExp(String.raw`^(([ \t]*)(?:-[ \t]+)*${YAML_KEY}[ \t]*:[ \t]*)((?:[!&][^ \t]+[ \t]+)+)([|>](?:[1-9][+-]?|[+-][1-9]?)?)([ \t]*(?:#.*)?)$`);
const YAML_VALUE = new RegExp(String.raw`^[ \t]*(?:-[ \t]+)*${YAML_KEY}[ \t]*:[ \t]*(.*)$`);
function normalizeYamlBlock(line) {
  const header = YAML_PROPERTY_BLOCK.exec(line);
  if (header) {
    const tokens = header[3].trim().split(/[ \t]+/), types = new Set();
    if (tokens.length > 2 || tokens.some(token => {
      const type = token === '!!str' ? 'tag' : /^&[A-Za-z0-9_-]{1,64}$/.test(token) ? 'anchor' : null;
      if (!type || types.has(type)) return true; types.add(type); return false;
    })) throw blockedError('unsupported YAML block scalar properties');
    return header[1] + 'X'.repeat(header[3].length) + header[4] + header[5];
  }
  const value = YAML_VALUE.exec(line)?.[1];
  if (value && (/^[|>]/.test(value) || (/^[!&]/.test(value) && /[|>]/.test(value))) && !YAML_BLOCK.test(line)) {
    throw blockedError('a YAML block scalar could not be read safely');
  }
  return line;
}
const YAML_EMPTY = new RegExp(String.raw`^([ \t]*)(?:-[ \t]+)*${YAML_KEY}[ \t]*:[ \t]*(?:#.*)?$`);
const YAML_NODE = new RegExp(String.raw`^[ \t]*(?:-(?:[ \t]|$)|#|${YAML_KEY}[ \t]*:(?:[ \t]|$))`);
const indentOf = (line) => line.length - line.trimStart().length;

// The last """ or ''' on the line, when it opens a string: after = or :, with no closer after it.
function tripleOpen(line) {
  for (const q of ['"""', "'''"]) {
    const k = line.lastIndexOf(q);
    if (k !== -1 && /[:=][ \t]{0,8}$/.test(line.slice(Math.max(0, k - 9), k))) return { q, at: k };
  }
  return null;
}

function detectionView(text, format) {
  let v = text.replace(/'\\''/g, 'XXXX');
  // CR is only a line ending; as a space it no longer cuts a joined value short.
  v = v.replace(/\r/g, ' ');
  const lines = v.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const property = YAML_PROPERTY_BLOCK.exec(lines[i]);
    const line = normalizeYamlBlock(lines[i]); lines[i] = line;
    const block = property ? [null, property[2]] : YAML_BLOCK.exec(line);
    const empty = format === 'yaml' && !block ? YAML_EMPTY.exec(line) : null;
    // A quote left open: that quote must also be odd in count on the line, or
    // `…Y=" https…'` (base64 padding, then a closing quote) would swallow the
    // lines after it.
    const quoteOpen = /[:=][ \t]*(["'])(?:(?!\1)[^\\]|\\.)*$/.exec(line.trimEnd());
    const open = quoteOpen && (line.replace(/\\./g, '').split(quoteOpen[1]).length - 1) % 2 === 1 ? quoteOpen : null;
    const triple = tripleOpen(line);
    if (triple) {
      let j = i + 1;
      while (j < lines.length && j - i <= 50 && !lines[j].includes(triple.q)) j++;
      if (j < lines.length && j - i <= 50) {
        // """ → "␠␠ at both ends, so the joined value reads as one quoted string.
        const joined = lines.slice(i, j + 1).join(' ');
        const q = triple.q[0];
        const close3 = joined.length - lines[j].length + lines[j].indexOf(triple.q);
        out.push(`${joined.slice(0, triple.at)}${q}  ${joined.slice(triple.at + 3, close3)}  ${q}${joined.slice(close3 + 3)}`);
        i = j;
      } else out.push(line);
    } else if (block || empty) {
      // Join the lines indented under it (up to 50) into this one; a plain
      // value on the next line only when those lines are not keys or items.
      const base = (block || empty)[1].length;
      let j = i + 1;
      while (j < lines.length && j - i <= 50 && (lines[j].trim() === '' || (indentOf(lines[j]) > base && (block || !YAML_NODE.test(lines[j]))))) j++;
      if (block && j === i + 1) throw blockedError('a block scalar has no readable body');
      if (j - i > 50 && j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > base)) throw blockedError('a multiline scalar exceeds the safe review limit');
      while (j > i + 1 && lines[j - 1].trim() === '') j--;
      out.push(lines.slice(i, j).join(' '));
      i = j - 1;
    } else if (open) {
      let j = i + 1;
      while (j < lines.length && j - i <= 20 && !lines[j].includes(open[1])) j++;
      if (j < lines.length && j - i <= 20) { out.push(lines.slice(i, j + 1).join(' ')); i = j; } else out.push(line);
    } else out.push(line);
  }
  const view = out.join('\n');
  // Offsets into the view are offsets into the text; anything else fails closed.
  if (view.length !== text.length) throw new Error('detection view changed length');
  return view;
}

// Where a command substitution that fetches a secret ends, or -1.
function fetchEnd(rest) {
  if (!SECRET_FETCH.test(rest)) return -1;
  if (rest[0] === '`') { const e = rest.indexOf('`', 1); return e === -1 ? -1 : e + 1; }
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '(') depth++;
    else if (rest[i] === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

function keptOnPurpose(text, hit, pathTilde, format) {
  const value = text.slice(hit.index, hit.index + hit.length);
  if (hit.kind === 'hex_secret') {
    if (LOCKFILE.test(pathTilde)) return true;
    const before = text.slice(Math.max(0, hit.index - 80), hit.index);
    const onLine = before.slice(before.lastIndexOf('\n') + 1);
    return PIN_KEY.test(onLine) || /\b(?:commit|rev|sha)\s+$/i.test(onLine);
  }
  const bare = value.replace(/^["'`]|["'`]$/g, '');
  // In shell, '…' is literal: '$FOO' is those four characters, not a lookup.
  const literal = format === 'shell' && text[hit.index - 1] === "'";
  if (!literal && isReference(bare, keyBefore(text, hit.index))) return true;
  // A path is where a secret lives, not the secret (signingkey = ~/.ssh/id_ed25519.pub).
  if (/^(?:~|\$HOME|\$\{HOME\})?\/[\w@%+=:,./ -]*$/.test(bare) && !findSecrets(bare, { classes: ['credential'], docExamples: false }).length && !looksRandom(bare)) return true;
  if (hit.kind === 'env_secret' || hit.kind === 'keyed' || hit.kind === 'keyed_set' || hit.kind === 'cli_secret_flag') {
    // Kept only when the whole hit sits inside the fetch: `$(security …) ||
    // export X=literal` must not keep the literal. env_secret's value stops
    // at a space, so the fetch is read from the line (bounded).
    const cap = text.slice(hit.index, hit.index + 4096);
    const nl = cap.indexOf('\n');
    const line = nl === -1 ? cap : cap.slice(0, nl);
    const skip = /^["']/.test(line) ? 1 : 0;
    const rest = line.slice(skip);
    const end = fetchEnd(rest);
    if (end !== -1 && hit.length <= skip + end + 1 && !findSecrets(rest.slice(0, end), { classes: ['credential'], docExamples: false }).length) return true;
  }
  return false;
}

// In JSON a raw " always ends the string a value sits in, so a span never
// runs past one: over-redaction stays inside the string and the file parses.
function clipToJsonString(text, h) {
  if (text[h.index] === '"') return h;
  for (let i = h.index; i < h.index + h.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') return { ...h, length: i - h.index };
  }
  return h;
}

// Secret spans in `original`, in its own offsets. `recheck`: the scrubber's
// output, whose own placeholders are not secrets.
function detectionSpans(original, pathTilde, format, recheck = false) {
  const { joined, map } = joinedText(original);
  const text = detectionView(joined, format);
  const json = format === 'json' || format === 'jsonc';
  const spans = [];
  const found = findSecrets(text, { standIns: recheck, docExamples: false });
  for (const hit of found) {
    const h = json ? clipToJsonString(text, hit) : hit;
    if (h.length <= 0) continue;
    // A keyed value that is only `|`: a block scalar whose lines were not joined.
    if (!recheck && (h.kind === 'keyed' || h.kind === 'keyed_exact') && BLOCK_INDICATOR.test(text.slice(h.index, h.index + h.length).trim())) {
      throw Object.assign(new Error('a secret block scalar could not be read'), { blocked: true });
    }
    if (keptOnPurpose(text, h, pathTilde, format)) continue;
    spans.push({ index: h.index, length: h.length, kind: h.kind });
  }
  // Starts of the pattern hits, sorted: does any start inside [a, b)?
  const starts = found.map((h) => h.index);
  const startsWithin = (a, b) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < a) lo = mid + 1; else hi = mid; }
    return lo < starts.length && starts[lo] < b;
  };
  ENTROPY_TOKEN.lastIndex = 0;
  let m;
  while ((m = ENTROPY_TOKEN.exec(text))) {
    // Judge each piece of a path or dotted name on its own; a whole path is
    // not random, but a token inside one can be.
    let off = 0;
    let piece = false;
    for (const p of m[0].split(/([/.])/)) {
      if (p.length >= 20 && looksRandom(p)) { spans.push({ index: m.index + off, length: p.length, kind: 'high_entropy' }); piece = true; }
      off += p.length;
    }
    if (!piece && looksRandom(m[0]) && !startsWithin(m.index, m.index + m[0].length)) {
      spans.push({ index: m.index, length: m[0].length, kind: 'high_entropy' });
    }
  }
  if (!map) return spans;
  return spans.map((s) => {
    const start = map[s.index];
    const end = map[s.index + s.length - 1] + 1;
    return { ...s, index: start, length: end - start };
  });
}

function merge(spans) {
  spans.sort((a, b) => a.index - b.index || b.length - a.length);
  const out = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.index < last.index + last.length) {
      last.length = Math.max(last.index + last.length, s.index + s.length) - last.index;
    } else out.push({ ...s });
  }
  return out;
}

// ── layer 5: machine values ──────────────────────────────────────────────────

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
// After a letter it is a version (v10.0.0.1); after _ or - it is still an address.
const IPV4 = new RegExp(`(?<![A-Za-z0-9.])${OCTET}(?:\\.${OCTET}){3}(?![\\w.]*\\d)`, 'g');
const PRIVATE_V4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/;
const IPV6_PRIVATE = /(?<![\w:.])(?:f[cd][0-9a-f]{2}|fe80):[0-9a-f:]{2,40}(?![\w:])/gi;
// A real email's domain ends in an alphabetic TLD; user@10.0.4.12 and
// user@nas.internal are logins, left for the IP, host and user passes.
const EMAIL = /(?<![\w.+-])[\w.+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,63}(?![\w.-])/g;
const INTERNAL_TLD = /\.(?:local|lan|internal|intranet|corp|home\.arpa|localdomain|ts\.net)$/i;
const INTERNAL_HOST = /(?<![\w.-])[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.(?:local|lan|internal|intranet|corp|home\.arpa|localdomain|ts\.net)(?![\w.-])/gi;
// Hostnames that identify no one.
const GENERIC_HOST = /^(?:localhost|localhost\.localdomain|ip6-localhost)$/i;
// A secret's name must not carry a host, an address or an IP of its own.
const NAME_LEAKS = /@|\d{1,3}(?:\.\d{1,3}){3}|\.(?:local|lan|internal|intranet|corp|arpa|localdomain|ts\.net)(?![\w-])|\.(?:com|net|org|io|co|za|uk|dev|app|ai|cloud|sh|me|us|de|eu|gov|edu)$/i;

// Both Unicode forms of a value: a file may hold josé in NFC while the
// machine reports NFD, or the other way round.
function forms(v) {
  return [...new Set([v.normalize('NFC'), v.normalize('NFD')])];
}

// Machine values are strings; anything else is ignored rather than trusted.
function machineOf(m) {
  const o = m && typeof m === 'object' ? m : {};
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
  return { home: str(o.home), user: str(o.user), hostname: str(o.hostname), emails: list(o.emails), names: list(o.names) };
}

function templater(machine) {
  const numbered = new Map();
  const counters = {};
  const number = (kind, value) => {
    const key = `${kind}\0${value.toLowerCase()}`;
    if (!numbered.has(key)) { counters[kind] = (counters[kind] || 0) + 1; numbered.set(key, `{{${kind}:${counters[kind]}}}`); }
    return numbered.get(key);
  };
  const ownEmails = new Set(machine.emails.flatMap(forms).map((e) => e.toLowerCase()));
  const home = machine.home ? machine.home.replace(/\\/g, '/').replace(/\/+$/, '') : null;
  // /Users/x, C:\Users\x and JSON's C:\\Users\\x are all this home.
  const homeRe = home ? new RegExp(`(?:${forms(home).map((h) => h.split('/').map(escapeRe).join('(?:/|\\\\{1,2})')).join('|')})(?:(?![\\w.-])|(?=\\.(?:\\s|$)))`, 'gi') : null;
  const hostShort = machine.hostname && !GENERIC_HOST.test(machine.hostname) ? machine.hostname.split('.')[0] : null;
  const hostRe = hostShort && hostShort.length >= 3 ? new RegExp(`(?<![\\w-])(?:${forms(hostShort).map(escapeRe).join('|')})(?:\\.[\\w-]+)*(?![\\w-])`, 'gi') : null;
  const user = machine.user && machine.user.length >= 3 ? machine.user : null;
  const userRe = user ? new RegExp(`(?<![A-Za-z0-9])(?:${forms(user).map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'gi') : null;
  const nameRes = machine.names.filter((n) => n.length >= 3).sort((a, b) => b.length - a.length)
    .map((n) => [n, new RegExp(`(?<![\\w])(?:${forms(n).map(escapeRe).join('|')})(?![\\w])`, 'gi')]);

  // Replace only outside placeholders already written: a user called
  // "home" must not turn {{HOME}} into {{{{USER}}}}.
  const outside = (s, re, fn) => (s.includes('{{') ? s.split(PLACEHOLDER_SPLIT).map((part, i) => (i % 2 ? part : part.replace(re, fn))).join('') : s.replace(re, fn));

  function apply(seg) {
    let s = seg;
    if (homeRe) s = outside(s, homeRe, () => '{{HOME}}');
    s = outside(s, EMAIL, (e) => (/^git@/i.test(e) || INTERNAL_TLD.test(e) ? e : ownEmails.has(e.toLowerCase()) ? '{{EMAIL}}' : number('EMAIL', e)));
    s = outside(s, IPV4, (ip) => (PRIVATE_V4.test(ip) ? number('IP', ip) : ip));
    s = outside(s, IPV6_PRIVATE, (ip) => number('IP', ip));
    if (hostRe) s = outside(s, hostRe, () => '{{HOSTNAME}}');
    s = outside(s, INTERNAL_HOST, (h) => number('HOST', h));
    for (const [n, re] of nameRes) s = outside(s, re, () => number('PRIVATE', n));
    if (userRe) s = outside(s, userRe, () => '{{USER}}');
    return s;
  }
  // Whether templating would touch `s` (without numbering anything).
  const touches = (s) => [homeRe, hostRe, userRe, ...nameRes.map((x) => x[1]), EMAIL, INTERNAL_HOST].some((re) => {
    if (!re) return false;
    re.lastIndex = 0;
    const hit = re.test(s);
    re.lastIndex = 0;
    return hit;
  });
  return { apply, number, touches };
}

// What must never survive, lower-cased and NFC: this machine's home (every
// separator form), hostname, emails and their local parts, names and user.
function machineNeedles(machine) {
  const needles = [];
  const add = (v, min = 3) => { if (v && v.length >= min) needles.push(v.normalize('NFC').toLowerCase()); };
  if (machine.home) {
    const h = machine.home.replace(/\\/g, '/').replace(/\/+$/, '');
    add(h); add(h.replace(/\//g, '\\')); add(h.replace(/\//g, '\\\\'));
  }
  if (machine.hostname && !GENERIC_HOST.test(machine.hostname)) { add(machine.hostname); add(machine.hostname.split('.')[0]); }
  for (const e of machine.emails) { add(e); add(e.split('@')[0], 6); }
  for (const n of machine.names) add(n);
  // A user of five or more letters is found inside longer words too
  // (github.com/callumbaker125); a shorter one only as a whole word.
  if (machine.user && machine.user.length >= 5) add(machine.user);
  return needles;
}

const percentDecoded = (s) => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });

function machineSurvives(text, machine) {
  const views = [text, percentDecoded(text)].map((v) => v.normalize('NFC').toLowerCase());
  const needles = machineNeedles(machine);
  const shortUser = machine.user && machine.user.length >= 3 && machine.user.length < 5
    ? new RegExp(`(?<![a-z0-9])${escapeRe(machine.user.normalize('NFC').toLowerCase())}(?![a-z0-9])`) : null;
  return views.some((v) => needles.some((n) => v.includes(n)) || (shortUser && shortUser.test(v)));
}

// ── the scrubber ─────────────────────────────────────────────────────────────

const blocked = (reason) => ({ status: 'blocked', reason, redactions: [], templates: [] });

function scrub({ path, content, format, machine: machineIn, sensitiveKeys } = {}) {
  const why = blockedReason(path, { sshConfig: /(?:^|\/)\.ssh\/config$/.test(String(path)) });
  if (why) return blocked(why);
  if (typeof content !== 'string') return blocked('not text');
  if (Buffer.byteLength(content) > MAX_BYTES) return blocked('larger than 1 MB');
  if (content.includes('\0')) return blocked('binary file');
  const plain = content.replace(CF, '');
  if (RESERVED.test(plain) || STAND_IN_LIKE.test(plain)) return blocked("already contains Buddy's placeholder syntax");
  const machine = machineOf(machineIn);
  const fmt = format || formatOf(path);
  const extraTables = Array.isArray(sensitiveKeys) ? sensitiveKeys.filter((k) => typeof k === 'string' && k) : [];

  let found;
  try {
    found = detectionSpans(content, path, fmt);
  } catch (e) {
    if (e && e.blocked) return blocked(e.message);
    throw e;
  }
  const toml = fmt === 'toml' ? tomlStructure(content, extraTables) : null;
  const values = structuredSpans(content, fmt, extraTables, toml);
  if (keyContainsSecret(toml ? toml.keys : structuredKeys(content, fmt), [...values, ...found], content)) return blocked('a structured key or property contains redacted secret material');
  const spans = merge([...values, ...found]);

  // Secret spans become fixed placeholders; everything between them is
  // templated. A secret name used twice for different values gets a suffix.
  const { apply, number, touches } = templater(machine);
  const machineWords = [machine.user, machine.hostname && machine.hostname.split('.')[0], ...machine.emails.map((e) => e.split('@')[0]), ...machine.names]
    .filter((w) => w && w.length >= 3).map((w) => w.toLowerCase());
  const shapeCache = new Map();
  const secretShaped = (base) => {
    if (!shapeCache.has(base)) shapeCache.set(base, looksRandom(base) || findSecrets(base, { docExamples: false }).length > 0 || /\d{4,}|[A-Za-z0-9+/]{24,}/.test(base));
    return shapeCache.get(base);
  };
  // Defense in depth for names: one that is part of any redacted value
  // falls back to the kind. The search is budgeted, so it stays linear;
  // past the budget every name is the kind.
  let joinedValues = null;
  let budget = 32 * 1024 * 1024;
  const insideAValue = (name) => {
    if (joinedValues === null) joinedValues = spans.map((s) => content.slice(s.index, s.index + s.length)).join('\0');
    budget -= joinedValues.length;
    return budget < 0 || joinedValues.includes(name);
  };
  const byValue = new Map();
  const nextSuffix = new Map();
  const used = new Set();
  const nameFor = (s, floor) => {
    if (s.kind === 'identity') return '{{NAME}}';
    if (s.kind === 'ssh_user') return '{{SSH_USER}}';
    if (s.kind === 'ssh_host') return number('HOST', content.slice(s.index, s.index + s.length));
    const raw = s.name ?? keyBefore(content, s.index, floor) ?? s.kind;
    let base = safeName(raw);
    // A name must carry neither a machine value, a host, an address or an
    // IP, nor anything secret-shaped (base64 padding once made a secret read
    // as `key=`), nor text from a redacted value.
    if (base !== safeName(s.kind) && (machineWords.some((w) => base.toLowerCase().includes(w)) || NAME_LEAKS.test(raw) || touches(raw) || secretShaped(base) || insideAValue(raw))) base = safeName(s.kind);
    const value = content.slice(s.index, s.index + s.length);
    const key = `${base}\0${value}`;
    if (byValue.has(key)) return byValue.get(key);
    let n = nextSuffix.get(base) || 1;
    let name = n === 1 ? base : `${base}_${n}`;
    while (used.has(name)) { n++; name = `${base}_${n}`; }
    nextSuffix.set(base, n + 1);
    used.add(name);
    const ph = `{{SECRET:${name}}}`;
    byValue.set(key, ph);
    return ph;
  };
  const redacted = [];
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += apply(content.slice(at, s.index));
    const ph = nameFor(s, at);
    redacted.push({ offset: out.length, kind: s.kind, name: ph.slice(2, -2).replace(/^SECRET:/, ''), placeholder: ph });
    out += ph;
    at = s.index + s.length;
  }
  out += apply(content.slice(at));

  // Fail closed: nothing secret-shaped and no machine value may remain.
  // A hit that touches a placeholder counts only if what is left of it
  // without the placeholders is itself secret-shaped.
  const starts = lineStarts(out);
  const left = merge(detectionSpans(out, path, fmt, true)).filter((h) => {
    const t = out.slice(h.index, h.index + h.length);
    const rest = t.replace(PLACEHOLDER, ' ');
    if (rest === t) return true;
    return findSecrets(rest, { classes: ['credential'], docExamples: false }).length > 0 || rest.split(/[^\w+/=.-]+/).some(looksRandom);
  });
  if (left.length) return blocked(`a ${left[0].kind} value survived scrubbing (line ${lineOf(starts, left[0].index)})`);
  if (machineSurvives(out.replace(PLACEHOLDER, ' '), machine)) return blocked('a value from this machine survived scrubbing');

  const redactedAt = new Set(redacted.map((r) => r.offset));
  return {
    status: 'ok',
    content: out,
    redactions: redacted.map((r) => ({ line: lineOf(starts, r.offset), kind: r.kind, name: r.name, placeholder: r.placeholder })),
    templates: [...out.matchAll(PLACEHOLDER)].filter((m) => !redactedAt.has(m.index)).map((m) => ({ line: lineOf(starts, m.index), placeholder: m[0] })),
  };
}

/** One file in, what may be shared out. Never throws: an error blocks the file. */
function scrubFile(args) {
  try {
    return scrub(args);
  } catch (e) {
    return blocked(e && e.blocked ? e.message : 'scrubber error');
  }
}

module.exports = { scrubFile, formatOf, looksRandom, shannon, detectionView };
