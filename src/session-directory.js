'use strict';
// One main-side session directory for Overview "My sessions" and "Team
// sessions" (and, later, card detail). Built from already-projected main
// inputs; nothing here reads provider chats, and no native path, provider
// thread id or credential is ever copied into an entry: every output field is
// rebuilt from a whitelist and passed through clean().
//
// Team privacy is decided HERE (main), never in the page: a teammate's entry
// is kept only when the team hub says it is explicitly shared with the
// selected team, live (not revoked, not expired) and the viewer is a current
// member of that team. A hub that over-shares is filtered again.
//
// Times: observedAt is when main (or the team hub server) received the
// report. It only moves forward, never past "now", so a replayed or
// future-dated report cannot make a session look fresh, and a parent's
// activity never refreshes its children. Self-reported claims keep their own
// state and time under selfReported.
const crypto = require('node:crypto');
const { clean } = require('./work-capture');

const CAPABILITIES = Object.freeze(['discovery', 'telemetry', 'taskReporting', 'receive', 'reply', 'resume', 'steer', 'interrupt', 'remoteControl']);
const STALE_MS = 90_000;
const MAX_ENTRIES = 300, MAX_CHILDREN = 64;
const TEAM_STATES = Object.freeze({ working: 'Working', waiting: 'Waiting', input: 'Needs input', idle: 'Idle', ended: 'Ended' });
const CODEX_UNMANAGED = 'Started in Codex, which has no supported way for another app to send to it. Start a session from Plexiform to message it.';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? clean(v, max) : '');
const cap = (available, reason) => ({ available: available === true, reason: available === true ? '' : reason });
const initials = (name) => (str(name, 80).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join('') || '?');
const stamp = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);

function freshness(observedAt, now, staleMs = STALE_MS) {
  if (!Number.isFinite(observedAt) || observedAt < 0 || observedAt > now) return { freshness: 'unknown', ageMs: null };
  const ageMs = now - observedAt;
  return { freshness: ageMs <= staleMs ? 'recent' : 'stale', ageMs };
}

// A human card edit beats a board/automated title, which beats a session's own report.
function taskOf({ human = null, card = null, reported = null } = {}) {
  for (const [value, source] of [[human, 'human'], [card, 'board'], [reported, 'reported']]) {
    const title = str(value, 200);
    if (title) return { title, source };
  }
  return { title: 'Task not reported', source: 'unknown' };
}

function capabilities(values) {
  const out = {};
  for (const key of CAPABILITIES) out[key] = object(values[key]) ? cap(values[key].available, str(values[key].reason, 300) || 'Not available.') : cap(false, 'Not reported for this session.');
  return out;
}

function createSessionDirectory({ now = Date.now, staleMs = STALE_MS, secret = crypto.randomBytes(32) } = {}) {
  const seen = new Map();
  const workBoardRuns = new Map(); // exact main-only own run identity; never projected
  const publicId = (parts) => crypto.createHmac('sha256', secret).update(JSON.stringify(parts)).digest('hex').slice(0, 40);
  // Monotonic receiver time per internal key; future times are refused.
  function observe(key, at, time) {
    const t = stamp(at), prev = seen.get(key) ?? null;
    const next = Number.isFinite(t) && t >= 0 && t <= time && (prev === null || t > prev) ? t : prev;
    if (next !== null) seen.set(key, next);
    if (seen.size > 5000) seen.delete(seen.keys().next().value);
    return next;
  }
  const timing = (key, at, time) => { const observedAt = observe(key, at, time); return { observedAt, ...freshness(observedAt, time, staleMs) }; };

  function teamBadges(list) {
    const out = [], keys = new Set();
    for (const t of Array.isArray(list) ? list : []) if (object(t) && typeof t.key === 'string' && !keys.has(t.key)) { keys.add(t.key); out.push({ key: t.key, name: str(t.name, 80) || 'Team' }); }
    return out;
  }

  // ── Personal inputs ──────────────────────────────────────────────────
  // work: Overview snapshot rows (already public DTOs) + main-only meta by row id.
  function fromWork(row, meta, time) {
    const m = object(meta) ? meta : {};
    const kind = ['reported', 'board', 'task'].includes(m.kind) ? m.kind : 'reported';
    const t = timing(`work:${row.id}`, Number.isFinite(row.age_ms) ? time - row.age_ms : null, time);
    const provider = { id: str(row.provider?.id, 40) || 'unknown', label: str(row.provider?.label, 120) || 'Local AI', kind: row.provider?.kind === 'local' ? 'local' : 'integrated' };
    const message = row.capabilities?.message ?? {}, codex = provider.id === 'codex';
    const observedOnly = kind === 'reported' && message.enabled !== true;
    const state = str(row.status, 40) || 'Unknown';
    const entry = {
      id: publicId(['work', row.id]), kind: kind === 'reported' ? 'observed' : kind, owner: { name: 'You', self: true, initials: 'Y' },
      scope: m.teamKey ? 'team' : 'personal', teams: teamBadges(m.teamKey ? [{ key: m.teamKey, name: m.teamName }] : []),
      board: { label: str(row.board?.label, 80) || 'Unassigned', kind: ['personal', 'team'].includes(row.board?.kind) ? row.board.kind : 'unknown' },
      card: row.task?.status === 'tracked' && kind !== 'reported' ? { key: str(row.task.key, 80) || null, title: str(row.task.title, 200) } : null,
      provider, device: { label: str(row.device?.label, 80) || 'Unknown device', local: row.device?.local === true }, project: str(row.project, 100) || null,
      task: taskOf({ human: m.humanTitle, card: row.task?.status === 'tracked' && kind !== 'reported' ? row.task.title : null, reported: row.task?.status === 'tracked' && kind === 'reported' ? row.task.title : null }),
      state, input: state === 'Waiting on you', ...t, nativeSessionId:m.nativeSessionId,nativeTurnId:m.nativeTurnId,selfReported: null,
      provenance: kind === 'reported' ? ['observed'] : kind === 'board' ? ['board'] : ['plexiform-tasks'],
      capabilities: capabilities({
        discovery: cap(true), telemetry: cap(true),
        taskReporting: cap(row.task?.status === 'tracked', 'No task has been reported for this session.'),
        receive: cap(message.enabled === true, observedOnly ? (codex ? CODEX_UNMANAGED : `${provider.label} activity hooks report activity only; a hook is not a way to send into this session.`) : str(message.reason, 300) || 'No supported message channel is current.'),
        reply: cap(message.enabled === true && kind !== 'reported', observedOnly ? 'No supported reply channel: replies stay inside the provider app.' : 'Replies arrive only through a current owned runner.'),
        resume: cap(false, observedOnly ? 'Plexiform cannot resume a session another app started.' : 'Resume is not offered for this session.'),
        steer: cap(false, observedOnly ? 'No supported steering channel.' : 'Messages queue for the runner; steering a running turn is not supported here.'),
        interrupt: cap(false, observedOnly ? 'No supported interrupt channel.' : 'Stop work from its board card or the Tasks page.'),
        remoteControl: cap(false, 'Not reachable from your other devices.'),
      }),
      interact: message.enabled === true || row.capabilities?.open?.enabled === true ? { kind: 'work', ref: row.id } : null,
      children: [],
    };
    for (const child of (Array.isArray(row.children) ? row.children : []).slice(0, MAX_CHILDREN)) {
      if (!object(child) || typeof child.id !== 'string') continue;
      const self = child.reporting?.source === 'self-reported';
      const ct = timing(`work-child:${child.id}`, Number.isFinite(child.age_ms) ? time - child.age_ms : null, time);
      const cstate = str(child.status, 40) || 'Unknown';
      entry.children.push({
        id: publicId(['work-child', child.id]), parent: entry.id, label: str(child.label, 80) || 'Agent', state: cstate, input: cstate === 'Waiting on you',
        task: taskOf({ reported: child.task?.status === 'tracked' ? child.task.title : null }), ...ct,
        selfReported: self && Number.isSafeInteger(child.reporting.observed_at) ? { state: cstate, at: child.reporting.observed_at } : null,
        provenance: [self ? 'self-reported' : 'observed'],
      });
    }
    return entry;
  }

  // owned: interaction hub states for the current Overview document (Plexiform-owned,
  // or an existing codex-daemon session attached there, which is never shared).
  function fromOwned({ state: s, leaf = null, nativeSessionId = null, nativeTurnId = null }, shares, time) {
    const existing = s.ownership !== 'plexiform-owned';
    const mine = existing && s.provider?.id !== 'claude-channel' ? [] : (Array.isArray(shares) ? shares : []).filter((x) => object(x) && x.session === s.session);
    const interact = mine.filter((x) => x.scope === 'interact');
    const label = str(s.provider?.label, 120) || 'AI';
    const status = s.status === 'working' ? 'Working' : s.status === 'ended' ? 'Ended' : s.status === 'compacting' ? 'Compacting' : 'Ready';
    const live = s.status !== 'ended';
    const inputTime = freshness(stamp(s.reporting?.input?.observed_at),time);
    const staleInput = live && s.reporting?.input?.needed === true && inputTime.freshness !== 'recent';
    // Main holds the live provider process: this read is the observation.
    const t = timing(`owned:${s.session}`, live ? time : null, time);
    const entry = {
      id: publicId(['owned', s.session]), kind: 'owned', owner: { name: 'You', self: true, initials: 'Y' },
      scope: mine.length ? 'team' : 'personal', teams: teamBadges(mine.map((x) => ({ key: x.teamKey, name: x.teamName }))),
      board: { label: existing ? 'Started outside Plexiform' : 'Started by Plexiform', kind: 'personal' }, card: null,
      provider: { id: str(s.provider?.id, 80) || 'unknown', label, kind: /^local-/.test(String(s.provider?.id)) ? 'local' : 'integrated' },
      device: { label: 'This device', local: true }, project: null,
      task: taskOf({ reported: s.reporting?.task?.title }), state: staleInput ? 'Last reported: Needs input' : live && s.input_needed === true ? 'Needs input' : status, input: live && !staleInput && s.input_needed === true, ...t, selfReported: null, provenance: ['owned'],
      capabilities: capabilities({
        discovery: cap(true), telemetry: cap(true),
        taskReporting: cap(!!s.reporting?.task?.title, 'No task has been reported for this session.'),
        receive: cap(live, 'This session has ended.'), reply: cap(live, 'This session has ended.'),
        resume: cap(false, 'Plexiform does not reattach to a session after it ends or after a restart.'),
        steer: cap(live && s.capabilities?.steer === true, live ? `${label} does not offer steering of a running turn.` : 'This session has ended.'),
        interrupt: cap(live && s.capabilities?.interrupt === true, live ? `${label} does not offer interrupting a turn.` : 'This session has ended.'),
        remoteControl: cap(live && interact.length > 0, existing ? 'A session started outside Plexiform is never shared with a team.' : mine.length ? 'Shared to watch only.' : 'Not shared. Use Share… on its card to let a team watch or send.'),
      }),
      interact: { kind: 'owned', ref: s.session }, children: [], nativeSessionId,nativeTurnId,leaf: typeof leaf === 'string' ? leaf : null,
    };
    for (const c of (Array.isArray(s.reporting?.children) ? s.reporting.children : []).slice(0, MAX_CHILDREN)) {
      if (!object(c) || typeof c.ref !== 'string') continue;
      const ct = timing(`owned-child:${s.session}:${c.ref}`, c.observed_at, time);
      const childState = Object.hasOwn(TEAM_STATES, c.state) ? TEAM_STATES[c.state] : 'Unknown';
      entry.children.push({ id: publicId(['owned-child', s.session, c.ref]), parent: entry.id, label: str(c.name,80)||'Agent', state: childState, input: childState==='Needs input', task: taskOf({reported:c.task_title}), ...ct, reporting:{source:str(c.source,40),observedAt:c.observed_at}, selfReported:c.source==='self-reported'?{state:childState,at:c.observed_at}:null,provenance:['owned',...(c.source==='self-reported'?['self-reported']:[])], capabilities: capabilities({ discovery:cap(true), telemetry:cap(true), taskReporting:cap(!!c.task_title,'Task not reported.') }) });
    }
    if(s.reporting?.task){entry.reporting={source:str(s.reporting.task.source,40),observedAt:s.reporting.task.observed_at};if(s.reporting.task.source==='human')entry.task.source='human';}
    if(staleInput)Object.assign(entry,inputTime,{observedAt:Number.isFinite(stamp(s.reporting.input.observed_at))?stamp(s.reporting.input.observed_at):null});
    return entry;
  }

  // An observed hook report from an owned session's own workspace is the same
  // session: fold it in (telemetry + children) instead of counting it twice.
  function fold(owned, observed) {
    owned.provenance = ['owned', 'observed'];
    if (observed.observedAt !== null && (owned.observedAt === null || observed.observedAt > owned.observedAt)) Object.assign(owned, { observedAt: observed.observedAt, ageMs: observed.ageMs, freshness: observed.freshness });
    if (!owned.children.length) owned.children = observed.children.map((c) => ({ ...c, parent: owned.id }));
    const rank = { unknown: 0, reported: 1, board: 2, human: 3 };
    if ((rank[observed.task.source] ?? 0) > (rank[owned.task.source] ?? 0)) owned.task = observed.task;
    if (observed.input && ['Working','Needs input'].includes(owned.state)) { owned.input = true; owned.state = observed.state; }
  }

  function mine({ work = [], meta = new Map(), owned = [], shares = [] } = {}) {
    const time = now(), out = [], byNative = new Map(), ambiguous = new Set();
    workBoardRuns.clear();
    for (const o of Array.isArray(owned) ? owned : []) {
      if (!object(o) || !object(o.state) || typeof o.state.session !== 'string') continue;
      const e = fromOwned(o, shares, time);
      if (out.some((x) => x.id === e.id)) continue;
      if (typeof e.nativeSessionId === 'string' && typeof e.nativeTurnId === 'string') {
        const key=JSON.stringify([e.provider.id,e.nativeSessionId,e.nativeTurnId]);
        if(byNative.has(key)){byNative.delete(key);ambiguous.add(key);}else if(!ambiguous.has(key))byNative.set(key,e);
      }
      out.push(e);
    }
    for (const row of Array.isArray(work) ? work : []) {
      if (!object(row) || typeof row.id !== 'string') continue;
      const e = fromWork(row, meta.get(row.id), time);
      const boardRunId = meta.get(row.id)?.boardRunId;
      if (e.kind === 'board' && typeof boardRunId === 'string') workBoardRuns.set(e.id, boardRunId);
      const twin = e.kind === 'observed' && typeof e.nativeSessionId === 'string' && typeof e.nativeTurnId === 'string' ? byNative.get(JSON.stringify([e.provider.id,e.nativeSessionId,e.nativeTurnId])) : null;
      if (twin && twin.provider.id === e.provider.id) { fold(twin, e); continue; }
      if (!out.some((x) => x.id === e.id) && out.length < MAX_ENTRIES) out.push(e);
    }
    for (const e of out) {delete e.leaf;delete e.nativeSessionId;delete e.nativeTurnId;}
    return out;
  }

  // ── Team inputs ──────────────────────────────────────────────────────
  // hub entries: what the team hub says is shared with the viewer for teamId.
  function sharedEntry(x, { team, viewer, time }) {
    if (!object(x) || typeof x.ref !== 'string' || !x.ref || x.ref.length > 200) return null;
    if (!object(x.team) || x.team.id !== team.id) return null;
    const share = x.share;
    if (!object(share) || share.explicit !== true || !['watch', 'interact'].includes(share.scope) || share.revoked === true) return null;
    const expires = share.expiresAt == null ? null : stamp(share.expiresAt);
    if (expires !== null && !(expires > time)) return null;
    if (!object(x.owner) || typeof x.owner.id !== 'string' || !x.owner.id ) return null;
    const self = x.owner.id === viewer.id;
    if (self && x.kind !== 'board-run') return null;
    const ownerName = str(x.owner.name, 80) || 'Teammate';
    const t = timing(`team:${team.key}:${x.ref}`, x.observed_at, time);
    const sr = object(x.self_reported) && Object.hasOwn(TEAM_STATES, x.self_reported.state) && Number.isFinite(stamp(x.self_reported.at)) ? { state: TEAM_STATES[x.self_reported.state], at: stamp(x.self_reported.at) } : null;
    const state = Object.hasOwn(TEAM_STATES, x.state) ? TEAM_STATES[x.state] : 'Unknown';
    const online = x.online === true && t.freshness === 'recent';
    const canSend = share.scope === 'interact', live = state !== 'Ended';
    const why = (ok, base) => (!canSend ? `${ownerName} shared this session with your team to watch only.` : !live ? 'This session has ended.' : !online ? `${ownerName}'s computer is offline or this report is stale.` : ok ? '' : base);
    const caps = object(x.capabilities) ? x.capabilities : {};
    const id = publicId(['team', team.key, x.ref]);
    const entry = {
      id, kind: 'shared', owner: { name: self ? 'You' : ownerName, self, initials: self ? 'Y' : initials(ownerName) },
      scope: 'team', teams: [{ key: team.key, name: team.name }],
      board: { label: str(x.board?.name, 80) || team.name, kind: 'team' },
      card: object(x.card) && str(x.card.title, 200) ? { key: str(x.card.key, 80) || null, title: str(x.card.title, 200) } : null,
      provider: { id: str(x.provider?.id, 40) || 'unknown', label: str(x.provider?.label, 120) || 'AI', kind: x.provider?.kind === 'local' ? 'local' : 'integrated' },
      device: { label: str(x.device?.label, 80) || 'Unknown device', local: false }, project: null,
      task: taskOf({ human: object(x.card) && x.card.edited_by === 'human' ? x.card.title : null, card: object(x.card) ? x.card.title : null, reported: x.task_title }),
      state, input: live && (state === 'Needs input' || x.input_needed === true), ...t, selfReported: sr,
      provenance: [x.messageContract === 'task-inbox' ? 'board' : 'shared', ...(sr ? ['self-reported'] : [])],
      messageContract: x.messageContract === 'task-inbox' ? 'task-inbox' : 'live',
      notice: x.messageContract === 'task-inbox' ? 'Task inbox: the agent reads this message with its board tools. Queued does not mean received or acknowledged. Sending does not resume a paused run.' : '',
      handoffs: (Array.isArray(x.handoffs) ? x.handoffs : []).slice(0, 10).filter(object).map((h) => ({ direction: h.direction === 'out' ? 'out' : 'in', with: str(h.with, 80) || 'Teammate', state: ['offered', 'accepted', 'declined'].includes(h.state) ? h.state : 'offered', summary: str(h.summary, 200) })),
      capabilities: capabilities({
        discovery: cap(true), telemetry: cap(true),
        taskReporting: cap(!!x.card || !!x.task_title, 'No task has been reported for this session.'),
        receive: cap(canSend && live && online, why(true)), reply: cap(canSend && live && online, why(true)),
        resume: cap(false, 'Only the owner can resume their own session.'),
        steer: cap(canSend && live && online && caps.steer === true, why(caps.steer === true, 'The owner\'s provider does not offer steering.')),
        interrupt: cap(canSend && live && online && caps.interrupt === true, why(caps.interrupt === true, 'The owner\'s provider does not offer interrupting.')),
        remoteControl: cap(false, 'Only the owner controls their session; teammates can message it when it is shared to send.'),
      }),
      interact: canSend ? { kind: 'team', ref: id } : null,
      deliveries: (Array.isArray(x.deliveries) ? x.deliveries : []).slice(-10).filter((d) => object(d) && typeof d.id === 'string').map((d) => ({ id: str(d.id, 80), text: str(d.text, 4000), by: str(d.by, 80) || null, state: ['queued', 'delivered', 'acknowledged', 'recorded', 'responding', 'completed', 'interrupted', 'failed', 'replied', 'refused', 'expired', 'unconfirmed', 'unknown'].includes(d.state) ? d.state : 'unknown', response: str(d.response, 4000) })),
      children: [],
    };
    if (typeof x.task_title === 'string') {
      entry.reporting = { source: ['human','provider','self-reported','observed'].includes(x.task_source) ? x.task_source : 'unknown', observedAt: x.task_observed_at };
      if (!entry.card && x.task_source === 'human') entry.task.source = 'human';
    }
    if(live && x.input_reported_needed===true && freshness(stamp(x.input_observed_at),time).freshness!=='recent'){
      entry.state='Last reported: Needs input';entry.input=false;
      Object.assign(entry,freshness(stamp(x.input_observed_at),time),{observedAt:Number.isFinite(stamp(x.input_observed_at))?stamp(x.input_observed_at):null});
    }
    for (const c of (Array.isArray(x.children) ? x.children : []).slice(0, MAX_CHILDREN)) {
      if (!object(c) || typeof c.ref !== 'string') continue;
      // Each child keeps its own report time; the parent's activity never refreshes it.
      const ct = timing(`team-child:${team.key}:${x.ref}:${c.ref}`, c.observed_at, time);
      const cstate = Object.hasOwn(TEAM_STATES, c.state) ? TEAM_STATES[c.state] : 'Unknown';
      entry.children.push({ id: publicId(['team-child', team.key, x.ref, c.ref]), parent: id, label: str(c.name, 80) || 'Agent', state: cstate, input: cstate === 'Needs input', task: taskOf({ reported: c.task_title }), ...ct, reporting:{source:['human','provider','self-reported','observed'].includes(c.source)?c.source:'unknown',observedAt:c.observed_at},selfReported: c.source==='self-reported'?{state:cstate,at:c.observed_at}:null, provenance: ['shared',...(c.source==='self-reported'?['self-reported']:[])] });
    }
    return { entry, ref: x.ref, scope: share.scope };
  }

  // Team view: viewer's own sessions already in that team (owned + shared,
  // team-board work), plus teammates' explicitly shared sessions.
  function team({ team: t, viewer, member = false, personal = [], hubEntries = [] } = {}) {
    const time = now(), entries = [], refs = new Map();
    if (!object(t) || typeof t.key !== 'string' || !object(viewer) || typeof viewer.id !== 'string') return { entries, refs };
    for (const e of Array.isArray(personal) ? personal : []) if (object(e) && e.teams?.some((b) => b.key === t.key) && entries.length < MAX_ENTRIES) entries.push(e);
    // Not a current member: nothing of anyone else's.
    if (member !== true) return { entries, refs };
    for (const x of Array.isArray(hubEntries) ? hubEntries : []) {
      if (object(x) && x.kind === 'board-run' && x.owner?.id === viewer.id && typeof x.boardRunId === 'string' && entries.some((e) => workBoardRuns.get(e.id) === x.boardRunId)) continue;
      const r = sharedEntry(x, { team: t, viewer, time });
      if (!r || refs.has(r.entry.id) || entries.length >= MAX_ENTRIES) continue;
      refs.set(r.entry.id, { ref: r.ref, scope: r.scope });
      entries.push(r.entry);
    }
    return { entries, refs };
  }

  function counts(entries) {
    const children = entries.flatMap((e) => e.children);
    const recent = (e) => e.freshness === 'recent';
    return {
      sessions: entries.length, working: entries.filter((e) => recent(e) && e.state === 'Working').length,
      input: [...entries, ...children].filter((e) => recent(e) && e.input).length, children: children.length,
      stale: entries.filter((e) => e.freshness !== 'recent').length, team: entries.filter((e) => e.scope === 'team').length,
    };
  }

  return { mine, team, counts, publicId };
}

// Narrow team hub interface the directory consumes (src/team-hub-fake.js is
// the in-memory stand-in until the real hub directory lands):
//   teams(viewer)              -> [{id, name}] teams the viewer is a current member of
//   sessions(viewer, teamId)   -> hub entries explicitly shared with that team (server-filtered)
//   send(viewer, teamId, ref, text, requestId) -> {ok, status, delivery?}
//   onChange(fn)               -> off; pushes when shares/sessions change
//   label                      -> shown with the team (e.g. a fake hub says so)
module.exports = { createSessionDirectory, freshness, taskOf, CAPABILITIES, STALE_MS, TEAM_STATES, CODEX_UNMANAGED };
