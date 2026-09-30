// The rules engine: turns raw hook signals into a resolved "look" for the
// widget. Shared by main.js (require) and the Lights editor (<script src>),
// so the preview in the editor and the real widget can never disagree.
//
// A session file carries a raw signal ({signal, tool, updatedAt, cwd}). A
// rule says: when this signal (optionally from this tool) is live in any
// session, set these visual channels. Rules apply top-down; the first rule
// that lights a lamp is the state, and rules above it may layer accents — so
// "subagent running" can recolour the eyes while "working" owns the lamp.
//
// Which signal a session is showing — the session lifecycle — is the state
// machine in hooks/session-machine.js; this file builds looks on top of it.
// The Lights editor loads that file with a <script> tag before this one.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hooks/session-machine.js'), require('./characters/index.js'));
  else root.TrafficLightRules = factory(root.SessionMachine, root.BuddyCharacters);
})(typeof self !== 'undefined' ? self : this, function (Machine, Characters) {
  const SIGNALS = [
    { id: 'prompt-submit', label: 'You send a prompt', hook: 'UserPromptSubmit', kind: 'working' },
    { id: 'tool-use', label: 'Claude uses a tool', hook: 'PreToolUse', kind: 'working', tool: true },
    { id: 'tool-done', label: 'A tool finishes', hook: 'PostToolUse', kind: 'working', tool: true },
    { id: 'tool-failed', label: 'A tool fails', hook: 'PostToolUseFailure', kind: 'working', tool: true },
    { id: 'subagent-start', label: 'A subagent starts', hook: 'SubagentStart', kind: 'working' },
    { id: 'subagent-done', label: 'A subagent finishes', hook: 'SubagentStop', kind: 'working' },
    { id: 'permission-denied', label: 'A permission is denied', hook: 'PermissionDenied', kind: 'working' },
    { id: 'turn-failed', label: 'A turn fails', hook: 'StopFailure', kind: 'working' },
    { id: 'stop', label: 'Claude finishes a task', hook: 'Stop', kind: 'working' },
    { id: 'idle-nudge', label: 'Claude is waiting for you', hook: 'Notification', kind: 'working' },
    { id: 'permission-ask', label: 'Claude asks permission', hook: 'Notification', kind: 'waiting' },
    { id: 'limit-hit', label: 'Usage limit hit', hook: 'Notification', kind: 'waiting' },
    { id: 'session-start', label: 'A session starts', hook: 'SessionStart', kind: 'working' },
    { id: 'compact', label: 'Context compacts', hook: 'PreCompact', kind: 'working' },
    { id: 'long-running', label: 'Working over 10 minutes', hook: null, kind: 'virtual' },
    { id: 'ignored-10', label: 'Ignored for 10 minutes', hook: null, kind: 'virtual' },
    { id: 'ignored-20', label: 'Ignored for 20 minutes', hook: null, kind: 'virtual' },
    { id: 'ignored-30', label: 'Ignored for 30 minutes', hook: null, kind: 'virtual' },
    { id: 'many-sessions', label: '3+ sessions at once', hook: null, kind: 'virtual' },
    { id: 'subagents', label: 'A subagent is running', hook: null, kind: 'virtual' },
    { id: 'team', label: 'Team mode is running', hook: null, kind: 'virtual' },
    { id: 'ralph', label: 'A ralph loop is running', hook: null, kind: 'virtual' },
    { id: 'agents-many', label: '3+ agents at once', hook: null, kind: 'virtual' },
    { id: 'offline', label: 'No network connection', hook: null, kind: 'virtual' },
    { id: 'idle', label: 'No sessions running', hook: null, kind: 'virtual' },
  ];

  // F2 git/ci ────────────────────────────────────────────────────────────────
  // Pull request and GitHub Actions events from src/github-signals.js (polled
  // with the user's own gh login, later a hub webhook). Each is a transient
  // event, not a session: main.js passes the live ones as env.git and they
  // resolve like virtual signals, carrying the cwd of a session in that repo
  // (or none), so project-scoped rules still work. The default rules only
  // layer a pose/sign/eyes accent and never set the lamp: the lamp stays
  // about Claude.
  const GIT_SIGNALS = [
    { id: 'pr-review-requested', label: 'Your review is requested on a PR', hook: null, kind: 'git' },
    { id: 'pr-changes-requested', label: 'Changes requested on your PR', hook: null, kind: 'git' },
    { id: 'ci-failed', label: 'CI failed on your branch', hook: null, kind: 'git' },
    { id: 'ci-passed', label: 'CI passed on your branch', hook: null, kind: 'git' },
    { id: 'deploy-failed', label: 'A deploy workflow failed', hook: null, kind: 'git' },
    { id: 'deploy-finished', label: 'A deploy workflow finished', hook: null, kind: 'git' },
  ];
  SIGNALS.push(...GIT_SIGNALS);
  function gitDefaultRules() {
    return [
      { id: 'git-ci-failed', name: 'CI failed', enabled: true, when: { signal: ['ci-failed'] }, then: { pose: 'banner', text: 'CI FAILED', eyes: '#e2231a', sound: 'Funk' } },
      { id: 'git-deploy-failed', name: 'Deploy failed', enabled: true, when: { signal: ['deploy-failed'] }, then: { pose: 'banner', text: 'DEPLOY FAILED', eyes: '#e2231a', sound: 'Funk' } },
      { id: 'git-changes-requested', name: 'Changes requested', enabled: true, when: { signal: ['pr-changes-requested'] }, then: { pose: 'banner', text: 'CHANGES ASKED', eyes: 'sad' } },
      { id: 'git-review-requested', name: 'Review requested', enabled: true, when: { signal: ['pr-review-requested'] }, then: { pose: 'banner', text: 'REVIEW PLEASE', eyes: 'surprised' } },
      { id: 'git-deploy-finished', name: 'Deploy finished', enabled: true, when: { signal: ['deploy-finished'] }, then: { pose: 'party', eyes: '#2fae3e' } },
      { id: 'git-ci-passed', name: 'CI passed', enabled: true, when: { signal: ['ci-passed'] }, then: { pose: 'thumbs', eyes: '#2fae3e' } },
    ];
  }
  // env.git: [{ signal, cwd, repo, pr, branch, … }] — the events still live.
  function gitSessions(env) {
    const known = new Set(GIT_SIGNALS.map((x) => x.id));
    return (env && Array.isArray(env.git) ? env.git : []).filter((e) => e && known.has(e.signal))
      .map((e) => ({ signal: e.signal, cwd: e.cwd || null, repo: e.repo || null, pr: e.pr || null, branch: e.branch || null, virtual: true, git: true }));
  }
  // v7: the git rules slot in just under "No network", above the accents.
  function addGitRules(add, out) {
    const offline = out.findIndex((r) => r.id === 'offline');
    const at = offline >= 0 ? offline + 1 : out.findIndex((r) => !r.locked);
    gitDefaultRules().forEach((r, i) => add(r.id, at < 0 ? -1 : at + i));
  }
  // ── end F2 git/ci
  // ── F1 spend ──────────────────────────────────────────────────────────────
  // Budgets and runaway sessions. The app works them out from the transcripts
  // (spend.js) and passes them in as env.spend = { budget: { level },
  // budgetText, runaway: [{ sessionId, cwd, burn }] }; here they become
  // virtual signals, get default rules, and v8 slots those rules into saved
  // configs. Everything else in this file only calls into this block.
  SIGNALS.splice(SIGNALS.findIndex((s) => s.id === 'idle'), 0,
    { id: 'runaway', label: 'A session is burning money fast', hook: null, kind: 'virtual' },
    { id: 'budget-warning', label: 'Spend is nearing your budget', hook: null, kind: 'virtual' },
    { id: 'budget-exceeded', label: 'Spend is over your budget', hook: null, kind: 'virtual' });
  const SPEND_RULES = [
    { id: 'runaway', name: 'Runaway session', enabled: true, when: { signal: ['runaway'] }, then: { lamp: 'red', lampFx: 'pulse', eyes: 'wide' } },
    { id: 'budget-exceeded', name: 'Over budget', enabled: true, when: { signal: ['budget-exceeded'] }, then: { lamp: 'red', eyes: 'money' } },
    { id: 'budget-warning', name: 'Nearing budget', enabled: true, when: { signal: ['budget-warning'] }, then: { lamp: 'amber', eyes: 'money' } },
  ];
  // No banners by default: the lamp stays visible, and the tooltip carries the
  // burn rate or budget line. A rule's text can quote them as {burn} and
  // {budget}. "Runaway" sits under "No network", above "working", so it shows while the
  // session is still burning. The budget rules sit above "Task finished": a
  // working session stays green, and a turn that ends over budget reads red
  // (or amber with money eyes when close) instead of plain amber.
  function placeSpendRules(list, spendRules = SPEND_RULES) {
    const out = list.slice();
    const at = (ids) => { for (const id of ids) { const i = out.findIndex((r) => r.id === id); if (i >= 0) return i; } return -1; };
    const put = (id, i) => {
      if (out.some((r) => r.id === id)) return;
      // A copy: callers (Lights presets) edit the rules they get back.
      out.splice(i < 0 ? out.length : i, 0, JSON.parse(JSON.stringify(spendRules.find((r) => r.id === id))));
    };
    const offline = at(['offline']);
    put('runaway', offline >= 0 ? offline + 1 : out.findIndex((r) => !r.locked));
    put('budget-exceeded', at(['done', 'nudge', 'started', 'idle']));
    put('budget-warning', at(['done', 'nudge', 'started', 'idle']));
    return out;
  }
  // A runaway lights only while its session is live and mid-turn: once the
  // turn ends the burn has stopped, and its notification already went out.
  // Budget signals ride on every live session (so a rule can scope them to a
  // project) and never on an empty desk.
  function spendSessions(sessions, env) {
    const sp = env && env.spend;
    if (!sp) return [];
    const out = [];
    for (const r of sp.runaway || []) {
      const s = sessions.find((x) => x.sessionId && x.sessionId === r.sessionId);
      if (!s || TURN_END.has(sessionSignal(s))) continue;
      out.push({ signal: 'runaway', sessionId: r.sessionId, cwd: s.cwd || r.cwd || null, source: s.source, hostApp: s.hostApp, virtual: true, burn: r.burn });
    }
    const level = sp.budget && sp.budget.level;
    if (level === 'warning' || level === 'exceeded') for (const s of sessions) out.push({ signal: `budget-${level}`, cwd: s.cwd, virtual: true, budget: sp.budgetText || '' });
    return out;
  }
  // ── end F1 spend ──────────────────────────────────────────────────────────

  // Virtual signals are derived from the live session set rather than a hook.
  const LONG_RUNNING_MS = 10 * 60 * 1000;
  // Signal sets, owned by the state machine: WAITING (blocked on you),
  // WAITING_ON_YOU (your turn in any form), TURN_END (the turn is over).
  const { WAITING, WAITING_ON_YOU, TURN_END, effectiveSignal, presentSignal, TRANSIENT_ASK_MS, sessionSignal } = Machine;
  // ── Other agents ──────────────────────────────────────────────────────────
  // A session file may carry `agents` (every subagent / teammate / ralph or
  // ultrawork worker it knows about) and `mode` (the OMC execution mode).
  // Anything that has finished stops counting as live.
  const AGENT_KINDS = ['subagent', 'teammate', 'ralph', 'ultrawork'];
  const AGENT_STATUSES = Machine.AGENT_STATUSES;
  const MODES = ['ralph', 'team', 'ultrawork'];

  function normalizeAgent(a, i = 0) {
    if (!a || typeof a !== 'object') return null;
    const kind = AGENT_KINDS.includes(a.kind) ? a.kind : 'subagent';
    const status = AGENT_STATUSES.includes(a.status) ? a.status : 'working';
    return {
      id: String(a.id || `${kind}-${i}`).slice(0, 80),
      name: String(a.name || a.id || kind).slice(0, 40),
      kind,
      status,
      since: a.since || null,
      parent: a.parent || null,
    };
  }

  // Every live (not finished) agent across the given sessions, each tagged
  // with the cwd of the session that owns it.
  function liveAgents(sessions) {
    const out = [];
    for (const s of sessions) {
      if (!Array.isArray(s.agents)) continue;
      s.agents.forEach((a, i) => {
        const n = normalizeAgent(a, i);
        if (n && n.status !== 'done') out.push({ ...n, cwd: s.cwd || null });
      });
    }
    return out;
  }

  // Keeps the agents whose kind is switched on; a kind missing from `kinds`
  // counts as on, so configs saved before this filter existed show everything.
  function filterAgentKinds(agents, kinds) {
    if (!kinds || typeof kinds !== 'object') return agents;
    return agents.filter((a) => kinds[a.kind] !== false);
  }

  function sessionMode(s) {
    return MODES.includes(s && s.mode) ? s.mode : null;
  }

  // Highest ralph iteration anyone is on (0 when no loop is running).
  function ralphIteration(sessions) {
    let max = 0;
    for (const s of sessions) if (sessionMode(s) === 'ralph') max = Math.max(max, Number(s.iteration) || 0);
    return max;
  }

  // env.offline comes from the app (Electron's net.isOnline); every session
  // is cut off when the machine is, so each one carries it.
  function virtualSessions(sessions, now = Date.now(), env = {}) {
    const out = [];
    if (sessions.length >= 3) out.push({ signal: 'many-sessions', virtual: true });
    if (env.offline) for (const s of sessions) out.push({ signal: 'offline', cwd: s.cwd, virtual: true });
    out.push(...busySignals(env));
    let agentTotal = 0;
    const lastTouch = lastTouchOf(sessions);
    for (const s of sessions) {
      const since = s.workingSince ? new Date(s.workingSince).getTime() : null;
      if (since && now - since > LONG_RUNNING_MS && !WAITING.has(s.signal)) out.push({ signal: 'long-running', cwd: s.cwd, virtual: true });
      const mins = ignoredMinutes(s, lastTouch, now);
      if (mins !== null) for (const m of [10, 20, 30]) if (mins >= m) out.push({ signal: `ignored-${m}`, cwd: s.cwd, virtual: true });
      const agents = liveAgents([s]);
      agentTotal += agents.length;
      const mode = sessionMode(s);
      if (agents.some((a) => a.kind === 'subagent')) out.push({ signal: 'subagents', cwd: s.cwd, virtual: true, agents: agents.length });
      if (mode === 'team' || agents.some((a) => a.kind === 'teammate')) out.push({ signal: 'team', cwd: s.cwd, virtual: true, agents: agents.length });
      if (mode === 'ralph') out.push({ signal: 'ralph', cwd: s.cwd, virtual: true, agents: agents.length, iteration: Number(s.iteration) || 0 });
    }
    if (agentTotal >= 3) out.push({ signal: 'agents-many', virtual: true, agents: agentTotal });
    out.push(...spendSessions(sessions, env)); // F1 spend
    return out;
  }
  // "Ignored" means you haven't touched *any* Claude, not just this one: a
  // session left waiting this morning must not nag while you're busy in a
  // newer terminal. A touch is you acting (the hooks stamp touchedAt), never
  // Claude moving: a ralph loop working away in another terminal says nothing
  // about whether you're at the desk. Files from before touchedAt fall back to
  // a waiting session's updatedAt, roughly when you last left it.
  function touchedAt(s) {
    const t = Date.parse(s.touchedAt || '');
    if (t) return t;
    return WAITING_ON_YOU.has(s.signal) && s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0;
  }
  function lastTouchOf(sessions) {
    return Math.max(0, ...sessions.map(touchedAt));
  }
  // How long a waiting session has gone unanswered, in minutes: since it
  // started waiting or since your last touch anywhere, whichever is later.
  // null for a session that isn't waiting on you.
  function ignoredMinutes(s, lastTouch, now) {
    if (!WAITING_ON_YOU.has(s.signal) || !s.updatedAt) return null;
    return (now - Math.max(Date.parse(s.updatedAt) || 0, lastTouch)) / 60000;
  }
  // Longest anyone has been ignored, in minutes (0 when nobody is) — the same
  // clock as ignored-N, so the beard and the rules agree.
  function waitMinutes(sessions, now = Date.now()) {
    const lastTouch = lastTouchOf(sessions);
    let max = 0;
    for (const s of sessions) max = Math.max(max, ignoredMinutes(s, lastTouch, now) || 0);
    return Math.round(max);
  }

  const TOOL_SUGGESTIONS = ['Agent', 'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'mcp__*'];

  const LAMPS = ['off', 'red', 'amber', 'green'];
  const LAMP_FX = ['none', 'pulse', 'strobe', 'breathe', 'flicker', 'chase', 'police', 'rainbow', 'all', 'sos'];
  const SIGNS = ['h3', 'v3', 'h1', 'h5'];
  const LAMP_SHAPES = ['square', 'round', 'heart', 'star', 'skull'];
  const SIGN_FX = ['none', 'wobble', 'spin', 'rattle', 'cracked', 'neon'];
  const NUMBERS = ['none', 'sessions', 'minutes', 'tasks', 'agents', 'ralph'];
  const SCREEN_FX = ['none', 'vignette', 'confetti', 'spotlight'];
  const POSES = ['none', 'think', 'wave', 'thumbs', 'sleep', 'blink', 'nod', 'bounce', 'look', 'spin', 'party', 'guitar', 'ak47', 'sniper', 'banner', 'bubble', 'tap', 'arms', 'run', 'knock', 'munch', 'kickflip', 'selfie', 'grin', 'smoke', 'zyn', 'line', 'juice', 'dead', 'cheer', 'facepalm'];
  const COSTUMES = ['none', 'dog', 'cat', 'unicorn', 'crown', 'partyhat', 'shades', 'halo', 'devil', 'wizard', 'tophat', 'santa', 'pumpkin', 'bunny', 'headphones', 'graduate', 'chef', 'cowboy', 'propeller', 'detective', 'flowercrown', 'beanie'];
  // Famous faces drawn over Claude's head; independent of costume, so a cameo can wear a hat.
  const CAMEOS = ['none', 'neo', 'alfred', 'mcafee', 'spagni', 'powell', 'baker', 'ellison', 'saylor', 'wizard', 'scientist', 'pirate', 'punk'];
  const CAMEO_ID = /^[a-z0-9-]{1,32}$/;
  // The built-in characters; a rule may also name an installed one (u-…),
  // which the widget shows once it's installed and as Claude until then.
  const BODIES = Characters.ids().filter(Characters.isBuiltin);
  const isBody = (id) => BODIES.includes(id) || (typeof id === 'string' && /^u-[a-z][a-z0-9-]{1,31}$/.test(id));
  const EYE_MOODS = ['heart', 'happy', 'angry', 'sad', 'surprised', 'wink', 'star', 'money', 'sleepy', 'suspicious', 'roll', 'googly', 'dizzy', 'x', 'tears', 'laser', 'loading', 'scan', 'wide', 'content', 'side', 'glow'];
  const EFFECTS = ['none', 'rain', 'sun', 'snow', 'sparkles', 'fire', 'beard', 'garden', 'stars', 'bubbles', 'leaves', 'matrix', 'hearts', 'fireflies', 'rainbow', 'petals'];
  const PETS = ['none', 'duck', 'cat', 'blob', 'dog', 'bunny', 'parrot', 'frog', 'snail', 'dragon'];
  const AGENT_STYLES = ['robot', 'duck', 'blob', 'ghost', 'cat', 'star', 'dot'];
  // What a gesture on the avatar can do. `arg` is free text where noted.
  const ACTIONS = [
    { id: 'jump', label: 'Jump to the session that needs you' },
    { id: 'terminal', label: 'Bring the terminal to the front' },
    { id: 'allow', label: 'Allow the pending permission' },
    { id: 'deny', label: 'Deny the pending permission' },
    { id: 'poke', label: 'Poke him' },
    { id: 'pet', label: 'Pet him' },
    { id: 'feed', label: 'Feed him a cookie' },
    { id: 'lights', label: 'Open Lights' },
    { id: 'stats', label: 'Open Stats' },
    { id: 'finder', label: "Open the session's folder in Finder" },
    { id: 'editor', label: "Open the session's folder in…", arg: 'App name, e.g. Visual Studio Code' },
    { id: 'copy-path', label: "Copy the session's folder path" },
    { id: 'url', label: 'Open a URL', arg: 'https://…' },
    { id: 'shell', label: 'Run a shell command', arg: 'e.g. open -a Slack' },
    { id: 'shortcut', label: 'Run a macOS Shortcut', arg: 'Shortcut name' },
    { id: 'say', label: 'Say something out loud', arg: 'Text to speak' },
    { id: 'snooze', label: 'Hide the widget for 30 minutes' },
    { id: 'none', label: 'Do nothing' },
  ];
  const GESTURES = ['click', 'double', 'alt'];
  const DEFAULT_CLICKS = { click: { type: 'jump' }, double: { type: 'pet' }, alt: { type: 'feed' } };

  // macOS system sounds, by name; 'beep' is the system alert; 'file:<path>' plays a chosen file.
  const SOUNDS = ['beep', 'Glass', 'Pop', 'Funk', 'Hero', 'Submarine', 'Sosumi', 'Blow', 'Ping', 'Purr'];

  // F5 busy/free ─────────────────────────────────────────────────────────────
  // env.busy comes from the app's busy sources (calendar, ICS, Focus): true or
  // false, or null when none is switched on, and then neither signal fires so
  // a 'free' rule can't claim a lamp for someone who never set this up.
  // env.backFromBusy is the short window after a busy spell, while the
  // "While you were away" recap is up.
  SIGNALS.push(
    { id: 'busy', label: "You're busy (calendar or Focus)", hook: null, kind: 'virtual' },
    { id: 'free', label: "You're free (no meeting, no Focus)", hook: null, kind: 'virtual' },
    { id: 'back-from-busy', label: 'Just back from being busy', hook: null, kind: 'virtual' },
  );
  function busySignals(env = {}) {
    const out = [];
    if (env.busy === true) out.push({ signal: 'busy', virtual: true });
    if (env.busy === false) out.push({ signal: 'free', virtual: true });
    if (env.backFromBusy) out.push({ signal: 'back-from-busy', virtual: true });
    return out;
  }
  // A rule's pings (its sound, the notification and the knock for its state)
  // while you're busy. Unset: red comes through, amber and green wait for the
  // recap. 'mine' is red only for cards you own; until the board says who
  // owns what, a session counts as yours unless it carries mine: false.
  const BUSY_PINGS = ['always', 'never', 'mine'];
  function pingsWhileBusy(rule, { lamp = null, session = null } = {}) {
    const mode = rule && rule.then ? rule.then.busyPing : null;
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    const red = ((rule && rule.then && rule.then.lamp) || lamp) === 'red';
    if (mode === 'mine') return red && !(session && session.mine === false);
    return red;
  }
  const F5_EXPORTS = { busySignals, BUSY_PINGS, pingsWhileBusy };

  // Seasonal costume for a date, or null. Applied by the app only when no
  // rule set a costume, and only if the seasonal toggle is on.
  function seasonalCostume(now = Date.now()) {
    const d = new Date(now);
    const m = d.getMonth() + 1, day = d.getDate();
    if (m === 12 && day <= 26) return 'santa';
    if (m === 10 && day >= 24) return 'pumpkin';
    if (m === 1 && day === 1) return 'partyhat';
    if ((m === 3 && day >= 25) || (m === 4 && day <= 20)) return 'bunny';
    return null;
  }
  function seasonalEffect(now = Date.now()) {
    const d = new Date(now);
    return d.getMonth() + 1 === 12 && d.getDate() <= 26 ? 'snow' : null;
  }

  function uid() {
    return Math.random().toString(36).slice(2, 8);
  }

  // The lamp answers one question — do I need to look? Green: working, leave
  // it. Amber: your turn (finished, waiting, or a failed turn to retry). Red:
  // blocked until you act (a permission ask, a limit, no network). Off:
  // nothing running.
  function defaultRules() {
    return placeSpendRules([ // F1 spend
      {
        id: 'limit', name: 'Out of tokens', locked: true, enabled: true,
        when: { signal: ['limit-hit'] },
        then: { lamp: 'red', eyes: 'closed', pose: 'sleep', sound: 'beep' },
      },
      {
        id: 'permission', name: 'Needs your input', locked: true, enabled: true,
        when: { signal: ['permission-ask'] },
        then: { lamp: 'red', pose: 'wave', sound: 'beep' },
      },
      {
        id: 'offline', name: 'No network', enabled: true,
        when: { signal: ['offline'] },
        then: { lamp: 'red', eyes: 'x', pose: 'banner', text: 'OFFLINE', effect: 'rain' },
      },
      ...gitDefaultRules(),
      {
        id: 'subagent', name: 'Subagent running', enabled: true,
        when: { signal: ['tool-use'], tool: 'Agent' },
        then: { eyes: '#8b5cf6' },
      },
      {
        id: 'ralph', name: 'Ralph loop', enabled: true,
        when: { signal: ['ralph'] },
        then: { pose: 'run', number: 'ralph', text: 'LOOP {iteration}' },
      },
      {
        id: 'swarm', name: 'Swarm', enabled: true,
        when: { signal: ['agents-many'] },
        then: { number: 'agents', eyes: '#f2a200' },
      },
      {
        id: 'team', name: 'Team mode', enabled: true,
        when: { signal: ['team'] },
        then: { pet: 'duck' },
      },
      {
        id: 'failed', name: 'A tool just failed', enabled: false,
        when: { signal: ['tool-failed'] },
        then: { eyes: '#e2231a' },
      },
      {
        id: 'shell', name: 'Running a command', enabled: false,
        when: { signal: ['tool-use'], tool: 'Bash' },
        then: { eyes: '#38bdf8' },
      },
      {
        id: 'working', name: 'Claude is working', enabled: true,
        when: { signal: ['prompt-submit', 'tool-use', 'tool-done', 'tool-failed', 'subagent-start', 'subagent-done', 'permission-denied', 'compact'] },
        then: { lamp: 'green', pose: 'think' },
      },
      {
        id: 'failed-turn', name: 'Turn failed', enabled: true,
        when: { signal: ['turn-failed'] },
        then: { lamp: 'amber', eyes: 'dizzy', pose: 'banner', text: '{fail}' },
      },
      {
        id: 'done', name: 'Task finished', enabled: true,
        when: { signal: ['stop'] },
        then: { lamp: 'amber', eyes: '#2fae3e', pose: 'thumbs', celebrate: true },
      },
      {
        id: 'ignored', name: 'Ignored for 20 minutes', enabled: true,
        when: { signal: ['ignored-20'] },
        then: { pose: 'arms', effect: 'beard' },
      },
      {
        id: 'nudge', name: 'Waiting for you', enabled: true,
        when: { signal: ['idle-nudge'] },
        then: { lamp: 'amber', pose: 'none' },
      },
      {
        id: 'started', name: 'Session open, no prompt yet', enabled: true,
        when: { signal: ['session-start'] },
        then: { lamp: 'off', pose: 'none' },
      },
      {
        id: 'idle', name: 'Nothing running', enabled: true,
        when: { signal: ['idle'] },
        then: { lamp: 'off', pose: 'none' },
      },
    ]);
  }

  // Rules added to the defaults after people already had saved configs. Each
  // is slotted in once, keyed by the saved rulesVersion, so deleting one
  // afterwards sticks.
  const RULES_VERSION = 8;
  // v4 recoloured four default lamps (see defaultRules). A saved rule that
  // still has the old default colour, and no custom lampColor, follows.
  const V4_LAMPS = { permission: ['amber', 'red'], done: ['green', 'amber'], nudge: ['green', 'amber'], idle: ['amber', 'off'] };
  // v6: the router's signals went with the router.
  const DEAD_SIGNALS = ['routed-cheap', 'escalated', 'delegated-read'];
  const DEAD_DEFAULT_IDS = ['routed', 'delegated'];
  function migrateRules(rules, version) {
    if (version >= RULES_VERSION) return rules;
    const out = rules.slice();
    const defaults = defaultRules();
    const add = (id, at) => {
      if (out.some((r) => r.id === id)) return;
      out.splice(at < 0 ? out.length : at, 0, normalizeRule(defaults.find((r) => r.id === id)));
    };
    // v2: a lost network and a failed turn got their own rules.
    if (version < 2) {
      add('offline', out.findIndex((r) => !r.locked));
      const done = out.findIndex((r) => r.id === 'done');
      add('failed-turn', done >= 0 ? done : out.findIndex((r) => r.when.signal.includes('idle')));
    }
    // v3: a failed tool or a starting subagent is still mid-turn; without them
    // a second, finished session read as "Task finished" over this one.
    const w = out.findIndex((r) => r.id === 'working');
    if (version < 3 && w >= 0) {
      const missing = ['tool-failed', 'subagent-start'].filter((s) => !out[w].when.signal.includes(s));
      if (missing.length) out[w] = { ...out[w], when: { ...out[w].when, signal: out[w].when.signal.concat(missing) } };
    }
    if (version < 4) {
      for (let i = 0; i < out.length; i += 1) {
        const lamps = V4_LAMPS[out[i].id];
        if (lamps && out[i].then && out[i].then.lamp === lamps[0] && !out[i].then.lampColor) out[i] = { ...out[i], then: { ...out[i].then, lamp: lamps[1] } };
      }
    }
    // v5: a denied tool call is mid-turn (auto mode's classifier said no and
    // Claude carries on), so it stays green instead of dropping the lamp; a
    // session that has only just opened is not working, so it leaves green
    // for its own (idle-looking) rule.
    if (version < 5) {
      if (w >= 0) {
        const signal = out[w].when.signal.filter((x) => x !== 'session-start');
        if (!signal.includes('permission-denied')) signal.push('permission-denied');
        out[w] = { ...out[w], when: { ...out[w].when, signal } };
      }
      add('started', out.findIndex((r) => r.id === 'idle'));
    }
    if (version < 6) {
      const kept = [];
      for (const r of out) {
        const sig = (r.when && r.when.signal) || [];
        const live = sig.filter((x) => !DEAD_SIGNALS.includes(x));
        if (live.length === sig.length) { kept.push(r); continue; }
        if (!live.length && DEAD_DEFAULT_IDS.includes(r.id)) continue;
        kept.push({ ...r, enabled: live.length ? r.enabled : false, when: { ...r.when, signal: live } });
      }
      out.splice(0, out.length, ...kept);
    }
    if (version < 7) addGitRules(add, out); // F2 git/ci
    // v8 (F1 spend): runaway and budget rules.
    if (version < 8) out.splice(0, out.length, ...placeSpendRules(out, SPEND_RULES.map(normalizeRule)));
    return out;
  }

  // Rule sets kept or passed around outside config.json (saved presets, share
  // codes, exported files) carried no rulesVersion before v5. Sharing shipped
  // a day before v2, v2–v4 all followed within that day, and v4 then stood for
  // three weeks, so an unversioned set is read as v4: it gets v5's changes,
  // and v2's re-added rules or v4's recolours can't undo a deliberate choice.
  const LEGACY_RULES_VERSION = 4;
  function rulesVersionOf(carrier) {
    const v = carrier && typeof carrier === 'object' ? carrier.rulesVersion : undefined;
    return v != null && Number.isFinite(Number(v)) ? Number(v) : LEGACY_RULES_VERSION;
  }

  function normalizeRule(r) {
    const signal = Array.isArray(r.when?.signal) ? r.when.signal : r.when?.signal ? [r.when.signal] : [];
    return {
      id: r.id || uid(),
      name: r.name || 'Untitled rule',
      locked: !!r.locked,
      enabled: r.enabled !== false,
      when: { signal, tool: (r.when?.tool || '').trim() || null, cwd: (r.when?.cwd || '').trim() || null, source: (r.when?.source || '').trim().toLowerCase() || null },
      then: {
        lamp: LAMPS.includes(r.then?.lamp) ? r.then.lamp : null,
        lampColor: /^#[0-9a-f]{6}$/i.test(r.then?.lampColor || '') ? r.then.lampColor : null,
        lampFx: LAMP_FX.includes(r.then?.lampFx) ? r.then.lampFx : null,
        sign: SIGNS.includes(r.then?.sign) ? r.then.sign : null,
        lampShape: LAMP_SHAPES.includes(r.then?.lampShape) ? r.then.lampShape : null,
        signFx: SIGN_FX.includes(r.then?.signFx) ? r.then.signFx : null,
        number: NUMBERS.includes(r.then?.number) && r.then.number !== 'none' ? r.then.number : null,
        screenFx: SCREEN_FX.includes(r.then?.screenFx) ? r.then.screenFx : null,
        eyes: r.then?.eyes === 'closed' || EYE_MOODS.includes(r.then?.eyes) || /^#[0-9a-f]{6}$/i.test(r.then?.eyes || '') ? r.then.eyes : (r.then?.eyes === 'default' ? 'default' : null),
        pose: POSES.includes(r.then?.pose) ? r.then.pose : null,
        sound: SOUNDS.includes(r.then?.sound) || /^file:.+/.test(r.then?.sound || '') ? r.then.sound : null,
        celebrate: !!r.then?.celebrate,
        text: typeof r.then?.text === 'string' && r.then.text.trim() ? r.then.text.trim().slice(0, 24) : null,
        costume: COSTUMES.includes(r.then?.costume) ? r.then.costume : null,
        // Built-ins, or a photo cameo the user added (cameos.js ids); a photo
        // that has since been removed just renders as no cameo.
        cameo: typeof r.then?.cameo === 'string' && (CAMEOS.includes(r.then.cameo) || CAMEO_ID.test(r.then.cameo)) ? r.then.cameo : null,
        body: isBody(r.then?.body) ? r.then.body : null,
        bodyColor: /^#[0-9a-f]{6}$/i.test(r.then?.bodyColor || '') ? r.then.bodyColor : null,
        effect: EFFECTS.includes(r.then?.effect) ? r.then.effect : null,
        pet: PETS.includes(r.then?.pet) ? r.then.pet : null,
        agents: AGENT_STYLES.includes(r.then?.agents) ? r.then.agents : null,
        agentsColor: /^#[0-9a-f]{6}$/i.test(r.then?.agentsColor || '') ? r.then.agentsColor : null,
        clicks: normalizeClicks(r.then?.clicks),
        ...(BUSY_PINGS.includes(r.then?.busyPing) ? { busyPing: r.then.busyPing } : {}),
      },
    };
  }

  function normalizeClicks(c) {
    const out = {};
    for (const g of GESTURES) {
      const a = c && c[g];
      if (!a || !ACTIONS.some((x) => x.id === a.type)) continue;
      out[g] = { type: a.type, arg: typeof a.arg === 'string' && a.arg.trim() ? a.arg.trim().slice(0, 500) : null };
    }
    return out;
  }

  // Every shell command and Shortcut a set of rules' clicks would run: what
  // anything imported from someone else must show before it loads.
  // What clicks in someone else's rules would do outside Buddy: shell
  // commands and Shortcuts as written, plus the external URLs they open and
  // the apps they launch on the session's folder.
  function clickCommands(rules) {
    const shown = (a) => {
      if (!a.arg) return null;
      if (a.type === 'shell' || a.type === 'shortcut' || a.type === 'url') return a.arg;
      if (a.type === 'editor') return `open -a ${a.arg} <session folder>`;
      return null;
    };
    return [...new Set(rules.flatMap((r) => Object.values(normalizeRule(r).then.clicks)).map(shown).filter(Boolean))];
  }

  function toolMatches(pattern, tool) {
    if (!pattern) return true;
    if (!tool) return false;
    if (pattern.endsWith('*')) return tool.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
    return tool.toLowerCase() === pattern.toLowerCase();
  }

  // Project scope: matches the folder name (last path segment) or a prefix
  // with `*` — 'bondly*' covers every bondly worktree.
  function cwdMatches(pattern, cwd) {
    if (!pattern) return true;
    if (!cwd) return false;
    const name = String(cwd).split('/').filter(Boolean).pop() || '';
    const p = pattern.toLowerCase();
    return p.endsWith('*') ? name.toLowerCase().startsWith(p.slice(0, -1)) : name.toLowerCase() === p;
  }

  // Rule text can quote live numbers from the session that fired it:
  // '{iteration}' (ralph loop count), '{agents}' (agents on that session) and
  // '{fail}' (why its turn failed).
  const FAIL_TEXT = { network: 'NO NETWORK', limit: 'RATE LIMITED', error: 'FAILED' };
  function fillText(text, session) {
    if (!text || !session) return text || null;
    return text
      .replace(/\{iteration\}/g, String(Number(session.iteration) || 0))
      .replace(/\{agents\}/g, String(Number(session.agents) || 0))
      .replace(/\{fail\}/g, FAIL_TEXT[session.failKind] || FAIL_TEXT.error)
      .replace(/\{burn\}/g, session.burn || '') // F1 spend: '$7.40 in 18 min'
      .replace(/\{budget\}/g, session.budget || '') // F1 spend: '$42.10 of $50 today'
      .slice(0, 24);
  }

  function ruleMatches(rule, session) {
    if (!rule.enabled) return false;
    const sig = sessionSignal(session);
    if (!sig || !rule.when.signal.includes(sig)) return false;
    const src = (session.source || 'claude').toLowerCase();
    if (rule.when.source && rule.when.source !== src) return false;
    return toolMatches(rule.when.tool, session.tool) && cwdMatches(rule.when.cwd, session.cwd);
  }

  // Priority is list order (index 0 wins), except locked rules always sit
  // above unlocked ones — a mis-ordered custom rule can't hide a real block.
  function orderedRules(rules) {
    return rules
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (Number(b.r.locked) - Number(a.r.locked)) || (a.i - b.i))
      .map((x) => x.r);
  }

  // sessions: [{signal, tool, updatedAt, cwd}]. An empty list resolves the
  // virtual 'idle' signal. Rules apply top-down; the first rule that owns the
  // lamp is "the state" and resolution stops there, so a lower rule can never
  // leak its eyes or pose upward (a finished session must not paint green
  // eyes onto a session that is still working). Rules above the lamp owner
  // layer accents: eyes, pose, sound.
  function resolve(rules, sessions, now = Date.now(), env = {}) {
    const list = orderedRules(rules.map(normalizeRule));
    const real = sessions.filter((s) => sessionSignal(s));
    // F1 spend adds nothing on an empty desk (spendSessions needs a live
    // session), so only offline, F5 busy and F2 git ride on idle.
    const live = (real.length ? real.concat(virtualSessions(real, now, env))
      : [{ signal: 'idle' }].concat(env.offline ? [{ signal: 'offline', virtual: true }] : [], busySignals(env))).concat(gitSessions(env));
    const fired = [];
    const look = { lamp: 'off', lampColor: null, lampFx: 'none', sign: 'h3', lampShape: 'square', signFx: 'none', numberOf: null, screenFx: 'none', eyes: 'default', pose: 'none', text: null, costume: 'none', cameo: 'none', body: 'claude', bodyColor: null, effect: 'none', pet: 'none', agents: 'robot', agentsColor: null, sound: null, celebrate: false, name: null, ruleId: null, waitMinutes: waitMinutes(real, now), minions: [], clicks: {} };
    const owned = {};
    for (const rule of list) {
      const matching = live.filter((s) => ruleMatches(rule, s));
      if (!matching.length) continue;
      fired.push(rule.id);
      const t = rule.then;
      if (!owned.eyes && t.eyes) { look.eyes = t.eyes; owned.eyes = rule.id; }
      if (!owned.pose && t.pose) { look.pose = t.pose; look.text = fillText(t.text, matching[0]); owned.pose = rule.id; }
      if (!owned.costume && t.costume) { look.costume = t.costume; owned.costume = rule.id; }
      if (!owned.cameo && t.cameo) { look.cameo = t.cameo; owned.cameo = rule.id; }
      if (!owned.body && t.body) { look.body = t.body; owned.body = rule.id; }
      if (!owned.bodyColor && t.bodyColor) { look.bodyColor = t.bodyColor; owned.bodyColor = rule.id; }
      if (!owned.effect && t.effect) { look.effect = t.effect; owned.effect = rule.id; }
      if (!owned.pet && t.pet) { look.pet = t.pet; owned.pet = rule.id; }
      if (!owned.agents && t.agents) { look.agents = t.agents; owned.agents = rule.id; }
      if (!owned.agentsColor && t.agentsColor) { look.agentsColor = t.agentsColor; owned.agentsColor = rule.id; }
      for (const g of GESTURES) if (!look.clicks[g] && t.clicks[g]) look.clicks[g] = t.clicks[g];
      if (!owned.sound && t.sound) { look.sound = t.sound; owned.sound = rule.id; }
      if (t.celebrate && !owned.celebrate) { look.celebrate = true; owned.celebrate = rule.id; }
      if (!look.name) { look.name = rule.name; look.ruleId = rule.id; }
      if (!owned.lampFx && t.lampFx) { look.lampFx = t.lampFx; owned.lampFx = rule.id; }
      if (!owned.sign && t.sign) { look.sign = t.sign; owned.sign = rule.id; }
      if (!owned.lampShape && t.lampShape) { look.lampShape = t.lampShape; owned.lampShape = rule.id; }
      if (!owned.signFx && t.signFx) { look.signFx = t.signFx; owned.signFx = rule.id; }
      if (!owned.numberOf && t.number) { look.numberOf = t.number; owned.numberOf = rule.id; }
      if (!owned.screenFx && t.screenFx) { look.screenFx = t.screenFx; owned.screenFx = rule.id; }
      if (t.lamp) { look.lamp = t.lamp; look.lampColor = t.lampColor; owned.lamp = rule.id; break; }
    }
    for (const g of GESTURES) if (!look.clicks[g]) look.clicks[g] = DEFAULT_CLICKS[g];
    return { look, fired, owned };
  }

  // Names of the rules that fired, the lamp owner first: look.name is only
  // the top-most rule, which is usually an accent (e.g. "Swarm"), not the
  // state the lamp is actually showing.
  function firedNames(rules, fired, owned) {
    const byId = new Map(rules.map((r) => [r.id, r.name]));
    const lamp = owned && owned.lamp;
    const ids = lamp ? [lamp, ...fired.filter((id) => id !== lamp)] : fired;
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  // The look a single rule would produce on its own — for the editor preview.
  function previewLook(rule) {
    const r = normalizeRule(rule);
    return {
      lamp: r.then.lamp || 'off',
      lampColor: r.then.lampColor,
      lampFx: r.then.lampFx || 'none',
      sign: r.then.sign || 'h3',
      lampShape: r.then.lampShape || 'square',
      signFx: r.then.signFx || 'none',
      numberOf: r.then.number,
      number: r.then.number ? 7 : null,
      screenFx: r.then.screenFx || 'none',
      eyes: r.then.eyes || 'default',
      pose: r.then.pose || 'none',
      text: r.then.text,
      costume: r.then.costume || 'none',
      cameo: r.then.cameo || 'none',
      body: r.then.body || 'claude',
      bodyColor: r.then.bodyColor,
      effect: r.then.effect || 'none',
      pet: r.then.pet || 'none',
      agents: r.then.agents || 'robot',
      agentsColor: r.then.agentsColor,
      waitMinutes: r.then.effect === 'beard' ? 20 : 0,
      sound: r.then.sound,
      celebrate: r.then.celebrate,
    };
  }

  return { AGENT_KINDS, AGENT_STATUSES, MODES, normalizeAgent, liveAgents, filterAgentKinds, sessionMode, ralphIteration, fillText, seasonalCostume, seasonalEffect, ACTIONS, GESTURES, DEFAULT_CLICKS, SIGNALS, TOOL_SUGGESTIONS, LAMPS, LAMP_FX, SIGNS, LAMP_SHAPES, SIGN_FX, NUMBERS, SCREEN_FX, POSES, COSTUMES, CAMEOS, CAMEO_ID, BODIES, EYE_MOODS, EFFECTS, PETS, AGENT_STYLES, SOUNDS, WAITING_ON_YOU, TURN_END, effectiveSignal, presentSignal, TRANSIENT_ASK_MS, AGENT_KEEPALIVE_MS: Machine.AGENT_KEEPALIVE_MS, classifySession: Machine.classify, LONG_RUNNING_MS, defaultRules, RULES_VERSION, LEGACY_RULES_VERSION, rulesVersionOf, migrateRules, normalizeRule, clickCommands, orderedRules, ruleMatches, toolMatches, cwdMatches, resolve, firedNames, previewLook, sessionSignal, virtualSessions, uid, GIT_SIGNALS, gitDefaultRules, gitSessions, SPEND_RULES, placeSpendRules, spendSessions, ...F5_EXPORTS };
});
