'use strict';

// "2 sessions share this working tree": live sessions (any tool) whose cwd is
// in the same git toplevel while it has uncommitted work. Uses local
// `git rev-parse --show-toplevel` / `git status --porcelain` only. Separate git
// worktrees have separate toplevels, so they never count as shared.

const path = require('node:path');
const { execFile } = require('node:child_process');

const LIVE_MS = 30 * 60_000;
const MAX_CWDS = 200;

function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? null : String(out)));
  });
}

// sessions: Sessions rows ({ sessionId, cwd, ... }) -> [{ toplevel, sessions: [sessionId], dirty: n }]
// shared() answers synchronously from a cache and refreshes it in the background;
// refresh() does the same work and resolves with the new answer.
// Options: { ttlMs = 30000, now = Date.now, log, git(args, cwd) -> Promise<stdout | null> }.
function createWorktreeShare({ ttlMs = 30000, now = Date.now, log = () => {}, git = runGit } = {}) {
  const tops = new Map(); // cwd -> { at, top }
  let last = [], lastAt = -Infinity, lastKey = '', inflight = null;

  function live(sessions) {
    const t = now(), seen = new Map();
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (!s || typeof s !== 'object' || typeof s.sessionId !== 'string' || typeof s.cwd !== 'string' || !path.isAbsolute(s.cwd)) continue;
      if (s.remote || s.device || s.sessionId.startsWith('remote:') || s.signal === 'session-end') continue;
      const at = Date.parse(s.updatedAt);
      if (!Number.isFinite(at) || t - at > LIVE_MS) continue;
      seen.set(s.sessionId, s.cwd);
    }
    return [...seen.entries()];
  }

  async function toplevel(cwd) {
    const c = tops.get(cwd);
    if (c && now() - c.at < ttlMs * 10) return c.top;
    const out = await git(['rev-parse', '--show-toplevel'], cwd);
    const top = out ? out.trim() || null : null;
    if (tops.size >= MAX_CWDS) tops.delete(tops.keys().next().value);
    tops.set(cwd, { at: now(), top });
    return top;
  }

  async function refresh(sessions) {
    const list = live(sessions);
    const byTop = new Map();
    for (const [id, cwd] of list) {
      const top = await toplevel(cwd);
      if (!top) continue;
      if (!byTop.has(top)) byTop.set(top, []);
      byTop.get(top).push(id);
    }
    const out = [];
    for (const [top, ids] of byTop) {
      if (ids.length < 2) continue;
      const st = await git(['--no-optional-locks', 'status', '--porcelain'], top);
      const dirty = st ? st.split('\n').filter((l) => l.trim()).length : 0;
      if (dirty) out.push({ toplevel: top, sessions: ids, dirty });
    }
    last = out; lastAt = now();
    return out;
  }

  function shared(sessions) {
    const key = live(sessions).map((x) => x.join('\0')).sort().join('\n');
    if (!inflight && (key !== lastKey || now() - lastAt >= ttlMs)) {
      lastKey = key;
      inflight = refresh(sessions).catch((e) => { log('[worktree-share] refresh failed', e && e.message); return last; }).finally(() => { inflight = null; });
    }
    return last;
  }

  return { shared, refresh };
}

module.exports = { createWorktreeShare, LIVE_MS };
