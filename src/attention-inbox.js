'use strict';
// One "Inbox" for Home: everything that needs a person, ordered by severity
// then age, each row with one action. Composed only from parts Home already
// receives from main (needs you, stuck/limit alerts, morning asks and failures,
// teammates' shared work, agent mail, followed-session events); teammates' rows
// therefore only ever describe sessions their owners explicitly shared.
(function (root) {
  // A finished piece of work is "Check it", the same word every view uses (src/work-organise.js).
  const Organise = typeof module === 'object' && module.exports && typeof require === 'function' ? require('./work-organise') : root.PlexiformWorkOrganise;
  const CHECK = Organise.BUCKETS.find(b => b.id === 'check').label;
  const SEVERITY = Object.freeze({ approval: 0, question: 0, blocker: 1, burst: 1, failed: 2, handoff: 3, mention: 3, link: 4, review: 4, reply: 4, setup: 4, waiting: 5, moment: 5, finished: 6 });
  const LABEL = Object.freeze({ approval: 'Approval', question: 'Question', blocker: 'Blocked', burst: 'Burst', failed: 'Failed', handoff: 'Handoff', mention: 'Mention', review: CHECK, reply: 'Reply', waiting: 'Waiting on', moment: 'Moment', link: 'Link request', setup: 'Plexiform', finished: 'Finished' });
  const TEAM_KINDS = Object.freeze(['mention', 'reply', 'moment', 'handoff', 'link']);
  const MAX = 30;
  const OPTIONS_MAX = 4;
  const str = (v, max) => typeof v === 'string' && v.length <= max ? v : '';
  const ageOf = (ms, now) => Number.isFinite(ms) ? Math.max(0, now - ms) : null;
  // One Burst row, at most (src/home-alerts.js burstCard): only when Burst is in a state worth a hand
  // (broken, too old, CA/hosts/console trouble, a gateway that stopped answering or missed three checks in
  // a row, an update available), when loose ends are reported, or when the chip says a limit is near.
  // Never for not installed, off on purpose, checking or unsupported. The row's one button runs that
  // step through main's consent dialog, or opens Usage & Burst. `dimmed` mirrors the card (stale state).
  const ATTENTION_KINDS = Object.freeze(['broken', 'too_old', 'ca_untrusted', 'hosts_missing', 'console_down', 'gateway_stale']);
  const NEVER_KINDS = Object.freeze(['not_installed', 'checking', 'unsupported']);
  function burstRow(b) {
    if (!b || typeof b !== 'object') return null;
    const v = b.view && typeof b.view === 'object' ? b.view : null;
    if (v && NEVER_KINDS.includes(v.kind)) return null;
    const flagged = !!v && (ATTENTION_KINDS.includes(v.kind) || v.attention === true);
    const action = flagged && v.action && str(v.action.kind, 40) && str(v.action.label, 60) ? { kind: v.action.kind, label: v.action.label } : null;
    const loose = b.looseEnds && typeof b.looseEnds === 'object' && Number.isSafeInteger(b.looseEnds.repos) && b.looseEnds.repos > 0 ? b.looseEnds : null;
    const limitNear = !!(v && v.chip && v.chip.label === 'Limit near');
    if (!action && !loose && !limitNear) return null;
    const dimmed = !!(v && v.dimmed === true);
    const open = { kind: 'navigate', destination: 'optimiser', label: 'Open Usage & Burst' };
    if (action) return { kind: 'burst', title: str(v.headline, 200) || 'Claude Burst needs attention', meta: str(v.detail, 400), ageMs: null, dimmed, action: { kind: 'burst', op: action.kind, label: action.label }, key: `burst:${action.kind}` };
    if (limitNear) return { kind: 'burst', title: 'Claude is near its limit', meta: str(v.detail, 400) || 'Burst reports rejected requests or primary failures; it moves to your secondary provider when the limit is hit.', ageMs: null, dimmed, action: open, key: 'burst:limit-near' };
    return { kind: 'burst', title: `Loose ends in ${loose.repos} ${loose.repos === 1 ? 'repository' : 'repositories'}`, meta: `${str(loose.text, 300) || 'Uncommitted files, unpushed commits or stashes.'} Commit or push before closing those sessions.`, ageMs: null, dimmed, action: open, key: 'burst:loose-ends' };
  }
  // team: rows from the hub inbox (src/team-inbox.js items()), already shaped; each carries
  // its Open action and the keys Mark read sends back ({read:{kind:'inbox-read', ids}}).
  function compose({ needs = null, alerts = null, morning = null, teamToday = null, follow = [], team = [], now = Date.now() } = {}) {
    const rows = [];
    const push = r => { if (rows.length < 200) rows.push(r); };
    if (needs?.paused && str(needs.paused.text, 200)) push({ kind: 'blocker', title: str(needs.paused.text, 200), meta: str(needs.paused.note, 400), ageMs: null, resumable: needs.paused.resumable !== false, action: { kind: 'navigate', destination: 'usage', label: 'Raise limit' }, key: 'paused' });
    for (const [i, n] of (needs?.items || []).entries()) {
      const kind = /permission|approv/i.test(n.kind) ? 'approval' : 'question';
      const requestId = str(n.id, 100);
      const options = requestId ? (Array.isArray(n.options) ? n.options : []).filter(o => o && str(o.id, 100) && str(o.label, 40)).slice(0, OPTIONS_MAX).map(o => ({ id: o.id, label: o.label })) : [];
      push({ kind, title: str(n.headline, 400) || 'Needs you', meta: [str(n.kind, 80), str(n.project, 200), str(n.age, 40)].filter(Boolean).join(' · '), ageMs: null, late: n.late === true, requestId, options, action: { kind: 'navigate', destination: 'waiting', label: n.action === 'answer' ? 'Answer' : 'Open' }, key: `needs:${i}` });
    }
    for (const s of alerts?.stuck || []) push({ kind: 'blocker', title: str(s.title, 400), meta: str(s.meta, 400), ageMs: null, action: s.canOpen ? { kind: 'alert', alert: 'stuck', op: 'open', handle: s.handle, label: 'Open session' } : { kind: 'alert', alert: 'stuck', op: 'dismiss', handle: s.handle, label: 'Dismiss' }, key: `stuck:${s.handle}` });
    for (const l of alerts?.limits || []) push({ kind: 'blocker', title: str(l.title, 400), meta: str(l.meta, 400), ageMs: null, action: l.canResume ? { kind: 'alert', alert: 'limit', op: 'resume', handle: l.handle, label: 'Resume at reset' } : { kind: 'alert', alert: 'limit', op: 'dismiss', handle: l.handle, label: 'Dismiss' }, key: `limit:${l.handle}` });
    const burst = burstRow(alerts?.burst);
    if (burst) push(burst);
    // Plexiform's agent bus notices (src/home-alerts.js busCards): Undo what it added, or dismiss.
    for (const b of alerts?.bus || []) if (str(b.handle, 100) && (b.action === 'undo' || b.action === 'dismiss')) push({ kind: 'setup', title: str(b.title, 400), meta: str(b.meta, 400), ageMs: null, action: { kind: 'alert', alert: 'bus', op: b.action, handle: b.handle, label: b.action === 'undo' ? 'Undo' : 'Dismiss' }, key: `bus:${b.handle}` });
    for (const w of alerts?.waiting || []) push({ kind: 'waiting', title: str(w.title, 400), meta: str(w.meta, 400), ageMs: null, action: { kind: 'alert', alert: 'waiting', op: 'open', handle: w.handle, label: 'Open request' }, key: `waiting:${w.handle}` });
    for (const m of alerts?.mail || []) push({ kind: 'question', title: str(m.title, 400), meta: str(m.meta, 400), ageMs: null, action: { kind: 'alert', alert: 'mail', op: 'open', handle: m.handle, label: 'Open agent mail' }, key: `mail:${m.handle}` });
    for (const [i, t] of (morning?.items || []).entries()) {
      if (t.state === 'failed') push({ kind: 'failed', title: str(t.title, 400), meta: str(t.summary, 400) || 'Task failed while you were away', ageMs: null, action: { kind: 'navigate', destination: 'tasks', label: 'Open Tasks' }, key: `morning:${i}` });
      else if (t.ask) push({ kind: 'question', title: str(t.title, 400), meta: str(t.ask, 400), ageMs: null, action: { kind: 'navigate', destination: 'tasks', label: 'Answer in Tasks' }, key: `morning-ask:${i}` });
    }
    for (const [i, c] of (teamToday?.changes?.items || []).entries()) {
      if (c.kind === 'handoff') push({ kind: 'handoff', title: str(c.text, 400), meta: [str(c.repo, 200), str(c.team, 200)].filter(Boolean).join(' · '), ageMs: ageOf(Date.parse(c.at), now), action: { kind: 'navigate', destination: 'overview', label: 'Open shared sessions' }, key: `handoff:${i}` });
      else if (c.kind === 'review') push({ kind: 'review', title: str(c.text, 400), meta: [str(c.repo, 200), str(c.team, 200)].filter(Boolean).join(' · '), ageMs: ageOf(Date.parse(c.at), now), action: { kind: 'navigate', destination: 'overview', label: 'Open shared sessions' }, key: `review:${i}` });
    }
    for (const [i, p] of (teamToday?.people?.items || []).entries()) if (p.status === 'Waiting') push({ kind: 'question', title: `${str(p.author, 200)}'s "${str(p.title, 300)}" is waiting`, meta: [str(p.repo, 200), str(p.branch, 200)].filter(Boolean).join(' · '), ageMs: ageOf(Date.parse(p.updated_at), now), action: { kind: 'navigate', destination: 'overview', label: 'Open shared sessions' }, key: `waiting:${i}` });
    for (const f of Array.isArray(follow) ? follow : []) push({ kind: f.transition === 'attention' ? 'question' : f.transition === 'failed' ? 'failed' : 'finished', title: `${str(f.owner, 200)}'s "${str(f.title, 400)}" ${f.transition === 'attention' ? 'needs input' : f.transition}`, meta: 'Session you follow', ageMs: ageOf(f.at, now), action: { kind: 'navigate', destination: 'overview', label: 'Open session' }, key: `follow:${f.key}:${f.transition}` });
    for (const t of Array.isArray(team) ? team : []) {
      if (!t || !TEAM_KINDS.includes(t.kind) || !str(t.key, 400) || !Array.isArray(t.read?.ids) || !t.read.ids.every(k => str(k, 300))) continue;
      push({ kind: t.kind, title: str(t.title, 400) || 'A teammate needs you to look', meta: str(t.meta, 400), ageMs: Number.isFinite(t.ageMs) ? Math.max(0, t.ageMs) : null, action: { kind: 'navigate', destination: t.action?.destination === 'sessions' ? 'sessions' : 'overview', label: 'Open' }, read: { kind: 'inbox-read', ids: t.read.ids.slice(0, 50) }, key: t.key });
    }
    rows.sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || Number(b.late === true) - Number(a.late === true) || (b.ageMs ?? -1) - (a.ageMs ?? -1));
    return { items: rows.slice(0, MAX), total: rows.length, label: k => LABEL[k] };
  }
  const api = { compose, burstRow, SEVERITY, LABEL, MAX, OPTIONS_MAX, TEAM_KINDS, ATTENTION_KINDS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformInbox = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
