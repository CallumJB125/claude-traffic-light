'use strict';
// One "Inbox" for Home: everything that needs a person, ordered by severity
// then age, each row with one action. Composed only from parts Home already
// receives from main (needs you, stuck/limit alerts, morning asks and failures,
// teammates' shared work, agent mail, followed-session events); teammates' rows
// therefore only ever describe sessions their owners explicitly shared.
(function (root) {
  const SEVERITY = Object.freeze({ approval: 0, question: 0, blocker: 1, failed: 2, handoff: 3, review: 4, waiting: 5, finished: 6 });
  const LABEL = Object.freeze({ approval: 'Approval', question: 'Question', blocker: 'Blocked', failed: 'Failed', handoff: 'Handoff', review: 'Ready for review', waiting: 'Waiting on', finished: 'Finished' });
  const MAX = 30;
  const str = (v, max) => typeof v === 'string' && v.length <= max ? v : '';
  const ageOf = (ms, now) => Number.isFinite(ms) ? Math.max(0, now - ms) : null;
  function compose({ needs = null, alerts = null, morning = null, teamToday = null, follow = [], now = Date.now() } = {}) {
    const rows = [];
    const push = r => { if (rows.length < 200) rows.push(r); };
    for (const [i, n] of (needs?.items || []).entries()) {
      const kind = /permission|approv/i.test(n.kind) ? 'approval' : 'question';
      push({ kind, title: str(n.headline, 400) || 'Needs you', meta: [str(n.kind, 80), str(n.project, 200), str(n.age, 40)].filter(Boolean).join(' · '), ageMs: null, late: n.late === true, action: { kind: 'navigate', destination: 'waiting', label: 'Answer' }, key: `needs:${i}` });
    }
    for (const s of alerts?.stuck || []) push({ kind: 'blocker', title: str(s.title, 400), meta: str(s.meta, 400), ageMs: null, action: s.canOpen ? { kind: 'alert', alert: 'stuck', op: 'open', handle: s.handle, label: 'Open session' } : { kind: 'alert', alert: 'stuck', op: 'dismiss', handle: s.handle, label: 'Dismiss' }, key: `stuck:${s.handle}` });
    for (const l of alerts?.limits || []) push({ kind: 'blocker', title: str(l.title, 400), meta: str(l.meta, 400), ageMs: null, action: l.canResume ? { kind: 'alert', alert: 'limit', op: 'resume', handle: l.handle, label: 'Resume at reset' } : { kind: 'alert', alert: 'limit', op: 'dismiss', handle: l.handle, label: 'Dismiss' }, key: `limit:${l.handle}` });
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
    rows.sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || Number(b.late === true) - Number(a.late === true) || (b.ageMs ?? -1) - (a.ageMs ?? -1));
    return { items: rows.slice(0, MAX), total: rows.length, label: k => LABEL[k] };
  }
  const api = { compose, SEVERITY, LABEL, MAX };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformInbox = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
