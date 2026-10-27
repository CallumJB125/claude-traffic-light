'use strict';
// Redesign R1: the copy glossary (plan-redesign §4.2), in WARN mode (§R2.9).
// It scans what people read (the text of every app page and the string
// literals of the scripts those pages load) for the old names §4.2 replaces,
// and prints each match. It passes; R15 switches it to fail
// (GLOSSARY_STRICT=1 does that now, for trying it out).
// Only the distinctive phrases of §4.2's "Today" column are scanned. The rows
// made of one everyday word (Review, Task, Session, Run, Quiet, Approval,
// Question, Checkpoint, Burst, Recent) need context rules and come with R15.
// New copy is held to it now: the chat-first sidebar's strings must be clean.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const STRICT = process.env.GLOSSARY_STRICT === '1';

// Old phrase → what §4.2 says to use instead.
const GLOSSARY = [
  [/\bWaiting on you\b/i, 'Needs you'], [/\bNeeds? input\b/i, 'Needs you'], [/\bNeeds your input\b/i, 'Needs you'], [/\bWaiting for your input\b/i, 'Needs you'],
  [/\bIn review\b/i, 'Finished — check it'], [/\bReady (?:for|to) review\b/i, 'Finished — check it'],
  [/\bStalled\b/i, 'Stuck + the reason'], [/\bOrphaned\b/i, 'Stuck + the reason'], [/\bNo signal\b/i, 'Stuck + the reason'], [/\bUnresponsive\b/i, 'Stuck + the reason'],
  [/\bReported:/, 'the status alone'], [/\bReported by Codex\b/i, 'the status alone'], [/\bFreshness unknown\b/i, 'the status alone'],
  [/\bTask not reported\b/i, 'the title rules'], [/\bUntitled task\b/i, 'the title rules'], [/\bCodex session\b/, 'the title rules'], [/\bLocal project\b/, 'the title rules'], [/\bUnknown project\b/i, 'the title rules'],
  [/\bTake over in terminal\b/i, 'Open in Terminal'], [/\bHand back\b/i, 'Back to chat'],
  [/\bActivity hooks cannot send\b/i, '“Plexiform can see this session but can’t type into it…”'],
  [/\bHooks point at an older\b/i, '“Claude Code is connected to an old copy of Plexiform.” Reconnect'],
  [/\bAgent bus\b/i, 'AI-to-AI messages'], [/\bbus tools\b/i, 'AI-to-AI messages'], [/\bNOT_BOUND\b/, 'AI-to-AI messages'], [/\bEXCLUDED\b/, 'AI-to-AI messages'],
  [/\bChild agents\b/i, 'Helpers'], [/\bAPI-equivalent\b/i, 'At API prices'],
  [/\bsaved report and references\b/i, 'Restore point'], [/\bWorktree\b/i, '“Works in a copy of your folder…”'], [/\bseparate working copy\b/i, '“Works in a copy of your folder…”'],
  [/\bHatch a character\b/i, 'Character'], [/\bWidget rules\b/i, 'Widget › When to light up'],
  [/\bCould not find its terminal\b/i, '“Plexiform can’t answer this one from here. Go to terminal”'], [/\bLoading repos…/i, '“No repos yet · Add one”'],
];

// Reviewed strings that keep a scanned phrase, or that the lab PRs and quick
// wins added and R15 must not "fix" (§R2.9 seeds).
const ALLOW = [
  'Answering here is off', // lab PR 5 (src/answerability.js)
  'Choose your plan', 'About these numbers', // Q12
  'Nothing needs a person right now.', // Q3's Inbox wording
  'This Mac', 'this computer', // lab PR 7 platform words (Brand.machine())
];

// What people read: every tracked app page's text, and the scripts it loads.
function sources() {
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean));
  const pages = [...tracked].filter((f) => /^([^/]+|buddy-window\/[^/]+)\.html$/.test(f));
  const scripts = new Set(['buddy-window/sidebar-chat.js']);
  for (const p of pages) for (const m of fs.readFileSync(path.join(ROOT, p), 'utf8').matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
    const f = path.posix.normalize(path.posix.join(path.posix.dirname(p), m[1]));
    if (tracked.has(f)) scripts.add(f);
  }
  return { pages, scripts: [...scripts].sort() };
}

const pageText = (html) => html.replace(/<script[^]*?<\/script>/g, ' ').replace(/<style[^]*?<\/style>/g, ' ').replace(/<!--[^]*?-->/g, ' ')
  .replace(/<[^>]*?\b(?:title|aria-label|placeholder|alt)="([^"]*)"[^>]*>/g, ' $1 ').replace(/<[^>]+>/g, '\n');
// The string and template literals of a script, in order. One pass, so a "//" or "/*" inside a string is text and a
// quote inside a comment or a regex literal opens nothing: comments are dropped, regex literals skipped, and each
// string or template (its `${}` included) is kept whole. A "/" starts a regex when the last token cannot end an expression.
// Known limits (rare here; a hit this causes in R15 is an allowlist entry, not more parser): a template nested inside a
// `${}` ends the outer one early (as before), a regex right after ")" is read as division, and "/" after a postfix
// "++"/"--" is read as a regex.
function literals(js) {
  const out = []; const n = js.length; let i = 0; let prev = '';
  const regexNext = () => prev === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /^(?:return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(prev);
  while (i < n) {
    const c = js[i]; const d = js[i + 1];
    if (c === '/' && d === '/') { while (i < n && js[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = js.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1; let s = '';
      while (j < n && js[j] !== c && (c === '`' || js[j] !== '\n')) { if (js[j] === '\\') { s += js.slice(j, j + 2); j += 2; } else s += js[j++]; }
      out.push(s); i = j + 1; prev = 'string'; continue;
    }
    if (c === '/' && regexNext()) {
      let j = i + 1; let inClass = false;
      while (j < n && js[j] !== '\n') { if (js[j] === '\\') { j += 2; continue; } if (js[j] === '[') inClass = true; else if (js[j] === ']') inClass = false; else if (js[j] === '/' && !inClass) break; j++; }
      i = j + 1; while (/[a-z]/.test(js[i] || '')) i++;
      prev = 'regex'; continue;
    }
    if (/[\w$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(js[j])) j++; prev = js.slice(i, j); i = j; continue; }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const prose = (s) => /\s/.test(s.trim()) || /^[A-Z]/.test(s);

function scan(chunks) {
  const hits = [];
  for (const [where, text] of chunks) for (const line of String(text).split('\n')) {
    if (ALLOW.some((a) => line.includes(a))) continue;
    for (const [re, instead] of GLOSSARY) if (re.test(line)) hits.push({ where, found: line.match(re)[0], instead, text: line.trim().slice(0, 120) });
  }
  return hits;
}

test(`copy glossary (${STRICT ? 'strict' : 'warn'} mode): the app's own copy`, (t) => {
  const { pages, scripts } = sources();
  assert.ok(pages.includes('index.html') && pages.includes('buddy-window/sidebar.html') && scripts.includes('buddy-window/sidebar.js'));
  const chunks = [
    ...pages.map((f) => [f, pageText(fs.readFileSync(path.join(ROOT, f), 'utf8'))]),
    // A script literal counts as copy when it reads like prose: a space, or a capital first letter (not an id like 'worktree').
    ...scripts.flatMap((f) => literals(fs.readFileSync(path.join(ROOT, f), 'utf8')).filter(prose).map((s) => [f, s])),
  ];
  const hits = scan(chunks);
  for (const h of hits) t.diagnostic(`glossary: ${h.where}: "${h.found}" → ${h.instead}   (${h.text})`);
  if (hits.length) t.diagnostic(`glossary: ${hits.length} old names (warn mode until R15)`);
  if (STRICT) assert.deepEqual(hits, []);
});

test('the scanner finds old names and respects the allowlist', () => {
  const hits = scan([['x.html', 'Waiting on you\nTake over in terminal\nAnswering here is off'], ['y.js', 'Ready to review']]);
  assert.deepEqual(hits.map((h) => [h.found, h.instead]), [['Waiting on you', 'Needs you'], ['Take over in terminal', 'Open in Terminal'], ['Ready to review', 'Finished — check it']]);
  assert.deepEqual(scan([['z.js', 'Needs you · Check it · Open in Terminal']]), []);
  assert.deepEqual(literals("a('Hand back'); // 'Worktree'\n/* 'Stalled' */ b(\"In review\", `Agent bus`)"), ['Hand back', 'In review', 'Agent bus']);
  assert.match(pageText('<p title="Widget rules">x</p><script>"Stalled"</script>'), /Widget rules/);
  assert.deepEqual(['worktree', 'Worktree', 'a worktree', 'no-signal'].filter(prose), ['Worktree', 'a worktree']);
  assert.doesNotMatch(pageText('<script>"Stalled"</script>'), /Stalled/);
});

test('literals: "//" and "/*" inside strings are text, comments and regex literals open no string', () => {
  // URLs and "//" in strings of any kind, including a "//" with no ":" before it, keep the whole literal
  assert.deepEqual(literals("a('https://x.example/a // b', \"Waiting on you // soon\", `see //docs ${1}`);"), ['https://x.example/a // b', 'Waiting on you // soon', 'see //docs ${1}']);
  assert.deepEqual(literals("a('//'); b('Take over /* here */ now');"), ['//', 'Take over /* here */ now']);
  // real comments are still dropped, with quotes inside them
  assert.deepEqual(literals("a('x'); // it's 'Worktree'\n/* \"Stalled\" it's */ b('y'); // end"), ['x', 'y']);
  // regex literals that hold quotes or slashes do not swallow the code after them
  assert.deepEqual(literals("const q = /['\"]/g; a('Hand back'); const u = /\\/\\//; b('Ready to review');"), ['Hand back', 'Ready to review']);
  assert.deepEqual(literals("x = s.replace(/'/g, ''); y = 'Agent bus'; z = a / b / c; w = 'Stalled';"), ['', 'Agent bus', 'Stalled']);
  // division is not a regex
  assert.deepEqual(literals("const r = (a + b) / 2; const t = 'In review'; const k = n / 3 / 4;"), ['In review']);
  // an escaped quote stays inside its string
  assert.deepEqual(literals("a('it\\'s // fine'); b(\"say \\\"hi\\\" // ok\");"), ["it\\'s // fine", 'say \\"hi\\" // ok']);
  // the old strip ate everything from a "//" in a string to the end of the line, so a phrase after it was never scanned
  assert.deepEqual(scan(literals("a('a // b', 'Waiting on you'); // done").map((s) => ['x.js', s])).map((h) => h.found), ['Waiting on you']);
});

test('new copy is held to the glossary now: the chat-first sidebar is clean', () => {
  const strings = literals(fs.readFileSync(path.join(ROOT, 'buddy-window/sidebar-chat.js'), 'utf8'));
  assert.ok(strings.includes('No chats yet.'));
  assert.deepEqual(scan(strings.map((s) => ['buddy-window/sidebar-chat.js', s])), []);
  // The old placeholders it recognises (and drops) are matchers, not copy.
  const { NO_PROJECT } = require('../src/overview-sidebar-rows.js');
  const rows = literals(fs.readFileSync(path.join(ROOT, 'src/overview-sidebar-rows.js'), 'utf8')).filter((s) => !NO_PROJECT.has(s));
  assert.deepEqual(scan(rows.map((s) => ['src/overview-sidebar-rows.js', s])), []);
});

test('new copy is held to the glossary now: the thread page and its reply box (R2a/R2b-1) are clean', () => {
  for (const f of ['thread.js', 'src/thread-main.js']) {
    const strings = literals(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.ok(strings.length > 10, f);
    assert.deepEqual(scan(strings.map((s) => [f, s])), [], f);
  }
  assert.ok(literals(fs.readFileSync(path.join(ROOT, 'src/thread-main.js'), 'utf8')).includes('This chat changed while sending. Check it before sending again.'));
});
