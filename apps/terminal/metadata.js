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
          subagents: agents ? {
            total: agents.length, running: agents.filter((a) => a.status === 'working' || a.status === 'running').length,
            list: agents.slice(0, 8).map((a) => ({ name: text(a.name, 40) || 'subagent', kind: a.kind === 'teammate' ? 'teammate' : 'subagent', status: text(a.status, 16) || 'unknown', since_ms: ms(a.since, now) })),
          } : null,
          tasks, cost: null, approvals: null, branch: null, changes: null, ci: null, tabId: null, timeline: [],
        };
        // Main-process only: non-enumerable, so neither IPC nor JSON carries them.
        Object.defineProperty(row, 'cwd', { value: typeof data.cwd === 'string' && path.isAbsolute(data.cwd) ? data.cwd : null, enumerable: false });
        Object.defineProperty(row, 'pid', { value: Number.isSafeInteger(pid) && pid > 1 ? pid : null, enumerable: false });
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

// Observed transitions since this window opened, newest last.
function trackTimeline(history, rows, now = Date.now()) {
  const live = new Set();
  for (const row of rows) {
    live.add(row.id);
    let list = history.get(row.id);
    if (!list) {
      list = [];
      if (row.started_ms !== null) list.push({ at: now - row.started_ms, bucket: 'idle', text: 'Session started' });
      history.set(row.id, list);
    }
    const last = list[list.length - 1];
    if (!last || last.text !== row.doing || last.bucket !== row.bucket) {
      list.push({ at: now - (row.since_ms ?? 0), bucket: row.bucket, text: row.doing });
      if (list.length > 12) list.splice(0, list.length - 12);
    }
    row.timeline = list.slice(-6).map((e) => ({ ago_ms: Math.max(0, now - e.at), bucket: e.bucket, text: e.text }));
  }
  for (const id of history.keys()) if (!live.has(id)) history.delete(id);
}

module.exports = { readMetadata, readSpend, readCi, gitInfo, parseStatus, trackTimeline, bucketOf, SIGNALS, PRICES, priceKey, costOf, modelLabel };
