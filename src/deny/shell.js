// A small, linear-time shell tokeniser for judging commands — not an
// interpreter. It splits a command line into simple commands, joins quoted
// pieces into words the way the shell does (r''m → rm), notes redirections
// and pipes, strips wrappers (env, nohup, sudo, xargs, time, `(`…), and
// reports anything whose meaning depends on expansion (hazards). The rules
// that use it err towards "desk" whenever it's unsure: a wrapper option it
// doesn't know, or nesting deeper than it looks, yields an `unparsed` command.

const SEP2 = new Set(['&&', '||', ';;', '|&']);
const MAX_DEPTH = 3;

// Bits on a word token's `x`: characters the shell expands, seen unquoted.
export const GLOB = 1;
export const TILDE = 2;
export const BRACE = 4;

// Zero-width, bidi and other format characters (Cf). Inside quoted data only
// the emoji joiners pass; bidi controls never do, as they make the command
// on screen differ from the one that runs.
const FORMAT = /\p{Cf}/gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/;
const JOINER = /^[\u200C\u200D\u{E0020}-\u{E007F}]$/u;

// Adds 'bidi' / 'invisible' hazards for format characters in `text`, given the
// [start, end) ranges that hold quoted data.
function formatHazards(text, data, hazards) {
  if (!/\p{Cf}/u.test(text)) return;
  data.sort((a, b) => a[0] - b[0]);
  let r = 0;
  for (const m of text.matchAll(FORMAT)) {
    if (BIDI.test(m[0])) { hazards.add('bidi'); continue; }
    while (r < data.length && data[r][1] <= m.index) r++;
    const inData = r < data.length && data[r][0] <= m.index;
    if (!(inData && JOINER.test(m[0]))) hazards.add('invisible');
  }
}

const atWordStart = (s, j) => j === 0 || /[\s;&|()]/.test(s[j - 1]);

// The delimiter of a here-doc whose `<<` ends just before `k`.
function heredocDelim(s, k) {
  const strip = s[k] === '-';
  if (strip) k++;
  while (s[k] === ' ' || s[k] === '\t') k++;
  let delim = '', quoted = false;
  for (; k < s.length && !/[\s;&|<>()]/.test(s[k]); k++) {
    if (s[k] === "'" || s[k] === '"' || s[k] === '\\') quoted = true;
    else delim += s[k];
  }
  return { delim, quoted, strip, end: k };
}

// Reads here-doc bodies starting at `j` (just after a newline) into each
// doc's `body`; → index after the last delimiter line.
function skipHeredocs(s, j, docs) {
  for (const h of docs) {
    let body = '';
    h.start = j;
    for (;;) {
      if (j >= s.length) { h.unterminated = true; break; }
      let e = s.indexOf('\n', j);
      if (e < 0) e = s.length;
      const line = s.slice(j, e);
      j = e + 1;
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
      body += line + '\n';
    }
    h.body = body;
  }
  return j;
}

// Index of the character closing a $(…) (close ')') or `…` body that starts
// at `start`, or -1 if it never closes. Inside $(…), quotes, here-docs,
// comments and `case` patterns start their own contexts, so a ')' in them
// doesn't close it. When unsure the body runs on: over-including is safe,
// closing early would hide the rest of the command inside a string.
function subEnd(s, start, close) {
  const stack = [close];
  let docs = [];
  let cases = 0;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    const top = stack[stack.length - 1];
    if (c === '\\') { j++; continue; }
    if (top === '`') {
      if (c === '`') stack.pop();
    } else if (top === '"') {
      if (c === '"') stack.pop();
      else if (c === '`') stack.push('`');
      else if (c === '$' && s[j + 1] === '(') { stack.push(')'); j++; }
    } else if (c === "'") {
      const k = s.indexOf("'", j + 1);
      if (k < 0) return -1;
      j = k;
    } else if (c === '"' || c === '`') stack.push(c);
    else if (c === '$' && s[j + 1] === '(') { stack.push(')'); j++; }
    else if (c === '(') stack.push('(');
    else if (c === ')') {
      if (cases > 0 && top === ')') continue;
      stack.pop();
    } else if (c === '#' && atWordStart(s, j)) {
      const k = s.indexOf('\n', j);
      if (k < 0) return -1;
      j = k - 1;
    } else if (c === '<' && s[j + 1] === '<' && s[j + 2] !== '<') {
      const h = heredocDelim(s, j + 2);
      docs.push(h);
      j = h.end - 1;
    } else if (c === '\n' && docs.length) {
      j = skipHeredocs(s, j + 1, docs) - 1;
      if (docs.some((h) => h.unterminated)) return -1;
      docs = [];
    } else if (atWordStart(s, j) && /^(case|esac)(?=[\s;&|()]|$)/.test(s.slice(j, j + 5))) {
      cases += c === 'c' ? 1 : -1;
      j += 3;
    }
    if (!stack.length) return j;
  }
  return -1;
}

// → { tokens: [{t:'word',v,x?}|{t:'op',v,heredoc?,herestring?}], hazards: Set<string>, subs: string[] }
export function tokenize(text) {
  const tokens = [];
  const hazards = new Set();
  const subs = []; // bodies of $(…), `…`, ((…)), comments and unquoted here-docs, for recursive checks
  let word = null; // null = no word in progress ('' is a real empty word)
  let wx = 0; // GLOB | TILDE | BRACE seen unquoted in the current word
  let wq = false; // the current word had quoting (a quoted here-doc delimiter means a literal body)
  let awaitDelim = null;
  let docs = [];
  const data = []; // [start, end) ranges of quoted data, for formatHazards
  const push = () => {
    if (word !== null) {
      tokens.push(wx ? { t: 'word', v: word, x: wx } : { t: 'word', v: word });
      if (awaitDelim) { awaitDelim.delim = word; awaitDelim.quoted = wq; docs.push(awaitDelim); awaitDelim = null; }
    }
    word = null; wx = 0; wq = false;
  };
  const op = (v, extra) => { push(); tokens.push(extra ? { t: 'op', v, ...extra } : { t: 'op', v }); };
  const n = text.length;
  let i = 0;
  // Records the $(…) / `…` body of `src` starting at `start`; → index of its closer.
  const readSub = (src, start, close) => {
    const e = subEnd(src, start, close);
    const end = e < 0 ? src.length : e;
    if (e < 0) hazards.add('unterminated-quote');
    const body = src.slice(start, end);
    // Inside backticks \` \\ \$ lose their backslash before the body runs.
    subs.push(close === '`' ? body.replace(/\\([\\`$])/g, '$1') : body);
    hazards.add('substitution');
    return end;
  };
  // An unquoted here-doc body still runs $(…) and `…`.
  const scanBody = (s, base) => {
    let seg = 0;
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') j++;
      else if (c === '$') {
        hazards.add('expansion');
        if (s[j + 1] === '(') { data.push([base + seg, base + j]); j = readSub(s, j + 2, ')'); seg = j + 1; }
      } else if (c === '`') { data.push([base + seg, base + j]); j = readSub(s, j + 1, '`'); seg = j + 1; }
    }
    data.push([base + seg, base + s.length]);
  };
  const bodies = (list) => {
    for (const h of list) {
      if (h.quoted) data.push([h.start, h.start + h.body.length]);
      else scanBody(h.body, h.start);
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      word = (word ?? '') + text.slice(i + 1, end);
      data.push([i + 1, end]);
      wq = true;
      if (j < 0) hazards.add('unterminated-quote');
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1, v = '', seg = j;
      for (; j < n && text[j] !== '"'; j++) {
        const d = text[j];
        if (d === '\\' && j + 1 < n) { v += text[++j]; hazards.add('escape'); }
        else if (d === '$') {
          hazards.add('expansion');
          if (text[j + 1] === '(') { data.push([seg, j]); j = readSub(text, j + 2, ')'); seg = j + 1; v += '$SUB'; } else v += d;
        } else if (d === '`') { data.push([seg, j]); j = readSub(text, j + 1, '`'); seg = j + 1; v += '$SUB'; }
        else v += d;
      }
      data.push([seg, Math.min(j, n)]);
      if (j >= n) hazards.add('unterminated-quote');
      word = (word ?? '') + v;
      wq = true;
      i = j + 1;
    } else if (c === '\\') {
      hazards.add('escape');
      wq = true;
      if (text[i + 1] === '\n') { i += 2; continue; }
      word = (word ?? '') + (text[i + 1] ?? '');
      i += 2;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      push(); i++;
    } else if (c === '\n' || c === ';') {
      op(';'); i++;
      if (c === '\n' && docs.length) {
        i = skipHeredocs(text, i, docs);
        bodies(docs);
        docs = [];
      }
    } else if (c === '#' && word === null) {
      // A comment hides nothing from the checks: its text is judged as well
      // (without its own '#'s, so comments can't fake nesting depth).
      const e = text.indexOf('\n', i);
      subs.push(text.slice(i + 1, e < 0 ? n : e).replace(/#/g, ' '));
      i = e < 0 ? n : e;
    } else if (c === '&' || c === '|') {
      const two = text.slice(i, i + 2);
      if (SEP2.has(two)) { op(two === '|&' ? '|' : two); i += 2; }
      else if (c === '&' && text[i + 1] === '>') { const two2 = text[i + 2] === '>'; op('>', { raw: two2 ? '&>>' : '&>' }); hazards.add('redirect'); i += two2 ? 3 : 2; }
      else { op(c); if (c === '&') hazards.add('background'); i++; }
    } else if (c === '>' || c === '<') {
      // "2>" / "1>>": a leading fd number belongs to the operator.
      if (word !== null && /^\d+$/.test(word)) word = null;
      let j = i + 1;
      while (j < n && (text[j] === '>' || text[j] === '<' || text[j] === '&' || text[j] === '|')) j++;
      const v = text.slice(i, j);
      if (v.startsWith('<(') || text[j] === '(') hazards.add('process-substitution');
      hazards.add('redirect');
      if (v === '<<') {
        const h = { delim: '', quoted: false, strip: text[j] === '-', body: '' };
        if (h.strip) j++;
        op('<', { heredoc: h });
        awaitDelim = h;
      } else if (v === '<<<') op('<', { herestring: true });
      else op(v.startsWith('<') ? '<' : '>', { raw: v });
      i = j;
    } else if (c === '(' && text[i + 1] === '(' && word === null) {
      // ((…)) arithmetic: a `<<` inside is a shift, not a here-doc.
      const e = subEnd(text, i + 2, ')');
      subs.push(text.slice(i + 2, e < 0 ? n : e));
      hazards.add('subshell');
      op(';');
      i = e < 0 ? n : e + (text[e + 1] === ')' ? 2 : 1);
    } else if (c === '(' || c === ')') {
      op(';'); hazards.add('subshell'); i++;
    } else if (c === '$') {
      hazards.add('expansion');
      if (text[i + 1] === '(') { i = readSub(text, i + 2, ')') + 1; word = (word ?? '') + '$SUB'; }
      else if (text[i + 1] === "'") {
        // $'…' (ANSI-C quoting), where \' does not end the string.
        let j = i + 2;
        for (; j < n && text[j] !== "'"; j++) if (text[j] === '\\') j++;
        if (j >= n) hazards.add('unterminated-quote');
        word = (word ?? '') + '$' + text.slice(i + 2, Math.min(j, n));
        data.push([i + 2, Math.min(j, n)]);
        hazards.add('escape');
        i = j + 1;
      } else { word = (word ?? '') + c; i++; }
    } else if (c === '`') {
      i = readSub(text, i + 1, '`') + 1; word = (word ?? '') + '$SUB';
    } else if ((c === '{' || c === '}') && word === null && (i + 1 >= n || /\s/.test(text[i + 1]))) {
      hazards.add('group'); op(';'); i++;
    } else {
      if (c === '*' || c === '?' || c === '[' || c === '~') hazards.add('glob');
      if (c === '*' || c === '?' || c === '[') wx |= GLOB;
      else if (c === '~' && word === null) wx |= TILDE;
      else if (c === '{') wx |= BRACE;
      word = (word ?? '') + c; i++;
    }
  }
  push();
  formatHazards(text, data, hazards);
  return { tokens, hazards, subs };
}

// Commands that run the rest of their words as another command, with the
// options each takes: `arg` short options with a value (attached or the next
// word), `flag` short options without, `opt` short options whose value can
// only be attached, and the long ones likewise; `operands` words between the
// options and the command (timeout's duration, flock's lock file); `cmd` the
// short/long option whose value is itself a command line; `joined` runs the
// rest through `sh -c`. An option not listed leaves the command unparsed
// (desk-only): guessing its arity wrongly would hide the real command.
const spec = (arg, flag, longArg = '', longFlag = '', extra = {}) => ({
  arg, flag, opt: '', operands: 0, ...extra,
  longArg: new Set(longArg.split(' ').filter(Boolean)), longFlag: new Set(longFlag.split(' ').filter(Boolean)),
});
const WRAPPERS = {
  nohup: spec('', ''),
  time: spec('fo', 'pvqla', 'format output', 'portability verbose quiet append'),
  command: spec('', 'pvV'),
  builtin: spec('', ''),
  exec: spec('a', 'cl'),
  unbuffer: spec('', 'p'),
  chronic: spec('', 'ev'),
  caffeinate: spec('tw', 'dimsu'),
  setsid: spec('', 'cfw', '', 'ctty fork wait'),
  nice: spec('n', '', 'adjustment', '', { numeric: true }),
  sudo: spec('ugCDhprtTU', 'AbBEeHiKklNnPSsVv', 'user group close-from chdir host prompt role type command-timeout other-user',
    'askpass background bell preserve-env edit set-home login remove-timestamp reset-timestamp list non-interactive no-update preserve-groups stdin shell validate'),
  doas: spec('uC', 'nsL'),
  env: spec('uCP', 'iv0', 'unset chdir', 'ignore-environment null debug', { dash: true, cmd: ['S', 'split-string'] }),
  xargs: spec('adEILnPsJRS', '0oprtx', 'arg-file delimiter max-args max-procs max-chars process-slot-var',
    'null open-tty interactive no-run-if-empty verbose exit show-limits eof replace max-lines', { opt: 'eil' }),
  timeout: spec('sk', 'vfp', 'signal kill-after', 'foreground preserve-status verbose', { operands: 1 }),
  stdbuf: spec('ioe', '', 'input output error'),
  watch: spec('nq', 'bcdegtxprwC', 'interval', 'beep color no-color differences errexit chgexit exec precise no-title no-wrap no-rerun', { joined: true }),
  flock: spec('wE', 'sexunoF', 'timeout conflict-exit-code', 'shared exclusive unlock nonblock nb close no-fork verbose', { operands: 1, cmd: ['c', 'command'] }),
  chroot: spec('ugG', '', 'userspec groups', 'skip-chdir', { operands: 1 }),
  script: spec('tTEIOBmF', 'aefqkdpr', 'timing log-io log-in log-out log-timing logging-format echo output-limit', 'append return flush force quiet', { operands: 1, cmd: ['c', 'command'] }),
};
// Shell words that come before a command without changing what runs.
const KEYWORDS = new Set(['!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'coproc', 'noglob', 'nocorrect']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

export const basename = (w) => w.slice(w.lastIndexOf('/') + 1);

// Simple commands of a token list:
// [{ cmd, args, words, piped, redirects, elevated, wrapped, env, inner, expanded, unparsed }]
export function commands(tokens) {
  const out = [];
  let cur = { words: [], redirects: [], piped: false, expanded: [] };
  let pipedNext = false;
  let pending = null;
  const flush = () => {
    if (cur.words.length || cur.redirects.length) out.push(finish(cur));
    cur = { words: [], redirects: [], piped: pipedNext, expanded: [] };
    pipedNext = false;
  };
  for (const tok of tokens) {
    if (tok.t === 'op') {
      if (pending) { cur.redirects.push({ ...pending, target: '' }); pending = null; }
      if (tok.v === '>' || tok.v === '<') {
        pending = { op: tok.v, raw: tok.raw ?? tok.v };
        if (tok.heredoc) pending.heredoc = tok.heredoc;
        if (tok.herestring) pending.herestring = true;
        continue;
      }
      pipedNext = tok.v === '|';
      flush();
      continue;
    }
    if (pending) { cur.redirects.push({ ...pending, target: tok.v }); pending = null; continue; }
    cur.words.push(tok.v);
    if (tok.x) cur.expanded.push({ word: tok.v, x: tok.x });
  }
  if (pending) cur.redirects.push({ ...pending, target: '' });
  flush();
  return out;
}

// Walks a wrapper's options from words[i]; → index of the first word after them.
function skipOptions(words, i, s, out) {
  const [cmdShort, cmdLong] = s.cmd ?? [];
  while (i < words.length) {
    const o = words[i];
    if (o === '--') return i + 1;
    if (o === '-') { if (s.dash) { i++; continue; } return i; }
    if (!o.startsWith('-')) return i;
    if (s.numeric && /^-\d+$/.test(o)) { i++; continue; }
    if (o.startsWith('--')) {
      const eq = o.indexOf('=');
      const name = o.slice(2, eq < 0 ? undefined : eq);
      if (s.longArg.has(name) || name === cmdLong) {
        if (name === cmdLong) out.inner.push((eq < 0 ? words[i + 1] : o.slice(eq + 1)) ?? '');
        i += eq < 0 ? 2 : 1;
      } else if (s.longFlag.has(name)) i++;
      else { out.unparsed = `unknown option ${o}`; return i + 1; }
      continue;
    }
    for (let j = 1; j < o.length; j++) {
      const ch = o[j];
      if (s.arg.includes(ch) || ch === cmdShort) {
        const attached = o.slice(j + 1);
        if (ch === cmdShort) out.inner.push(attached || (words[i + 1] ?? ''));
        if (!attached) i++;
        break;
      }
      if (s.opt.includes(ch)) break;
      if (!s.flag.includes(ch)) { out.unparsed = `unknown option ${o}`; return i + 1; }
    }
    i++;
  }
  return i;
}

function finish({ words, redirects, piped, expanded }) {
  let i = 0;
  let elevated = false;
  let wrapped = false;
  const out = { inner: [], unparsed: null };
  const env = [];
  for (;;) {
    for (; i < words.length && ASSIGN.test(words[i]); i++) {
      const k = words[i].indexOf('=');
      env.push({ name: words[i].slice(0, k), value: words[i].slice(k + 1) });
      wrapped = true;
    }
    if (KEYWORDS.has(words[i])) { i++; wrapped = true; continue; }
    const w = basename(words[i] ?? '');
    if (!Object.hasOwn(WRAPPERS, w)) break;
    const s = WRAPPERS[w];
    wrapped = true;
    if (w === 'sudo' || w === 'doas') elevated = true;
    const before = out.inner.length;
    i = skipOptions(words, i + 1, s, out);
    if (out.unparsed) break;
    i = Math.min(i + s.operands, words.length);
    if (s.cmd && (words[i] === `-${s.cmd[0]}` || words[i] === `--${s.cmd[1]}`)) { out.inner.push(words[i + 1] ?? ''); i += 2; }
    if (out.inner.length > before) {
      // env -S: the split string is the command, followed by the remaining words.
      if (w === 'env') out.inner[out.inner.length - 1] = [out.inner[out.inner.length - 1], ...words.slice(i)].join(' ');
      i = words.length;
    }
    if (s.joined && i < words.length) { out.inner.push(words.slice(i).join(' ')); i = words.length; }
  }
  const cmd = basename(words[i] ?? '');
  return { cmd, args: words.slice(i + 1), words, piped, redirects, elevated, wrapped, env, inner: out.inner, expanded, unparsed: out.unparsed };
}

const stub = (unparsed) => ({ cmd: '', args: [], words: [], piped: false, redirects: [], elevated: false, wrapped: false, env: [], inner: [], expanded: [], unparsed });

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox']);
export const INTERPRETERS = /^(python\d?(\.\d+)?|node|nodejs|deno|bun|perl\d*|ruby|php|lua|osascript|pwsh|powershell|Rscript|R|tclsh|expect|julia)$/;

// Command lines a simple command runs in turn: sh -c's script, eval's words,
// wrappers' command strings, trap and alias bodies, here-docs fed to a shell.
function innerCommands(c) {
  const out = [...c.inner];
  const a = c.args;
  if (SHELLS.has(c.cmd) || c.cmd === 'source' || c.cmd === '.') {
    const k = a.findIndex((x) => /^-[a-zA-Z]*c[a-zA-Z]*$|^--command$/.test(x));
    if (SHELLS.has(c.cmd) && k >= 0 && a[k + 1] !== undefined) out.push(a[k + 1]);
    for (const x of a) if (x.startsWith('--command=')) out.push(x.slice(10));
    for (const r of c.redirects) {
      if (r.heredoc) out.push(r.heredoc.body);
      else if (r.herestring) out.push(r.target);
    }
  } else if (c.cmd === 'eval') out.push(a.join(' '));
  else if (c.cmd === 'trap' && a.length > 1 && !a[0].startsWith('-')) out.push(a[0]);
  else if (c.cmd === 'alias') {
    for (const x of a) { const k = x.indexOf('='); if (k > 0) out.push(x.slice(k + 1)); }
  } else if (c.cmd === 'su' || c.cmd === 'runuser') {
    const k = a.findIndex((x) => x === '-c' || x === '--command');
    if (k >= 0) out.push(a[k + 1] ?? '');
    for (const x of a) if (x.startsWith('--command=')) out.push(x.slice(10));
  } else if (c.cmd === 'rsync') {
    for (let k = 0; k < a.length; k++) {
      if (/^-[a-zA-Z]*e$|^--rsh$/.test(a[k])) out.push(a[k + 1] ?? '');
      else if (a[k].startsWith('--rsh=')) out.push(a[k].slice(6));
    }
  }
  return out;
}

// All simple commands in `text`, including those inside `sh -c '…'`, `eval …`,
// $(…), backticks, wrappers' command strings and here-docs fed to a shell, to
// MAX_DEPTH levels; anything nested deeper becomes an `unparsed` command.
export function parseShell(text, depth = 0) {
  const { tokens, hazards, subs } = tokenize(text);
  const cmds = commands(tokens);
  const nested = [...subs];
  for (const c of cmds) nested.push(...innerCommands(c));
  if (nested.length && depth >= MAX_DEPTH) cmds.push(stub('nested too deeply to judge'));
  else {
    for (const s of nested) {
      const r = parseShell(s, depth + 1);
      cmds.push(...r.cmds);
      for (const h of r.hazards) hazards.add(h);
    }
  }
  return { cmds, hazards };
}
