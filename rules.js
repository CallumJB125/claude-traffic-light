// The rules engine: turns raw hook signals into a resolved "look" for the
// widget. Shared by main.js (require) and the Lights editor (<script src>),
// so the preview in the editor and the real widget can never disagree.
//
// A session file carries a raw signal ({signal, tool, updatedAt, cwd}). A
// rule says: when this signal (optionally from this tool) is live in any
// session, set these visual channels. Rules apply top-down; the first rule
// that lights a lamp is the state, and rules above it may layer accents — so
// "subagent running" can recolour the eyes while "working" owns the lamp.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrafficLightRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SIGNALS = [
    { id: 'prompt-submit', label: 'You send a prompt', hook: 'UserPromptSubmit', kind: 'working' },
    { id: 'tool-use', label: 'Claude uses a tool', hook: 'PreToolUse', kind: 'working', tool: true },
    { id: 'tool-done', label: 'A tool finishes', hook: 'PostToolUse', kind: 'working', tool: true },
    { id: 'tool-failed', label: 'A tool fails', hook: 'PostToolUseFailure', kind: 'working', tool: true },
    { id: 'subagent-start', label: 'A subagent starts', hook: 'SubagentStart', kind: 'working' },
    { id: 'subagent-done', label: 'A subagent finishes', hook: 'SubagentStop', kind: 'working' },
    { id: 'permission-denied', label: 'You deny a permission', hook: 'PermissionDenied', kind: 'working' },
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
    { id: 'routed-cheap', label: 'Session routed to a cheaper model', hook: null, kind: 'virtual' },
    { id: 'escalated', label: 'You switched a routed session up a model', hook: null, kind: 'virtual' },
    { id: 'delegated-read', label: 'Buddy delegated a big read', hook: null, kind: 'virtual' },
    { id: 'idle', label: 'No sessions running', hook: null, kind: 'virtual' },
  ];

  // Virtual signals are derived from the live session set rather than a hook.
  const LONG_RUNNING_MS = 10 * 60 * 1000;
  // Signals that mean Claude is waiting on the person: a permission ask, a
  // limit, a finished turn, or the idle nudge that follows it.
  const WAITING = new Set(['permission-ask', 'limit-hit']);
  const WAITING_ON_YOU = new Set(['permission-ask', 'limit-hit', 'idle-nudge', 'stop']);
  // Signals that close a turn: the working-since clock stops on any of them.
  const TURN_END = new Set(['stop', 'idle-nudge', 'permission-ask', 'limit-hit', 'session-start', 'turn-failed', 'permission-denied']);
  // A turn that has ended while its subagents are still working hasn't really
  // ended; only a finished/idle turn is promoted — a permission ask or a limit
  // still needs the person whatever the agents are doing.
  const PROMOTABLE_TURN_END = new Set(['stop', 'idle-nudge']);
  // ── Other agents ──────────────────────────────────────────────────────────
  // A session file may carry `agents` (every subagent / teammate / ralph or
  // ultrawork worker it knows about) and `mode` (the OMC execution mode).
  // Anything that has finished stops counting as live.
  const AGENT_KINDS = ['subagent', 'teammate', 'ralph', 'ultrawork'];
  const AGENT_STATUSES = ['working', 'waiting', 'done'];
  const MODES = ['ralph', 'team', 'ultrawork'];
  // Router picks below Opus; a session carrying one fires 'routed-cheap'.
  const CHEAP_ROUTES = new Set(['sonnet', 'haiku']);
  // 'delegated-read' holds this long after the delegate hook last narrowed,
  // denied or trimmed something in a session (its `delegated.at`).
  const DELEGATED_MS = 10 * 1000;

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

  // The signal a session should be read as: a finished turn with a subagent
  // still working is presented as that agent's tool use, so the working rules
  // (and "Subagent running") keep firing instead of "Task finished".
  function effectiveSignal(session) {
    const signal = sessionSignal(session);
    const tool = session.tool || null;
    if (PROMOTABLE_TURN_END.has(signal) && liveAgents([session]).some((a) => a.status === 'working')) {
      return { signal: 'tool-use', tool: 'Agent', turnSignal: signal };
    }
    return { signal, tool, turnSignal: null };
  }

  // A permission ask that only came from a Notification can be resolved by
  // auto mode's classifier within a second, so the widget sits it out for
  // this long first. A blocking PermissionRequest (askKind 'request' or still
  // in the pending list) and an AskUserQuestion are real waits and show at once.
  const TRANSIENT_ASK_MS = 1200;

  // The signal the widget should show for a session right now.
  function presentSignal(session, now = Date.now(), pendingIds = []) {
    const signal = sessionSignal(session);
    if (signal !== 'permission-ask') return signal;
    if (session.askKind === 'question' || session.askKind === 'request') return signal;
    if ([...pendingIds].includes(session.sessionId)) return signal;
    const since = Date.parse(session.signalSince || session.updatedAt || '');
    if (!since || now - since >= TRANSIENT_ASK_MS) return signal;
    return session.prevSignal && session.prevSignal !== 'permission-ask' ? session.prevSignal : 'tool-use';
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

  function virtualSessions(sessions, now = Date.now()) {
    const out = [];
    if (sessions.length >= 3) out.push({ signal: 'many-sessions', virtual: true });
    let agentTotal = 0;
    // "Ignored" means you haven't touched *any* Claude, not just this one: a
    // session left waiting this morning must not nag while you're busy in a
    // newer terminal.
    const lastTouch = Math.max(0, ...sessions.map((s) => (s.updatedAt ? new Date(s.updatedAt).getTime() : 0)));
    for (const s of sessions) {
      const since = s.workingSince ? new Date(s.workingSince).getTime() : null;
      if (since && now - since > LONG_RUNNING_MS && !WAITING.has(s.signal)) out.push({ signal: 'long-running', cwd: s.cwd, virtual: true });
      if (WAITING_ON_YOU.has(s.signal) && s.updatedAt) {
        const mins = (now - Math.max(new Date(s.updatedAt).getTime(), lastTouch)) / 60000;
        for (const m of [10, 20, 30]) if (mins >= m) out.push({ signal: `ignored-${m}`, cwd: s.cwd, virtual: true });
      }
      const agents = liveAgents([s]);
      agentTotal += agents.length;
      const mode = sessionMode(s);
      if (agents.some((a) => a.kind === 'subagent')) out.push({ signal: 'subagents', cwd: s.cwd, virtual: true, agents: agents.length });
      if (mode === 'team' || agents.some((a) => a.kind === 'teammate')) out.push({ signal: 'team', cwd: s.cwd, virtual: true, agents: agents.length });
      if (mode === 'ralph') out.push({ signal: 'ralph', cwd: s.cwd, virtual: true, agents: agents.length, iteration: Number(s.iteration) || 0 });
      if (s.escalated) out.push({ signal: 'escalated', cwd: s.cwd, virtual: true });
      else if (s.route && CHEAP_ROUTES.has(s.route.model)) out.push({ signal: 'routed-cheap', cwd: s.cwd, virtual: true });
      const delegatedAt = s.delegated && Date.parse(s.delegated.at || '');
      if (delegatedAt && now - delegatedAt < DELEGATED_MS) out.push({ signal: 'delegated-read', cwd: s.cwd, virtual: true });
    }
    if (agentTotal >= 3) out.push({ signal: 'agents-many', virtual: true, agents: agentTotal });
    return out;
  }
  // Longest anyone has been kept waiting, in minutes (0 when nobody is).
  function waitMinutes(sessions, now = Date.now()) {
    let max = 0;
    for (const s of sessions) if (WAITING_ON_YOU.has(s.signal) && s.updatedAt) max = Math.max(max, (now - new Date(s.updatedAt).getTime()) / 60000);
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
  const POSES = ['none', 'think', 'wave', 'thumbs', 'sleep', 'blink', 'nod', 'bounce', 'look', 'spin', 'party', 'guitar', 'ak47', 'sniper', 'banner', 'bubble', 'tap', 'arms', 'run', 'knock', 'munch', 'kickflip', 'selfie', 'grin', 'smoke', 'zyn', 'line', 'juice', 'dead'];
  const COSTUMES = ['none', 'dog', 'cat', 'unicorn', 'crown', 'partyhat', 'shades', 'halo', 'devil', 'wizard', 'tophat', 'santa', 'pumpkin', 'bunny'];
  const BODIES = ['claude', 'dog', 'cat', 'frog', 'robot', 'ghost'];
  const EYE_MOODS = ['heart', 'happy', 'angry', 'sad', 'surprised', 'wink', 'star', 'money', 'sleepy', 'suspicious', 'roll', 'googly', 'dizzy', 'x', 'tears', 'laser'];
  const EFFECTS = ['none', 'rain', 'sun', 'snow', 'sparkles', 'fire', 'beard', 'garden'];
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

  // Legacy session files (pre-rules) wrote a colour instead of a signal.
  const LEGACY_STATE_TO_SIGNAL = { green: 'tool-use', amber: 'permission-ask', red: 'limit-hit', done: 'stop' };

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

  // Reproduces the pre-rules behaviour exactly, plus one showcase rule for the
  // eyes channel so a new user can see what the extra channel is for.
  function defaultRules() {
    return [
      {
        id: 'limit', name: 'Out of tokens', locked: true, enabled: true,
        when: { signal: ['limit-hit'] },
        then: { lamp: 'red', eyes: 'closed', pose: 'sleep', sound: 'beep' },
      },
      {
        id: 'permission', name: 'Needs your input', locked: true, enabled: true,
        when: { signal: ['permission-ask'] },
        then: { lamp: 'amber', pose: 'wave', sound: 'beep' },
      },
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
        when: { signal: ['prompt-submit', 'tool-use', 'tool-done', 'subagent-done', 'session-start', 'compact'] },
        then: { lamp: 'green', pose: 'think' },
      },
      {
        id: 'done', name: 'Task finished', enabled: true,
        when: { signal: ['stop'] },
        then: { lamp: 'green', eyes: '#2fae3e', pose: 'thumbs', celebrate: true },
      },
      {
        id: 'ignored', name: 'Ignored for 20 minutes', enabled: true,
        when: { signal: ['ignored-20'] },
        then: { pose: 'arms', effect: 'beard' },
      },
      {
        id: 'nudge', name: 'Waiting for you', enabled: true,
        when: { signal: ['idle-nudge'] },
        then: { lamp: 'green', pose: 'none' },
      },
      {
        id: 'idle', name: 'Nothing running', enabled: true,
        when: { signal: ['idle'] },
        then: { lamp: 'amber', pose: 'none' },
      },
    ];
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
        body: BODIES.includes(r.then?.body) ? r.then.body : null,
        bodyColor: /^#[0-9a-f]{6}$/i.test(r.then?.bodyColor || '') ? r.then.bodyColor : null,
        effect: EFFECTS.includes(r.then?.effect) ? r.then.effect : null,
        pet: PETS.includes(r.then?.pet) ? r.then.pet : null,
        agents: AGENT_STYLES.includes(r.then?.agents) ? r.then.agents : null,
        agentsColor: /^#[0-9a-f]{6}$/i.test(r.then?.agentsColor || '') ? r.then.agentsColor : null,
        clicks: normalizeClicks(r.then?.clicks),
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

  function toolMatches(pattern, tool) {
    if (!pattern) return true;
    if (!tool) return false;
    if (pattern.endsWith('*')) return tool.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
    return tool.toLowerCase() === pattern.toLowerCase();
  }

  function sessionSignal(session) {
    if (session.signal) return session.signal;
    return LEGACY_STATE_TO_SIGNAL[session.state] || null;
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
  // '{iteration}' (ralph loop count) and '{agents}' (agents on that session).
  function fillText(text, session) {
    if (!text || !session) return text || null;
    return text
      .replace(/\{iteration\}/g, String(Number(session.iteration) || 0))
      .replace(/\{agents\}/g, String(Number(session.agents) || 0))
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
  function resolve(rules, sessions, now = Date.now()) {
    const list = orderedRules(rules.map(normalizeRule));
    const real = sessions.filter((s) => sessionSignal(s));
    const live = real.length ? real.concat(virtualSessions(real, now)) : [{ signal: 'idle' }];
    const fired = [];
    const look = { lamp: 'off', lampColor: null, lampFx: 'none', sign: 'h3', lampShape: 'square', signFx: 'none', numberOf: null, screenFx: 'none', eyes: 'default', pose: 'none', text: null, costume: 'none', body: 'claude', bodyColor: null, effect: 'none', pet: 'none', agents: 'robot', agentsColor: null, sound: null, celebrate: false, name: null, ruleId: null, waitMinutes: waitMinutes(real, now), minions: [], clicks: {} };
    const owned = {};
    for (const rule of list) {
      const matching = live.filter((s) => ruleMatches(rule, s));
      if (!matching.length) continue;
      fired.push(rule.id);
      const t = rule.then;
      if (!owned.eyes && t.eyes) { look.eyes = t.eyes; owned.eyes = rule.id; }
      if (!owned.pose && t.pose) { look.pose = t.pose; look.text = fillText(t.text, matching[0]); owned.pose = rule.id; }
      if (!owned.costume && t.costume) { look.costume = t.costume; owned.costume = rule.id; }
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

  return { AGENT_KINDS, AGENT_STATUSES, MODES, normalizeAgent, liveAgents, filterAgentKinds, sessionMode, ralphIteration, fillText, seasonalCostume, seasonalEffect, ACTIONS, GESTURES, DEFAULT_CLICKS, SIGNALS, TOOL_SUGGESTIONS, LAMPS, LAMP_FX, SIGNS, LAMP_SHAPES, SIGN_FX, NUMBERS, SCREEN_FX, POSES, COSTUMES, BODIES, EYE_MOODS, EFFECTS, PETS, AGENT_STYLES, SOUNDS, WAITING_ON_YOU, TURN_END, effectiveSignal, presentSignal, TRANSIENT_ASK_MS, LONG_RUNNING_MS, DELEGATED_MS, defaultRules, normalizeRule, resolve, firedNames, previewLook, sessionSignal, virtualSessions, uid };
});
