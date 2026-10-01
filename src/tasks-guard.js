// Main-side gatekeeping for the Tasks page: what a Task or event may look like
// when it crosses to the renderer (whitelisted fields, bounded strings), and
// the allow-list of things the renderer may ask for (act / create). The
// renderer is untrusted input: nothing it sends is forwarded as is.
// `P` is board/tasks-api/protocol.js (ESM, so main imports it and passes it in).
'use strict';

const fs = require('fs');
const path = require('path');
const TV = require('./tasks-view.js');

const STATES = ['todo', 'queued', 'claimed', 'running', 'quiet', 'blocked', 'parked', 'suspended', 'reconnecting', 'unresponsive', 'orphaned', 'handing_over', 'handed_over', 'in_review', 'done', 'failed'];
// States with an agent (possibly dead) behind them: shown as "connection lost" when the socket drops.
const LIVE_STATES = new Set(['queued', 'claimed', 'running', 'quiet', 'blocked', 'handing_over', 'suspended', 'unresponsive', 'orphaned']);
const TONES = ['grey', 'green', 'quiet', 'amber', 'red', 'violet', 'purple', 'done', 'unknown', 'none'];

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const strOrNull = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const intOrNull = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const pick = (v, list, dflt = null) => (list.includes(v) ? v : dflt);
const tilde = (p, homeDir) => (homeDir && (p === homeDir || p.startsWith(homeDir + path.sep)) ? `~${p.slice(homeDir.length)}` : p);

function createGuard({ P, taskFace }) {
  const actions = (a) => (Array.isArray(a) ? a.filter((x) => P.ACTIONS.includes(x)) : []);

  function sanitizeTask(v, { now = Date.now(), homeDir = '' } = {}) {
    if (!v || typeof v.id !== 'string' || !v.id || v.id.length > 128) return null;
    const state = pick(v.state, STATES, 'queued');
    let face = { label: v.label, tone: v.tone, reason: v.reason, actions: v.actions, confirm: v.confirm, green: v.green };
    // The supervisor computes the face; taskFace() only fills in when it is missing.
    if (typeof v.label !== 'string' || typeof v.reason !== 'string') {
      try { face = taskFace(v); } catch { face = { label: state, tone: 'grey', reason: '', actions: [], confirm: [], green: false }; }
    }
    return {
      id: v.id,
      title: str(v.title, 200),
      state,
      blockedKind: strOrNull(v.blockedKind, 40),
      failKind: strOrNull(v.failKind, 40),
      parkReason: strOrNull(v.parkReason, 40),
      outcome: pick(v.outcome, P.OUTCOMES),
      green: face.green === true && state === 'running',
      label: str(face.label, 60),
      tone: pick(face.tone, TONES, 'grey'),
      reason: str(face.reason, 400),
      actions: actions(face.actions),
      confirm: actions(face.confirm),
      ai: { id: pick(v.ai?.id, P.AIS, null), reason: strOrNull(v.ai?.reason, 300), model: strOrNull(v.ai?.model, 80) },
      surface: pick(v.surface, P.SURFACES, 'background'),
      permissionLevel: pick(v.permissionLevel, P.PERMISSION_LEVELS, 'auto-edits'),
      planFirst: v.planFirst === true,
      source: pick(v.source, P.SOURCES, 'local'),
      awaitingConfirm: v.awaitingConfirm === true,
      repo: v.repo ? { name: str(v.repo.name, 120) } : null,
      where: v.repo ? tilde(str(v.repo.root, 400), homeDir) : '',
      branch: strOrNull(v.branch, 200),
      workInPlace: v.workInPlace === true,
      cost: { usd: Number.isFinite(v.cost?.usd) ? v.cost.usd : 0, budgetUsd: Number.isFinite(v.cost?.budgetUsd) ? v.cost.budgetUsd : null },
      createdAtMs: now - int(v.createdAgeMs),
      stateSinceMs: now - int(v.stateAgeMs),
      lastSeq: int(v.lastSeq),
      hub: v.hub ? { cardKey: str(v.hub.cardKey, 60) } : null,
    };
  }

  const party = (p) => ({ kind: pick(p?.kind, ['task', 'card', 'member', 'human', 'repo'], 'task'), id: str(p?.id, 200), label: str(p?.label, 120) });
  function sanitizeMessage(m) {
    if (!m || typeof m.id !== 'string') return null;
    return {
      id: str(m.id, 128), type: 'message', seq: int(m.seq), direction: m.direction === 'out' ? 'out' : 'in',
      from: party(m.from), to: party(m.to), body: str(m.body, P.MAX_TRANSCRIPT_CHUNK),
      createdAt: intOrNull(m.createdAt), deliveredAt: intOrNull(m.deliveredAt), readAt: intOrNull(m.readAt),
      source: pick(m.source, ['live', 'notes']), quarantined: m.quarantined === true,
    };
  }

  function sanitizeDetail(d, opts = {}) {
    const base = sanitizeTask(d, opts);
    if (!base) return null;
    const now = opts.now ?? Date.now();
    const ev = d.evidence;
    return {
      ...base,
      text: str(d.text, 20000),
      worktree: typeof d.worktree === 'string' ? tilde(d.worktree.slice(0, 400), opts.homeDir) : null,
      baseBranch: strOrNull(d.baseBranch, 200),
      handover: d.handover ? { version: int(d.handover.version), markdown: str(d.handover.markdown, P.MAX_TRANSCRIPT_CHUNK), provenance: str(d.handover.provenance, 40), syncedAtMs: now - int(d.handover.syncedAgeMs) } : null,
      evidence: ev ? {
        tests: strOrNull(ev.tests, 20), testCommand: strOrNull(ev.testCommand, 200), summary: strOrNull(ev.summary, 2000),
        diffStat: ev.diffStat ? { files: int(ev.diffStat.files), added: int(ev.diffStat.added), removed: int(ev.diffStat.removed) } : null,
      } : null,
      pr: d.pr ? { number: int(d.pr.number), state: pick(d.pr.state, ['open', 'merged', 'closed'], 'open') } : null,
      openApprovals: (Array.isArray(d.openApprovals) ? d.openApprovals : []).slice(0, 10).map((a) => ({ approvalId: str(a.approvalId, 128), tool: str(a.tool, 80), inputSummary: str(a.inputSummary, 500) })),
      openAsk: d.openAsk ? {
        askId: str(d.openAsk.askId, 128), kind: str(d.openAsk.kind, 20), text: str(d.openAsk.text, 4000),
        options: Array.isArray(d.openAsk.options) ? d.openAsk.options.slice(0, 20).map((o) => str(o, 300)) : null,
        choices: Array.isArray(d.openAsk.choices)
          ? d.openAsk.choices.slice(0, 6).map((c) => ({ id: str(c.id, 60), label: str(c.label, 120), action: pick(c.action, P.ACTIONS), payload: pick(c.action, P.ACTIONS) ? actPayload(c.action, c.payload, false) : null })).filter((c) => c.action && c.payload)
          : null,
      } : null,
      limitResetsAtMs: Number.isFinite(d.limitResetsInMs) ? now + d.limitResetsInMs : null,
      messages: (Array.isArray(d.messages) ? d.messages : []).slice(-200).map(sanitizeMessage).filter(Boolean),
    };
  }

  // The few event types the page shows; everything else is dropped here.
  function sanitizeEvent(e, now = Date.now()) {
    if (!e || typeof e.type !== 'string') return null;
    const seq = int(e.seq);
    switch (e.type) {
      case 'transcript': return { type: 'transcript', seq, role: pick(e.role, ['assistant', 'user', 'system'], 'system'), text: str(e.text, P.MAX_TRANSCRIPT_CHUNK), turn: int(e.turn), partial: e.partial === true };
      case 'tool': return { type: 'tool', seq, phase: e.phase === 'end' ? 'end' : 'start', toolUseId: str(e.toolUseId, 128), name: str(e.name, 80), summary: str(e.summary, 400), ok: typeof e.ok === 'boolean' ? e.ok : null, durationMs: intOrNull(e.durationMs) };
      case 'message': { const m = sanitizeMessage(e); return m && { ...m, seq }; }
      case 'message-state': return { type: 'message-state', seq, id: str(e.id, 128), deliveredAt: intOrNull(e.deliveredAt), readAt: intOrNull(e.readAt), source: pick(e.source, ['live', 'notes']) };
      case 'error': return { type: 'error', seq, code: P.ERRORS.includes(e.code) ? e.code : 'INTERNAL' };
      case 'cost': return { type: 'cost', seq, usd: Number.isFinite(e.usd) ? e.usd : 0, budgetUsd: Number.isFinite(e.budgetUsd) ? e.budgetUsd : null };
      case 'state': return { type: 'state', seq, patch: sanitizeTask({ ...e, id: str(e.taskId, 128), title: '', createdAgeMs: 0, stateAgeMs: 0 }, { now }) };
      case 'approval': case 'ask': return { type: 'refresh', seq };
      case 'diff': return { type: 'diff', seq, files: (Array.isArray(e.files) ? e.files : []).slice(0, 200).map((f) => ({ path: str(f.path, 300), status: str(f.status, 12), added: int(f.added), removed: int(f.removed) })) };
      default: return null;
    }
  }

  // A state event's face as a patch over a cached task (the rest of the row is kept).
  function applyState(task, e, now = Date.now()) {
    const p = sanitizeEvent(e, now)?.patch;
    if (!p) return task;
    return { ...task, state: p.state, blockedKind: p.blockedKind, failKind: p.failKind, parkReason: p.parkReason, outcome: p.outcome, green: p.green, label: p.label, tone: p.tone, reason: p.reason, actions: p.actions, confirm: p.confirm, stateSinceMs: e.state !== e.prevState ? now : task.stateSinceMs };
  }

  // What the person sees right now: green only while the lease holds, and a dropped
  // connection never leaves a live-looking task behind (P1).
  function withLease(task, { connected, leaseGreen }) {
    if (!connected) {
      if (!LIVE_STATES.has(task.state)) return { ...task, green: false, actions: [], confirm: [], stale: true };
      return { ...task, green: false, label: 'Connection lost', tone: 'unknown', reason: 'Lost touch with the background helper. This is the last thing it reported.', actions: [], confirm: [], stale: true };
    }
    if (task.green && !leaseGreen) return { ...task, green: false, tone: 'unknown', reason: 'No recent signal from the background helper.' };
    return task;
  }

  // ── what the page may ask for ──
  const fail = (code) => ({ ok: false, code });
  const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && [...v].length <= max;
  const bytes = (v) => Buffer.byteLength(v);

  function actPayload(action, p, confirmed) {
    const o = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    switch (action) {
      case 'pause': case 'stop': return {};
      case 'resume': return { when: pick(o.when, ['now', 'reset'], 'now') };
      case 'takeover': return { mode: 'print', ...(confirmed ? { confirm: true } : {}) }; // `confirmed` here is main's own native confirmation
      case 'handback': return text(o.note, TV.LIMITS.note) ? { note: o.note.trim() } : {};
      case 'message': return typeof o.body === 'string' && o.body.trim() && bytes(o.body.trim()) <= TV.LIMITS.message ? { body: o.body.trim() } : null;
      case 'approve': return text(o.approvalId, 128) ? { approvalId: o.approvalId, scope: pick(o.scope, ['once', 'task'], 'once') } : null;
      case 'deny': return text(o.approvalId, 128) ? { approvalId: o.approvalId } : null;
      case 'answer': return text(o.askId, 128) && text(o.answer, TV.LIMITS.answer) ? { askId: o.askId, answer: o.answer.trim() } : null;
      case 'merge': return { strategy: pick(o.strategy, ['merge', 'squash', 'ff'], 'merge') };
      case 'openPr': return { draft: o.draft === true };
      case 'discard': return { confirm: true };
      case 'retry': return { fresh: o.fresh === true };
      case 'switchAi': return P.AIS.includes(o.ai) ? { ai: o.ai } : null;
      default: return null;
    }
  }

  // Actions whose confirmation main owns (a native dialog); the page's `confirmed` never counts for them.
  const NATIVE_ACTIONS = ['discard', 'openPr', 'takeover'];

  /**
   * req = {id, action, payload?, confirmed?}; task = main's cached row for req.id (its `actions` are what the
   * supervisor accepts now). ctx = {approvals: Map(approvalId → {tool}), asks: Set(askId), nativeConfirmed}
   * from main: ids main did not relay are refused, and native-confirmed actions need nativeConfirmed.
   * A refusal with `native: true` means "ask the person in a native dialog, then call again".
   */
  function validateAct(req, task, ctx = {}) {
    if (!req || typeof req !== 'object') return fail('VALIDATION');
    if (typeof req.id !== 'string' || !req.id || req.id.length > 128) return fail('VALIDATION');
    if (!P.ACTIONS.includes(req.action)) return fail('VALIDATION');
    if (!task || task.id !== req.id) return fail('NOT_FOUND');
    if (!task.actions.includes(req.action)) return fail('ILLEGAL_TRANSITION');
    const confirmed = req.confirmed === true;
    const native = ctx.nativeConfirmed === true;
    const raw = req.payload && typeof req.payload === 'object' ? req.payload : {};
    let startTask = false;
    if (req.action === 'approve' || req.action === 'deny') {
      const a = ctx.approvals?.get(raw.approvalId);
      if (!a) return fail('NOT_FOUND');
      startTask = a.tool === 'StartTask';
    }
    if (req.action === 'answer' && !ctx.asks?.has(raw.askId)) return fail('NOT_FOUND');
    const needsNative = NATIVE_ACTIONS.includes(req.action) || (req.action === 'approve' && (startTask || raw.scope === 'task'));
    if (needsNative && !native) return { ...fail('CONFIRM_REQUIRED'), native: true };
    if (!needsNative && (TV.CONFIRM_ACTIONS.includes(req.action) || task.confirm.includes(req.action)) && !confirmed) return fail('CONFIRM_REQUIRED');
    const payload = actPayload(req.action, startTask ? { ...raw, scope: 'once' } : req.payload, native);
    if (!payload) return fail('VALIDATION');
    return { ok: true, id: req.id, action: req.action, payload };
  }

  const SURFACES_UI = ['background', 'tmux', 'tab'];
  const PERMS_UI = ['plan', 'ask', 'auto-edits'];
  /** draft = {text, ai, surface, permissionLevel, planFirst}; cwd is resolved by main from a folder handle, never taken from the page. */
  function validateCreate(draft, cwd) {
    if (!draft || typeof draft !== 'object') return fail('VALIDATION');
    if (typeof cwd !== 'string' || !cwd) return fail('VALIDATION');
    if (!text(draft.text, TV.LIMITS.taskText)) return fail('VALIDATION');
    const spec = { text: draft.text.trim(), cwd, source: 'local', ai: pick(draft.ai, P.AI_CHOICES, 'auto'), surface: pick(draft.surface, SURFACES_UI, 'background') };
    if (PERMS_UI.includes(draft.permissionLevel)) spec.permissionLevel = draft.permissionLevel;
    if (draft.planFirst === true) spec.planFirst = true;
    return { ok: true, spec };
  }

  function sanitizeAis(list) {
    return (Array.isArray(list) ? list : []).filter((a) => P.AIS.includes(a?.id)).map((a) => ({
      id: a.id, label: TV.AI_NAME[a.id], installed: a.installed === true, loggedIn: typeof a.loggedIn === 'boolean' ? a.loggedIn : null,
      health: pick(a.health, ['ok', 'warn', 'missing'], 'warn'), note: str(Array.isArray(a.notes) ? a.notes[0] : '', 200),
    }));
  }

  return { sanitizeTask, sanitizeDetail, sanitizeEvent, sanitizeMessage, sanitizeAis, applyState, withLease, validateAct, validateCreate, actPayload };
}

const SECRET_ENV = /(TOKEN|SECRET|KEY|PASSWORD)/i;
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
function resolveBin(name, env = process.env) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name)) return name;
  const dirs = [...String(env.PATH || '').split(path.delimiter), ...(env.HOME ? [path.join(env.HOME, '.local', 'bin')] : []), ...EXTRA_BIN_DIRS].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return name;
}

// `cd '<cwd>' && NAME=… /abs/bin argv…`, quoted for a POSIX shell. No secret-looking env var is ever included
// (the hook shim falls back to <run_dir>/hook.token and board-mcp reads its token from mcp.json), and the binary
// is its absolute path. `mask` hides the remaining env values on screen.
function takeoverCommand(t, { mask = false, resolve = resolveBin } = {}) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const env = Object.entries(t.env || {}).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && !SECRET_ENV.test(k)).map(([k, v]) => `${k}=${mask ? '…' : q(v)}`);
  const argv = (Array.isArray(t.argv) ? t.argv : []).map((a, i) => (i === 0 ? resolve(a) : a)).map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : q(a)));
  return `${t.cwd ? `cd ${q(t.cwd)} && ` : ''}${[...env, ...argv].join(' ')}`;
}

module.exports = { createGuard, takeoverCommand, resolveBin, tilde, NATIVE_ACTIONS: ['discard', 'openPr', 'takeover'], LIVE_STATES, STATES };
