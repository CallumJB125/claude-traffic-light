'use strict';
// The team hub's "look here" rows (GET /api/account/inbox) folded into Home's
// Inbox and the dock badge. Pure: main.js feeds it what each linked hub
// returned and asks which rows to raise a notification for; nothing here
// reads the network or a transcript. Rows are keyed `${origin}:${id}` so two
// hubs never collide, and a row seen twice (poll plus live push) stays one row.
(function (root) {
  const NOTIFY_KINDS = Object.freeze(['mention', 'handoff_request']);
  const NOTIFY_EVERY_MS = 30_000;
  const MAX_ROWS = 200;
  const KIND = Object.freeze({ mention: 'mention', reply: 'reply', moment: 'moment', handoff_request: 'handoff', handoff_answer: 'handoff', input_answered: 'reply', board_link_request: 'link' });
  // A link request opens Sessions, where "Link a repo to a board" is (organised views PR 7).
  const DESTINATION = Object.freeze({ mention: 'overview', reply: 'overview', moment: 'overview', handoff: 'sessions', link: 'sessions' });
  const str = (v, max) => typeof v === 'string' && v.length <= max ? v : '';
  const who = (ref) => str(ref?.by_name, 120) || str(ref?.requester_name, 120) || (str(ref?.by, 100) ? 'A teammate' : 'Someone');
  const what = (ref) => str(ref?.title, 200) || str(ref?.label, 120) || str(ref?.excerpt, 200) || '';
  function title(item) {
    const by = who(item.ref), thing = what(item.ref);
    switch (item.kind) {
      case 'mention': return `${by} mentioned you${thing ? `: ${thing}` : ''}`;
      case 'reply': return `${by} replied to you${thing ? `: ${thing}` : ''}`;
      case 'moment': return `${by} marked a moment${thing ? `: ${thing}` : ''}`;
      case 'handoff_request': return `${by} handed you a card${thing ? `: ${thing}` : ''}`;
      case 'handoff_answer': return `${by} answered your hand-off${thing ? `: ${thing}` : ''}`;
      case 'input_answered': return `${by} answered your session's question${thing ? `: ${thing}` : ''}`;
      case 'board_link_request': return `${by} asked you to put ${str(item.ref?.repo_short, 80) || 'a project'} on a team board`;
      default: return `${by} needs you to look`;
    }
  }
  const keyOf = (origin, id) => `${origin}:${id}`;
  function splitKey(key) {
    const at = typeof key === 'string' ? key.lastIndexOf(':') : -1;
    return at > 0 ? { origin: key.slice(0, at), id: key.slice(at + 1) } : null;
  }
  // Only a mention or a hand-off request makes a sound-free macOS notification,
  // and at most one per 30 s per hub; everything else is badge plus Inbox.
  function notifyPolicy(item, lastAt, now = Date.now()) {
    if (!item || !NOTIFY_KINDS.includes(item.kind) || item.read_at) return false;
    return lastAt == null || now - lastAt >= NOTIFY_EVERY_MS;
  }
  function notification(item) {
    return { title: item.kind === 'mention' ? 'A teammate mentioned you' : 'A card was handed to you', body: title(item), silent: true };
  }

  function createTeamInbox({ now = Date.now } = {}) {
    const rows = new Map(); // key → {key, origin, id, kind, ref, created_at, read_at}
    const lastNotified = new Map(); // origin → ms
    function ingest(origin, items) {
      if (typeof origin !== 'string' || !origin) return [];
      const fresh = [];
      for (const it of Array.isArray(items) ? items : []) {
        const id = str(it?.id, 100);
        if (!id || !KIND[it.kind]) continue;
        const key = keyOf(origin, id);
        const had = rows.get(key);
        const row = { key, origin, id, kind: it.kind, ref: it.ref && typeof it.ref === 'object' ? it.ref : {}, created_at: str(it.created_at, 40), read_at: str(it.read_at, 40) || (had?.read_at ?? null) || null };
        rows.set(key, row);
        if (!had && !row.read_at) fresh.push(row);
      }
      if (rows.size > MAX_ROWS) for (const k of [...rows.keys()].slice(0, rows.size - MAX_ROWS)) rows.delete(k);
      return fresh;
    }
    // Marks rows read here (the badge drops at once) and says which hub to tell: [{origin, ids}].
    function markRead(keys) {
      const by = new Map();
      for (const key of Array.isArray(keys) ? keys : []) {
        const row = rows.get(key);
        if (!row) continue;
        if (!row.read_at) row.read_at = new Date(now()).toISOString();
        if (!by.has(row.origin)) by.set(row.origin, []);
        by.get(row.origin).push(row.id);
      }
      return [...by].map(([origin, ids]) => ({ origin, ids }));
    }
    const unreadRows = () => [...rows.values()].filter((r) => !r.read_at).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    // Home Inbox rows: each with one Open action and the keys Mark read sends back.
    function items(at = now()) {
      return unreadRows().map((r) => {
        const kind = KIND[r.kind];
        const ms = Date.parse(r.created_at);
        return { kind, title: title(r), meta: [str(r.ref?.team, 60), str(r.ref?.board, 60)].filter(Boolean).join(' · ') || 'Team hub', ageMs: Number.isFinite(ms) ? Math.max(0, at - ms) : null, action: { kind: 'navigate', destination: DESTINATION[kind], label: 'Open' }, read: { kind: 'inbox-read', ids: [r.key] }, key: `team:${r.key}` };
      });
    }
    function merge(localItems = [], at = now()) {
      const team = items(at);
      const local = Array.isArray(localItems) ? localItems : [];
      return { items: [...local, ...team], unread: team.length, total: local.length + team.length };
    }
    // Which of the rows just ingested deserve a notification right now (the throttle advances here).
    function toNotify(fresh, at = now()) {
      const out = [];
      for (const r of Array.isArray(fresh) ? fresh : []) {
        if (!notifyPolicy(r, lastNotified.get(r.origin) ?? null, at)) continue;
        lastNotified.set(r.origin, at);
        out.push(notification(r));
      }
      return out;
    }
    return { ingest, markRead, unread: () => unreadRows().length, items, merge, toNotify, size: () => rows.size };
  }
  const api = { createTeamInbox, notifyPolicy, notification, title, splitKey, keyOf, NOTIFY_KINDS, NOTIFY_EVERY_MS, KIND, DESTINATION, MAX_ROWS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformTeamInbox = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
