// Repo scoping, default deny (design §9.4, §8 T5). The runner calls scopeOf()
// before ANY byte about a session leaves the machine, filterPath() on every
// path in a fact, and serializeOutbound() (which runs assertNoForeignBytes)
// as the one and only outbox serializer. A session whose repo is not both on
// the board allowlist AND opted in on this machine produces zero bytes.
//
// Pure: the runner does the git calls (`rev-parse --show-toplevel`,
// `--git-common-dir`, `remote get-url origin`) and passes the strings in.
// Browser-safe, dependency-free.

// Hosts whose owner/repo path is case-insensitive.
const CASE_INSENSITIVE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

/**
 * Canonical repo identity: "host/owner/repo" (more path segments allowed for
 * GitLab subgroups). null for anything that is not a network remote
 * (local paths, file://, empty).
 *   git@github.com:PistorVentures/bondly.git     → github.com/pistorventures/bondly
 *   ssh://git@github.com:22/PistorVentures/bondly → github.com/pistorventures/bondly
 *   https://user:tok@GitHub.com/PistorVentures/Bondly/ → github.com/pistorventures/bondly
 */
export function normalizeRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  let s = url.trim();
  if (!s) return null;
  let host;
  let path;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (!['ssh', 'git', 'http', 'https', 'git+ssh', 'ssh+git'].includes(proto)) return null;
    s = s.slice(scheme[0].length);
    const slash = s.indexOf('/');
    let authority = slash === -1 ? s : s.slice(0, slash);
    path = slash === -1 ? '' : s.slice(slash + 1);
    authority = authority.slice(authority.lastIndexOf('@') + 1);   // strip userinfo
    // ssh://host:owner/repo (scp-ish inside ssh://) vs host:port
    const colon = authority.indexOf(':');
    if (colon !== -1) {
      const after = authority.slice(colon + 1);
      if (!/^\d*$/.test(after)) path = `${after}/${path}`;
      authority = authority.slice(0, colon);
    }
    host = authority;
  } else {
    // scp-like: [user@]host:path — but not a Windows drive (C:\...) or a local path.
    const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(s);
    if (!m || /^[a-z]$/i.test(m[1])) return null;
    host = m[1];
    path = m[2];
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  path = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const segs = path.split('/').filter(Boolean);
  if (segs.length < 2 || segs.some((p) => p === '.' || p === '..')) return null;
  const joined = segs.join('/');
  return `${host}/${CASE_INSENSITIVE_HOSTS.has(host) ? joined.toLowerCase() : joined}`;
}

// Allowlist entries are trusted hub data and may already be canonical
// ("github.com/o/r", which is what the hub stores) or a remote URL. Only
// allowlist names get this leniency: a session's remote must be a real remote.
function allowlistName(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return normalizeRemoteUrl(t) ?? (/^[^:/\s]+\.[^:/\s]+\//.test(t) ? normalizeRemoteUrl(`https://${t}`) : null);
}

/**
 * allowlist: [{repo_id, canonical_url, aliases?: string[]}] (board_repos ⋈ repos).
 * canonical_url/aliases may be canonical ("host/owner/repo") or remote URLs.
 * Returns the repo_id whose canonical url or alias matches, else null.
 */
export function matchRepo(remoteUrl, allowlist) {
  const canon = normalizeRemoteUrl(remoteUrl);
  if (!canon || !Array.isArray(allowlist)) return null;
  for (const r of allowlist) {
    const names = [r.canonical_url, ...(r.aliases ?? [])].map(allowlistName).filter(Boolean);
    if (names.includes(canon)) return r.repo_id;
  }
  return null;
}

/**
 * THE scoping decision. session: {cwd, toplevel, remote_url} as the runner
 * read them from git (toplevel null / remote_url null ⇒ deny).
 * policy: {allowlist, opted_in: Set|string[] of repo_ids opted in on THIS machine}.
 * Returns {repo_id, toplevel} or null (null ⇒ nothing about this session may
 * be serialized).
 */
export function scopeOf(session, policy) {
  if (!session || !session.toplevel || !session.remote_url || !policy) return null;
  const repoId = matchRepo(session.remote_url, policy.allowlist);
  if (!repoId) return null;
  const opted = policy.opted_in instanceof Set ? policy.opted_in : new Set(policy.opted_in ?? []);
  if (!opted.has(repoId)) return null;
  // Phase 2 interactive links stop sharing while cwd is outside the repo.
  if (session.cwd && filterPath(session.cwd, session.toplevel) === null) return null;
  return { repo_id: repoId, toplevel: normPath(session.toplevel) };
}

function normPath(p) {
  const s = String(p).replace(/\\/g, '/');
  const abs = s.startsWith('/') || /^[a-z]:\//i.test(s);
  const out = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); continue; }
    out.push(seg);
  }
  const drive = /^[a-z]:$/i.test(out[0] ?? '');
  return (abs && !drive ? '/' : '') + out.join('/');
}

/**
 * Per-fact path filter: absolute or toplevel-relative path → repo-relative
 * path, or null when it resolves outside the repo toplevel. The toplevel
 * itself maps to ".".
 */
export function filterPath(p, toplevel) {
  if (typeof p !== 'string' || !p || !toplevel) return null;
  if (p.includes('\0')) return null;
  const top = normPath(toplevel);
  const raw = p.replace(/\\/g, '/');
  const isAbs = raw.startsWith('/') || /^[a-z]:\//i.test(raw) || raw.startsWith('~');
  if (raw.startsWith('~')) return null;
  const full = normPath(isAbs ? raw : `${top}/${raw}`);
  const cmpTop = /^[a-z]:/i.test(top) ? top.toLowerCase() : top;
  const cmpFull = /^[a-z]:/i.test(full) ? full.toLowerCase() : full;
  if (cmpFull === cmpTop) return '.';
  if (!cmpFull.startsWith(`${cmpTop}/`)) return null;
  return full.slice(top.length + 1);
}

// Credential shapes that must never appear in a hub-bound byte (exit j).
export const CREDENTIAL_PATTERNS = Object.freeze([
  ['anthropic_key', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/],
  ['github_pat', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['cf_access_secret', /\bCF-Access-Client-Secret\s*[:=]\s*\S{8,}/i],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
  ['env_secret', /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*['"]?[^\s'"]{6,}/],
]);

// Local absolute paths that must never leave the machine (the worktree path
// included: it is local-only, §9.4 #6). Facts carry repo-relative paths.
// Any preceding character counts as a boundary (file:///Users/…, cat</Users/…,
// x|/home/…, {/Users/…}) except one that continues a path segment, so a
// repo-relative lib/tmp/x.js is not mistaken for /tmp/.
const LOCAL_PATH = /(?<![\w.-])(?:\/Users\/|\/home\/|\/root\/|\/private\/|\/var\/folders\/|\/tmp\/|\/Volumes\/|~\/|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])/;

/**
 * Redact free text (command tails, agent-written text) before it enters the
 * outbox: toplevel-prefixed paths become repo-relative, other local absolute
 * paths become <path>, credential shapes become <redacted:kind>.
 */
export function redact(text, toplevel) {
  if (typeof text !== 'string') return text;
  let out = text;
  if (toplevel) {
    const top = normPath(toplevel);
    out = out.split(`${top}/`).join('').split(top).join('.');
  }
  out = out.replace(/(?<![\w.-])(?:(?:\/Users\/|\/home\/|\/root\/|\/private\/|\/var\/folders\/|\/tmp\/|\/Volumes\/|~\/)[^\s"'`)},\]<>|]*|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"'`)},\]<>|]*)/g, '<path>');
  for (const [kind, re] of CREDENTIAL_PATTERNS) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), `<redacted:${kind}>`);
  return out;
}

export class ForeignBytesError extends Error {
  constructor(reason, where) {
    super(`refusing to serialize: ${reason}${where ? ` at ${where}` : ''}`);
    this.name = 'ForeignBytesError';
    this.code = 'OUT_OF_SCOPE';
    this.reason = reason;
    this.where = where;
  }
}

/**
 * Serializer guard. Throws ForeignBytesError unless:
 *  - scope is non-null (a scoped session),
 *  - message.repo_id (when present) equals scope.repo_id; every repo-scoped
 *    message kind MUST carry repo_id (protocol.js REPO_SCOPED),
 *  - no string anywhere contains a local absolute path or a credential shape.
 */
export function assertNoForeignBytes(message, scope, { requireRepoId = false } = {}) {
  if (!scope || !scope.repo_id) throw new ForeignBytesError('no scope (session not in an opted-in board repo)');
  if (message == null || typeof message !== 'object') throw new ForeignBytesError('message must be an object');
  if ('repo_id' in message ? message.repo_id !== scope.repo_id : requireRepoId) {
    throw new ForeignBytesError(`repo_id ${message.repo_id} does not match scope ${scope.repo_id}`);
  }
  const walk = (v, where, depth) => {
    if (depth > 32) throw new ForeignBytesError('message too deep', where);
    if (typeof v === 'string') {
      if (LOCAL_PATH.test(v)) throw new ForeignBytesError('local absolute path', where);
      for (const [kind, re] of CREDENTIAL_PATTERNS) if (re.test(v)) throw new ForeignBytesError(`credential pattern ${kind}`, where);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`, depth + 1)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walk(k, `${where}.<key>`, depth + 1); walk(x, `${where}.${k}`, depth + 1); }
  };
  walk(message, '$', 0);
}

/** The ONE outbox serializer: guard, then JSON. Never returns bytes for an out-of-scope message. */
export function serializeOutbound(message, scope, opts) {
  assertNoForeignBytes(message, scope, opts);
  return JSON.stringify(message);
}
