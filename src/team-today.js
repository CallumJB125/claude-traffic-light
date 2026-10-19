'use strict';
// Home's "Team today" card: who on your teams is working on what right now,
// what changed since you last looked, and where a teammate's work overlaps
// yours. Main-only. It reads only what the hub already shows you: the activity
// log's current records (src/team-activity.js, the same rule as the team
// brief: nothing is read back from a team you do not share summaries with) and
// the board snapshot the Board page shows. Nothing is sent. Signed out, it is
// nothing at all.
//
// Overlaps use the board's own engine (board/shared/overlap.js) on your local
// WorkRecords against teammates' shared ones, so Home and the board agree.
const fs = require('node:fs');
const path = require('node:path');
const { createActivityClient } = require('./team-activity');
const { clean } = require('./work-capture');
const { heatmap } = require('./team-heatmap');
const { standup } = require('./team-standup');

const REFRESH_MS = 60_000;
const DEADLINE_MS = 5000;
const FIRST_LOOK_MS = 24 * 3600_000;
const MAX_REPOS = 8;
const MAX_BOARDS = 8;
const MAX_ROWS = 8;
const MAX_COLUMNS = 2000;
const ACTIVE = new Set(['working', 'waiting']);
const COLUMN = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done' };
const REASON = { same_file: 'also editing', same_branch: 'on your branch', locked_path: 'also editing', same_dir: 'editing next to you in', planned_paths: 'planning to edit', lockfile: 'also changing a lockfile:', migrations: 'also adding migrations in' };
const STATUS = { working: 'Working', waiting: 'Waiting' };

const text = (v, n) => (typeof v === 'string' ? clean(v, n) : '');
const repoName = (canonical) => text(String(canonical || '').split('/').slice(-2).join('/'), 80) || 'a repository';
const time = (iso) => Date.parse(iso || '') || 0;
const newest = (a, b) => time(b.updated_at) - time(a.updated_at);

function loadOverlap() { return import('../board/shared/overlap.js'); } // privacy-flow: team-today

// Pure. teams: [{team, repo, repo_id, records:[team-activity record] | null}] (null: unreadable);
// boards: [{team, board, cards:[CardView] | null}]; mine: local WorkRecords; seen: {looked_at, columns}.
const WEEK_MS = 7 * 24 * 60 * 60_000, MAX_SHIPPED = 12, MOMENT_KINDS = { ship: 'Shipped', decision: 'Decision', demo: 'Demo', moment: 'Moment' };
function compose({ teams = [], boards = [], mine = [], seen = {}, engine = null, now = Date.now() }) {
  const installs = new Set(mine.map((r) => r && r.install_id).filter(Boolean));
  const sessions = new Set(mine.map((r) => r && r.session_id).filter(Boolean));
  const ours = (r) => sessions.has(r.session_id) || [...installs].some((i) => r.record_id.startsWith(`${i}:`));
  const since = Number.isFinite(seen.looked_at) ? seen.looked_at : now - FIRST_LOOK_MS;

  const people = [], changes = [], overlaps = [], shared = [];
  for (const t of teams) {
    if (!Array.isArray(t.records)) continue;
    const others = t.records.filter((r) => !ours(r));
    shared.push(...others);
    for (const r of others.filter((x) => ACTIVE.has(x.status))) {
      people.push({ author: r.author, adapter: r.adapter, title: r.title, status: STATUS[r.status], repo: t.repo, team: t.team, branch: r.branch, updated_at: r.updated_at });
    }
    for (const r of others) {
      if (time(r.updated_at) <= since) continue;
      if (r.handoff_requested) changes.push({ kind: 'handoff', text: `${r.author} handed "${r.title}" to the team`, repo: t.repo, team: t.team, at: r.updated_at });
      else if (r.status === 'ended') changes.push({ kind: 'finished', text: `${r.author} finished "${r.title}"`, repo: t.repo, team: t.team, at: r.updated_at });
      else if (r.status === 'review') changes.push({ kind: 'review', text: `${r.author}'s "${r.title}" is ready for review`, repo: t.repo, team: t.team, at: r.updated_at });
    }
    if (!engine) continue;
    const runs = [];
    for (const r of mine) if (r && r.repo_id === t.repo_id && ACTIVE.has(r.status)) runs.push({ run_id: `me:${r.record_id}`, repo_id: t.repo_id, branch: r.branch || null, touched_paths: r.files?.edited ?? [], mine: true });
    if (!runs.length) continue;
    const theirs = others.filter((r) => ACTIVE.has(r.status));
    const byId = new Map(theirs.map((r) => [r.record_id, r]));
    for (const r of theirs) runs.push({ run_id: r.record_id, repo_id: t.repo_id, branch: r.branch, touched_paths: r.files.edited });
    const rows = engine.computeOverlaps(runs);
    const seenPair = new Set();
    for (const me of runs.filter((x) => x.mine)) {
      for (const o of engine.overlapsFor(me.run_id, rows, null)) {
        const r = byId.get(o.other.run_id);
        if (!r || seenPair.has(r.record_id)) continue;
        seenPair.add(r.record_id);
        const reason = o.reasons.find((x) => REASON[x]) || o.reasons[0];
        const paths = o.paths.slice(0, 3);
        overlaps.push({ level: o.level, author: r.author, title: r.title, repo: t.repo, team: t.team, paths,
          text: `${r.author} is ${REASON[reason] || 'working near you'}${paths.length ? ` ${paths.join(', ')}` : ''}` });
      }
      const editing = new Set(me.touched_paths);
      for (const r of theirs) {
        if (seenPair.has(r.record_id)) continue;
        const reading = r.files.read.filter((p) => editing.has(p)).slice(0, 3);
        if (!reading.length) continue;
        seenPair.add(r.record_id);
        overlaps.push({ level: 'low', author: r.author, title: r.title, repo: t.repo, team: t.team, paths: reading, text: `${r.author} is reading ${reading.join(', ')}, which you are editing` });
      }
    }
  }

  const columns = {}, shipped = [];
  for (const b of boards) {
    // Moments teammates marked on the board (ship, decision, demo): new ones are changes, ships are shipped.
    for (const m of Array.isArray(b.moments) ? b.moments.slice(0, 50) : []) {
      if (!m || typeof m !== 'object' || !text(m.label, 120)) continue;
      const at = time(m.at), kind = MOMENT_KINDS[m.kind] ? m.kind : 'moment';
      const line = `${MOMENT_KINDS[kind]}: ${text(m.label, 120)}${text(m.by, 60) ? ` · ${text(m.by, 60)}` : ''}`;
      if (at > since) changes.push({ kind: 'moment', text: line, board: b.board, team: b.team, at: m.at });
      if (kind === 'ship' && now - at <= WEEK_MS) shipped.push({ kind: 'ship', text: text(m.label, 120), by: text(m.by, 60), board: b.board, team: b.team, at: m.at });
    }
    if (!Array.isArray(b.cards)) continue;
    for (const c of b.cards) {
      if (!c || typeof c.id !== 'string' || c.archived) continue;
      if (Object.keys(columns).length < MAX_COLUMNS) columns[c.id] = c.column;
      const name = `${text(c.key, 20)} ${text(c.title, 120)}`.trim();
      if (c.column === 'done' && Number.isFinite(c.state_age_ms) && c.state_age_ms <= WEEK_MS) shipped.push({ kind: 'done', text: name, board: b.board, team: b.team, at: new Date(now - c.state_age_ms).toISOString() });
      const was = seen.columns?.[c.id];
      if (was && was !== c.column && COLUMN[c.column]) changes.push({ kind: 'moved', text: `${name} moved to ${COLUMN[c.column]}`, board: b.board, team: b.team });
      const mergedAt = Number.isFinite(c.pr?.merged_age_ms) ? now - c.pr.merged_age_ms : null;
      if (mergedAt != null && c.pr.number) {
        const by = text(c.pr.merged_by, 60);
        if (now - mergedAt <= WEEK_MS) shipped.push({ kind: 'merged', text: `PR #${c.pr.number} · ${name}`, by, board: b.board, team: b.team, at: new Date(mergedAt).toISOString() });
        if (mergedAt > since) changes.push({ kind: 'merged', text: `PR #${c.pr.number} merged${by ? ` by ${by}` : ''} · ${name}`, board: b.board, team: b.team, at: new Date(mergedAt).toISOString(), url: typeof c.pr.url === 'string' && c.pr.url.startsWith('https://github.com/') ? c.pr.url : null });
      }
    }
  }

  people.sort(newest);
  changes.sort((a, b) => time(b.at) - time(a.at));
  overlaps.sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.level] || 0) - ({ high: 3, medium: 2, low: 1 }[a.level] || 0));
  const cap = (list) => ({ items: list.slice(0, MAX_ROWS), more: Math.max(0, list.length - MAX_ROWS) });
  shipped.sort((a, b) => time(b.at) - time(a.at));
  const heatFor = (window) => { const x = heatmap(shared, { window, now }); return { window: x.window, dirs: x.dirs, more: x.more, shared: x.shared.slice(0, 10), total: x.total }; };
  const heat = { '24h': heatFor('24h'), '7d': heatFor('7d') };
  return { heat, standup: standup(shared, { now }), people: cap(people), changes: cap(changes), overlaps: cap(overlaps), shipped: { items: shipped.slice(0, MAX_SHIPPED), more: Math.max(0, shipped.length - MAX_SHIPPED) }, columns, since };
}

function readSeen(file) {
  if (!file) return {};
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    const columns = v && typeof v.columns === 'object' && !Array.isArray(v.columns) ? Object.fromEntries(Object.entries(v.columns).filter(([k, c]) => typeof k === 'string' && typeof c === 'string').slice(0, MAX_COLUMNS)) : {};
    return { looked_at: Number.isFinite(v?.looked_at) ? v.looked_at : undefined, columns };
  } catch { return {}; }
}

// links() → [{repo, route, token}] for every signed-in team route (buddy-window teamMemoryLinks).
// board(route) → the board snapshot ({ok, cards, board}) or null. mine() → this Mac's WorkRecords.
function createTeamToday({ links, board, mine = () => [], fetch, file = null, now = Date.now, overlap = loadOverlap, log = () => {} }) {
  let seen = readSeen(file);
  let cache = null, inflight = null, timer = null, columns = null;
  const save = () => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(seen), { mode: 0o600 }); } catch { /* best effort */ }
  };

  async function read() {
    let all = [];
    try { all = (await links()) || []; } catch { all = []; }
    all = all.filter((l) => l && l.route && typeof l.route.repo_id === 'string');
    if (!all.length) return { state: 'signed_out' };
    const deadline = Date.now() + DEADLINE_MS;
    const repos = new Map(), boardsBy = new Map(), quiet = new Set();
    for (const l of all) {
      const team = text(l.route.team_name, 60) || 'Team';
      if (l.route.share_summaries !== true) quiet.add(team);
      else if (!repos.has(`${l.route.hub}|${l.route.repo_id}`)) repos.set(`${l.route.hub}|${l.route.repo_id}`, { l, team });
      const bk = `${l.route.hub}|${l.route.team_id}|${l.route.board_id}`;
      if (!boardsBy.has(bk)) boardsBy.set(bk, { l, team });
    }
    const teams = await Promise.all([...repos.values()].slice(0, MAX_REPOS).map(async ({ l, team }) => {
      const out = { team, repo: repoName(l.repo || l.route.canonical_url), repo_id: l.route.repo_id, records: null };
      try {
        const cur = await createActivityClient({ baseUrl: l.route.hub, token: l.token, fetch }).current(l.route.repo_id, deadline);
        if (cur.ok) out.records = cur.records;
      } catch { /* unreachable */ }
      return out;
    }));
    const boards = await Promise.all([...boardsBy.values()].slice(0, MAX_BOARDS).map(async ({ l, team }) => {
      let snap = null;
      try { snap = await board(l.route); } catch { snap = null; }
      const settings = snap?.board?.settings && typeof snap.board.settings === 'object' ? snap.board.settings : {};
      return { team, board: text(snap?.board?.name || l.route.board_name, 60) || 'Board', cards: snap && snap.ok !== false && Array.isArray(snap.cards) ? snap.cards : null, moments: Array.isArray(settings.moments) ? settings.moments : [] };
    }));
    let engine = null;
    try { engine = await overlap(); } catch (e) { log(`[team-today] overlap engine unavailable: ${e.message}`); }
    let local = [];
    try { local = (await mine()) || []; } catch { local = []; }
    const failed = [...teams.filter((t) => !t.records), ...boards.filter((b) => !b.cards)];
    const reached = teams.some((t) => t.records) || boards.some((b) => b.cards);
    if (!reached) return { state: 'error' };
    if (!seen.columns || !Object.keys(seen.columns).length) {
      const first = compose({ boards, now: now() }).columns;
      if (Object.keys(first).length) { seen = { ...seen, columns: first }; save(); }
    }
    const view = compose({ teams, boards, mine: local, seen, engine, now: now() });
    columns = view.columns;
    return {
      state: 'ok', teams: [...new Set(all.map((l) => text(l.route.team_name, 60) || 'Team'))],
      sharing_off: [...quiet].filter((t) => !teams.some((x) => x.team === t)),
      unreachable: [...new Set(failed.map((x) => x.team))],
      heat: view.heat, standup: view.standup, people: view.people, changes: view.changes, overlaps: view.overlaps, shipped: view.shipped, since: view.since,
    };
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const at = now();
      let next;
      try { next = await read(); } catch (e) { log(`[team-today] ${e.message}`); next = { state: 'error' }; }
      if (next.state === 'error') cache = cache && cache.state !== 'signed_out' ? { ...cache, state: 'error', checked_at: at } : { state: 'error', checked_at: at, updated_at: null };
      else cache = { ...next, updated_at: next.state === 'ok' ? at : null, checked_at: at };
      return cache;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    refresh,
    // The cached card; a stale or missing one starts a background refresh and answers with what it has.
    snapshot() {
      if (!cache || now() - (cache.checked_at || 0) > REFRESH_MS) void refresh();
      return cache && cache.state !== 'signed_out' ? cache : null;
    },
    markSeen() {
      seen = { looked_at: now(), columns: columns || seen.columns || {} };
      save();
      if (cache && cache.state !== 'signed_out') cache = { ...cache, changes: { items: [], more: 0 }, since: seen.looked_at };
      return true;
    },
    start() { if (!timer) { timer = setInterval(() => void refresh(), REFRESH_MS); timer.unref?.(); void refresh(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}

function wire({ ipcMain, allowed, ...opts }) {
  const today = createTeamToday(opts);
  ipcMain.handle('home:team-today', (e) => (allowed(e) ? today.snapshot() : null));
  ipcMain.handle('home:team-today-seen', (e) => (allowed(e) ? today.markSeen() : false));
  ipcMain.handle('home:team-today-refresh', async (e) => (allowed(e) ? ((await today.refresh()).state === 'signed_out' ? null : today.snapshot()) : null));
  today.start();
  return today;
}

// Dev only (main.js gates it on an unpackaged dev run): a FAKE signed-in team from a JSON
// fixture, for screenshots. {routes:[route], current:{repo_id:[record]}, boards:{board_id:snapshot}, mine:[record]}.
function fixtureSources(fx) {
  const route = (r) => ({ hub: 'http://127.0.0.1', share_summaries: true, ...r });
  return {
    links: async () => (fx.routes || []).map((r) => ({ repo: r.canonical_url, route: route(r), token: () => 'fake' })),
    board: async (r) => (fx.boards?.[r.board_id] ? { ok: true, ...fx.boards[r.board_id] } : null),
    mine: () => fx.mine || [],
    fetch: async (url) => {
      const id = new URL(url).searchParams.get('repo_id');
      const body = fx.unreachable ? null : JSON.stringify({ records: fx.current?.[id] || [] });
      if (!body) throw new Error('unreachable');
      return { status: 200, headers: { get: () => null }, text: async () => body };
    },
  };
}

module.exports = { createTeamToday, compose, wire, fixtureSources, REFRESH_MS, WEEK_MS };
