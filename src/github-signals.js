// Git and CI signals (F2, polling v1): pull requests and GitHub Actions runs
// as transient rule signals — pr-review-requested, pr-changes-requested,
// ci-failed, ci-passed, deploy-finished, deploy-failed.
//
// It asks GitHub through the user's own `gh` login (`gh api`), never a token
// of ours, and never touches gh's config. What it watches:
//   - repos: the GitHub remote of every live session's folder (kept for an
//     hour after the last session there closes), plus config.gitRepos;
//   - runs: only runs you triggered (`actor=<you>`). CI = a non-deploy
//     workflow's latest run on a branch a session is on; deploy = a workflow
//     whose name is in config.gitDeployWorkflows (default: name says deploy,
//     release or publish), on any branch;
//   - PRs: review requests addressed to you, and "changes requested" reviews
//     on PRs you opened.
//
// Rate budget: every GET carries the last ETag as If-None-Match, and a 304
// does not count against the primary rate limit (GitHub REST best practices,
// verified live: X-RateLimit-Used unchanged across a 304). Retry-After and
// X-RateLimit-Remaining 0 are obeyed; other failures back off exponentially.
//
// Events are transitions, not states: each one has a stable id (run id +
// attempt + conclusion, review id, or repo#PR for a review request), fires
// once, and stays live for HOLD_MS[signal]. An event older than FRESH_MS is
// never fired, so a restart or a newly watched repo can't replay old news.
//
// Hub path (later): a GitHub App webhook relayed by the hub calls
// `ingest(events)` with the same event shape ({ id, signal, repo, at, title,
// url, branch, pr }); dedupe, freshness and hold are shared with the poller,
// so switching a repo from polling to webhooks changes nothing downstream.
// See docs/git-ci-signals.md.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SIGNALS = ['pr-review-requested', 'pr-changes-requested', 'ci-failed', 'ci-passed', 'deploy-finished', 'deploy-failed'];
const ACTIVE_MS = 90 * 1000;
const IDLE_MS = 10 * 60 * 1000;
const UNAVAILABLE_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const REPO_KEEP_MS = 60 * 60 * 1000;
const FRESH_MS = 15 * 60 * 1000;
const LOW_RATE = 100;
const MAX_OWN_PRS = 5;
const HOLD_MS = {
  'pr-review-requested': 10 * 60 * 1000,
  'pr-changes-requested': 10 * 60 * 1000,
  'ci-failed': 10 * 60 * 1000,
  'deploy-failed': 10 * 60 * 1000,
  'ci-passed': 2 * 60 * 1000,
  'deploy-finished': 2 * 60 * 1000,
};
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const DEPLOY_NAME = /deploy|release|publish/i;
const NOT_DEPLOY_NAME = /notes|drafter|changelog/i;
const SETUP_HINT = {
  'no-gh': 'Install the GitHub CLI (gh) and run gh auth login to light up for PRs and CI.',
  'no-auth': 'Run gh auth login in a terminal to light up for PRs and CI.',
};

// Repo names end up in API paths, so each segment is held to GitHub's own
// shape: no '.', '..', leading dot/dash, or anything that could walk the path.
const SEGMENT = /^[A-Za-z0-9][\w.-]*$/;
const validSegment = (x) => SEGMENT.test(x) && x !== '.' && x !== '..' && x.length <= 100;
function repoName(owner, name) {
  const n = String(name || '').replace(/\.git$/i, '');
  return validSegment(String(owner || '')) && validSegment(n) ? `${owner}/${n}` : null;
}

// git@github.com:o/r.git, https://github.com/o/r, ssh://git@github.com/o/r.git → 'o/r'.
function normalizeRemote(url) {
  const m = /^(?:[\w+.-]+:\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?[:/]+([^/\s]+)\/([^/\s]+?)\/?$/i.exec(String(url || '').trim());
  return m ? repoName(m[1], m[2]) : null;
}

function normalizeRepoList(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(/[\s,]+/);
  const out = [];
  for (const x of raw) {
    const plain = /^([^/\s]+)\/([^/\s]+)$/.exec(String(x).trim());
    const r = normalizeRemote(x) || (plain ? repoName(plain[1], plain[2]) : null);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

function isDeployWorkflow(name, chosen) {
  const n = String(name || '');
  const list = (Array.isArray(chosen) ? chosen : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (list.length) return list.includes(n.toLowerCase());
  return DEPLOY_NAME.test(n) && !NOT_DEPLOY_NAME.test(n);
}

// `gh api -i` prints the status line, headers, a blank line, then the body.
function parseResponse(stdout) {
  const text = String(stdout || '');
  const m = /^HTTP\/[\d.]+ (\d{3})/.exec(text);
  if (!m) return null;
  const split = /\r?\n\r?\n/.exec(text);
  const head = split ? text.slice(0, split.index) : text;
  const body = split ? text.slice(split.index + split[0].length) : '';
  const headers = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let json = null;
  try { json = body.trim() ? JSON.parse(body) : null; } catch { /* not JSON */ }
  return { status: Number(m[1]), headers, body: json };
}

const time = (s) => Date.parse(s || '') || 0;
const byNewest = (a, b) => time(b.created_at) - time(a.created_at) || (b.id || 0) - (a.id || 0);

// Everything one repo's responses say, as candidate events (not yet deduped).
function repoEvents({ repo, login, branches = [], deployWorkflows = [], runs = [], pulls = [], reviews = {} }) {
  const out = [];
  const latest = new Map();
  for (const run of runs.slice().sort(byNewest)) {
    if (!run || run.status !== 'completed') continue;
    const deploy = isDeployWorkflow(run.name, deployWorkflows);
    if (!deploy && !branches.includes(run.head_branch)) continue;
    const key = deploy ? `d:${run.workflow_id}` : `c:${run.workflow_id}:${run.head_branch}`;
    if (latest.has(key)) continue;
    latest.set(key, run);
    const failed = FAILED.has(run.conclusion);
    if (!failed && run.conclusion !== 'success') continue;
    out.push({
      id: `run:${repo}:${run.id}:${run.run_attempt || 1}:${run.conclusion}`,
      signal: deploy ? (failed ? 'deploy-failed' : 'deploy-finished') : (failed ? 'ci-failed' : 'ci-passed'),
      repo, branch: run.head_branch || null, title: run.name || null, url: run.html_url || null, at: run.updated_at || run.created_at,
    });
  }
  for (const pr of pulls) {
    const author = pr.user && pr.user.login;
    if (author !== login && (pr.requested_reviewers || []).some((u) => u && u.login === login)) {
      out.push({ id: `rr:${repo}#${pr.number}`, signal: 'pr-review-requested', repo, branch: pr.head && pr.head.ref, pr: pr.number, title: pr.title, url: pr.html_url, at: pr.updated_at });
    }
    if (author !== login) continue;
    for (const rv of reviews[pr.number] || []) {
      if (rv.state !== 'CHANGES_REQUESTED') continue;
      out.push({ id: `review:${repo}:${rv.id}`, signal: 'pr-changes-requested', repo, branch: pr.head && pr.head.ref, pr: pr.number, title: pr.title, url: rv.html_url || pr.html_url, at: rv.submitted_at, by: rv.user && rv.user.login });
    }
  }
  return out;
}

// Which candidates fire now: unseen, known signal, and fresh.
function newEvents(candidates, seen, now) {
  const out = [];
  for (const e of candidates) {
    if (!e || !SIGNALS.includes(e.signal) || !e.id || seen[e.id]) continue;
    const at = time(e.at) || now;
    if (now - at > FRESH_MS) continue;
    out.push(e);
  }
  return out;
}

function activeEvents(events, now) {
  return (events || []).filter((e) => now - e.firedAt < (HOLD_MS[e.signal] || 0));
}

// How long until the next poll.
function nextDelay({ state, active, failures = 0, rate = null, retryAfterMs = 0, now }) {
  if (state === 'no-gh' || state === 'no-auth') return UNAVAILABLE_MS;
  if (retryAfterMs) return retryAfterMs;
  if (rate && rate.remaining === 0 && rate.reset) return Math.max(60000, rate.reset * 1000 - now + 1000);
  if (failures) return Math.min(MAX_BACKOFF_MS, 60000 * 2 ** (failures - 1));
  if (rate && rate.remaining != null && rate.remaining < LOW_RATE) return IDLE_MS;
  return active ? ACTIVE_MS : IDLE_MS;
}

function defaultRunGh(args) {
  const bin = process.env.CLAUDE_BUDDY_GH || 'gh';
  return new Promise((resolve) => {
    execFile(bin, args, {
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin`, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
    }, (err, stdout, stderr) => resolve({ notFound: !!(err && err.code === 'ENOENT'), stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function defaultGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5000, env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin`, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// The GitHub repo and current branch a folder is on, or null.
async function folderRepo(cwd, git = defaultGit) {
  if (!cwd) return null;
  const remotes = await git(cwd, ['remote', '-v']);
  if (!remotes) return null;
  const found = remotes.split('\n').map((l) => l.split(/\s+/)).filter((p) => p[2] === '(fetch)' && normalizeRemote(p[1]));
  const pick = found.find((p) => p[0] === 'origin') || found[0];
  if (!pick) return null;
  const branch = await git(cwd, ['branch', '--show-current']);
  return { repo: normalizeRemote(pick[1]), branch: branch || null };
}

function create({ stateFile, runGh = defaultRunGh, git = defaultGit, now = Date.now, log = () => {} } = {}) {
  const etags = new Map();
  let st = { state: 'starting', login: null, loginAt: 0, repos: {}, events: [], seen: {}, rate: null, failures: 0, lastPollAt: 0, nextPollAt: 0, error: null };
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (saved && typeof saved === 'object') {
      st.events = Array.isArray(saved.events) ? saved.events.filter((e) => e && SIGNALS.includes(e.signal)).slice(-30) : [];
      st.seen = saved.seen && typeof saved.seen === 'object' ? saved.seen : {};
    }
  } catch { /* first run */ }
  let polling = null;
  let pausedFor = null;

  function save() {
    if (!stateFile) return;
    const t = now();
    for (const [id, at] of Object.entries(st.seen)) if (t - at > 2 * 86400000) delete st.seen[id];
    const out = { ...status(), seen: st.seen, events: st.events.slice(-30) };
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch (e) { log(`[git] could not save state: ${e.message}`); }
  }

  class GhError extends Error {
    constructor(kind, msg, extra = {}) { super(msg); this.kind = kind; Object.assign(this, extra); }
  }

  async function request(apiPath) {
    const cached = etags.get(apiPath);
    const args = ['api', '-i', ...(cached ? ['-H', `If-None-Match: ${cached.etag}`] : []), apiPath];
    const r = await runGh(args);
    if (r.notFound) throw new GhError('no-gh', 'gh is not installed');
    const res = parseResponse(r.stdout);
    if (!res) {
      if (/auth login|not logged in|authenticat/i.test(r.stderr)) throw new GhError('no-auth', 'gh is not logged in');
      throw new GhError('error', (r.stderr || 'no response').trim().slice(0, 200));
    }
    const h = res.headers;
    if (h['x-ratelimit-remaining'] != null) st.rate = { limit: Number(h['x-ratelimit-limit']) || null, remaining: Number(h['x-ratelimit-remaining']), reset: Number(h['x-ratelimit-reset']) || null, used: Number(h['x-ratelimit-used']) || 0 };
    if (res.status === 304 && cached) return cached.body;
    if (res.status >= 200 && res.status < 300) {
      if (h.etag) etags.set(apiPath, { etag: h.etag, body: res.body });
      return res.body;
    }
    if (res.status === 401) throw new GhError('no-auth', 'gh credentials were rejected');
    const retry = Number(h['retry-after']);
    if ((res.status === 403 || res.status === 429) && (retry || h['x-ratelimit-remaining'] === '0' || /rate limit/i.test(JSON.stringify(res.body || '')))) {
      throw new GhError('rate', `rate limited (HTTP ${res.status})`, { retryAfterMs: retry ? retry * 1000 : 0 });
    }
    throw new GhError(res.status === 404 || res.status === 403 ? 'repo' : 'error', `HTTP ${res.status} for ${apiPath}`);
  }

  // Repos from the live sessions' folders, merged into the remembered set.
  async function discover(sessions, manual) {
    const t = now();
    const cwds = [...new Set((sessions || []).map((s) => s && s.cwd).filter(Boolean))];
    const found = await Promise.all(cwds.map(async (cwd) => ({ cwd, info: await folderRepo(cwd, git) })));
    const fresh = {};
    for (const { cwd, info } of found) {
      if (!info) continue;
      const r = fresh[info.repo] || (fresh[info.repo] = { branches: [], cwds: [] });
      if (info.branch && !r.branches.includes(info.branch)) r.branches.push(info.branch);
      if (!r.cwds.includes(cwd)) r.cwds.push(cwd);
    }
    for (const [repo, r] of Object.entries(fresh)) st.repos[repo] = { ...r, seenAt: t, manual: false };
    for (const repo of Object.keys(st.repos)) if (!fresh[repo] && !st.repos[repo].manual && t - st.repos[repo].seenAt > REPO_KEEP_MS) delete st.repos[repo];
    for (const repo of Object.keys(st.repos)) if (st.repos[repo].manual && !manual.includes(repo) && !fresh[repo]) delete st.repos[repo];
    for (const repo of manual) if (!st.repos[repo]) st.repos[repo] = { branches: [], cwds: [], seenAt: t, manual: true };
    return Object.keys(fresh).length > 0;
  }

  function record(candidates, source) {
    const t = now();
    const fired = newEvents(candidates, st.seen, t);
    for (const e of candidates) if (e && e.id && !st.seen[e.id] && !fired.includes(e)) st.seen[e.id] = t;
    const stored = fired.map((e) => {
      st.seen[e.id] = t;
      const repo = st.repos[e.repo];
      return { ...e, source, firedAt: t, cwd: e.cwd || (repo && repo.cwds[0]) || null };
    });
    st.events = st.events.concat(stored).slice(-30);
    if (stored.length) log(`[git] ${stored.map((e) => `${e.signal} ${e.repo}${e.pr ? `#${e.pr}` : ''}`).join(', ')}`);
    return stored;
  }

  async function pollRepo(repo, info, deployWorkflows) {
    // One at a time, as GitHub asks, to stay clear of secondary limits.
    const runs = await request(`repos/${repo}/actions/runs?actor=${encodeURIComponent(st.login)}&per_page=20`);
    const pulls = await request(`repos/${repo}/pulls?state=open&per_page=50`);
    const mine = (Array.isArray(pulls) ? pulls : []).filter((p) => p.user && p.user.login === st.login)
      .sort((a, b) => time(b.updated_at) - time(a.updated_at)).slice(0, MAX_OWN_PRS);
    const reviews = {};
    for (const p of mine) reviews[p.number] = await request(`repos/${repo}/pulls/${p.number}/reviews?per_page=100`) || [];
    const candidates = repoEvents({ repo, login: st.login, branches: info.branches, deployWorkflows, runs: (runs && runs.workflow_runs) || [], pulls: Array.isArray(pulls) ? pulls : [], reviews });
    // A review request that went away (answered or withdrawn) may come back.
    const requested = new Set(candidates.filter((e) => e.signal === 'pr-review-requested').map((e) => e.id));
    for (const id of Object.keys(st.seen)) if (id.startsWith(`rr:${repo}#`) && !requested.has(id)) delete st.seen[id];
    return candidates;
  }

  // One poll if it is due. opts: { sessions, config }.
  async function tick({ sessions = [], config = {} } = {}) {
    const t = now();
    if (pausedFor) { st.state = config.gitSignals === false ? 'disabled' : pausedFor; return []; }
    if (config.gitSignals === false) {
      if (st.state !== 'disabled') { st.state = 'disabled'; save(); }
      return [];
    }
    if (st.state === 'disabled') st.nextPollAt = 0;
    if (polling || t < st.nextPollAt) return [];
    polling = (async () => {
      let fired = [];
      let retryAfterMs = 0;
      const active = await discover(sessions, normalizeRepoList(config.gitRepos));
      try {
        if (!st.login || t - st.loginAt > 3600000) {
          const user = await request('user');
          st.login = user && user.login;
          st.loginAt = t;
        }
        const deployWorkflows = Array.isArray(config.gitDeployWorkflows) ? config.gitDeployWorkflows : [];
        for (const [repo, info] of Object.entries(st.repos)) {
          try {
            fired = fired.concat(record(await pollRepo(repo, info, deployWorkflows), 'poll'));
            info.error = null;
          } catch (e) {
            if (e.kind !== 'repo') throw e;
            info.error = e.message;
          }
        }
        st.state = 'ok';
        st.failures = 0;
        st.error = null;
      } catch (e) {
        st.state = e.kind === 'no-gh' || e.kind === 'no-auth' ? e.kind : e.kind === 'rate' ? 'rate-limited' : 'backoff';
        st.error = e.message;
        if (e.kind === 'error' || e.kind === 'rate') st.failures += 1;
        retryAfterMs = e.retryAfterMs || 0;
        log(`[git] ${st.state}: ${e.message}`);
      }
      st.lastPollAt = t;
      st.nextPollAt = t + nextDelay({ state: st.state, active, failures: st.failures, rate: st.rate, retryAfterMs, now: t });
      save();
      return fired;
    })();
    try { return await polling; } finally { polling = null; }
  }

  // The webhook/hub entry point: same dedupe, freshness and hold as polling.
  function ingest(events, source = 'hub') {
    const valid = (Array.isArray(events) ? events : []).filter((e) => e && typeof e.repo === 'string' && normalizeRepoList([e.repo])[0] === e.repo);
    const fired = record(valid.map((e) => ({ ...e, id: e.id ? String(e.id) : null })), source);
    if (fired.length) save();
    return fired;
  }

  function active(t = now()) {
    return st.state === 'disabled' ? [] : activeEvents(st.events, t);
  }

  function status() {
    const t = now();
    return {
      state: st.state,
      hint: SETUP_HINT[st.state] || null,
      error: st.error,
      login: st.login,
      repos: Object.entries(st.repos).map(([repo, r]) => ({ repo, branches: r.branches, cwds: r.cwds, manual: !!r.manual, error: r.error || null })),
      active: active(t),
      recent: st.events.slice(-10).reverse(),
      rate: st.rate,
      lastPollAt: st.lastPollAt ? new Date(st.lastPollAt).toISOString() : null,
      nextPollAt: st.nextPollAt ? new Date(st.nextPollAt).toISOString() : null,
      updatedAt: new Date(t).toISOString(),
    };
  }

  // Dev runs: no gh calls, but saved events still show (the visual tests).
  function pause(reason) {
    pausedFor = reason;
    st.state = reason;
  }

  return { tick, ingest, active, status, pause, request };
}

// For readers without the poller (mcp-server.js): the state file main.js writes.
function readState(stateFile, t = Date.now()) {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
  if (!saved || typeof saved !== 'object') return null;
  const { seen, events, ...rest } = saved;
  return { ...rest, active: saved.state === 'disabled' ? [] : activeEvents(events, t), recent: (Array.isArray(events) ? events : []).slice(-10).reverse() };
}

module.exports = { SIGNALS, validSegment, HOLD_MS, FRESH_MS, ACTIVE_MS, IDLE_MS, UNAVAILABLE_MS, MAX_BACKOFF_MS, SETUP_HINT, normalizeRemote, normalizeRepoList, isDeployWorkflow, parseResponse, repoEvents, newEvents, activeEvents, nextDelay, folderRepo, create, readState };
