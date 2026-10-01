// Push-to-talk questions (F7 step 1): what a spoken question means, and the
// short spoken answer. Pure: main.js hands in sessions, usage turns and state
// transitions, and does the listening, the speaking and the I/O.
//
// Step 1 answers questions only; nothing here changes any state.
const Usage = require('../usage.js');

// ── Hotkeys ────────────────────────────────────────────────────────────────
// Hold-to-talk needs to see the key come back up, which Electron's global
// shortcuts can't; the helper polls the key by its macOS virtual keycode, so
// only keys with a known code can be offered.
const HOTKEYS = [
  { accelerator: 'Control+Alt+Space', label: '⌃⌥ Space', keyCode: 49 },
  { accelerator: 'Alt+Space', label: '⌥ Space', keyCode: 49 },
  { accelerator: 'Control+Alt+B', label: '⌃⌥ B', keyCode: 11 },
  { accelerator: 'F13', label: 'F13', keyCode: 105 },
  { accelerator: 'F14', label: 'F14', keyCode: 107 },
  { accelerator: 'F15', label: 'F15', keyCode: 113 },
  { accelerator: 'F16', label: 'F16', keyCode: 106 },
  { accelerator: 'F17', label: 'F17', keyCode: 64 },
  { accelerator: 'F18', label: 'F18', keyCode: 79 },
  { accelerator: 'F19', label: 'F19', keyCode: 80 },
];
const hotkey = (accelerator) => HOTKEYS.find((h) => h.accelerator === accelerator) || null;

// Off until the user picks a key; long-press on the widget works from the start;
// free-form questions to the user's own `claude` only when switched on.
const DEFAULTS = { hotkey: null, longPress: true, askClaude: false };
function normalizeConfig(v) {
  const c = v && typeof v === 'object' ? v : {};
  return { hotkey: hotkey(c.hotkey) ? c.hotkey : null, longPress: c.longPress !== false, askClaude: c.askClaude === true };
}

// ── Intents ────────────────────────────────────────────────────────────────
function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\bwhat's\b/g, 'what is').replace(/\bhow's\b/g, 'how is').replace(/\bwho's\b/g, 'who is')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein plus adjacent swaps (optimal string alignment).
function editDistance(a, b) {
  if (a === b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
// Speech-to-text slips a letter now and then ("blocks", "spent" for "spend").
const near = (word, key) => word === key || (key.length >= 5 && word.length >= 4 && editDistance(word, key) <= 1);

const PHRASES = {
  away: [/\bwhile i (was|were|am) (out|away|gone|off)\b/, /\bwhat (did i|have i) miss/, /\bcatch me up\b/, /\bsince i (left|was away|got back)\b/, /\bwhat (has )?happened\b/, /\bany news\b/],
  spend: [/\bhow much\b.*\b(spen[dt]|spending|cost|used|burn)/, /\bwhat (did|have) i spen[dt]\b/, /\b(spend|spent|spending|cost|costs) (today|so far)\b/],
  blocked: [/\bwhat is (blocked|stuck)\b/, /\b(anything|is anything|anyone|who is|what) (blocked|stuck)\b/, /\bneeds? (me|my input|my attention|you)\b/, /\bwaiting (on|for) me\b/],
  doing: [/\bwhat (is|are) .*\bdoing\b/, /\bhow is .*\b(going|getting on)\b/, /\bwhat is .*\bup to\b/, /\bstatus of\b/],
  help: [/\bwhat can (you|i) (do|ask|say)\b/, /^help\b/],
};
const KEYWORDS = {
  blocked: ['blocked', 'block', 'blocks', 'blocking', 'stuck', 'waiting', 'permission', 'needs'],
  spend: ['spend', 'spent', 'spending', 'cost', 'costs', 'money', 'dollars', 'tokens', 'usage'],
  away: ['happened', 'missed', 'miss', 'away', 'while', 'recap'],
  doing: ['doing', 'working', 'status', 'progress'],
};

// "what is tonde's claude doing" → "tonde"; "what is claude doing" → null.
const SELF = new Set(['claude', 'my claude', 'my', 'everyone', 'everybody', 'it', 'he', 'buddy', 'they', 'my sessions', 'the sessions', 'everything', 'all']);
function nameIn(n) {
  const m = /\bwhat (?:is|are) (.+?) doing\b/.exec(n) || /\bhow is (.+?) (?:going|getting on)\b/.exec(n) || /\bwhat is (.+?) up to\b/.exec(n) || /\bstatus of (.+)$/.exec(n);
  if (!m) return null;
  let who = m[1].replace(/\b(claudes?|agents?|sessions?|the|up)\b/g, ' ').replace(/'s?\b/g, ' ').replace(/\s+/g, ' ').trim();
  return !who || SELF.has(who) ? null : who;
}

function parseIntent(text) {
  const n = normalize(text);
  if (!n) return { intent: 'empty', text: n };
  for (const intent of ['away', 'spend', 'blocked', 'doing', 'help']) {
    if (PHRASES[intent].some((re) => re.test(n))) return intent === 'doing' ? { intent, name: nameIn(n), text: n } : { intent, text: n };
  }
  const words = n.split(' ');
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const [intent, keys] of Object.entries(KEYWORDS)) {
    const score = keys.filter((k) => words.some((w) => near(w, k))).length;
    if (score > bestScore) { best = intent; bestScore = score; tie = false; } else if (score && score === bestScore) tie = true;
  }
  if (!best || tie) return { intent: 'unknown', text: n };
  return best === 'doing' ? { intent: best, name: nameIn(n), text: n } : { intent: best, text: n };
}

// ── Answers ────────────────────────────────────────────────────────────────
// Short and spoken: no symbols, folder names read as words, at most three
// things named, the rest counted.
const { folderOf: folder } = require('../rules.js');
const spoken = (name) => String(name || '').replace(/[-_.]+/g, ' ').trim() || 'a session';
const nameOf = (s) => spoken(folder(s.cwd));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function list(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
const MAX_NAMED = 3;
function named(items) {
  const shown = items.slice(0, MAX_NAMED);
  const rest = items.length - shown.length;
  return rest ? `${shown.join('. ')}. And ${rest} more.` : `${shown.join('. ')}.`;
}

const BLOCKED = new Set(['permission-ask', 'limit-hit', 'turn-failed']);
const YOUR_TURN = new Set(['stop', 'idle-nudge']);

function describe(s) {
  const tool = s.tool ? ` ${s.tool}` : '';
  switch (s.signal) {
    case 'permission-ask': return s.askKind === 'question' ? 'has a question for you' : `wants permission${tool ? ` to use${tool}` : ''}`;
    case 'limit-hit': return 'is stuck on the usage limit';
    case 'turn-failed': return `stopped with an error${s.failKind ? `, ${spoken(s.failKind)}` : ''}`;
    case 'stop': case 'idle-nudge': return 'is done and waiting for you';
    case 'tool-use': case 'tool-done': return `is working${tool ? `, using${tool}` : ''}`;
    case 'tool-failed': return `is working, a${tool ? `${tool}` : ' tool'} call just failed`;
    case 'subagent-start': case 'subagent-done': return 'is working with helper agents';
    case 'compact': return 'is compacting its context';
    case 'session-start': return 'just started';
    case 'permission-denied': return 'is working after a denied permission';
    default: return 'is working';
  }
}
function liveAgentCount(s) {
  return (Array.isArray(s.agents) ? s.agents : []).filter((a) => a && a.status !== 'done').length;
}
function sentence(s) {
  const agents = liveAgentCount(s);
  return `${nameOf(s)} ${describe(s)}${agents ? `, with ${plural(agents, 'helper agent')}` : ''}`;
}

function answerBlocked({ sessions = [], pending = [] } = {}) {
  const blocked = sessions.filter((s) => BLOCKED.has(s.signal));
  // A widget Allow/Deny request is an ask even while its file says "working".
  for (const r of pending) {
    if (!blocked.some((s) => s.sessionId === r.sessionId)) blocked.push({ sessionId: r.sessionId, cwd: r.cwd, signal: 'permission-ask', tool: r.tool });
  }
  const waiting = sessions.filter((s) => YOUR_TURN.has(s.signal));
  if (!sessions.length && !blocked.length) return 'No sessions are running, so nothing is blocked.';
  const turn = waiting.length ? ` ${plural(waiting.length, 'session')} ${waiting.length === 1 ? 'is' : 'are'} done and waiting for your next message.` : '';
  if (!blocked.length) return `Nothing is blocked.${turn}`;
  const head = blocked.length === 1 ? 'One thing needs you.' : `${plural(blocked.length, 'thing')} need you.`;
  return `${head} ${named(blocked.map(sentence))}${turn}`;
}

// Local sessions only, for now. A name that matches no folder here is taken
// as a person, and a person's Claude lives on their machine: that needs the
// team board.
function answerDoing({ name = null, sessions = [] } = {}) {
  if (name) {
    const said = normalize(name).replace(/[^a-z0-9]/g, '');
    // "tondes claude": speech-to-text often drops the apostrophe
    const wants = [said, said.replace(/s$/, '')].filter((w, i, a) => w && a.indexOf(w) === i);
    const hits = sessions.filter((s) => {
      const f = folder(s.cwd).toLowerCase().replace(/[^a-z0-9]/g, '');
      return f && wants.some((want) => f === want || (want.length >= 3 && f.includes(want)) || (want.length >= 4 && editDistance(f, want) <= 1));
    });
    if (!hits.length) return `I can only see the Claude sessions on this Mac, and none is in a folder called ${spoken(name)}. Seeing a teammate's Claude needs the team board.`;
    return named(hits.map(sentence));
  }
  if (!sessions.length) return 'No Claude sessions are running on this Mac.';
  const head = sessions.length === 1 ? '' : `${plural(sessions.length, 'session')}. `;
  return `${head}${named(sessions.map(sentence))}`;
}

function money(v) {
  if (!(v > 0)) return 'nothing';
  if (v < 0.01) return 'less than a cent';
  const dollars = Math.floor(v);
  const cents = Math.round((v - dollars) * 100);
  if (v >= 100) return `${Math.round(v)} dollars`;
  if (!dollars) return `${cents} cents`;
  return cents ? `${dollars} dollars ${cents}` : `${dollars} dollars`;
}
// API-price estimate from the transcripts (usage.js), the same numbers as
// Stats → Spend. Budgets come later (F1).
function answerSpend({ turns = [], now = Date.now() } = {}) {
  const today = Usage.summarise(turns, { days: 1, baselineDays: 1, now });
  const cost = today.total.cost;
  if (!today.total.turns) return 'Nothing yet today. No Claude turns since midnight.';
  const top = today.byProject[0];
  const model = today.byModel[0];
  const where = top && today.byProject.length > 1 && cost > 0 ? ` Most of it in ${spoken(top.name)}.` : top && cost > 0 ? ` All of it in ${spoken(top.name)}.` : '';
  const on = model && cost > 0 ? `, mostly ${spoken(model.name)}` : '';
  return `About ${money(cost)} today at API prices, over ${plural(today.total.turns, 'turn')}${on}.${where}`;
}

// transitions: buddy_recent_transitions entries (mcp-server.js), any order.
// The latest state per session inside the window is what's worth saying.
function answerWhileOut({ transitions = [], since, now = Date.now(), awayKnown = false } = {}) {
  const from = Number.isFinite(since) ? since : now - 60 * 60 * 1000;
  const inWindow = transitions.filter((t) => { const at = Date.parse(t.at); return at >= from && at <= now; });
  const mins = Math.max(1, Math.round((now - from) / 60000));
  const span = awayKnown ? `While you were out, ${mins >= 90 ? `about ${plural(Math.round(mins / 60), 'hour')}` : plural(mins, 'minute')}` : mins === 60 ? 'In the last hour' : `In the last ${plural(mins, 'minute')}`;
  if (!inWindow.length) return `${span}, nothing changed.`;
  const latest = new Map();
  for (const t of [...inWindow].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) latest.set(t.session, t);
  const phrase = (t) => {
    const who = spoken(folder(t.project) || t.project);
    switch (t.to) {
      case 'stop': case 'idle-nudge': return `${who} finished`;
      case 'permission-ask': return `${who} is waiting for your permission`;
      case 'limit-hit': return `${who} hit the usage limit`;
      case 'turn-failed': return `${who} failed${t.failKind ? ` with ${spoken(t.failKind)}` : ''}`;
      case 'gone': return `${who} closed`;
      case 'session-start': return `${who} started`;
      default: return `${who} is still working`;
    }
  };
  const order = { 'permission-ask': 0, 'limit-hit': 0, 'turn-failed': 1, stop: 2, 'idle-nudge': 2 };
  const items = [...latest.values()].sort((a, b) => (order[a.to] ?? 3) - (order[b.to] ?? 3)).map(phrase);
  return `${span}: ${named(items)}`;
}

const HELP = 'Ask me what is blocked, what a session is doing, how much you have spent today, or what happened while you were out.';

// Everything a question can need, gathered by main.js; answer() picks the
// builder. Unknown questions get the help line unless free-form is on (main
// asks the user's own claude then).
function answer(intent, ctx = {}) {
  switch (intent.intent) {
    case 'blocked': return answerBlocked(ctx);
    case 'doing': return answerDoing({ ...ctx, name: intent.name });
    case 'spend': return answerSpend(ctx);
    case 'away': return answerWhileOut(ctx);
    case 'help': return HELP;
    case 'empty': return "I didn't catch that.";
    default: return `I can't answer that yet. ${HELP}`;
  }
}

// ── Free-form, through the user's own Claude Code login ──────────────────
// Only when voice.askClaude is on. The isolation profile from the board
// spikes: no user/project settings, hooks, plugins or MCP servers, no tools,
// nothing saved, no auto-memory, a hard spend cap. The question goes in on
// stdin, never argv. Never another provider or key.
const CLAUDE_MAX_BUDGET_USD = '0.05';
const CLAUDE_SYSTEM = 'You are Plexiform, a desk widget that watches the user\'s Claude Code sessions. Answer the spoken question in at most two short sentences, plain words for text-to-speech, using only the JSON snapshot given. If the snapshot cannot answer it, say so.';
function claudeArgs() {
  return ['-p', '--model', 'haiku', '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--no-session-persistence', '--max-budget-usd', CLAUDE_MAX_BUDGET_USD, '--output-format', 'text', '--system-prompt', CLAUDE_SYSTEM];
}
function claudePrompt(question, snap) {
  return `Snapshot:\n${JSON.stringify(snap)}\n\nQuestion: ${String(question).slice(0, 500)}`;
}
// Only what the CLI needs to find the user's login; nothing that could point
// it at another config dir, account, key or parent Claude Code session.
const CLAUDE_ENV_KEYS = ['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR'];
function claudeEnv(env = process.env, extraPath = '') {
  const out = {};
  for (const k of CLAUDE_ENV_KEYS) if (env[k]) out[k] = env[k];
  if (extraPath) out.PATH = out.PATH ? `${out.PATH}:${extraPath}` : extraPath;
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return out;
}
// `say` and the tooltip get plain words: nothing that reads as an option.
const speakable = (text) => String(text || '').replace(/^[\s-]+/, '').trim();

// What free-form sees: states and names, never file contents or transcripts.
function snapshot(ctx = {}) {
  return {
    sessions: (ctx.sessions || []).map((s) => ({ project: folder(s.cwd), state: describe(s), agents: liveAgentCount(s) })),
    spendToday: answerSpend(ctx),
    recent: (ctx.transitions || []).slice(0, 30).map((t) => ({ at: t.at, project: t.project, from: t.from, to: t.to })),
  };
}

module.exports = { HOTKEYS, hotkey, DEFAULTS, normalizeConfig, normalize, editDistance, parseIntent, answerBlocked, answerDoing, answerSpend, answerWhileOut, answer, HELP, claudeArgs, claudePrompt, claudeEnv, CLAUDE_ENV_KEYS, speakable, snapshot, CLAUDE_MAX_BUDGET_USD };
