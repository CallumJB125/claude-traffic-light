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

const folderOf = (cwd) => String(cwd || '').split('/').filter(Boolean).pop() || '';

function notifiable({ sessions = [], pending = [], offline = false }) {
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
  return out;
}

function message(kind, s) {
  const where = s ? folderOf(s.cwd) : '';
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

// prevKeys: the key set from last time, or null on the very first look —
// which only records what is already going on, so a restart doesn't replay
// every ask and failure that is still sitting there.
function notifications(prevKeys, next, config) {
  const now = notifiable(next);
  const keys = new Set(now.keys());
  if (!prevKeys) return { keys, fire: [] };
  const { on, kinds } = notifyConfig(config);
  const fire = [];
  if (on) {
    for (const [key, { kind, session }] of now) {
      if (prevKeys.has(key) || kinds[kind] === false) continue;
      fire.push({ key, kind, ...message(kind, session), hostApp: (session && session.hostApp) || null, cwd: (session && session.cwd) || null });
    }
  }
  return { keys, fire };
}

module.exports = { MARKER, shouldAutoShow, explain, NOTIFY_KINDS, NOTIFY_DEFAULTS, notifyConfig, notifications };
