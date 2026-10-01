// A small, linear-time shell tokeniser for judging commands — not an
// interpreter. It splits a command line into simple commands, joins quoted
// pieces into words the way the shell does (r''m → rm), notes redirections
// and pipes, strips wrappers (env, nohup, sudo, xargs, time, `(`…), and
// reports anything whose meaning depends on expansion (hazards). The rules
// that use it err towards "desk" whenever it's unsure.

const SEP2 = new Set(['&&', '||', ';;', '|&']);

// → { tokens: [{t:'word',v}|{t:'op',v}], hazards: Set<string>, subs: string[] }
export function tokenize(text) {
  const tokens = [];
  const hazards = new Set();
  const subs = []; // bodies of $(…) and `…`, for recursive checks
  let word = null; // null = no word in progress ('' is a real empty word)
  const push = () => { if (word !== null) tokens.push({ t: 'word', v: word }); word = null; };
  const op = (v) => { push(); tokens.push({ t: 'op', v }); };
  const n = text.length;
  let i = 0;
  // Reads a $(…) or `…` body starting after its opener; returns end index.
  const readSub = (start, close) => {
    let depth = 1, j = start;
    for (; j < n; j++) {
      const c = text[j];
      if (close === ')' && c === '(') depth++;
      else if (c === close && --depth === 0) break;
    }
    subs.push(text.slice(start, j));
    return j;
  };
  while (i < n) {
    const c = text[i];
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      word = (word ?? '') + text.slice(i + 1, end);
      if (j < 0) hazards.add('unterminated-quote');
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1, v = '';
      for (; j < n && text[j] !== '"'; j++) {
        const d = text[j];
        if (d === '\\' && j + 1 < n) { v += text[++j]; hazards.add('escape'); }
        else if (d === '$') { hazards.add('expansion'); if (text[j + 1] === '(') { j = readSub(j + 2, ')'); hazards.add('substitution'); } else v += d; }
        else if (d === '`') { j = readSub(j + 1, '`'); hazards.add('substitution'); }
        else v += d;
      }
      if (j >= n) hazards.add('unterminated-quote');
      word = (word ?? '') + v;
      i = j + 1;
    } else if (c === '\\') {
      hazards.add('escape');
      if (text[i + 1] === '\n') { i += 2; continue; }
      word = (word ?? '') + (text[i + 1] ?? '');
      i += 2;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      push(); i++;
    } else if (c === '\n' || c === ';') {
      op(';'); i++;
    } else if (c === '&' || c === '|') {
      const two = text.slice(i, i + 2);
      if (SEP2.has(two)) { op(two === '|&' ? '|' : two); i += 2; }
      else if (c === '&' && text[i + 1] === '>') { op('>'); hazards.add('redirect'); i += text[i + 2] === '>' ? 3 : 2; }
      else { op(c); if (c === '&') hazards.add('background'); i++; }
    } else if (c === '>' || c === '<') {
      // "2>" / "1>>": a leading fd number belongs to the operator.
      if (word !== null && /^\d+$/.test(word)) word = null;
      let j = i + 1;
      while (j < n && (text[j] === '>' || text[j] === '<' || text[j] === '&' || text[j] === '|')) j++;
      const v = text.slice(i, j);
      if (v.startsWith('<(') || text[j] === '(') hazards.add('process-substitution');
      op(v.startsWith('<') ? '<' : '>');
      hazards.add('redirect');
      i = j;
    } else if (c === '(' || c === ')') {
      op(';'); hazards.add('subshell'); i++;
    } else if (c === '$') {
      hazards.add('expansion');
      if (text[i + 1] === '(') { i = readSub(i + 2, ')') + 1; hazards.add('substitution'); word = (word ?? '') + '$SUB'; }
      else { word = (word ?? '') + c; i++; }
    } else if (c === '`') {
      i = readSub(i + 1, '`') + 1; hazards.add('substitution'); word = (word ?? '') + '$SUB';
    } else if ((c === '{' || c === '}') && word === null && (i + 1 >= n || /\s/.test(text[i + 1]))) {
      hazards.add('group'); op(';'); i++;
    } else {
      if (c === '*' || c === '?' || c === '[' || c === '~') hazards.add('glob');
      word = (word ?? '') + c; i++;
    }
  }
  push();
  return { tokens, hazards, subs };
}

// Commands that run the rest of their arguments as another command.
const WRAPPERS = {
  nohup: 0, time: 0, command: 0, builtin: 0, exec: 0, '!': 0, unbuffer: 0, chronic: 0, caffeinate: 0,
  nice: /^-(n)$/, sudo: /^-[ugCchpDrtUT]$/, doas: /^-[uC]$/, env: /^-[uSCP]$|^--(unset|chdir|split-string)$/,
  xargs: /^-[IiLlnPsdaE]$|^--(max-args|max-procs|delimiter|arg-file|replace|max-lines|max-chars|eof)$/,
  timeout: /^-[sk]$|^--(signal|kill-after)$/, stdbuf: /^-[ioe]$/, watch: /^-[nd]$|^--(interval|differences)$/,
};

export const basename = (w) => w.slice(w.lastIndexOf('/') + 1);

// Simple commands of a token list: [{ cmd, args, words, piped, redirects, elevated, wrapped }]
export function commands(tokens) {
  const out = [];
  let cur = { words: [], redirects: [], piped: false };
  let pipedNext = false;
  let pendingRedirect = null;
  const flush = () => {
    if (cur.words.length) out.push(finish(cur));
    cur = { words: [], redirects: [], piped: pipedNext };
    pipedNext = false;
  };
  for (const tok of tokens) {
    if (tok.t === 'op') {
      if (pendingRedirect) { cur.redirects.push({ op: pendingRedirect, target: '' }); pendingRedirect = null; }
      if (tok.v === '>' || tok.v === '<') { pendingRedirect = tok.v; continue; }
      pipedNext = tok.v === '|';
      flush();
      continue;
    }
    if (pendingRedirect) { cur.redirects.push({ op: pendingRedirect, target: tok.v }); pendingRedirect = null; continue; }
    cur.words.push(tok.v);
  }
  flush();
  return out;
}

function finish({ words, redirects, piped }) {
  let i = 0;
  let elevated = false;
  let wrapped = false;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { i++; wrapped = true; }
    const w = basename(words[i] ?? '');
    if (!(w in WRAPPERS)) break;
    wrapped = true;
    if (w === 'sudo' || w === 'doas') elevated = true;
    const argFlag = WRAPPERS[w];
    i++;
    while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
      if (words[i] === '--') { i++; break; }
      i += argFlag && argFlag.test(words[i]) ? 2 : 1;
    }
    if (w === 'timeout' && i < words.length) i++; // the duration
  }
  const cmd = basename(words[i] ?? '');
  return { cmd, args: words.slice(i + 1), words, piped, redirects, elevated, wrapped };
}

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox']);
export const INTERPRETERS = /^(python\d?(\.\d+)?|node|nodejs|deno|bun|perl\d*|ruby|php|lua|osascript|pwsh|powershell|Rscript|tclsh)$/;

// All simple commands in `text`, including those inside `sh -c '…'`,
// `eval …`, $(…) and backticks, to `depth` levels.
export function parseShell(text, depth = 0) {
  const { tokens, hazards, subs } = tokenize(text);
  const cmds = commands(tokens);
  if (depth < 3) {
    for (const s of subs) cmds.push(...parseShell(s, depth + 1).cmds);
    for (const c of [...cmds]) {
      if (SHELLS.has(c.cmd)) {
        const k = c.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
        if (k >= 0 && c.args[k + 1] !== undefined) cmds.push(...parseShell(c.args[k + 1], depth + 1).cmds);
      } else if (c.cmd === 'eval' || c.cmd === 'source' || c.cmd === '.') {
        if (c.cmd === 'eval') cmds.push(...parseShell(c.args.join(' '), depth + 1).cmds);
      }
    }
  }
  return { cmds, hazards };
}
