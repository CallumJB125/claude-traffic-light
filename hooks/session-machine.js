// The session lifecycle as an explicit, pure state machine: what a session
// file's signal becomes when a hook fires (the writer side), and what the
// widget shows for a stored session at a given moment (the reader side).
//
// Writer: set-status.js (Claude Code hooks), emit.js and the app's /signal
// endpoint (bare signals, via session-state.js applyBareSignal) all step a
// session with step(). Reader: main.js readSessions and the MCP server's
// session explainer both call classify(). docs/state-machine.md is generated
// from TRANSITIONS and PRESENTATION, and a test keeps the two in sync.
//
// UMD and dependency-free: the packaged hooks run from Resources/hooks with
// nothing beside them, and the Lights editor loads rules.js (which builds on
// this) with a <script> tag.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionMachine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ── Signal sets ─────────────────────────────────────────────────────────
  // Signals that close a turn: the working-since clock stops on any of them.
  // Not a permission denial: auto mode's classifier denies a tool call and
  // Claude carries on with the same turn, so a denial is mid-turn work.
  const TURN_END = new Set(['stop', 'idle-nudge', 'permission-ask', 'limit-hit', 'session-start', 'turn-failed']);
  // Blocked until you act.
  const WAITING = new Set(['permission-ask', 'limit-hit']);
  // Waiting on the person: a permission ask, a limit, a finished turn, the
  // idle nudge that follows it, or a failed turn (nothing happens until the
  // person retries). These keep their file for hours (no heartbeat while
  // they wait) and feed the ignored-for-N-minutes clock.
  const WAITING_ON_YOU = new Set(['permission-ask', 'limit-hit', 'idle-nudge', 'stop', 'turn-failed']);
  // Open, but nothing asked of it yet: not working (no heartbeat is coming,
  // so it keeps the waiting window) and not waiting on you either (a
  // terminal you opened and left must not grow a beard).
  const QUIET = new Set(['session-start']);
  // A turn that has ended while its subagents are still working hasn't
  // really ended; only a finished/idle turn (or a quiet session whose
  // teammates are at work) is promoted — a permission ask or a limit still
  // needs the person whatever the agents are doing.
  const PROMOTABLE_TURN_END = new Set(['stop', 'idle-nudge', 'session-start']);
  // A permission ask that only came from a Notification can be resolved by
  // auto mode's classifier within a second, so the widget sits it out for
  // this long first. A blocking PermissionRequest (askKind 'request' or still
  // in the pending list) and an AskUserQuestion are real waits and show at once.
  const TRANSIENT_ASK_MS = 1200;
  // A finished turn whose subagents are still working stays live for as long
  // as they plausibly are: a long agent can go quiet for well over the
  // working window without having died.
  const AGENT_KEEPALIVE_MS = 6 * 60 * 60 * 1000;
  // A killed or stopped subagent never fires SubagentStop. A hook subagent
  // whose own tool hooks (lastAt) have been silent this long reads 'stale':
  // not known to be working, never claimed done. Longer than Bash's 10-minute
  // ceiling, so one long command doesn't trip it.
  const AGENT_QUIET_MS = 15 * 60 * 1000;
  // 'stopped': the parent's TaskStop for it succeeded. 'stale': gone quiet.
  const AGENT_STATUSES = ['working', 'waiting', 'done', 'stopped', 'stale'];
  // Legacy session files (pre-rules) wrote a colour instead of a signal.
  const LEGACY_STATE_TO_SIGNAL = { green: 'tool-use', amber: 'permission-ask', red: 'limit-hit', done: 'stop' };

  function sessionSignal(session) {
    if (session.signal) return session.signal;
    return LEGACY_STATE_TO_SIGNAL[session.state] || null;
  }

  // ── Writer machine ──────────────────────────────────────────────────────
  // States: where a session file's stored signal puts it. Everything not a
  // turn end is mid-turn ('working'), including files from older hooks.
  const STATES = ['absent', 'working', 'started', 'asking', 'limited', 'finished', 'nudged', 'failed'];
  const STATE_OF_TURN_END = {
    'session-start': 'started',
    'permission-ask': 'asking',
    'limit-hit': 'limited',
    stop: 'finished',
    'idle-nudge': 'nudged',
    'turn-failed': 'failed',
  };
  // The turn is over in every state but these two.
  const CLOSED = STATES.filter((s) => s !== 'absent' && s !== 'working');

  function stateOf(session) {
    if (!session) return 'absent';
    return STATE_OF_TURN_END[session.signal] || 'working';
  }

  // Events: the resolved hook signal, grouped by what it does to the machine.
  // A tool hook (or a denied tool call) carrying an agent_id is a background
  // subagent's own tool use. A denied call is work: the turn goes on.
  const EVENTS = ['prompt', 'work', 'agent', 'task', 'start', 'stop', 'nudge', 'fail', 'ask', 'limit', 'end'];
  const EVENT_OF_SIGNAL = {
    'prompt-submit': 'prompt',
    'tool-use': 'work',
    'tool-done': 'work',
    'tool-failed': 'work',
    compact: 'work',
    'permission-denied': 'work',
    'subagent-start': 'agent',
    'subagent-done': 'agent',
    'task-created': 'task',
    'task-done': 'task',
    'session-start': 'start',
    stop: 'stop',
    'idle-nudge': 'nudge',
    'turn-failed': 'fail',
    'permission-ask': 'ask',
    'limit-hit': 'limit',
    'session-end': 'end',
  };

  function eventOf(signal, { fromSubagent = false } = {}) {
    if (fromSubagent && (/^tool-/.test(signal) || signal === 'permission-denied')) return 'agent';
    return EVENT_OF_SIGNAL[signal] || 'work';
  }

  // First matching row wins. `to`: 'signal' stores the event's signal (the
  // state follows from it), 'keep' leaves the stored signal as it was,
  // 'absent' removes the file. `bookkeeping` rows change lists and counters
  // but must not look like the session moved (updatedAt holds, agentsAt
  // stamps). The guards apply to every writer: a bare signal (emit.js,
  // /signal) carries no agent_id, so only its subagent-start/-done can be an
  // agent event, but those must not reopen a finished turn either.
  // `hooksOnly` rows depend on data only the Claude Code hook has: task
  // counters are counted from hook events (a /signal caller posts its own
  // `tasks` instead), so a bare task signal, if one ever came, lands as sent.
  const TRANSITIONS = [
    { id: 'end', from: '*', on: 'end', to: 'absent',
      why: 'SessionEnd removes the file' },
    { id: 'task-bookkeeping', from: '*', on: 'task', to: 'keep', bookkeeping: true, hooksOnly: true,
      why: 'task events only count; they never change what the session is doing' },
    { id: 'agent-after-turn', from: CLOSED, on: 'agent', to: 'keep', bookkeeping: true,
      why: 'a background agent working after the turn ended must not look like the turn restarted' },
    { id: 'nudge-keeps-failure', from: ['failed'], on: 'nudge', to: 'keep',
      why: 'the idle nudge ~60 s after a failed turn must not turn "the network dropped" into "waiting for you"' },
    { id: 'signal', from: '*', on: '*', to: 'signal',
      why: 'anything else is what the session is now doing' },
  ];

  function transitionFor(from, event, writer = 'hook') {
    return TRANSITIONS.find((t) => (t.from === '*' || t.from.includes(from))
      && (t.on === '*' || t.on === event)
      && (!t.hooksOnly || writer === 'hook'));
  }

  // The stored signal a transition leaves; a 'keep' from an absent file
  // (a task event before anything else) starts the session as working.
  function signalAfter(row, prev, signal) {
    if (row.to === 'absent') return null;
    if (row.to === 'keep') return (prev && prev.signal) || 'tool-use';
    return signal;
  }

  function stateOfSignal(signal) {
    return signal == null ? 'absent' : stateOf({ signal });
  }

  // Did this event come from you acting, rather than Claude moving? The
  // "ignored for N minutes" signals count from the last such touch, so a
  // session working on its own (a ralph loop, a background agent) must not
  // reset them. A touch is: sending a prompt, opening or resuming a session,
  // or Claude carrying on after an ask you answered (a denial included). A
  // denial on its own is not: PermissionDenied is auto mode's classifier, and
  // its payload doesn't say whether a person was involved.
  function userTouched(prev, signal, { sessionSource = null, bookkeeping = false, now = Date.now() } = {}) {
    if (bookkeeping) return false;
    if (signal === 'prompt-submit') return true;
    if (signal === 'session-start') return sessionSource !== 'compact';
    if (prev && prev.signal === 'permission-ask' && !TURN_END.has(signal)) {
      if (prev.askKind === 'request' || prev.askKind === 'question') return true;
      const since = Date.parse(prev.signalSince || prev.updatedAt || '');
      return !!since && now - since >= TRANSIENT_ASK_MS;
    }
    return false;
  }

  // One step of the writer machine: the lifecycle fields of the next session
  // file. `signal` is the resolved signal (a Notification already mapped to
  // permission-ask / idle-nudge / limit-hit, AskUserQuestion to
  // permission-ask). Writers add their own payload fields around this.
  function step(prev, { signal, fromSubagent = false, writer = 'hook', sessionSource = null }, nowIso) {
    const from = stateOf(prev);
    const event = eventOf(signal, { fromSubagent });
    const row = transitionFor(from, event, writer);
    const signalOut = signalAfter(row, prev, signal);
    const bookkeeping = !!row.bookkeeping;
    // The event didn't land as itself: the session's own fields (tool, ask
    // kind, via, failure) carry over from before.
    const held = row.to === 'keep';
    const turnOver = from !== 'absent' && from !== 'working';
    const changed = signalOut !== ((prev && prev.signal) ?? null);
    return {
      from,
      event,
      to: stateOfSignal(signalOut),
      rule: row.id,
      signal: signalOut,
      held,
      bookkeeping,
      changed,
      // What the session showed before this signal, and since when this one
      // has held — the app shows a young notification ask as prevSignal.
      prevSignal: changed ? ((prev && prev.signal) ?? null) : ((prev && prev.prevSignal) ?? null),
      signalSince: changed ? nowIso : ((prev && (prev.signalSince || prev.updatedAt)) || nowIso),
      // When the current turn began (for "working over N minutes").
      workingSince: turnOver && bookkeeping ? (prev.workingSince ?? null)
        : signal === 'prompt-submit' ? nowIso : TURN_END.has(signal) ? null : ((prev && prev.workingSince) || nowIso),
      // updatedAt means "the session last moved" (ignored-N timers, stale
      // windows); bookkeeping must not bump it, so it stamps agentsAt instead.
      updatedAt: bookkeeping && prev && prev.updatedAt ? prev.updatedAt : nowIso,
      agentsAt: bookkeeping ? nowIso : ((prev && prev.agentsAt) ?? null),
      touchedAt: userTouched(prev, signal, { sessionSource, bookkeeping: held, now: Date.parse(nowIso) }) ? nowIso : ((prev && prev.touchedAt) ?? null),
    };
  }

  // ── Reader: what a stored session presents right now ────────────────────
  function hasWorkingAgent(session) {
    return Array.isArray(session.agents) && session.agents.some((a) => a && typeof a === 'object'
      && a.status === 'working');
  }

  // The signal a session should be read as: a finished turn with a subagent
  // still working is presented as that agent's tool use, so the working rules
  // (and "Subagent running") keep firing instead of "Task finished".
  function effectiveSignal(session) {
    const signal = sessionSignal(session);
    const tool = session.tool || null;
    if (PROMOTABLE_TURN_END.has(signal) && hasWorkingAgent(session)) {
      return { signal: 'tool-use', tool: 'Agent', turnSignal: signal };
    }
    return { signal, tool, turnSignal: null };
  }

  // Received hook metadata only. Async delivery is not an answer; later AI
  // work cannot renew the original clock of a reported input request.
  const CODEX_INPUT_MS = 90000;
  // Claude's parallel tool hooks carry tool_use_id. A different tool finishing
  // cannot answer this input. Store only bounded correlation metadata locally;
  // neither tool input nor prompt text is part of this receipt.
  const INPUT_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
  function claudeInputEntries(session) {
    if (!Array.isArray(session?.claudeInputRequests) || session.claudeInputRequests.length > 16) return [];
    return session.claudeInputRequests.filter(r => r && typeof r === 'object' && !Array.isArray(r)
      && Object.keys(r).sort().join(',') === 'agentId,askedAt,id,kind,tool'
      && typeof r.id === 'string' && INPUT_ID.test(r.id)
      && (r.agentId === null || typeof r.agentId === 'string' && INPUT_ID.test(r.agentId))
      && ['question', 'request'].includes(r.kind) && typeof r.tool === 'string' && r.tool.length <= 80
      && typeof r.askedAt === 'string' && Number.isFinite(Date.parse(r.askedAt)));
  }
  function reduceClaudeInputs(prev, { signal, askKind, toolUseId, agentId = null, tool = '' }, nowIso) {
    let requests = claudeInputEntries(prev).map(r => ({ ...r }));
    let overflow = prev?.claudeInputOverflow === true;
    if (['session-start', 'session-end'].includes(signal))
      return { requests: [], overflow: false, answered: false };
    // A foreground turn ending does not end background agents or their asks.
    if (['prompt-submit', 'stop', 'turn-failed'].includes(signal))
      return { requests: requests.filter(r => r.agentId !== null), overflow, answered: false };
    const validId = typeof toolUseId === 'string' && INPUT_ID.test(toolUseId);
    const validOwner = agentId === null || typeof agentId === 'string' && INPUT_ID.test(agentId);
    const owner = typeof agentId === 'string' && INPUT_ID.test(agentId) ? agentId : null;
    const same = r => validId && validOwner && r.id === toolUseId && r.agentId === owner;
    let answered = false;
    if (['tool-done', 'tool-failed', 'permission-denied'].includes(signal)) {
      answered = requests.some(same); requests = requests.filter(r => !same(r));
    } else if (signal === 'subagent-done' && owner !== null) {
      answered = requests.some(r => r.agentId === owner); requests = requests.filter(r => r.agentId !== owner);
    }
    if (signal === 'permission-ask' && ['question', 'request'].includes(askKind) && validId && validOwner && !requests.some(same)) {
      if (requests.length === 16) overflow = true;
      else requests.push({ id: toolUseId, agentId: owner, kind: askKind, tool: typeof tool === 'string' ? tool.slice(0, 80) : '', askedAt: nowIso });
    }
    return { requests, overflow, answered };
  }
  function claudeInputPending(session) {
    return session?.claudeInputOverflow === true || claudeInputEntries(session).length > 0;
  }
  function codexInputEntries(session) {
    if (session?.source !== 'codex' || session.codexLifecycle !== 1 || !Array.isArray(session.codexInputRequests) || session.codexInputRequests.length > 16) return [];
    return session.codexInputRequests.filter(r => r && typeof r === 'object' && !Array.isArray(r)
      && Object.keys(r).sort().join(',') === 'askedAt,id,kind,turnId'
      && typeof r.id === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(r.id)
      && typeof r.turnId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(r.turnId) && r.turnId === session.codexTurnId
      && ['sync', 'async'].includes(r.kind) && typeof r.askedAt === 'string' && r.askedAt.length <= 64
      && Number.isFinite(Date.parse(r.askedAt))).map(r => ({ id: r.id, turnId: r.turnId, kind: r.kind, askedAt: r.askedAt }));
  }
  function codexInputPending(session, now = Date.now()) {
    if (session?.source !== 'codex' || session.codexLifecycle !== 1 || session.codexClosedTurn !== false || !Number.isFinite(now)) return false;
    const children = Array.isArray(session.codexAgents) ? session.codexAgents.slice(0, 64).filter(a => a && typeof a === 'object'
      && typeof a.id === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(a.id) && ['working', 'waiting'].includes(a.status)) : [];
    const entries = [...codexInputEntries(session), ...children.flatMap(a => codexInputEntries({ source: 'codex', codexLifecycle: 1, codexTurnId: a.turnId, codexInputRequests: a.codexInputRequests }))];
    return entries.some(r => {
      const age = now - Date.parse(r.askedAt);
      return age >= 0 && age <= CODEX_INPUT_MS;
    });
  }

  // The signal the widget should show for a session right now: a young
  // notification ask shows what came before it (hysteresis).
  function presentSignal(session, now = Date.now(), pendingIds = []) {
    if (claudeInputPending(session) || codexInputPending(session, now)) return 'permission-ask';
    const signal = sessionSignal(session);
    if (signal !== 'permission-ask') return signal;
    if (session.askKind === 'question' || session.askKind === 'request') return signal;
    if ([...pendingIds].includes(session.sessionId)) return signal;
    const since = Date.parse(session.signalSince || session.updatedAt || '');
    if (!since || now - since >= TRANSIENT_ASK_MS) return signal;
    return session.prevSignal && session.prevSignal !== 'permission-ask' ? session.prevSignal : 'tool-use';
  }

  // How long until a promoted session (finished turn, agents working) goes
  // stale: the working window from its last sign of life (a write, an agent
  // bookkeeping write, an agent starting), or while any working agent is
  // younger than AGENT_KEEPALIVE_MS, until that one ages out. Negative: stale.
  function agentsStaleInMs(data, now, workingStaleMs) {
    let last = Math.max(Date.parse(data.updatedAt || '') || 0, Date.parse(data.agentsAt || '') || 0);
    let keepAlive = -Infinity;
    (Array.isArray(data.agents) ? data.agents : []).forEach((a) => {
      if (!a || typeof a !== 'object') return;
      if (a.status !== 'working') return;
      const since = Date.parse(a.since || '') || 0;
      last = Math.max(last, since);
      if (since && now - since < AGENT_KEEPALIVE_MS) keepAlive = Math.max(keepAlive, AGENT_KEEPALIVE_MS - (now - since));
    });
    return Math.max(workingStaleMs - (now - last), keepAlive);
  }

  function withFreshAgents(data, now) {
    if (!Array.isArray(data.agents)) return data;
    let changed = false;
    const agents = data.agents.map((a) => {
      if (!a || a.source !== 'hook' || a.status !== 'working') return a;
      const seen = Math.max(Date.parse(a.lastAt || '') || 0, Date.parse(a.since || '') || 0);
      if (seen > 0 && seen <= now && now - seen <= AGENT_QUIET_MS) return a;
      changed = true;
      return { ...a, status: 'stale' };
    });
    return changed ? { ...data, agents } : data;
  }

  // The reader's decision, in order; the first that applies wins.
  const PRESENTATION = [
    { id: 'no-signal', shows: 'nothing', why: 'no signal (and no legacy colour) in the file' },
    { id: 'gone', shows: 'nothing', why: 'its local Claude process exited without a SessionEnd' },
    { id: 'held', shows: 'prevSignal (or tool-use)', why: `a notification ask younger than ${TRANSIENT_ASK_MS} ms that no pending request or real ask backs` },
    { id: 'promoted', shows: 'tool-use / Agent', why: 'a finished, idle or just-opened session with a subagent still working' },
    { id: 'stale-agents', shows: 'nothing', why: 'promoted, but its working agents went quiet past the working window and keepalive' },
    { id: 'stale', shows: 'nothing', why: 'no update within the working window (or the waiting window for a waiting-on-you or quiet signal)' },
    { id: 'shown', shows: 'the stored signal', why: 'otherwise' },
  ];

  // One stored session → what the widget does with it. ctx: now (ms),
  // pendingIds (sessions with a blocking PermissionRequest), isGone (a thunk:
  // is its process gone? — the only impure question, asked only if needed),
  // workingStaleMs, waitingStaleMs.
  function classify(stored, { now, pendingIds = [], isGone = () => false, workingStaleMs, waitingStaleMs }) {
    const data = withFreshAgents(stored, now);
    const signal = sessionSignal(data);
    if (!signal) return { live: false, dropped: 'no-signal', signal: null };
    if (isGone()) return { live: false, dropped: 'gone', signal };
    const presented = presentSignal(data, now, pendingIds);
    const held = presented !== signal;
    const eff = effectiveSignal({ ...data, signal: presented });
    const input = claudeInputPending(data) || codexInputPending(data, now);
    const source = input ? 'reported input request' : held ? 'hysteresis-held' : eff.turnSignal ? 'promoted-agents' : (data.via || 'hook signal');
    const observedAt = typeof data.updatedAt === 'string' ? Date.parse(data.updatedAt) : NaN;
    // NaN < 0 is false: missing/corrupt clocks previously became live forever.
    // A future timestamp is not proof of fresh work either, even with agents.
    if (!Number.isFinite(now) || !Number.isFinite(observedAt) || observedAt < 0 || observedAt > now)
      return { live: false, dropped: 'stale', rule: 'stale', signal, presented: eff.signal, held, source, staleInMs: null, confidence: 'unknown', observedAt: null, session: { ...data, ...eff } };
    if (eff.turnSignal) {
      const staleInMs = agentsStaleInMs(data, now, workingStaleMs);
      const stale = staleInMs < 0;
      return { live: !stale, dropped: stale ? 'stale-agents' : null, rule: stale ? 'stale-agents' : 'promoted', signal, presented: eff.signal, held, source, staleInMs, session: { ...data, ...eff } };
    }
    const waiting = WAITING_ON_YOU.has(presented);
    const quiet = QUIET.has(signal);
    const staleInMs = (waiting || quiet ? waitingStaleMs : workingStaleMs) - (now - new Date(data.updatedAt).getTime());
    const stale = staleInMs < 0;
    return { live: !stale, dropped: stale ? 'stale' : null, rule: stale ? 'stale' : held ? 'held' : 'shown', waiting, quiet, signal, presented, held, source, staleInMs: Number.isNaN(staleInMs) ? null : staleInMs, session: { ...data, signal: presented } };
  }

  // ── Diagram ─────────────────────────────────────────────────────────────
  // Every (state, event) pair, resolved through TRANSITIONS.
  function table(writer = 'hook') {
    const out = [];
    for (const from of STATES) {
      for (const event of EVENTS) {
        const row = transitionFor(from, event, writer);
        const to = row.to === 'absent' ? 'absent' : row.to === 'keep' ? (from === 'absent' ? 'working' : from) : null;
        out.push({ from, event, rule: row.id, to });
      }
    }
    return out;
  }
  // A representative signal per event, to name the state it leads to.
  const EVENT_SIGNAL = { prompt: 'prompt-submit', work: 'tool-use', agent: 'subagent-start', task: 'task-created', start: 'session-start', stop: 'stop', nudge: 'idle-nudge', fail: 'turn-failed', ask: 'permission-ask', limit: 'limit-hit', end: 'session-end' };

  function mermaid() {
    const edges = new Map();
    for (const t of table('hook')) {
      const to = t.to || stateOfSignal(EVENT_SIGNAL[t.event]);
      const key = `${t.from}->${to}`;
      if (!edges.has(key)) edges.set(key, []);
      const label = t.rule === 'signal' || t.rule === 'end' ? t.event : `${t.event} [${t.rule}]`;
      edges.get(key).push(label);
    }
    const lines = ['stateDiagram-v2', '  [*] --> absent'];
    for (const [key, labels] of edges) {
      const [from, to] = key.split('->');
      lines.push(`  ${from} --> ${to}: ${labels.join(', ')}`);
    }
    return lines.join('\n');
  }

  return {
    TURN_END, WAITING, WAITING_ON_YOU, QUIET, PROMOTABLE_TURN_END, TRANSIENT_ASK_MS, AGENT_KEEPALIVE_MS, AGENT_QUIET_MS, AGENT_STATUSES, LEGACY_STATE_TO_SIGNAL,
    STATES, EVENTS, CLOSED, TRANSITIONS, PRESENTATION, EVENT_OF_SIGNAL, EVENT_SIGNAL,
    sessionSignal, stateOf, eventOf, transitionFor, step, userTouched,
    hasWorkingAgent, effectiveSignal, presentSignal, agentsStaleInMs, withFreshAgents, classify, codexInputEntries, codexInputPending, CODEX_INPUT_MS,
    claudeInputEntries, claudeInputPending, reduceClaudeInputs,
    table, mermaid,
  };
});
