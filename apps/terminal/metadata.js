'use strict';
// Local observed hook metadata only: no transcripts, requests, titles, summaries,
// prompts, external commands or writes. These rows grant no control authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const text = (s, n = 80) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, n) : '';
const DAY = 24 * 60 * 60 * 1000;

// Mirrors src/work-organise.js SIGNALS for hook signals (parity is tested), so
// the Terminal files a session under the same bucket Plexiform shows.
const SIGNALS = {
  needs: ['permission-ask', 'user-question', 'question-ask', 'question', 'plan-approval', 'plan', 'approval', 'blocked', 'failed_limit', 'limit-hit', 'limit', 'budget', 'budget-reached', 'waiting', 'input', 'needs-input', 'needs_input'],
  working: ['session-start-working', 'prompt-submit', 'tool-use', 'tool-done', 'tool-failed', 'permission-denied', 'compact', 'compacting', 'subagent-start', 'subagent-done', 'running', 'reconnecting'],
  check: ['stop', 'review'],
  stuck: ['stuck', 'turn-failed', 'failed', 'stalled', 'orphaned', 'unresponsive', 'error'],
};
const BUCKET_OF = Object.fromEntries(Object.entries(SIGNALS).flatMap(([id, keys]) => keys.map((k) => [k, id])));
const bucketOf = (signal) => BUCKET_OF[String(signal || '').toLowerCase()] || 'idle';
const PROVIDERS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', hermes: 'Hermes' };

function modelLabel(model) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(model || ''));
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  return text(model, 32) || null;
}
// Short, fixed phrases from the signal and tool name only; never prompt text.
function describe(bucket, data) {
  const tool = text(data.tool, 40);
  if (bucket === 'needs') {
    if (data.askKind === 'question' || /question/.test(data.signal)) return 'Asked you a question';
    if (/limit|budget/.test(data.signal)) return 'Hit a usage limit';
    if (/plan/.test(data.signal)) return 'Waiting for plan approval';
    return tool ? `Approve ${tool}` : 'Waiting for your approval';
  }
  if (bucket === 'working') {
    if (/compact/.test(data.signal)) return 'Compacting context';
    if (data.signal === 'subagent-start') return 'Starting a subagent';
    if (data.signal === 'prompt-submit') return 'Thinking';
    if (data.signal === 'tool-failed') return tool ? `${tool} failed, continuing` : 'A tool failed, continuing';
    if (data.signal === 'tool-use') return tool ? `Running ${tool}` : 'Using a tool';
    return tool ? `Working · last used ${tool}` : 'Working';
  }
  if (bucket === 'check') return 'Finished its turn — check the result';
  if (bucket === 'stuck') return 'Turn failed';
  return data.signal === 'idle-nudge' ? 'Idle, waiting for a prompt' : 'Idle';
}
const ms = (iso, now) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.max(0, now - t) : null; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Bounded read of one owner-owned regular file; never follows a symlink.
function readJson(file, cap = 128 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > cap) return null;
    // Read cap remains effective if a file grows after fstat.
    const b = Buffer.alloc(cap + 1); const n = fs.readSync(fd, b, 0, b.length, 0); if (n > cap) return null;
    return JSON.parse(b.subarray(0, n).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
const privateDir = (directory) => { try { const d = fs.lstatSync(directory); return d.isDirectory() && !d.isSymbolicLink() && d.uid === process.getuid(); } catch { return false; } };

// The hook's `since` is when an agent started while it works, and when it ended
// once it is done or stopped; a finished agent's start_ms is filled in by
// trackAgents only if this window saw it start.
function subagentView(agents, now) {
  const all = agents.map((a) => {
    const status = text(a.status, 16) || 'unknown', live = status === 'working' || status === 'running' || status === 'waiting';
    const out = { name: text(a.name, 40) || 'subagent', kind: a.kind === 'teammate' ? 'teammate' : 'subagent', status, start_ms: live ? ms(a.since, now) : null, end_ms: live ? null : ms(a.since, now), depth: 1 };
    const aid = typeof a.id === 'string' ? a.id.slice(0, 64) : null;
    Object.defineProperty(out, 'aid', { value: aid, enumerable: false });
    return { out, aid, parent: typeof a.parent === 'string' ? a.parent.slice(0, 64) : null, live, since: Date.parse(a.since) || 0 };
  });
  // Live agents first, then newest, so a long session's running agents are never cut.
  const pick = [...all].sort((a, b) => (b.live - a.live) || (b.since - a.since)).slice(0, 24);
  // Nesting follows parent links only; a child whose parent was cut is shown at the top level.
  const byId = new Map(pick.filter((v) => v.aid).map((v) => [v.aid, v]));
  const children = new Map();
  for (const v of pick) if (v.parent && v.parent !== v.aid && byId.has(v.parent)) children.set(v.parent, [...(children.get(v.parent) || []), v]);
  const list = [], seen = new Set();
  const walk = (v, depth) => {
    if (seen.has(v)) return; seen.add(v);
    v.out.depth = Math.min(depth, 3); list.push(v.out);
    for (const c of children.get(v.aid) || []) walk(c, depth + 1);
  };
  for (const v of pick) if (!v.parent || !byId.has(v.parent) || v.parent === v.aid) walk(v, 1);
  for (const v of pick) walk(v, 1); // parent cycles
  const view = { total: agents.length, running: all.filter((v) => v.out.status === 'working' || v.out.status === 'running').length, list };
  Object.defineProperty(view, 'starts', { value: all.filter((v) => v.aid).map((v) => [v.aid, v.out.start_ms]), enumerable: false });
  return view;
}

function readMetadata(directory, now = Date.now(), { isAlive = alive } = {}) {
  const rows = [];
  try {
    if (!privateDir(directory)) return rows;
    for (const name of fs.readdirSync(directory).filter((x) => /^[\w.-]+\.json$/.test(x)).slice(0, 200)) {
      try {
        const data = readJson(path.join(directory, name)); if (!data || typeof data !== 'object') continue;
        const provider = Object.hasOwn(PROVIDERS, data.source) ? data.source : data.source ? 'other' : 'claude';
        const age = ms(data.updatedAt, now);
        const pid = Number(data.claudePid);
        if (data.signal === 'session-end' || (age !== null && age > DAY)) continue;
        if (Number.isSafeInteger(pid) && pid > 1 && !isAlive(pid)) continue;
        const bucket = bucketOf(data.signal);
        const agents = Array.isArray(data.agents) ? data.agents.filter((a) => a && typeof a === 'object').slice(0, 100) : null;
        const tasks = data.tasks && Number.isSafeInteger(data.tasks.created) && Number.isSafeInteger(data.tasks.done) ? { created: data.tasks.created, done: data.tasks.done } : null;
        const quiet = bucket === 'working' && age !== null && age > 10 * 60 * 1000;
        const row = {
          id: crypto.createHash('sha256').update(name).digest('hex'), provider, tool: PROVIDERS[provider] || 'AI',
          title: `${PROVIDERS[provider] || 'AI'} session`, project: text(path.basename(typeof data.cwd === 'string' ? data.cwd : '')),
          bucket, signal: text(data.signal, 32), doing: describe(bucket, data), waitingOn: bucket === 'needs' ? describe(bucket, data) : null, quiet,
          status: quiet ? 'Quiet · no hook update in 10 min' : bucket === 'needs' ? 'Needs you in its own app' : bucket === 'working' ? 'Working · observed' : bucket === 'check' ? 'Finished · check its app' : bucket === 'stuck' ? 'Needs attention' : 'Idle · observed',
          age_ms: age, since_ms: ms(data.signalSince, now) ?? age, working_ms: bucket === 'working' ? ms(data.workingSince, now) : null, started_ms: ms(data.startedAt, now),
          model: modelLabel(data.model), hostApp: text(data.hostApp), interactive: data.interactive === true,
          subagents: agents ? subagentView(agents, now) : null,
          tasks, cost: null, approvals: null, branch: null, changes: null, ci: null, tabId: null, timeline: [], lane: [],
          handle: null, board: null, notesWaiting: null,
        };
        // Main-process only: non-enumerable, so neither IPC nor JSON carries them.
        Object.defineProperty(row, 'cwd', { value: typeof data.cwd === 'string' && path.isAbsolute(data.cwd) ? data.cwd : null, enumerable: false });
        Object.defineProperty(row, 'pid', { value: Number.isSafeInteger(pid) && pid > 1 ? pid : null, enumerable: false });
        // The roster's key for this session (provider|session id); used only to join, never sent.
        Object.defineProperty(row, 'key', { value: typeof data.sessionId === 'string' && /^[\w.:-]{1,128}$/.test(data.sessionId) ? `${provider === 'other' ? text(data.source, 16) : provider}|${data.sessionId}` : null, enumerable: false });
        rows.push(row);
      } catch { /* partial, unreadable and replaced hook files are omitted */ }
    }
  } catch { /* not installed: the empty state explains the metadata boundary */ }
  return rows;
}

// Today's Claude spend from Plexiform's usage rollup (token counts per day,
// model and folder). Prices mirror usage.js PRICES/costOf; parity is tested.
const PRICES = {
  fable: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
};
function priceKey(model) {
  const m = String(model || '').toLowerCase();
  if (m.replace(/-\d{8}$/, '') === 'claude-fable-5') return 'fable-5';
  return ['fable', 'opus', 'sonnet', 'haiku'].find((k) => m.includes(k)) || null;
}
function costOf(t, key) {
  const p = PRICES[key]; if (!p) return null;
  const n = (v) => Number.isFinite(v) ? v : 0, w1h = n(t.cacheWrite1h);
  return (n(t.input) * p.input + n(t.output) * p.output + n(t.cacheRead) * p.cacheRead + (n(t.cacheWrite) - w1h) * p.cacheWrite + w1h * p.input * 2) / 1e6;
}
const dayKey = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
function readSpend(dataDir, now = Date.now()) {
  const day = dayKey(now), out = { day, usd: null, turns: 0, unpricedTurns: 0, byCwd: new Map() };
  try {
    const dir = path.join(dataDir, 'usage/daily'); if (!privateDir(dir)) return out;
    const doc = readJson(path.join(dir, `${day.slice(0, 7)}.json`), 16 * 1024 * 1024);
    const sources = doc?.days?.[day]?.sources; if (!sources || typeof sources !== 'object') return out;
    let usd = 0;
    for (const models of Object.values(sources)) for (const [model, folders] of Object.entries(models || {})) {
      const key = priceKey(model);
      for (const [cwd, t] of Object.entries(folders || {})) {
        const turns = Number.isSafeInteger(t?.turns) ? t.turns : 0, c = costOf(t || {}, key);
        out.turns += turns;
        if (c === null) { out.unpricedTurns += turns; continue; }
        usd += c; out.byCwd.set(cwd, (out.byCwd.get(cwd) || 0) + c);
      }
    }
    out.usd = Math.round(usd * 100) / 100;
  } catch { /* no rollup yet: spend stays unavailable */ }
  return out;
}

// Newest CI/PR signal per branch from Plexiform's GitHub poll cache. Text only.
function readCi(dataDir) {
  const out = new Map();
  try {
    const doc = readJson(path.join(dataDir, 'git-signals.json'), 4 * 1024 * 1024);
    const items = [...(Array.isArray(doc?.recent) ? doc.recent : []), ...(Array.isArray(doc?.events) ? doc.events : [])].slice(0, 2000);
    for (const e of items) {
      if (!e || typeof e.branch !== 'string' || typeof e.signal !== 'string') continue;
      const at = Date.parse(e.at); if (!Number.isFinite(at)) continue;
      const seen = out.get(e.branch); if (seen && seen.at >= at) continue;
      const pr = /\/pull\/([1-9][0-9]{0,9})$/.exec(typeof e.url === 'string' ? e.url : '');
      out.set(e.branch, { at, signal: text(e.signal, 32), label: text(e.signal.replace(/-/g, ' '), 40), title: text(e.title, 60), pr: pr ? Number(pr[1]) : null, repo: text(e.repo, 80) });
    }
  } catch { /* no GitHub poll: CI stays unavailable */ }
  return out;
}

// Branch and uncommitted files for a folder. Read-only: --no-optional-locks
// keeps git from refreshing the index of a repository an agent is using.
function gitInfo(cwd, { timeout = 2000 } = {}) {
  return new Promise((resolve) => {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return resolve(null);
    execFile('/usr/bin/git', ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal'], { timeout, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(parseStatus(stdout));
    });
  });
}
function parseStatus(stdout) {
  const parts = String(stdout).split('\0'); let branch = null; const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]; if (!p) continue;
    if (p.startsWith('## ')) {
      const head = p.slice(3);
      branch = /^No commits yet on /.test(head) ? head.slice(18) : /^HEAD \(no branch\)/.test(head) ? 'detached HEAD' : head.split('...')[0];
      continue;
    }
    files.push({ state: p.slice(0, 2).trim() || '?', path: text(p.slice(3), 160) });
    if (p[0] === 'R' || p[0] === 'C') i++; // rename source path follows
  }
  return { branch: text(branch, 120) || null, changed: files.length, files: files.slice(0, 8) };
}

const LANE_MS = 60 * 60 * 1000;

// Board routing as the roster reports it ({kind, why, name?}). Two vocabularies
// exist (the awareness hook's and bus-contract §3.5); both map to fixed phrases.
// An unknown kind or why shows nothing rather than a guess.
const BOARD_WHY_TEXT = {
  linked_repo: 'repo is linked to this team', repo_default: 'your default board for this repo', inherited: 'started from a hand-off or card',
  no_link: 'repo not linked to a team', no_link_suggested: 'repo not linked; a team matches its GitHub org', no_repo: 'not a git repo with a remote',
  deferred: 'team hub offline, will re-route', read_only: 'your team role is read-only', read_only_role: 'your team role is read-only',
  choose: 'several team boards, none chosen', multiple_links_unchosen: 'several team boards, none chosen',
  personal_mark: 'marked personal', cards_off: 'automatic cards are off',
};
function boardView(board) {
  if (!board || typeof board !== 'object') return null;
  const why = BOARD_WHY_TEXT[board.why] || null;
  const name = text(board.name, 60);
  switch (board.kind) {
    case 'team': return { kind: 'team', label: name ? `On ${name}` : 'On a team board', why };
    case 'personal': case 'readonly': return { kind: 'personal', label: 'My board', why };
    case 'choose': return { kind: 'none', label: 'Board not chosen', why };
    case 'none': case 'untracked': return { kind: 'none', label: 'No board', why };
    case 'off': return { kind: 'none', label: 'Cards off', why };
    default: return null; // 'unknown' and anything new: say nothing
  }
}

// Plexiform's awareness roster: which observed sessions are on the agent bus,
// their bus handle and where their cards go. Keyed by provider|session id.
function readRoster(dataDir, now = Date.now()) {
  const out = { bus: null, peers: 0, self: new Map() };
  try {
    const dir = path.join(dataDir, 'awareness'); if (!privateDir(dir)) return out;
    // Same freshness rule as Plexiform's hook: the app is running (port file) and
    // the roster was rebuilt in the last five minutes; otherwise it is ignored.
    if (!fs.existsSync(path.join(dataDir, 'port'))) return out;
    const doc = readJson(path.join(dir, 'roster.json'), 1024 * 1024);
    if (!doc || typeof doc !== 'object' || doc.v !== 1) return out;
    const age = now - Date.parse(doc.generated_at);
    if (!(age >= -60000 && age < 5 * 60000)) return out;
    if (doc.bus && typeof doc.bus === 'object') out.bus = { enabled: doc.bus.enabled === true, halted: doc.bus.halted === true ? true : doc.bus.halted === false ? false : null };
    out.peers = Array.isArray(doc.peers) ? Math.min(doc.peers.length, 999) : 0;
    for (const [key, v] of Object.entries(doc.self && typeof doc.self === 'object' ? doc.self : {}).slice(0, 500)) {
      if (!v || typeof v !== 'object' || v.allowed !== true) continue;
      // notices: unread notes for this session (ids only; counted, never shown).
      out.self.set(key, { handle: typeof v.handle === 'string' && HANDLE.test(v.handle) ? v.handle : null, board: boardView(v.board), notesWaiting: v.caps?.notes === true && Array.isArray(v.notices) ? Math.min(v.notices.length, 99) : null });
    }
  } catch { /* no roster: bus fields stay absent */ }
  return out;
}

// Hand-offs from the bus trace (<data>/bus-trace.jsonl; ids, handles, providers and
// reason codes only — the trace never holds a note body, brief or title). Bounded
// tail read; lines are re-validated against the trace patterns.
const HANDLE = /^(?:(?:claude|codex|gemini)-[a-z0-9-]{1,16}-[0-9a-f]{4,6}|plexiform)$/;
const HOF = /^hof_[a-f0-9]{12,32}$/;
const REASON = /^[A-Z][A-Z_]{1,39}$/;
const TRACE_PROVIDERS = new Set(['claude', 'codex', 'gemini', 'any', 'bus']);
const REASON_TEXT = {
  PROVIDER_UNAVAILABLE: 'provider unavailable', QUOTA: 'out of quota', AUTH: 'signed out', MISSING: 'not installed', CRASH: 'crashed',
  NO_ELIGIBLE_AGENT: 'no AI could take it', NO_LOCAL_CHECKOUT: 'no local checkout', POLICY_DENIED: 'not allowed here', EXCLUDED: 'folder excluded', BLOCKED: 'blocked on its person',
};
function readTrace(files, now = Date.now(), { windowMs = 2 * LANE_MS, cap = 1024 * 1024 } = {}) {
  const lines = [];
  for (const file of [].concat(files)) tailLines(file, cap, lines);
  return handoffsFrom(lines, now, windowMs);
}
function tailLines(file, cap, lines) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd); if (!st.isFile() || st.uid !== process.getuid()) return;
      const len = Math.min(st.size, cap), b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len);
      const parts = b.toString('utf8').split('\n'); if (st.size > len) parts.shift();
      for (const p of parts) { if (p.includes('"ref":"hof_')) { try { lines.push(JSON.parse(p)); } catch { /* torn line */ } } }
    } finally { fs.closeSync(fd); }
  } catch { /* no trace file */ }
}
function handoffsFrom(lines, now, windowMs) {
  const byRef = new Map();
  for (const e of lines) {
    if (!e || typeof e.ref !== 'string' || !HOF.test(e.ref) || !Number.isFinite(e.t) || now - e.t > windowMs) continue;
    let h = byRef.get(e.ref);
    if (!h) { h = { id: crypto.createHash('sha256').update(e.ref).digest('hex').slice(0, 12), at: e.t, from: null, to: null, asker: null, provider: null, steps: new Set(), final: null, early: null, reason: null, blocked: false, last: e.t }; byRef.set(e.ref, h); }
    h.at = Math.min(h.at, e.t); h.last = Math.max(h.last, e.t);
    const handle = (v) => typeof v === 'string' && HANDLE.test(v) ? v : null;
    const reason = REASON.test(e.reason || '') ? e.reason : null;
    if (e.op === 'handoff') { h.from ??= handle(e.from_handle); h.to ??= handle(e.to) || (TRACE_PROVIDERS.has(e.to) ? e.to : null); }
    if (TRACE_PROVIDERS.has(e.provider) && e.provider !== 'bus' && e.provider !== 'any') h.provider = e.provider;
    const bad = e.result === 'refused' || e.result === 'error';
    if (['handoff', 'claim', 'start'].includes(e.op)) {
      if (bad) { h.early = 'failed'; h.reason = reason; h.steps.add(`${e.op}:bad`); }
      else if (e.result === 'ok' || e.result === 'deferred') h.steps.add(e.op);
    }
    // Only a result line settles the outcome; deferred results (expired, outcome unknown) end without one.
    if (e.op === 'result') {
      h.final = e.result === 'ok' ? 'succeeded' : bad ? 'failed' : e.result === 'deferred' ? 'ended' : h.final;
      if (h.final !== 'succeeded') h.reason = reason;
      h.steps.add(bad ? 'result:bad' : 'result');
    }
    // `returned` reports delivery to the asker (whose handle it carries), not the outcome.
    // A fallback is posted inside the bus with no handoff line, so this is its only asker.
    if (e.op === 'returned') {
      h.asker ??= handle(e.to);
      if (reason === 'BLOCKED') h.blocked = true;
    }
  }
  return [...byRef.values()].sort((a, b) => a.at - b.at).slice(-60).map((h) => {
    const has = (op) => h.steps.has(op), bad = (op) => h.steps.has(`${op}:bad`);
    const stage = (label, ops) => ({ label, state: ops.some(bad) ? 'bad' : ops.some(has) ? 'done' : 'todo' });
    const state = h.final || h.early || (h.blocked ? 'blocked' : has('start') ? 'running' : has('claim') ? 'claimed' : 'sent');
    const reason = state === 'blocked' ? 'BLOCKED' : state === 'succeeded' ? null : h.reason;
    return {
      id: h.id, from: h.from ?? h.asker, to: h.to ?? h.provider, provider: h.provider, ago_ms: Math.max(0, now - h.at), last_ms: Math.max(0, now - h.last),
      state, reason: reason ? REASON_TEXT[reason] || reason.toLowerCase().replace(/_/g, ' ') : null,
      steps: [stage('Sent', ['handoff']), stage('Claimed', ['claim']), stage('Ran', ['start']), stage('Result', ['result'])],
    };
  });
}

// A finished subagent's start is known only if this window saw it working.
function trackAgents(memory, rows, now = Date.now()) {
  const live = new Set();
  for (const row of rows) {
    // Every agent in the file, not just the listed ones, so a start is remembered while the agent is cut.
    for (const [aid, start] of row.subagents?.starts || []) {
      const key = `${row.id}:${aid}`; live.add(key);
      if (start !== null) memory.set(key, now - start);
    }
    for (const a of row.subagents?.list || []) {
      const key = `${row.id}:${a.aid}`;
      if (a.aid && a.start_ms === null && memory.has(key)) a.start_ms = Math.max(0, now - memory.get(key));
    }
  }
  for (const key of memory.keys()) if (!live.has(key)) memory.delete(key);
}

// Observed transitions since this window opened, newest last.
function trackTimeline(history, rows, now = Date.now()) {
  const live = new Set();
  for (const row of rows) {
    live.add(row.id);
    let list = history.get(row.id);
    if (!list) {
      list = [];
      // What happened before this window first saw the session is unknown: 'unseen', never guessed.
      if (row.started_ms !== null) list.push({ at: now - row.started_ms, bucket: 'unseen', text: 'Session started' });
      history.set(row.id, list);
    }
    const last = list[list.length - 1];
    if (!last || last.text !== row.doing || last.bucket !== row.bucket) {
      list.push({ at: Math.max(last ? last.at : 0, now - (row.since_ms ?? 0)), bucket: row.bucket, text: row.doing });
      // The lanes show an hour: keep the last entry that began before it, and everything since.
      let cut = 0;
      for (let i = list.length - 1; i > 0; i--) if (now - list[i].at >= LANE_MS) { cut = i; break; }
      if (cut) list.splice(0, cut);
      // Every tool call is a transition; past the cap, older same-state entries merge.
      if (list.length > TIMELINE_CAP) {
        const keep = list.filter((e, i) => i === 0 || i >= list.length - 6 || e.bucket !== list[i - 1].bucket);
        list.splice(0, list.length, ...keep.slice(-TIMELINE_CAP));
      }
    }
    row.timeline = list.slice(-6).map((e) => ({ ago_ms: Math.max(0, now - e.at), bucket: e.bucket, text: e.text }));
    // One lane segment per run of the same state; a run of several tools is named by its state.
    const runs = [];
    for (const e of list) {
      const r = runs[runs.length - 1];
      if (r && r.bucket === e.bucket) { if (r.text !== e.text) r.text = LANE_LABEL[e.bucket] || r.text; } else runs.push({ ...e });
    }
    row.lane = runs.map((e, i) => ({ start_ms: Math.max(0, now - e.at), end_ms: i + 1 < runs.length ? Math.max(0, now - runs[i + 1].at) : 0, bucket: e.bucket, text: e.text }))
      .filter((s) => s.end_ms < LANE_MS && (s.start_ms > s.end_ms || s.end_ms === 0));
  }
  for (const id of history.keys()) if (!live.has(id)) history.delete(id);
}
const TIMELINE_CAP = 400;
const LANE_LABEL = { working: 'Working', needs: 'Needs you', check: 'Finished', idle: 'Idle', stuck: 'Needs attention' };

module.exports = { readMetadata, readSpend, readCi, readRoster, readTrace, boardView, trackAgents, gitInfo, parseStatus, trackTimeline, bucketOf, SIGNALS, PRICES, priceKey, costOf, modelLabel };
