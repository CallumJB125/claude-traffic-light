'use strict';
// The "never" half of the agent bus repo rule (board/AGENT-BUS.md §5), shared
// by the bus engine (board/tasks-engine/engine.js busRepoAllowed), main's
// awareness roster (src/agent-awareness.js) and the awareness hook
// (hooks/awareness.js). One copy, so a folder the bus refuses is a folder no
// other AI session is ever shown.
//
// Dependency-free and fs-free: packaged hooks run from Resources/hooks, and
// main must never block. Each caller injects its own async git and realpath.
//
//   git(dir, args) → Promise<stdout>; rejects when git says no (exit != 0)
//   realpath(p)    → Promise<real path>; rejects when it can't be resolved
const path = require('path');

// = board/runner/launch.js DENY_READ (test/repo-scope.test.js keeps them equal).
const DENY_READ = Object.freeze(['~/.ssh', '~/.aws', '~/.config/gh', '~/Library/Keychains', '~/.claude', '~/.claude.json', '~/.codex', '~/.claude-traffic-light', '~/.config/gcloud', '~/.azure']);
// = engine.js PROTECTED_IN_PLACE: a dot-folder or ~/Library directly under $HOME.
const PROTECTED_IN_PLACE = /^(?:\.|Library$)/;
const CASE_INSENSITIVE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

const within = (dir, base) => dir === base || dir.startsWith(`${base}${path.sep}`);

// = board/shared/scope.js normalizeRemoteUrl (test/repo-scope.test.js keeps them equal).
function normalizeRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  let s = url.trim();
  if (!s) return null;
  let host;
  let p;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (!['ssh', 'git', 'http', 'https', 'git+ssh', 'ssh+git'].includes(proto)) return null;
    s = s.slice(scheme[0].length);
    const slash = s.indexOf('/');
    let authority = slash === -1 ? s : s.slice(0, slash);
    p = slash === -1 ? '' : s.slice(slash + 1);
    authority = authority.slice(authority.lastIndexOf('@') + 1);
    const colon = authority.indexOf(':');
    if (colon !== -1) {
      const after = authority.slice(colon + 1);
      if (!/^\d*$/.test(after)) p = `${after}/${p}`;
      authority = authority.slice(0, colon);
    }
    host = authority;
  } else {
    const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(s);
    if (!m || /^[a-z]$/i.test(m[1])) return null;
    host = m[1];
    p = m[2];
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  p = p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const segs = p.split('/').filter(Boolean);
  if (segs.length < 2 || segs.some((x) => x === '.' || x === '..')) return null;
  const joined = segs.join('/');
  return `${host}/${CASE_INSENSITIVE_HOSTS.has(host) ? joined.toLowerCase() : joined}`;
}

// A protected folder: a root, $HOME or a folder holding it, or a dot-folder or
// ~/Library directly under $HOME. `home` is already a realpath.
function isProtected(dir, home) {
  if (dir === '/' || dir === home || home.startsWith(`${dir}${path.sep}`)) return true;
  if (!dir.startsWith(`${home}${path.sep}`)) return false;
  return PROTECTED_IN_PLACE.test(path.relative(home, dir).split(path.sep)[0]);
}

// engine.js's rule for "may this be worked on in place": the top, or where
// the sibling worktree would go.
function protectedReason(top, home) {
  return isProtected(top, home) || (path.dirname(top) !== home && isProtected(path.dirname(top), home)) ? 'PROTECTED' : null;
}

/**
 * Why `top` (a git top or a folder's realpath) is never on the bus and never
 * shown to other AI sessions, or null. Order and matching as busRepoAllowed
 * had them inline: a root or $HOME (or a folder holding it); Plexiform's data
 * folder; a DENY_READ path; an exclude entry (a folder covers everything below
 * it and every worktree sharing its git-common-dir; a non-path entry is a
 * canonical remote).
 */
async function neverReason(top, { home, dataDirs = [], denyRead = DENY_READ, exclude = [], git, realpath, normalize = normalizeRemoteUrl } = {}) {
  if (!top || typeof top !== 'string') return 'UNRESOLVED';
  const real = async (p) => { try { return await realpath(p); } catch { return p; } };
  const h = await real(home);
  if (top === path.parse(top).root) return 'ROOT';
  if (within(h, top)) return 'HOME';
  for (const d of dataDirs) {
    const data = await real(d);
    if (within(top, data) || within(data, top)) return 'DATA';
  }
  if (denyRead.some((p) => within(top, path.join(h, p.replace(/^~\//, ''))))) return 'DENY';
  if (!exclude.length) return null;
  const url = await git(top, ['config', '--get', 'remote.origin.url']).then((x) => String(x).trim(), () => null);
  const canon = url ? normalize(url) : null;
  const commonDir = async (dir) => git(dir, ['rev-parse', '--git-common-dir'])
    .then((x) => realpath(path.resolve(dir, String(x).trim())), () => null);
  let common;
  for (const key of exclude) {
    if (!path.isAbsolute(key)) { if (canon && (normalize(key) ?? key) === canon) return 'EXCLUDED'; continue; }
    const r = await real(key);
    if (within(top, r)) return 'EXCLUDED';
    if (common === undefined) common = await commonDir(top);
    if (common && common === (await commonDir(r))) return 'EXCLUDED';
  }
  return null;
}

module.exports = { neverReason, protectedReason, isProtected, normalizeRemoteUrl, within, DENY_READ, PROTECTED_IN_PLACE };
