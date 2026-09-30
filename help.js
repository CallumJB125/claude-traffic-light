// Plain-language help for the widget, and which states deserve a macOS
// notification. Pure: main.js feeds it the resolved state and does the I/O.
const Rules = require('./rules.js');

// ── First run ───────────────────────────────────────────────────────────────
// The help panel opens by itself once per install, the first time the app
// runs for real. Dev runs (demos, shots) never show it and never write the
// marker, so they can't use up the real user's one showing.
const MARKER = '.help-shown';
function shouldAutoShow({ markerExists, devRun }) {
  return !markerExists && !devRun;
}

// ── What's on screen, in words ──────────────────────────────────────────────
// Keyed by the default rules' ids. Only used when the rule still listens for
// the signal it shipped with; a rule the user repurposed gets a generic line.
const RULE_TEXT = {
  limit: { signal: 'limit-hit', text: "You've hit your Claude usage limit. Nothing happens until it resets." },
  permission: { signal: 'permission-ask', text: "Claude has stopped mid-task to ask you something — permission to run a tool, or a question. It won't carry on until you answer in the terminal." },
  offline: { signal: 'offline', text: "This computer is offline, so Claude can't reach its servers. Sessions pick up again when the network is back." },
  subagent: { signal: 'tool-use', text: 'Claude handed part of the job to a helper agent.' },
  ralph: { signal: 'ralph', text: 'A ralph loop keeps re-running Claude until the task checks out. The number is which round it is on.' },
  swarm: { signal: 'agents-many', text: 'Three or more agents are working at once; the sign counts them.' },
  team: { signal: 'team', text: 'Several Claude agents are working together as a team.' },
  failed: { signal: 'tool-failed', text: 'A tool Claude just ran failed. Claude usually deals with it on its own.' },
  shell: { signal: 'tool-use', text: 'Claude is running a command in the terminal.' },
  working: { signal: 'prompt-submit', text: 'Claude is busy reading, writing or running things. Nothing for you to do.' },
  'failed-turn': { signal: 'turn-failed', text: 'The last request errored (no network, servers busy, or a rate limit). Retry in the terminal.' },
  done: { signal: 'stop', text: "Claude finished what you asked. It's your turn — no rush." },
  ignored: { signal: 'ignored-20', text: 'Something has been waiting on you for 20+ minutes, so he has crossed his arms and grown a beard.' },
  nudge: { signal: 'idle-nudge', text: 'Claude finished a while ago and is idle until you send the next message. Nothing is blocked.' },
  idle: { signal: 'idle', text: 'No Claude Code session is running (or they have all gone quiet).' },
  // F2 git/ci
  'git-ci-failed': { signal: 'ci-failed', text: 'A GitHub Actions run you started on the branch you are working on just failed. It shows for 10 minutes; Preferences → Git and CI turns these off.' },
  'git-deploy-failed': { signal: 'deploy-failed', text: 'A deploy workflow you started just failed on GitHub Actions. Which workflows count as deploys is set in Preferences → Git and CI.' },
  'git-changes-requested': { signal: 'pr-changes-requested', text: 'Someone asked for changes on one of your pull requests.' },
  'git-review-requested': { signal: 'pr-review-requested', text: 'Someone asked you to review their pull request.' },
  'git-deploy-finished': { signal: 'deploy-finished', text: 'A deploy workflow you started finished successfully.' },
  'git-ci-passed': { signal: 'ci-passed', text: 'CI passed on the branch you are working on.' },
  // F1 spend
  runaway: { signal: 'runaway', text: "A session has spent more than your runaway threshold in the last few minutes (hover Claude for how much, how fast). Check it's doing what you meant — Buddy never stops a session you started; the notification jumps to its terminal." },
  'budget-exceeded': { signal: 'budget-exceeded', text: "You're over the daily or weekly budget set in Preferences → Spend. Nothing is stopped; this is just so you know." },
  'budget-warning': { signal: 'budget-warning', text: "You're close to the daily or weekly budget set in Preferences → Spend." },
};

const LAMP_TEXT = {
  green: 'Green light',
  amber: 'Amber light',
  red: 'Red light',
  off: 'Light off',
};

const POSE_WORDS = {
  think: 'thinking', wave: 'waving at you', thumbs: 'thumbs up', sleep: 'asleep', banner: 'holding up a sign',
  arms: 'arms crossed', run: 'running laps', knock: 'knocking', bubble: 'speech bubble', party: 'partying',
  blink: 'blinking', nod: 'nodding', bounce: 'bouncing', look: 'looking around', spin: 'spinning', tap: 'tapping his foot',
};
const EYE_WORDS = {
  '#8b5cf6': 'purple eyes', '#2fae3e': 'green eyes', '#f2a200': 'orange eyes', '#e2231a': 'red eyes', '#38bdf8': 'blue eyes',
  closed: 'eyes closed', x: 'X eyes', dizzy: 'dizzy eyes',
};
const EFFECT_WORDS = { beard: 'a beard growing', garden: 'gardening', rain: 'rain cloud', sun: 'sunshine', snow: 'snow', sparkles: 'sparkles', fire: 'fire' };

function words(channel, value) {
  if (channel === 'pose') return POSE_WORDS[value] || value;
  if (channel === 'eyes') return EYE_WORDS[value] || (/^#/.test(value) ? `coloured eyes (${value})` : `${value} eyes`);
  if (channel === 'effect') return EFFECT_WORDS[value] || value;
  return value;
}

function ruleText(rule) {
  if (!rule) return null;
  const known = RULE_TEXT[rule.id];
  const signals = (rule.when && rule.when.signal) || [];
  if (known && signals.includes(known.signal)) return known.text;
  const labels = signals.map((id) => (Rules.SIGNALS.find((s) => s.id === id) || { label: id }).label).map((l) => (/^Claude/.test(l) ? l : l[0].toLowerCase() + l.slice(1)));
  return labels.length ? `Your rule — it fires when ${labels.join(' or ')}.` : 'One of your rules in Lights.';
}

const CHANNELS = [['pose', 'Pose'], ['eyes', 'Eyes'], ['effect', 'Effect'], ['costume', 'Costume'], ['pet', 'Pet'], ['cameo', 'Face'], ['body', 'Body']];
const UNSET = { pose: 'none', eyes: 'default', effect: 'none', costume: 'none', pet: 'none', cameo: 'none', body: 'claude' };

// state: what computeState() returns for the real (not travelling) widget.
// extra.travel: the name of whatever he is off doing on screen, if anything.
function explain(state, rules, extra = {}) {
  const look = (state && state.look) || {};
  const owned = (state && state.owned) || {};
  const byId = new Map((rules || []).map((r) => [r.id, r]));
  const lampRule = byId.get(owned.lamp);
  const out = {
    headline: (state.firedNames && state.firedNames[0]) || look.name || 'Claude Buddy',
    lamp: look.lamp || 'off',
    lampText: LAMP_TEXT[look.lamp] || LAMP_TEXT.off,
    meaning: ruleText(lampRule),
    why: [],
    activity: null,
    agents: null,
    sessions: (state.sessions || []).length,
  };
  if (state.reason === 'manual') out.meaning = 'You set this colour by hand from the menu-bar icon. It clears itself after 5 minutes, or use Clear override.';
  if (state.reason === 'preview') out.meaning = 'This is a preview from the Lights editor; the real state comes back in a few seconds.';

  for (const [ch, label] of CHANNELS) {
    const value = look[ch];
    if (!value || value === UNSET[ch]) continue;
    const rule = byId.get(owned[ch]);
    out.why.push({ label, value: words(ch, value), rule: rule ? rule.name : ch === 'costume' || ch === 'effect' ? 'Seasonal costumes (Preferences)' : null });
  }
  if (look.text) out.why.push({ label: 'Sign', value: `“${look.text}”`, rule: byId.get(owned.pose)?.name || null });
  // The other rules that fired but aren't already named above.
  const named = new Set(out.why.map((w) => w.rule));
  out.also = (state.firedNames || []).slice(1).filter((n) => !named.has(n));

  const travel = extra.travel || '';
  if (/^garden/i.test(travel) || look.effect === 'garden') {
    const by = byId.get(owned.effect);
    out.activity = `He's gardening. ${by ? `Your rule “${by.name}” has the Garden effect on, so` : 'The Garden effect is on, so'} while nothing needs you he wanders the screen planting pots. He drops everything the moment a session needs you. To stop it, open Lights and remove the Garden effect from that rule.`;
  } else if (/^knock/i.test(travel)) {
    out.activity = `${travel}: a session needs you and your terminal wasn't in front, so he ran to its Dock icon. Turn this off in Preferences → “Run to the terminal and knock”.`;
  } else if (travel) {
    out.activity = `${travel}.`;
  }

  // F5: only once a busy source is actually working, so nobody reads about
  // held pings they never set up.
  const busy = extra.busy;
  if (busy && busy.busy !== null && busy.busy !== undefined) {
    const why = busy.reasons && busy.reasons.length ? ` (${busy.reasons.join(', ')})` : '';
    out.busy = {
      busy: !!busy.busy,
      until: busy.busy ? busy.until || null : null,
      text: busy.busy
        ? `You're busy${why}, so amber and green sounds, notifications and knocks are held; red ones (a permission ask, a limit, offline) still come through. The lights keep updating. When you're free, a “While you were away” card under Claude sums up what happened — click a line to jump to that terminal.`
        : 'Busy detection is on. During a calendar event marked busy or a Focus, amber and green pings wait and red ones still come through; afterwards a “While you were away” card sums up what happened. Change which sources count in Preferences → Busy & Focus (macOS Calendar stays off until you tick it there), and per rule in Lights → While you\'re busy.',
    };
  }
  if (state.away) out.away = state.away.headline;

  const minions = state.minions || [];
  if (minions.length) {
    const n = minions.length;
    out.agents = {
      text: `The ${n} little chip${n === 1 ? '' : 's'} under Claude ${n === 1 ? 'is a helper agent' : 'are helper agents'} (subagents, teammates or ralph workers) doing part of the job. Green and bobbing = working, amber and flashing = waiting, grey = done. Hover Claude for names; click a chip for its status.`,
      list: minions.slice(0, 8).map((a) => ({ name: a.name, status: a.status, kind: a.kind })),
      more: Math.max(0, n - 8),
    };
  }
  return out;
}

// ── Notifications ───────────────────────────────────────────────────────────
// One notification per state entry: each notifiable state gets a key (the
// session it belongs to, or 'offline'), and only keys that weren't there on
// the previous evaluation fire. A state that holds never fires twice; one
// that ends and comes back does.
const NOTIFY_KINDS = ['permission-ask', 'turn-failed', 'offline'];
const NOTIFY_DEFAULTS = { 'permission-ask': true, 'turn-failed': true, offline: true };

const folderOf = Rules.folderOf;

const periodKey = (b) => (b.which === 'week' ? b.weekKey : b.dayKey);

function notifiable({ sessions = [], pending = [], offline = false, spend = null }) {
  const out = new Map();
  for (const s of sessions) {
    if (!s || !s.sessionId || (s.signal !== 'permission-ask' && s.signal !== 'turn-failed')) continue;
    out.set(`${s.signal}:${s.sessionId}`, { kind: s.signal, session: s });
  }
  // A blocking request from the widget's Allow/Deny path is an ask even while
  // the session file still says the tool is running.
  for (const r of pending) {
    if (!r || !r.sessionId) continue;
    const key = `permission-ask:${r.sessionId}`;
    if (out.has(key)) continue;
    const s = sessions.find((x) => x.sessionId === r.sessionId) || {};
    out.set(key, { kind: 'permission-ask', session: { ...s, sessionId: r.sessionId, cwd: r.cwd || s.cwd, tool: r.tool || s.tool } });
  }
  // Only worth saying while a session is open: a laptop dropping wifi with
  // nothing running is none of Claude's business.
  if (offline && sessions.length) out.set('offline', { kind: 'offline', session: null });
  // F1 spend: keyed on spend alone, never on which sessions are open. A
  // runaway is one key per episode (the app's latch keeps firedAt while the
  // session hovers near the line or its turn ends); a budget level is one
  // key per day or week.
  if (spend) {
    for (const r of spend.runaway || []) {
      const s = sessions.find((x) => x.sessionId && x.sessionId === r.sessionId) || {};
      out.set(`runaway:${r.sessionId}:${r.firedAt || 0}`, { kind: 'runaway', session: { ...s, sessionId: r.sessionId, cwd: s.cwd || r.cwd || null, burn: r.burn } });
    }
    const b = spend.budget;
    if (b && b.level) out.set(`budget-${b.level}:${b.which}:${periodKey(b)}`, { kind: `budget-${b.level}`, session: null, text: spend.budgetText });
  }
  return out;
}

function message(kind, s, text) {
  const where = s ? folderOf(s.cwd) : '';
  if (kind === 'runaway') return { title: `Runaway session${where ? ` — ${where}` : ''}`, body: `${s.burn}. Click to jump to its terminal.` };
  if (kind === 'budget-exceeded') return { title: 'Over budget', body: `${text || 'Spend is over your budget'}.` };
  if (kind === 'budget-warning') return { title: 'Nearing your budget', body: `${text || 'Spend is close to your budget'}.` };
  if (kind === 'permission-ask') {
    const body = s.askKind === 'question' ? 'Claude has a question for you.' : s.tool ? `Claude wants to use ${s.tool}.` : 'Claude is waiting for your answer.';
    return { title: `Needs your input${where ? ` — ${where}` : ''}`, body };
  }
  if (kind === 'turn-failed') {
    const why = Rules.fillText('{fail}', s);
    return { title: `Turn failed${where ? ` — ${where}` : ''}`, body: why === 'FAILED' ? 'The last request errored. Retry in the terminal.' : `${why[0]}${why.slice(1).toLowerCase()}. Retry in the terminal.` };
  }
  return { title: 'No network', body: "This computer is offline; Claude can't reach its servers." };
}

function notifyConfig(config) {
  const per = config && config.notifyStates && typeof config.notifyStates === 'object' ? config.notifyStates : {};
  return { on: !config || config.notifyOnStates !== false, kinds: { ...NOTIFY_DEFAULTS, ...per } };
}

// F1 spend: toggled in Preferences → Spend, under the master switch.
function spendMuted(kind, config) {
  const sp = (config && config.spend) || {};
  if (kind === 'runaway') return sp.notifyRunaway === false;
  // notifyBudget was one switch for both budget notices; it still mutes both
  // unless a split key says otherwise.
  const budget = (key) => (sp[key] === undefined ? sp.notifyBudget : sp[key]) === false;
  if (kind === 'budget-warning') return budget('notifyBudgetWarning');
  if (kind === 'budget-exceeded') return budget('notifyBudgetExceeded');
  return false;
}

// prevKeys: the key set from last time, or null on the very first look —
// which only records what is already going on, so a restart doesn't replay
// every ask and failure that is still sitting there.
function notifications(prevKeys, next, config) {
  const now = notifiable(next);
  const keys = new Set(now.keys());
  // A budget notice stays sent for its day or week, even if the level dips
  // (a raised budget, a new day's first read) and comes back.
  const b = next.spend && next.spend.budget;
  for (const k of prevKeys || []) if (k.startsWith('budget-') && (!b || k.endsWith(`:${b.dayKey}`) || k.endsWith(`:${b.weekKey}`))) keys.add(k);
  if (!prevKeys) return { keys, fire: [] };
  const { on, kinds } = notifyConfig(config);
  const fire = [];
  if (on) {
    for (const [key, { kind, session, text }] of now) {
      if (prevKeys.has(key) || kinds[kind] === false || spendMuted(kind, config)) continue;
      fire.push({ key, kind, ...message(kind, session, text), hostApp: (session && session.hostApp) || null, cwd: (session && session.cwd) || null, sessionId: (session && session.sessionId) || null });
    }
  }
  return { keys, fire };
}

module.exports = { MARKER, shouldAutoShow, explain, NOTIFY_KINDS, NOTIFY_DEFAULTS, notifyConfig, notifications };
