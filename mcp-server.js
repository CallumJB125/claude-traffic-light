#!/usr/bin/env node
// Claude Buddy's MCP server: lets any Claude Code session ask "what is the
// widget showing, and why?" without reading session files and app.log by hand.
//
// Runs standalone over stdio (`node mcp-server.js`) — no Electron. It reads
// what main.js reads straight off disk (sessions/, requests/, config.json,
// app.log, router/) and resolves the look with the same rules.js. What only
// the running app knows (a Lights preview, the walk to your terminal, the
// OS's online flag) comes from its GET /status endpoint when it is up.
//
// Every export below is a plain function of { root, now } so tests can run
// them against fixture directories; main() only wires them to the SDK.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Rules = require('./rules.js');

const DEFAULTS = {
  workingStaleMinutes: 6,
  waitingStaleHours: 4,
  seasonal: true,
  askFromWidget: false,
  showTasks: true,
  showAgents: true,
  agentKinds: { subagent: true, teammate: true, ralph: true, ultrawork: true },
  routerPolicy: 'balanced',
  routerProjects: {},
};
// main.js drops a request this old: the hook has long since timed out.
const REQUEST_MAX_AGE_MS = 90000;
const OVERRIDE_SIGNALS = { green: 'tool-use', amber: 'permission-ask', red: 'limit-hit' };
const AGENT_KEEPALIVE_MS = 6 * 60 * 60 * 1000;
const CHANNELS = ['lamp', 'lampFx', 'sign', 'lampShape', 'signFx', 'numberOf', 'screenFx', 'eyes', 'pose', 'costume', 'cameo', 'body', 'bodyColor', 'effect', 'pet', 'agents', 'agentsColor', 'sound', 'celebrate'];
// A rule's `then` key → the look channel it fills (only `number` differs).
const THEN_KEY = { numberOf: 'number' };

function rootDir(env = process.env) {
  return env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// main.js buildConfig(), limited to what these tools read — the rules get the
// same defaults and migrations, so they resolve exactly as the widget's do.
function loadConfig(root) {
  const saved = readJson(path.join(root, 'config.json')) || {};
  const config = { ...DEFAULTS, ...saved };
  config.agentKinds = { ...DEFAULTS.agentKinds, ...(saved.agentKinds && typeof saved.agentKinds === 'object' ? saved.agentKinds : {}) };
  config.rules = (Array.isArray(saved.rules) ? saved.rules : Rules.defaultRules()).map(Rules.normalizeRule);
  if (!config.rules.some((r) => r.when.signal.includes('idle-nudge'))) {
    const nudge = Rules.defaultRules().find((r) => r.id === 'nudge');
    const at = config.rules.findIndex((r) => r.when.signal.includes('idle'));
    config.rules.splice(at < 0 ? config.rules.length : at, 0, Rules.normalizeRule(nudge));
  }
  if (Array.isArray(saved.rules)) config.rules = Rules.migrateRules(config.rules, Number(saved.rulesVersion) || 0);
  return config;
}

function readRequests(root, now = Date.now()) {
  const dir = path.join(root, 'requests');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const r = readJson(path.join(dir, f));
    if (!r || now - new Date(r.createdAt).getTime() > REQUEST_MAX_AGE_MS) continue;
    out.push(r);
  }
  return out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

// The widget's Allow/Deny (main.js answerRequest): the blocked hook in
// hooks/set-status.js polls for `<id>.answer` and hands its text to Claude Code.
function answerRequest(root, id, decision) {
  id = String(id || '');
  decision = String(decision || '');
  if (!/^[\w.-]+$/.test(id)) return { ok: false, error: 'bad request id' };
  if (!['allow', 'deny'].includes(decision)) return { ok: false, error: 'decision must be "allow" or "deny"' };
  const dir = path.join(root, 'requests');
  if (!fs.existsSync(path.join(dir, `${id}.json`))) return { ok: false, error: 'no such pending request (answered, timed out, or never existed)' };
  fs.writeFileSync(path.join(dir, `${id}.answer`), decision);
  return { ok: true, id, decision };
}

function readManualOverride(root, now = Date.now()) {
  const data = readJson(path.join(root, 'manual-override.json'));
  if (!data || (data.expiresAt && now > data.expiresAt)) return null;
  return data;
}

// main.js readSessions(), one file at a time and without dropping anything:
// a file the widget ignores comes back with `live: false` and why, which is
// usually the answer to "why isn't that session showing?".
function classifySession(data, config, now, pendingIds = []) {
  const signal = Rules.sessionSignal(data);
  if (!signal) return { live: false, dropped: 'no signal', signal: null };
  const presented = Rules.presentSignal(data, now, pendingIds);
  const held = presented !== signal;
  const eff = Rules.effectiveSignal({ ...data, signal: presented });
  const source = held ? 'hysteresis-held' : eff.turnSignal ? 'promoted-agents' : (data.via || 'hook signal');
  const workingStaleMs = config.workingStaleMinutes * 60 * 1000;
  if (eff.turnSignal) {
    let last = Math.max(Date.parse(data.updatedAt || '') || 0, Date.parse(data.agentsAt || '') || 0);
    let keepAlive = -Infinity;
    (Array.isArray(data.agents) ? data.agents : []).forEach((a, i) => {
      const n = Rules.normalizeAgent(a, i);
      if (!n || n.status !== 'working') return;
      const since = Date.parse(n.since || '') || 0;
      last = Math.max(last, since);
      if (since && now - since < AGENT_KEEPALIVE_MS) keepAlive = Math.max(keepAlive, AGENT_KEEPALIVE_MS - (now - since));
    });
    const staleInMs = Math.max(workingStaleMs - (now - last), keepAlive);
    const session = { ...data, ...eff };
    return staleInMs < 0
      ? { live: false, dropped: 'stale: finished turn whose working agents went quiet', signal, presented: eff.signal, held, source, staleInMs, session }
      : { live: true, signal, presented: eff.signal, held, source, staleInMs, session };
  }
  const staleAfter = Rules.WAITING_ON_YOU.has(signal) ? config.waitingStaleHours * 3600000 : workingStaleMs;
  const staleInMs = staleAfter - (now - new Date(data.updatedAt).getTime());
  const session = { ...data, signal: presented };
  return staleInMs < 0
    ? { live: false, dropped: `stale: no update for over ${Rules.WAITING_ON_YOU.has(signal) ? `${config.waitingStaleHours} h (waiting signal)` : `${config.workingStaleMinutes} min (working signal)`}`, signal, presented, held, source, staleInMs, session }
    : { live: true, signal, presented, held, source, staleInMs: Number.isNaN(staleInMs) ? null : staleInMs, session };
}

function scanSessions(root, config, now = Date.now(), pendingIds = []) {
  const dir = path.join(root, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  return files.map((file) => {
    const data = readJson(path.join(dir, file));
    if (!data) return { file, live: false, dropped: 'unreadable (partial write?)' };
    return { file, data, ...classifySession(data, config, now, pendingIds) };
  });
}

function sumTasks(sessions) {
  let created = 0, done = 0;
  for (const s of sessions) if (s.tasks) { created += s.tasks.created || 0; done += s.tasks.done || 0; }
  return { created, done };
}

function currentTool(sessions) {
  if (sessions.some((s) => s.signal === 'permission-ask' && s.askKind === 'question')) return 'asking you a question';
  let best = null;
  for (const s of sessions) {
    if ((s.signal !== 'tool-use' && s.signal !== 'tool-done') || !s.tool) continue;
    if (!best || (Date.parse(s.updatedAt || '') || 0) > (Date.parse(best.updatedAt || '') || 0)) best = s;
  }
  return best ? best.tool : null;
}

// Electron's net.isOnline() is not available here; an up, non-loopback
// interface is the same question asked of the OS.
function guessOnline() {
  return Object.values(os.networkInterfaces()).some((list) => (list || []).some((i) => !i.internal));
}

// main.js computeState(), minus what only the running app holds (preview,
// travel, router advice): manual override → pending ask → the rules.
function computeState({ root, now = Date.now(), online = guessOnline() }) {
  const config = loadConfig(root);
  const requests = readRequests(root, now);
  const scanned = scanSessions(root, config, now, requests.map((r) => r.sessionId));
  const sessions = scanned.filter((s) => s.live).map((s) => s.session);
  const pending = config.askFromWidget ? requests : [];
  const tasks = config.showTasks ? sumTasks(sessions.filter((s) => !Rules.WAITING_ON_YOU.has(s.signal) && s.signal !== 'idle-nudge')) : null;
  const env = { offline: !online };
  const base = { config, requests, scanned, sessions, pending, tasks, online, env };
  const override = readManualOverride(root, now);
  if (override) {
    const { look, fired, owned } = Rules.resolve(config.rules, [{ signal: OVERRIDE_SIGNALS[override.state] || 'idle', cwd: '' }]);
    return { ...base, look, fired, owned, reason: 'manual', override };
  }
  const { look, fired, owned } = Rules.resolve(config.rules, sessions, now, env);
  if (config.seasonal) {
    if (look.costume === 'none') look.costume = Rules.seasonalCostume() || 'none';
    if (look.effect === 'none') look.effect = Rules.seasonalEffect() || 'none';
  }
  if (pending.length) {
    const asked = Rules.resolve(config.rules, [{ signal: 'permission-ask', cwd: pending[0].cwd }]);
    return { ...base, look: asked.look, fired: asked.fired, owned: asked.owned, reason: 'pending-permission', sessionResolution: { fired, owned } };
  }
  return { ...base, look, fired, owned, reason: sessions.length ? 'session' : 'idle' };
}

const ruleName = (rules, id) => (rules.find((r) => r.id === id) || {}).name || null;

function fetchLive(port = Number(process.env.CLAUDE_TRAFFIC_LIGHT_PORT || 47172), timeoutMs = 400) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const pickLook = (look) => (look ? { lamp: look.lamp, lampColor: look.lampColor, pose: look.pose, text: look.text, eyes: look.eyes, costume: look.costume, effect: look.effect, pet: look.pet, cameo: look.cameo, body: look.body, sign: look.sign, number: look.number ?? null, name: look.name, ruleId: look.ruleId } : null);

async function buddyStatus({ root, now = Date.now(), online, live } = {}) {
  const st = computeState({ root, now, online });
  const { rules } = st.config;
  const channels = {};
  for (const ch of CHANNELS) {
    const id = st.owned[ch];
    channels[ch] = { value: st.look[ch], ruleId: id || null, rule: id ? ruleName(rules, id) : null };
  }
  const liveStatus = live === undefined ? await fetchLive() : live;
  const look = pickLook(st.look);
  const liveLook = liveStatus ? pickLook(liveStatus.look) : null;
  return {
    look,
    reason: st.reason,
    channels,
    lampOwner: st.owned.lamp ? { ruleId: st.owned.lamp, rule: ruleName(rules, st.owned.lamp) } : null,
    fired: st.fired,
    firedNames: Rules.firedNames(rules, st.fired, st.owned),
    sessionCount: st.sessions.length,
    agentCount: Rules.liveAgents(st.sessions).length,
    currentTool: currentTool(st.sessions),
    tasks: st.tasks,
    pendingRequests: st.pending.length,
    manualOverride: st.override || null,
    online: { value: st.online, source: 'network interfaces (the app uses Electron net.isOnline)' },
    app: liveStatus
      ? { running: true, look: liveLook, agrees: ['lamp', 'pose', 'eyes', 'costume', 'effect', 'pet', 'cameo'].every((k) => liveLook[k] === look[k]) }
      : { running: false, note: 'widget not reachable on its local /status endpoint; look computed from disk only' },
    note: 'Computed from disk with rules.js. If app.agrees is false, the widget is showing something only it knows: a Lights preview, the walk to your terminal, or a different online state.',
  };
}

function buddySessions({ root, now = Date.now() } = {}) {
  const config = loadConfig(root);
  const requests = readRequests(root, now);
  return {
    now: new Date(now).toISOString(),
    sessions: scanSessions(root, config, now, requests.map((r) => r.sessionId)).map((s) => {
      if (!s.data) return { file: s.file, live: false, dropped: s.dropped };
      const d = s.data;
      const updated = Date.parse(d.updatedAt || '');
      return {
        file: s.file,
        sessionId: d.sessionId || null,
        source: d.source || 'claude',
        cwd: d.cwd || null,
        live: s.live,
        dropped: s.dropped || undefined,
        signal: s.signal,
        presented: s.presented,
        held: s.held || undefined,
        via: s.source,
        tool: s.session ? s.session.tool || null : null,
        askKind: d.askKind || undefined,
        failKind: d.failKind || undefined,
        mode: d.mode || null,
        iteration: d.iteration ?? null,
        tasks: d.tasks || null,
        agents: (Array.isArray(d.agents) ? d.agents : []).map((a, i) => {
          const n = Rules.normalizeAgent(a, i);
          if (!n) return null;
          const since = Date.parse(n.since || '');
          return { ...n, heartbeatAgoMs: since ? now - since : null };
        }).filter(Boolean),
        updatedAt: d.updatedAt || null,
        ageMs: updated ? now - updated : null,
        workingSince: d.workingSince || null,
        staleInMs: s.staleInMs ?? null,
      };
    }),
  };
}

function summariseRule(r, i) {
  const then = Object.fromEntries(Object.entries(r.then).filter(([k, v]) => (k === 'clicks' ? Object.keys(v).length : v != null && v !== false)));
  const when = Object.fromEntries(Object.entries(r.when).filter(([, v]) => (Array.isArray(v) ? v.length : v != null)));
  return { priority: i, id: r.id, name: r.name, enabled: r.enabled, locked: r.locked, when, then };
}

function buddyRules({ root } = {}) {
  const { rules } = loadConfig(root);
  return { note: 'In priority order (locked rules sit above unlocked ones). The first matching rule with a lamp stops resolution.', rules: Rules.orderedRules(rules).map(summariseRule) };
}

// Whether `rule` would match each entry, and if not, which clause failed.
function matchReport(rule, entry) {
  const r = { ...rule, enabled: true };
  const sig = Rules.sessionSignal(entry);
  const failed = [];
  if (!sig || !r.when.signal.includes(sig)) failed.push(`signal ${sig || 'none'} not in [${r.when.signal.join(', ')}]`);
  if (r.when.source && r.when.source !== (entry.source || 'claude').toLowerCase()) failed.push(`source ${entry.source || 'claude'} ≠ ${r.when.source}`);
  if (!Rules.toolMatches(r.when.tool, entry.tool)) failed.push(`tool ${entry.tool || 'none'} ≠ ${r.when.tool}`);
  if (!Rules.cwdMatches(r.when.cwd, entry.cwd)) failed.push(`project ${String(entry.cwd || '').split('/').filter(Boolean).pop() || 'none'} ≠ ${r.when.cwd}`);
  return { sessionId: entry.sessionId || null, signal: sig, cwd: entry.cwd || null, tool: entry.tool || null, virtual: !!entry.virtual, matches: Rules.ruleMatches(r, entry), failed };
}

function buddyWhy({ root, now = Date.now(), online, query } = {}) {
  const st = computeState({ root, now, online });
  const { rules } = st.config;
  const ordered = Rules.orderedRules(rules);
  const q = String(query || '').trim();
  const ql = q.toLowerCase();
  const channel = CHANNELS.find((c) => c.toLowerCase() === ql);
  // What the rules were resolved against: the real sessions plus the virtual
  // signals rules.js derives from them (or 'idle' when there are none).
  const entries = st.reason === 'manual' ? [{ signal: OVERRIDE_SIGNALS[st.override.state] || 'idle', cwd: '' }]
    : st.reason === 'pending-permission' ? [{ signal: 'permission-ask', cwd: st.pending[0].cwd }]
    : st.sessions.length ? st.sessions.concat(Rules.virtualSessions(st.sessions, now, st.env))
    : [{ signal: 'idle' }].concat(st.env.offline ? [{ signal: 'offline', virtual: true }] : []);
  const context = { reason: st.reason, lampOwner: st.owned.lamp ? { ruleId: st.owned.lamp, rule: ruleName(rules, st.owned.lamp) } : null, resolvedAgainst: entries.map((e) => ({ sessionId: e.sessionId || null, signal: Rules.sessionSignal(e), cwd: e.cwd || null, tool: e.tool || null, virtual: !!e.virtual })) };
  if (st.reason === 'manual') context.note = 'A manual tray override is active; it replaces every session until it expires.';
  if (st.reason === 'pending-permission') context.note = 'A pending permission request forces the "permission-ask" state, whatever the session files say.';

  if (channel) {
    const ownerId = st.owned[channel] || null;
    const key = THEN_KEY[channel] || channel;
    const setters = ordered.map((r, i) => ({ r, i })).filter(({ r }) => r.then[key] != null && r.then[key] !== false);
    return {
      kind: 'channel',
      channel,
      value: st.look[channel],
      owner: ownerId ? { ruleId: ownerId, rule: ruleName(rules, ownerId) } : null,
      ...(ownerId ? {} : { note: 'No rule set this channel; it shows the default (or a seasonal fill for costume/effect).' }),
      candidates: setters.map(({ r, i }) => {
        const matching = entries.filter((e) => r.enabled && Rules.ruleMatches(r, e)).length;
        const fired = st.fired.includes(r.id);
        const verdict = r.id === ownerId ? 'owns it'
          : !r.enabled ? 'disabled'
          : !matching ? 'no matching session'
          : fired ? 'fired, but a higher-priority rule already owns this channel'
          : 'matches, but resolution stopped at a higher rule that owns the lamp';
        return { priority: i, ruleId: r.id, rule: r.name, sets: r.then[key], verdict };
      }),
      context,
    };
  }

  const rule = rules.find((r) => r.id === q) || rules.find((r) => r.name.toLowerCase() === ql) || rules.find((r) => r.name.toLowerCase().includes(ql));
  if (!q || !rule) {
    return { kind: 'unknown', query: q, error: `no rule or channel called "${q}"`, channels: CHANNELS, rules: ordered.map((r) => ({ id: r.id, name: r.name })) };
  }
  const priority = ordered.indexOf(rule);
  const matches = entries.map((e) => matchReport(rule, e));
  const anyMatch = matches.some((m) => m.matches);
  const fired = st.fired.includes(rule.id);
  const sets = CHANNELS.filter((c) => { const v = rule.then[THEN_KEY[c] || c]; return v != null && v !== false; });
  const owns = sets.filter((c) => st.owned[c] === rule.id);
  const shadowed = sets.filter((c) => st.owned[c] && st.owned[c] !== rule.id).map((c) => ({ channel: c, ownedBy: st.owned[c], rule: ruleName(rules, st.owned[c]) }));
  const lampOwnerPriority = st.owned.lamp ? ordered.findIndex((r) => r.id === st.owned.lamp) : -1;
  const verdict = !rule.enabled ? (anyMatch ? 'disabled (would match if enabled)' : 'disabled')
    : !anyMatch ? 'not firing: no session matches its "when"'
    : !fired ? `not reached: resolution stopped at the lamp owner "${ruleName(rules, st.owned.lamp)}" (priority ${lampOwnerPriority}), above this rule (priority ${priority})`
    : owns.includes('lamp') ? 'firing and owns the lamp'
    : owns.length ? `firing; owns ${owns.join(', ')}`
    : 'firing, but every channel it sets is already owned by a higher rule';
  return { kind: 'rule', rule: summariseRule(rule, priority), verdict, firing: rule.enabled && fired, owns, shadowed, sessions: matches, context };
}

// `2026-09-11T10:00:00.000Z [log] [state] 1234abcd work/proj tool-use → stop (hook signal) +2 unlogged`
const STATE_LINE = /^(\S+) \[log\] \[state\] (\S+) (.*) (\S+) → (\S+?)(?: \[([^\]]+)\])? \(([^)]*)\)(?: \+(\d+) unlogged)?$/;
function parseTransition(line) {
  const m = STATE_LINE.exec(line);
  if (!m) return null;
  return { at: m[1], session: m[2], project: m[3] || null, from: m[4] === '—' ? null : m[4], to: m[5], failKind: m[6] || null, cause: m[7], unlogged: m[8] ? Number(m[8]) : 0 };
}

function buddyRecentTransitions({ root, limit = 20, session = null } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 20));
  const lines = [];
  for (const f of ['app.log.old', 'app.log']) {
    try { lines.push(...fs.readFileSync(path.join(root, f), 'utf8').split('\n')); } catch { /* rotated away or never written */ }
  }
  const all = lines.filter((l) => l.includes('[state] ')).map(parseTransition).filter(Boolean)
    .filter((t) => !session || t.session.startsWith(String(session).slice(0, 8)));
  return { total: all.length, transitions: all.slice(-n).reverse(), note: 'Newest first. At most one line per session per 250 ms; "unlogged" counts changes folded into the next line.' };
}

function buddyPendingRequests({ root, now = Date.now() } = {}) {
  const config = loadConfig(root);
  const waitMs = Number(process.env.CLAUDE_TRAFFIC_LIGHT_ASK_MS || 55000);
  return {
    askFromWidget: !!config.askFromWidget,
    ...(config.askFromWidget ? {} : { note: '"Answer permission prompts from the widget" is off in Preferences, so the PermissionRequest hook is not installed and nothing new will appear here.' }),
    requests: readRequests(root, now).map((r) => ({
      id: r.id, sessionId: r.sessionId, cwd: r.cwd, tool: r.tool, summary: r.summary, createdAt: r.createdAt,
      ageMs: now - Date.parse(r.createdAt),
      hookWaitsMsMore: Math.max(0, waitMs - (now - Date.parse(r.createdAt))),
      answered: fs.existsSync(path.join(root, 'requests', `${r.id}.answer`)),
    })),
  };
}

// main.js routerOpts()/delegationOpts() outside a dev run: the real HOME.
function routerRoot(root) {
  return { root, home: os.homedir() };
}

function buddyRouterStatus({ root, limit = 20 } = {}) {
  const Router = require('./router.js');
  const RouterInstall = require('./router-install.js');
  const DelegationInstall = require('./delegation-install.js');
  const config = loadConfig(root);
  const opts = { ...routerRoot(root), shellPath: process.env.SHELL || os.userInfo().shell, env: process.env };
  const flag = DelegationInstall.readFlag(opts);
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  return {
    enabled: !!config.routerEnabled,
    enabledAt: config.routerEnabledAt || null,
    policy: config.routerPolicy,
    projectOverrides: config.routerProjects || {},
    launcher: RouterInstall.status(opts),
    delegation: { enabled: !!(flag && flag.enabled), flag },
    decisions: Router.readDecisions(path.join(root, 'router', 'decisions.jsonl'), n),
    delegations: DelegationInstall.readLog(opts).slice(-n).reverse(),
  };
}

// main.js deriveUsage() + get-savings, read fresh from the transcripts.
async function buddySavings({ root, now = Date.now(), projectsDir } = {}) {
  const Usage = require('./usage.js');
  const RouterInstall = require('./router-install.js');
  const DelegationInstall = require('./delegation-install.js');
  const config = loadConfig(root);
  const opts = routerRoot(root);
  const { turns, files, skipped } = await Usage.readTurns({ since: now - 61 * 86400000, ...(projectsDir ? { root: projectsDir } : {}) });
  let events = [];
  try { events = DelegationInstall.readLog(opts, now - 8 * 86400000); } catch { /* no log yet */ }
  const frozen = RouterInstall.readFrozen(opts);
  const enabledAt = Date.parse(config.routerEnabledAt || '') || null;
  const out = {
    subscriber: config.routerSubscriberView ?? !process.env.ANTHROPIC_API_KEY,
    savings: Usage.savings(turns, {
      events,
      routing: !!config.routerEnabled,
      delegation: !!(config.routerDelegation && config.routerDelegation.enabled),
      enabledAt,
      switchedOnAt: Date.parse(config.routerSwitchedOnAt || '') || null,
      frozen,
      now,
    }),
    transcripts: { files, turns: turns.length, overSizeCap: skipped.length },
  };
  // The routing review (escalation cost included) exists once router phase 3 has landed.
  if (typeof Usage.review === 'function' && enabledAt) out.review = Usage.review(turns, { since: enabledAt, frozen, events, now });
  return out;
}

const TOOLS = [
  { name: 'buddy_status', description: 'What the Claude Buddy widget is showing right now and why: lamp, pose, eyes, costume, effect, pet, cameo; which rule owns each channel; session/agent counts; current tool; online state; and whether the running app agrees.', run: (a, c) => buddyStatus(c) },
  { name: 'buddy_sessions', description: 'Every session file the widget sees: signal (raw and as presented), cwd, tool, agents with kind/status/heartbeat, age, and how long until it goes stale — including the ones the widget is ignoring and why.', run: (a, c) => buddySessions(c) },
  { name: 'buddy_why', description: 'Explain why a rule is or is not firing, or who owns a look channel, against the live session set. `query` is a rule id, a rule name (or part of one), or a channel: lamp, pose, eyes, costume, cameo, effect, pet, body, sign, sound, …', input: (z) => ({ query: z.string().describe('rule id, rule name, or channel name') }), run: (a, c) => buddyWhy({ ...c, query: a.query }) },
  { name: 'buddy_rules', description: 'The configured light rules in priority order: id, name, enabled, locked, and a when/then summary.', run: (a, c) => buddyRules(c) },
  { name: 'buddy_recent_transitions', description: 'The latest session state changes from app.log, parsed: time, session, project, from → to, fail kind, and cause (hook signal, hysteresis-held, promoted-agents, …). Newest first.', input: (z) => ({ limit: z.number().int().min(1).max(500).optional().describe('how many (default 20)'), session: z.string().optional().describe('only this session id (or its first 8 chars)') }), run: (a, c) => buddyRecentTransitions({ ...c, limit: a.limit, session: a.session }) },
  { name: 'buddy_savings', description: 'Model-routing and context-diet savings as the widget computes them (today, 7 and 30 days), plus the routing review with escalation cost when available. Reads the Claude Code transcripts, so the first call can take a few seconds.', run: (a, c) => buddySavings(c) },
  { name: 'buddy_router_status', description: 'Model router: on/off, policy, per-project overrides, launcher and delegation install state, and the latest routing decisions and delegations.', input: (z) => ({ limit: z.number().int().min(1).max(200).optional().describe('how many decisions (default 20)') }), run: (a, c) => buddyRouterStatus({ ...c, limit: a.limit }) },
  { name: 'buddy_pending_requests', description: 'Permission requests currently blocked waiting for an answer from the widget (PermissionRequest hook), with how long the hook will keep waiting.', run: (a, c) => buddyPendingRequests(c) },
  { name: 'buddy_answer_request', description: 'Answer a pending permission request exactly as the widget\'s Allow/Deny buttons do. This approves or denies a tool call in ANOTHER Claude Code session — only do it when the user has asked you to.', input: (z) => ({ id: z.string().describe('request id from buddy_pending_requests'), decision: z.enum(['allow', 'deny']) }), readOnly: false, run: (a, c) => answerRequest(c.root, a.id, a.decision) },
];

async function main() {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');
  const server = new McpServer({ name: 'claude-buddy', version: require('./package.json').version });
  for (const t of TOOLS) {
    server.registerTool(t.name, {
      description: t.description,
      inputSchema: t.input ? t.input(z) : {},
      annotations: { readOnlyHint: t.readOnly !== false },
    }, async (args) => {
      try {
        const result = await t.run(args || {}, { root: rootDir(), now: Date.now() });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result && result.ok === false };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}

module.exports = { TOOLS, CHANNELS, rootDir, loadConfig, readRequests, answerRequest, classifySession, scanSessions, computeState, parseTransition, buddyStatus, buddySessions, buddyWhy, buddyRules, buddyRecentTransitions, buddySavings, buddyRouterStatus, buddyPendingRequests };

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`claude-buddy mcp: ${err.stack || err}\n`); process.exit(1); });
}
