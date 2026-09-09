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
    { id: 'idle', label: 'No sessions running', hook: null, kind: 'virtual' },
  ];

  // Virtual signals are derived from the live session set rather than a hook.
  const LONG_RUNNING_MS = 10 * 60 * 1000;
  // Signals that mean Claude is waiting on the person: a permission ask, a
  // limit, or the idle nudge after a finished turn.
  const WAITING = new Set(['permission-ask', 'limit-hit']);
  const WAITING_ON_YOU = new Set(['permission-ask', 'limit-hit', 'idle-nudge']);
  function virtualSessions(sessions, now = Date.now()) {
    const out = [];
    if (sessions.length >= 3) out.push({ signal: 'many-sessions', virtual: true });
    for (const s of sessions) {
      const since = s.workingSince ? new Date(s.workingSince).getTime() : null;
      if (since && now - since > LONG_RUNNING_MS && !WAITING.has(s.signal)) out.push({ signal: 'long-running', cwd: s.cwd, virtual: true });
      if (WAITING_ON_YOU.has(s.signal) && s.updatedAt) {
        const mins = (now - new Date(s.updatedAt).getTime()) / 60000;
        for (const m of [10, 20, 30]) if (mins >= m) out.push({ signal: `ignored-${m}`, cwd: s.cwd, virtual: true });
      }
    }
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
  const POSES = ['none', 'think', 'wave', 'thumbs', 'sleep', 'blink', 'nod', 'bounce', 'look', 'spin', 'party', 'guitar', 'ak47', 'sniper', 'banner', 'bubble', 'tap', 'arms', 'run', 'knock', 'munch'];
  const COSTUMES = ['none', 'dog', 'cat', 'unicorn', 'crown', 'partyhat', 'shades', 'halo', 'devil', 'wizard', 'tophat', 'santa', 'pumpkin', 'bunny'];
  const BODIES = ['claude', 'dog', 'cat', 'frog', 'robot', 'ghost'];
  const EYE_MOODS = ['heart', 'happy', 'angry', 'sad', 'surprised', 'wink', 'star', 'money', 'sleepy', 'suspicious', 'roll', 'googly', 'dizzy', 'x', 'tears', 'laser'];
  const EFFECTS = ['none', 'rain', 'sun', 'snow', 'sparkles', 'fire', 'beard'];
  const PETS = ['none', 'duck', 'cat', 'blob'];
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
      when: { signal, tool: (r.when?.tool || '').trim() || null, cwd: (r.when?.cwd || '').trim() || null },
      then: {
        lamp: LAMPS.includes(r.then?.lamp) ? r.then.lamp : null,
        lampColor: /^#[0-9a-f]{6}$/i.test(r.then?.lampColor || '') ? r.then.lampColor : null,
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
      },
    };
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

  function ruleMatches(rule, session) {
    if (!rule.enabled) return false;
    const sig = sessionSignal(session);
    if (!sig || !rule.when.signal.includes(sig)) return false;
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
    const look = { lamp: 'off', lampColor: null, eyes: 'default', pose: 'none', text: null, costume: 'none', body: 'claude', bodyColor: null, effect: 'none', pet: 'none', sound: null, celebrate: false, name: null, ruleId: null, waitMinutes: waitMinutes(real, now) };
    const owned = {};
    for (const rule of list) {
      const matching = live.filter((s) => ruleMatches(rule, s));
      if (!matching.length) continue;
      fired.push(rule.id);
      const t = rule.then;
      if (!owned.eyes && t.eyes) { look.eyes = t.eyes; owned.eyes = rule.id; }
      if (!owned.pose && t.pose) { look.pose = t.pose; look.text = t.text; owned.pose = rule.id; }
      if (!owned.costume && t.costume) { look.costume = t.costume; owned.costume = rule.id; }
      if (!owned.body && t.body) { look.body = t.body; owned.body = rule.id; }
      if (!owned.bodyColor && t.bodyColor) { look.bodyColor = t.bodyColor; owned.bodyColor = rule.id; }
      if (!owned.effect && t.effect) { look.effect = t.effect; owned.effect = rule.id; }
      if (!owned.pet && t.pet) { look.pet = t.pet; owned.pet = rule.id; }
      if (!owned.sound && t.sound) { look.sound = t.sound; owned.sound = rule.id; }
      if (t.celebrate && !owned.celebrate) { look.celebrate = true; owned.celebrate = rule.id; }
      if (!look.name) { look.name = rule.name; look.ruleId = rule.id; }
      if (t.lamp) { look.lamp = t.lamp; look.lampColor = t.lampColor; owned.lamp = rule.id; break; }
    }
    return { look, fired, owned };
  }

  // The look a single rule would produce on its own — for the editor preview.
  function previewLook(rule) {
    const r = normalizeRule(rule);
    return {
      lamp: r.then.lamp || 'off',
      lampColor: r.then.lampColor,
      eyes: r.then.eyes || 'default',
      pose: r.then.pose || 'none',
      text: r.then.text,
      costume: r.then.costume || 'none',
      body: r.then.body || 'claude',
      bodyColor: r.then.bodyColor,
      effect: r.then.effect || 'none',
      pet: r.then.pet || 'none',
      waitMinutes: r.then.effect === 'beard' ? 20 : 0,
      sound: r.then.sound,
      celebrate: r.then.celebrate,
    };
  }

  return { seasonalCostume, seasonalEffect, SIGNALS, TOOL_SUGGESTIONS, LAMPS, POSES, COSTUMES, BODIES, EYE_MOODS, EFFECTS, PETS, SOUNDS, WAITING_ON_YOU, LONG_RUNNING_MS, defaultRules, normalizeRule, resolve, previewLook, sessionSignal, virtualSessions, uid };
});
