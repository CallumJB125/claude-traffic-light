'use strict';
// Explain mode for people who don't read code: what a permission prompt
// means, what a finished session did, and what to ask when one is stuck.
// Pure and local. Common commands are explained here by rules built on the
// deny-list's own shell parser, so they never reach a model; only what the
// rules don't know goes to src/explain-ai.js.

const { parseShell } = require('./deny/shell.js');
const { shellFinding, SHELL_TOOLS, FILE_WRITE_TOOLS, CREDENTIAL_PATHS, RUNS_CODE_LATER } = require('./deny/denylist.js');
const { redactSecretsPass, maskPii, PATTERNS } = require('./scrub.js');

const RATINGS = Object.freeze(['safe', 'be careful', 'risky']);
const RECOMMEND = Object.freeze({ safe: 'Allow', 'be careful': 'Allow if you expected it', risky: 'Deny unless you are sure' });
const MAX_TEXT = 4000;

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const short = (s, n = 60) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

// Text bound for a model: secrets, emails and the home folder taken out.
function clean(text, { home = null } = {}) {
  let t = String(text || '').slice(0, MAX_TEXT);
  if (home) t = t.split(String(home)).join('~');
  return maskPii(redactSecretsPass(t)).replace(PATTERNS.EMAIL, '[email]');
}

const READ_ONLY = { ls: 'list the files in', cat: 'show the contents of', head: 'show the start of', tail: 'show the end of', pwd: 'show which folder it is in', grep: 'search for text in', rg: 'search for text in', find: 'look for files in', wc: 'count lines in', echo: 'print a message', which: 'check where a program is installed', tree: 'show the folder layout of', less: 'show the contents of', diff: 'compare', stat: 'look at the details of', du: 'measure the size of', file: 'check the type of' };
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'blame', 'rev-parse', 'ls-files', 'describe']);
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const TEST_WORDS = /^(test|lint|typecheck|check|build|format|fmt)$/;

function words(c) { return c.args.filter((a) => !a.startsWith('-')); }

// One simple command → {says, rating} or null when the rules don't know it.
function oneCommand(c) {
  const cmd = c.cmd, args = c.args || [], w = words(c);
  const where = w.length ? w.map(base).slice(0, 3).join(', ') : 'this folder';
  if (c.elevated) return { says: `run "${cmd}" as the computer's administrator`, rating: 'risky' };
  if (READ_ONLY[cmd]) return { says: `${READ_ONLY[cmd]} ${cmd === 'pwd' || cmd === 'echo' || cmd === 'which' ? '' : where}`.trim(), rating: 'safe' };
  if (cmd === 'cd') return { says: `move into ${where}`, rating: 'safe' };
  if (cmd === 'mkdir') return { says: `make a new folder called ${where}`, rating: 'safe' };
  if (cmd === 'touch') return { says: `create an empty file called ${where}`, rating: 'safe' };
  if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'trash') {
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
    return { says: `permanently delete ${recursive ? 'the folder' : 'the file'} ${where}${recursive ? ' and everything inside it' : ''}`, rating: recursive ? 'risky' : 'be careful' };
  }
  if (cmd === 'mv') return { says: `move or rename ${where}`, rating: 'be careful' };
  if (cmd === 'cp') return { says: `copy ${where}`, rating: 'safe' };
  if (cmd === 'chmod' || cmd === 'chown') return { says: `change who may open or run ${where}`, rating: 'be careful' };
  if (cmd === 'git') {
    const sub = w[0] || '';
    if (GIT_READ.has(sub)) return { says: `look at the project's change history (git ${sub})`, rating: 'safe' };
    if (sub === 'add') return { says: 'mark changed files to be saved in the project history', rating: 'safe' };
    if (sub === 'commit') return { says: 'save a snapshot of the changes in the project history', rating: 'safe' };
    if (sub === 'push') return { says: 'upload the saved changes to the shared copy of the project', rating: args.some((a) => /^(-f|--force)/.test(a)) ? 'risky' : 'be careful' };
    if (sub === 'pull' || sub === 'fetch' || sub === 'clone') return { says: 'download changes from the shared copy of the project', rating: 'safe' };
    if (sub === 'checkout' || sub === 'switch') return { says: 'switch to another version or branch of the project', rating: 'be careful' };
    if (sub === 'reset' || sub === 'clean' || sub === 'restore') return { says: 'throw away changes that have not been saved', rating: 'risky' };
    return { says: `run a version-control command (git ${sub})`, rating: 'be careful' };
  }
  if (PKG.has(cmd)) {
    const sub = w[0] || 'install';
    if (sub === 'install' || sub === 'i' || sub === 'add' || sub === 'ci') return { says: `download and install ${w.length > 1 ? w.slice(1, 4).join(', ') : "the project's building blocks"} from the internet`, rating: 'be careful' };
    if (sub === 'run' && w[1]) return TEST_WORDS.test(w[1]) ? { says: `run the project's "${w[1]}" check`, rating: 'safe' } : { says: `run the project's "${w[1]}" script`, rating: /^(dev|start|serve|preview)$/.test(w[1]) ? 'safe' : 'be careful' };
    if (TEST_WORDS.test(sub)) return { says: `run the project's ${sub === 'test' ? 'tests' : sub} to check the work`, rating: 'safe' };
    if (sub === 'start') return { says: 'start the app so you can try it', rating: 'safe' };
    if (sub === 'publish') return { says: 'publish the project for everyone to download', rating: 'risky' };
    return { says: `run a package-manager command (${cmd} ${sub})`, rating: 'be careful' };
  }
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') return { says: `download and run the tool "${w[0] || cmd}"`, rating: 'be careful' };
  if (/^(pytest|jest|vitest|mocha|tsc|eslint|prettier|cargo|go|make)$/.test(cmd)) {
    if (cmd === 'cargo' || cmd === 'go') return { says: `build or test the project (${cmd} ${w[0] || ''})`.trim(), rating: 'safe' };
    return { says: `check the project with ${cmd}`, rating: 'safe' };
  }
  if (cmd === 'curl' || cmd === 'wget') return { says: `fetch ${w.find((x) => /^https?:/.test(x)) ? 'a web address' : 'something'} from the internet`, rating: 'be careful' };
  if (cmd === 'kill' || cmd === 'pkill' || cmd === 'killall') return { says: 'stop a running program', rating: 'be careful' };
  if (/^(python\d?|node)$/.test(cmd) && w[0] && !c.inner?.length) return { says: `run the script ${base(w[0])}`, rating: 'be careful' };
  return null;
}

const worst = (a, b) => (RATINGS.indexOf(a) >= RATINGS.indexOf(b) ? a : b);
const sentence = (s) => { const t = oneLine(s); return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : ''; };

/** A shell command line → {sentence, rating, recommend, source:'local'} or null (unknown). */
function explainCommand(text) {
  const t = oneLine(text);
  if (!t) return null;
  let parsed;
  try { parsed = parseShell(t); } catch { return null; }
  const cmds = parsed?.cmds || [];
  const finding = shellFinding(t);
  const flagged = () => (finding ? { sentence: `Your AI wants to run a command Plexiform flags: ${finding.reason}. Only allow it if you know why it is needed.`, rating: 'risky', recommend: RECOMMEND.risky, source: 'local' } : null);
  if (!cmds.length || cmds.some((c) => c.unparsed) || Object.keys(parsed.hazards || {}).length || cmds.length > 4) return flagged();
  const parts = [];
  let rating = 'safe';
  for (const c of cmds.slice(0, 4)) {
    const r = oneCommand(c);
    if (!r) return flagged();
    parts.push(r.says);
    rating = worst(rating, r.rating);
  }
  if (finding) rating = 'risky';
  if (CREDENTIAL_PATHS.test(t)) rating = 'risky';
  const why = finding ? ` Plexiform flags it: ${finding.reason}.` : CREDENTIAL_PATHS.test(t) ? ' It touches where your passwords or keys are kept.' : '';
  return { sentence: `${sentence(`Your AI wants to ${parts.join(', then ')}`)}${why}`, rating, recommend: RECOMMEND[rating], source: 'local' };
}

/** A permission input (src/pending-inputs.js shape) → explanation or null when only the model could say. */
function explainLocal(input) {
  const i = input || {};
  const tool = String(i.tool || '');
  const text = oneLine(i.text || i.headline || '');
  if (SHELL_TOOLS.test(tool)) return explainCommand(text);
  if (FILE_WRITE_TOOLS.test(tool)) {
    const file = short(base(text.split(/\s/)[0]) || 'a file', 60);
    const later = RUNS_CODE_LATER.test(text) || CREDENTIAL_PATHS.test(text);
    const rating = later ? 'risky' : 'be careful';
    return { sentence: sentence(`Your AI wants to change the file ${file}${later ? ', which controls how programs or your tools run' : ''}`), rating, recommend: RECOMMEND[rating], source: 'local' };
  }
  if (/^(Read|Glob|Grep|LS|NotebookRead|read_file|list_directory|search)$/i.test(tool)) return { sentence: sentence(`Your AI wants to look at ${short(base(text) || 'some files', 60)} without changing anything`), rating: CREDENTIAL_PATHS.test(text) ? 'risky' : 'safe', recommend: RECOMMEND[CREDENTIAL_PATHS.test(text) ? 'risky' : 'safe'], source: 'local' };
  if (/^(WebFetch|WebSearch|web_fetch|web_search)$/i.test(tool)) return { sentence: 'Your AI wants to look something up on the internet.', rating: 'safe', recommend: RECOMMEND.safe, source: 'local' };
  return null;
}

// The model's reply → {sentence, rating, recommend, source:'ai'} or null.
function parseReply(out) {
  const t = String(out || '');
  const line = (k) => { const m = new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'im').exec(t); return m ? oneLine(m[1]) : ''; };
  const what = line('WHAT');
  const r = line('RATING').toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (!what) return null;
  const rating = RATINGS.includes(r) ? r : 'be careful';
  return { sentence: short(sentence(what), 300), rating, recommend: short(line('ANSWER'), 80) || RECOMMEND[rating], source: 'ai' };
}

const EXPLAIN_PROMPT = 'An AI coding agent is asking permission. Explain it to someone who does not program. '
  + 'Reply with exactly three lines and nothing else:\nWHAT: one plain-English sentence, no jargon\nRATING: safe, be careful or risky\nANSWER: Allow, Deny, or Allow if you expected it\n\n';
function explainPrompt(input, opts) { return `${EXPLAIN_PROMPT}Tool: ${clean(input?.tool || 'unknown', opts)}\nRequest: ${clean(input?.text || input?.headline || input?.title || '', opts)}\n`; }

// ── Recap ────────────────────────────────────────────────────────────────
const PORT_RE = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g;
/** Dev-server ports seen in transcript text, most recent last, deduped. */
function portsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PORT_RE)) { const p = Number(m[1]); if (p >= 1024 && p <= 65535 && !out.includes(p)) out.push(p); }
  return out.slice(-5);
}

/**
 * facts: hooks/handover-tap.js shape ({files:{path:'edit'|'read'}, commands, lastPrompt, lastToolFailed}).
 * turnFiles: checkpoint diff files ([{path, status?}] or strings) when there is one.
 * → {headline, lines:[string], risky:[string], changed, commands, testUrl|null}
 */
function buildRecap({ project = 'your project', facts = null, turnFiles = null, ports = [] } = {}) {
  const f = facts || {};
  const fromDiff = Array.isArray(turnFiles) ? turnFiles.map((x) => (typeof x === 'string' ? x : x?.path || x?.file)).filter(Boolean) : null;
  const edited = fromDiff || Object.entries(f.files || {}).filter(([, k]) => k === 'edit').map(([p]) => p);
  const commands = Array.isArray(f.commands) ? f.commands : [];
  const lines = [];
  if (f.lastPrompt) lines.push(`You asked: "${short(f.lastPrompt, 120)}"`);
  if (edited.length) lines.push(`Changed ${edited.length} file${edited.length === 1 ? '' : 's'}: ${edited.slice(0, 5).map(base).join(', ')}${edited.length > 5 ? ` and ${edited.length - 5} more` : ''}.`);
  else lines.push('No files were changed.');
  const risky = [];
  const told = new Set();
  for (const c of commands) {
    const e = explainCommand(c);
    const say = e ? e.sentence.replace(/^Your AI wants to /, '').replace(/\. (Plexiform flags it|It touches|Only allow).*$/, '').replace(/\.$/, '') : `run a command the explainer doesn't know (${short(c, 40)})`;
    if (e?.rating === 'risky') risky.push(e.sentence.replace(/^Your AI wants to /, '').replace(/^./, (x) => x.toUpperCase()));
    if (!told.has(say) && told.size < 4) told.add(say);
  }
  if (told.size) lines.push(`Along the way it set out to: ${[...told].map((s) => s.replace(/^[A-Z]/, (x) => x.toLowerCase())).join('; ')}.`);
  if (f.lastToolFailed) lines.push(`Something it tried failed${f.lastToolFailed.tool ? ` (${f.lastToolFailed.tool})` : ''}. Check that it finished what you asked.`);
  const port = ports.length ? ports[ports.length - 1] : null;
  return {
    headline: `What your AI just did in ${project}`,
    lines, risky: risky.slice(0, 5), changed: edited.length, commands: commands.length,
    testUrl: port ? `http://localhost:${port}/` : null,
  };
}

// ── Stuck help ───────────────────────────────────────────────────────────
const STUCK_PROMPTS = Object.freeze([
  { id: 'explain-error', label: 'Ask Claude to explain the error simply', text: 'Something went wrong. Please explain the last error in plain English, without jargon, and tell me what you will do next to fix it.' },
  { id: 'undo-last', label: 'Undo the last change', text: 'Please undo the last change you made and put the files back the way they were before it. Tell me what you undid.' },
  { id: 'status', label: 'Ask what it is waiting for', text: 'You seem stuck. In one or two plain sentences: what are you doing right now, and do you need anything from me?' },
  { id: 'smaller-step', label: 'Try a smaller step', text: 'Let’s go one small step at a time. Do only the next smallest step, check that it works, and tell me the result.' },
]);
/** Session (stuck flag, failed tool) → [{id,label,text}] or [] when it looks fine. */
function stuckHelp({ stuck = null, failed = false } = {}) {
  if (failed) return STUCK_PROMPTS.slice(0, 2).concat(STUCK_PROMPTS[3]);
  if (stuck) return [STUCK_PROMPTS[2], STUCK_PROMPTS[0], STUCK_PROMPTS[1]];
  return [];
}
const promptById = (id) => STUCK_PROMPTS.find((p) => p.id === id) || null;

module.exports = { explainCommand, explainLocal, parseReply, explainPrompt, clean, portsIn, buildRecap, stuckHelp, promptById, RATINGS, RECOMMEND, STUCK_PROMPTS };
