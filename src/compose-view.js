// Home's task box (plan-orchestrator O4): the pure part. State in, what the box shows out: the route line, whether
// Run is allowed, the draft Run sends, and the running card. Loaded by home.html as a plain script
// (window.ComposeView), by main (src/compose-main.js) and by node:test. No DOM, no clock, no IPC.
// Callum (2026-10-24): nothing starts until the person presses Run. Nothing here sends anything.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ComposeView = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TEXT_MAX = 20000; // TASKS-CONTRACT §5.1, the same limit as the Tasks composer
  const AI_NAME = Object.freeze({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini' });
  // A started task keeps Home alive (and its card live) only in these states (review R1: an allowlist). Anything
  // else, including a state added later, a missing row or a disconnected helper, is not live.
  const LIVE = Object.freeze(['queued', 'claimed', 'running', 'quiet', 'blocked', 'handing_over']);
  const isLive = (state) => LIVE.includes(state);
  const PERMS = Object.freeze({ plan: 'Plan only', ask: 'Ask me first', 'auto-edits': 'Edit files' });

  function initial() {
    return {
      text: '', folder: null, ai: 'auto', perm: 'auto-edits', ais: [], connected: false, hidden: false,
      route: null,     // {key, seq, result: {decision, ai, reason, alternatives, code?, canOverride?}} for the inputs it answered
      pending: null,   // {key, seq} of the route request in flight
      pick: null,      // the AI picked from a tie
      preflight: null, // {folder, peers: [...], key}
      ackPeers: false,
      busy: false, error: '', held: null, task: null,
    };
  }

  const trimmed = (s) => (typeof s.text === 'string' ? s.text.trim() : '');
  /** The inputs a route answers. A route shown for other inputs is stale. */
  function inputKey(s) { return JSON.stringify([trimmed(s), s.folder?.handle || '', s.ai, s.perm]); }
  function textError(s) {
    const t = trimmed(s);
    if (!t) return 'Say what you want done first.';
    if (s.text.length > TEXT_MAX) return `That is ${(s.text.length - TEXT_MAX).toLocaleString('en')} characters over the ${TEXT_MAX.toLocaleString('en')} limit.`;
    return '';
  }
  /** A route can be asked for: some text within the limit and a folder. */
  const routable = (s) => !!s.connected && !textError(s) && !!s.folder;
  const label = (ai) => AI_NAME[ai] || 'This AI';

  /**
   * The line under the box. kind: offline | none | checking | routed | ask | refused.
   * A route counts only while it answers the current inputs and nothing newer is in flight (review finding 8).
   */
  function routeView(s) {
    if (!s.connected) return { kind: 'offline', text: 'The Tasks background helper is not running, so a task cannot be started yet.' };
    if (!routable(s)) return { kind: 'none', text: '' };
    const key = inputKey(s);
    if (!s.route || s.route.key !== key || (s.pending && s.pending.seq > s.route.seq)) return { kind: 'checking', text: 'Checking who should do this…' };
    const r = s.route.result;
    if (r.decision === 'run') return { kind: 'routed', ai: r.ai, text: `→ ${r.reason}` };
    if (r.decision === 'ask') {
      const choices = r.alternatives.filter((a) => a.usable).slice(0, 2).map((a) => ({ ai: a.ai, label: label(a.ai), reason: a.reason, picked: s.pick === a.ai }));
      return { kind: 'ask', text: r.reason || `${choices.map((c) => c.label).join(' or ')}?`, choices }; // the reason names both
    }
    return { kind: 'refused', code: r.code, text: r.reason, canOverride: r.canOverride === true };
  }

  /** Who runs it if Run is pressed now, or null. */
  function chosenAi(s) {
    const v = routeView(s);
    if (v.kind === 'routed') return v.ai;
    if (v.kind === 'ask') return v.choices.some((c) => c.ai === s.pick) ? s.pick : null;
    return null;
  }

  const peersOf = (s) => (s.preflight && s.preflight.folder === s.folder?.handle ? s.preflight.peers : null);
  /** Whether Run (or ⌘↩) may send. Every reason it may not is a state the box shows. */
  function canRun(s) {
    if (s.busy || s.hidden || (s.task && isLive(s.task.row?.state))) return false;
    if (!routable(s) || !chosenAi(s)) return false;
    const peers = peersOf(s);
    if (!peers) return false;
    return peers.length === 0 || s.ackPeers === true;
  }

  /**
   * The one thing Run sends. expectAi is the AI the person saw, only with "Choose for me" (an explicit Who pick
   * needs none): the engine refuses with CONFLICT if routing has changed, and runs a tie as the pick.
   */
  function runDraft(s, { requestId, overrideBudget = false } = {}) {
    if (!canRun(s)) return null;
    const draft = { text: s.text, folder: s.folder.handle, ai: s.ai, permissionLevel: s.perm, requestId, peersKey: s.preflight.key };
    if (s.ai === 'auto') draft.expectAi = chosenAi(s);
    if (overrideBudget === true) draft.overrideBudget = true;
    return draft;
  }

  /** Permission choices for the Who chip: Codex cannot route approvals in the background, so it has no "Ask me first". */
  function permOptions(ai) {
    const keys = ai === 'codex' ? ['plan', 'auto-edits'] : ['plan', 'ask', 'auto-edits'];
    return keys.map((k) => ({ value: k, label: PERMS[k] }));
  }
  /** Who chip choices: Choose for me, then each AI the helper can start. */
  function whoOptions(ais) {
    return [{ value: 'auto', label: 'Choose for me', disabled: false }, ...(Array.isArray(ais) ? ais : []).map((a) => ({ value: a.id, label: a.usable ? label(a.id) : `${label(a.id)} (not available)`, disabled: !a.usable }))];
  }

  /** The peers line, or null when there is none to show. */
  function peersView(s) {
    const peers = peersOf(s);
    if (!peers || !peers.length) return null;
    return { text: `${peers.length} other ${peers.length === 1 ? 'task is' : 'tasks are'} working in this project.`, acknowledged: s.ackPeers === true };
  }

  /** The running card for the task this page started; null when there is none. */
  function cardView(task, now = 0) {
    if (!task) return null;
    const row = task.row;
    const ai = label(row?.ai?.id || task.ai);
    const state = row?.state || 'queued';
    const live = isLive(state);
    const needs = state === 'blocked';
    // A quiet task is measured from its last sign of life: its state may have changed long ago, or just now.
    const from = state === 'quiet' && Number.isFinite(row?.lastActivityMs) ? row.lastActivityMs : row?.stateSinceMs;
    const since = Number.isFinite(from) && now ? Math.max(0, now - from) : null;
    const age = since === null ? '' : since < 60_000 ? ' · under a minute' : ` · ${Math.floor(since / 60_000)} min`;
    return {
      title: (task.title || '').split('\n')[0].slice(0, 120) || 'New task',
      status: `${ai} · ${row?.label || 'Starting'}${live ? age : ''}`,
      tone: needs ? 'waiting' : live ? 'working' : state === 'failed' ? 'failed' : 'done',
      needsApproval: needs,
      approval: needs ? `Needs your approval: ${row?.reason || 'it is waiting for you.'}` : '',
      lines: Array.isArray(task.lines) ? task.lines.slice(-3) : [],
      live,
      canStop: live && Array.isArray(row?.actions) && row.actions.includes('stop'),
    };
  }

  /** One progress line from a task event, or null (transcript and tool events only). */
  function eventLine(e) {
    const one = (v, n = 160) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    if (!e || typeof e !== 'object') return null;
    if (e.type === 'transcript' && e.role === 'assistant') return one(e.text) || null;
    if (e.type === 'tool' && e.phase === 'start') return `▸ ${one(e.name, 60)}${e.summary ? ` ${one(e.summary, 100)}` : ''}`;
    if (e.type === 'error') return `✗ ${one(e.text || e.message)}`;
    return null;
  }

  /** Only Run and ⌘↩ (Ctrl+Enter) submit; plain Enter is a newline. */
  const isSubmitKey = (e) => !!e && e.key === 'Enter' && (e.metaKey === true || e.ctrlKey === true);

  return { TEXT_MAX, AI_NAME, LIVE, isLive, PERMS, initial, inputKey, textError, routable, routeView, chosenAi, canRun, runDraft, permOptions, whoOptions, peersView, cardView, eventLine, isSubmitKey };
}));
