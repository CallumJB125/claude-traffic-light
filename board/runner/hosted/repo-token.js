// Short-lived GitHub App installation tokens for hosted checkouts.
//
// The hub mints them (GET /api/runner/v1/repo-token?repo_id= → {token,
// expires_at}, authenticated by this runner's own token). They live only in
// this process's memory and reach git only as an environment variable of the
// one git process that needs it, read back by an askpass helper that holds no
// secret. Never on disk, in argv, a URL, a git config or a log line.
import fs from 'node:fs';
import path from 'node:path';

export const REFRESH_SKEW_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const TOKEN_RE = /^[A-Za-z0-9_.-]{20,512}$/;

const err = (code, message) => Object.assign(new Error(message), { code });

export function hubHttpBase(hub) {
  const u = new URL(hub);
  if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol === 'ws:') u.protocol = 'http:';
  u.pathname = '/'; u.search = ''; u.hash = '';
  return u.toString().replace(/\/$/, '');
}

export class RepoTokens {
  constructor({ hub, team, runnerToken, fetchImpl = globalThis.fetch, now = Date.now, skewMs = REFRESH_SKEW_MS }) { // privacy-flow: runner-hosted
    this.base = hubHttpBase(hub);
    this.team = team;
    this.runnerToken = runnerToken;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.skewMs = skewMs;
    this.cache = new Map();   // repo_id → {token, expiresAt}
  }

  invalidate(repoId) { this.cache.delete(repoId); }

  /** A token good for at least skewMs more (fresh: always ask the hub). */
  async get(repoId, { fresh = false } = {}) {
    const c = this.cache.get(repoId);
    if (!fresh && c && c.expiresAt - this.now() > this.skewMs) return c.token;
    const url = `${this.base}/api/runner/v1/repo-token?repo_id=${encodeURIComponent(repoId)}`;
    let res;
    try {
      res = await this.fetchImpl(url, { // privacy-flow: runner-hosted
        headers: { authorization: `Bearer ${this.runnerToken}`, 'board-team': this.team, accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw err('HUB_UNREACHABLE', 'the board hub is unreachable; cannot get a repository token');
    }
    if (res.status === 401 || res.status === 403) throw err('UNAUTHENTICATED', `the hub refused a repository token (${res.status})`);
    if (res.status === 404) throw err('NOT_AVAILABLE', 'the hub has no GitHub App installation for this repository');
    if (!res.ok) throw err('HUB_UNREACHABLE', `the hub could not mint a repository token (${res.status})`);
    let body;
    try { body = await res.json(); } catch { throw err('INTERNAL', 'the hub answered a repository token request with no JSON'); }
    const expiresAt = Date.parse(body?.expires_at ?? '');
    if (typeof body?.token !== 'string' || !TOKEN_RE.test(body.token) || !Number.isFinite(expiresAt)) throw err('INTERNAL', 'the hub answered with a malformed repository token');
    if (expiresAt - this.now() <= 0) throw err('INTERNAL', 'the hub answered with an expired repository token');
    this.cache.set(repoId, { token: body.token, expiresAt });
    return body.token;
  }
}

// The askpass helper: no secret in it, it prints the token git's env carries.
export const ASKPASS = `#!/bin/sh
case "$1" in
  Username*|username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$BOARD_GIT_TOKEN" ;;
esac
`;

export function installAskpass(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'git-askpass');
  fs.writeFileSync(file, ASKPASS, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

/** The env one networked git process gets: our askpass, no stored helpers, no prompts. */
export function tokenEnv(askpass, token) {
  return {
    GIT_ASKPASS: askpass, BOARD_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  };
}

const NETWORK = new Set(['fetch', 'push', 'pull', 'ls-remote', 'clone']);
/** The git subcommand, skipping `-c k=v` / `-C dir` style globals. */
export function subcommandOf(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C') { i++; continue; }
    if (a.startsWith('-')) continue;
    return a;
  }
  return null;
}
export const isNetworkGit = (args) => NETWORK.has(subcommandOf(args));

export function isAuthFailure(e) {
  return /Authentication failed|could not read (?:Username|Password)|Invalid username or password|HTTP(?:\/\d(?:\.\d)?)? 40[13]|returned error: 40[13]|Bad credentials/i.test(String(e?.stderr ?? '') + String(e?.message ?? ''));
}
