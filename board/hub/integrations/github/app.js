// The hub's own GitHub App (step 4): one app, registered once by the
// operator (docs/github-app-manifest.json), installed by teams. The app's
// private key signs a short JWT; the JWT buys an installation access token
// per installation. Tokens live only in this process's memory, until a few
// minutes before GitHub's expires_at, and never in a log line, an error
// message, the DB or a response: errors carry a status and a path template.
//
// Config (hub/README.md): GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_FILE,
// GITHUB_APP_WEBHOOK_SECRET, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET.

import { createPrivateKey, createSign } from 'node:crypto';
import { verify as verifyWebhook } from './webhook.js';

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const HOSTS = new Set(['api.github.com', 'github.com']);
const TIMEOUT_MS = 10_000;
// GitHub refuses a JWT whose exp is more than 10 minutes out, and allows 60 s of clock drift on iat.
const JWT_BACK_S = 60;
const JWT_LIFE_S = 9 * 60;
// A token is reused until this long before its expiry (GitHub: 1 hour).
const TOKEN_MARGIN_MS = 5 * 60_000;
const TOKEN_CACHE_MAX = 1000;
const INSTALLATIONS_PAGES = 5;
const REPOS_PAGES = 5;
const INSTALL_ID = /^[1-9][0-9]{0,15}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,32}[a-z0-9])?$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** Fixed text and a short code: a GitHub answer or a token never reaches it. */
export class GitHubAppError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.healthCode = code;
  }
}

/** The RS256 app JWT GitHub's /app endpoints take: iss = app id, at most 10 minutes. */
export function appJwt({ appId, privateKey, nowS }) {
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({ iat: nowS - JWT_BACK_S, exp: nowS + JWT_LIFE_S, iss: String(appId) });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/**
 * The config createGitHubApp takes, or null when the hub has no app. A set
 * but broken app is an error at startup that names the variable, never its value.
 */
export function githubAppConfig(env, { readFile }) {
  const id = env.GITHUB_APP_ID;
  const keyFile = env.GITHUB_APP_PRIVATE_KEY_FILE;
  const secret = env.GITHUB_APP_WEBHOOK_SECRET;
  if (!id && !keyFile && !secret) return null;
  if (!/^[1-9][0-9]{0,15}$/.test(id ?? '')) throw new Error('GITHUB_APP_ID must be the GitHub App\'s numeric id');
  if (!keyFile) throw new Error('GITHUB_APP_PRIVATE_KEY_FILE must name the app\'s private key file (.pem)');
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 256) throw new Error('GITHUB_APP_WEBHOOK_SECRET must be the app\'s webhook secret (16–256 characters)');
  let pem;
  try { pem = readFile(keyFile); } catch { throw new Error('GITHUB_APP_PRIVATE_KEY_FILE could not be read'); }
  let privateKey;
  try { privateKey = createPrivateKey(pem); } catch { throw new Error('GITHUB_APP_PRIVATE_KEY_FILE is not a PEM private key'); }
  const clientId = env.GITHUB_APP_CLIENT_ID || null;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET || null;
  if (!clientId || !clientSecret) throw new Error('GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET are needed: the install callback checks the installation with the installing user\'s GitHub sign-in');
  const out = { appId: Number(id), clientId };
  const hidden = (value) => ({ value, enumerable: false, writable: false, configurable: false });
  Object.defineProperties(out, { privateKey: hidden(privateKey), webhookSecret: hidden(secret), clientSecret: hidden(clientSecret) });
  return Object.freeze(out);
}

/**
 * → { jwt(), token(installationId), repoToken(installationId, {repositoryId, permissions}),
 *     request(installationId, method, path, body?),
 *     repositories(installationId), slug(), installUrl(state),
 *     installationFor({code, installationId}), verify({headers, rawBody}),
 *     forget(installationId), cached() }
 */
export function createGitHubApp(config, { fetchImpl = globalThis.fetch, now = Date.now } = {}) { // privacy-flow: integrations-hub
  const { appId, privateKey, webhookSecret, clientId, clientSecret } = config;
  const tokens = new Map(); // installation id → {token, expiresAtMs}
  const minting = new Map(); // installation id → the in-flight mint
  let slugCache = null;

  async function send(url, { method = 'GET', headers = {}, body, signal } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.port || !HOSTS.has(u.hostname)) throw new GitHubAppError('host_refused', 'not a GitHub address');
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(u.href, { // privacy-flow: integrations-hub
        method, redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'plexiform-hub', 'x-github-api-version': '2022-11-28', ...headers },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
    } catch {
      throw new GitHubAppError('provider_unreachable', 'GitHub could not be reached');
    }
    return res;
  }

  const jwt = () => appJwt({ appId, privateKey, nowS: Math.floor(now() / 1000) });

  async function json(res, what) {
    if (!res.ok) throw new GitHubAppError(res.status === 404 ? 'not_found' : res.status === 401 || res.status === 403 ? 'provider_refused' : 'provider_error', `GitHub ${what} → ${res.status}`, res.status);
    try { return await res.json(); } catch { throw new GitHubAppError('provider_error', `GitHub ${what}: not JSON`); }
  }

  async function mint(id) {
    const res = await send(`${API}/app/installations/${id}/access_tokens`, { method: 'POST', headers: { authorization: `Bearer ${jwt()}` } });
    const v = await json(res, 'POST /app/installations/:id/access_tokens');
    const exp = Date.parse(v?.expires_at ?? '');
    if (typeof v?.token !== 'string' || !v.token || v.token.length > 512 || !Number.isFinite(exp)) throw new GitHubAppError('provider_error', 'GitHub returned no installation token');
    // A token that is already past the margin is used for this call only.
    if (exp - TOKEN_MARGIN_MS > now()) {
      if (tokens.size >= TOKEN_CACHE_MAX) tokens.delete(tokens.keys().next().value);
      tokens.set(id, { token: v.token, expiresAtMs: exp });
    }
    return v.token;
  }

  /** An installation access token: the cached one while it has more than 5 minutes left, else a new one. */
  async function token(installationId) {
    const id = String(installationId);
    if (!INSTALL_ID.test(id)) throw new GitHubAppError('validation', 'not an installation id');
    const hit = tokens.get(id);
    if (hit && hit.expiresAtMs - TOKEN_MARGIN_MS > now()) return hit.token;
    tokens.delete(id);
    if (!minting.has(id)) minting.set(id, mint(id).finally(() => minting.delete(id)));
    return minting.get(id);
  }

  const forget = (installationId) => { tokens.delete(String(installationId)); };

  /**
   * A token narrowed to one repository and exactly these permissions, for
   * someone outside this process (a hosted runner's git): never cached here,
   * never the installation-wide token above. GitHub's answer must name that
   * one repository and grant exactly what was asked (plus metadata read,
   * which GitHub always adds), or the token is dropped unreturned.
   * → {token, expires_at}
   */
  async function repoToken(installationId, { repositoryId, permissions }) {
    const id = String(installationId);
    if (!INSTALL_ID.test(id)) throw new GitHubAppError('validation', 'not an installation id');
    if (!posInt(repositoryId)) throw new GitHubAppError('validation', 'not a repository id');
    const res = await send(`${API}/app/installations/${id}/access_tokens`, {
      method: 'POST', headers: { authorization: `Bearer ${jwt()}`, 'content-type': 'application/json' },
      body: { repository_ids: [repositoryId], permissions },
    });
    // 422: the installation does not grant those permissions, or lacks that repository.
    if (res.status === 422) throw new GitHubAppError('not_granted', 'GitHub POST /app/installations/:id/access_tokens → 422', 422);
    const v = await json(res, 'POST /app/installations/:id/access_tokens');
    const exp = Date.parse(v?.expires_at ?? '');
    if (typeof v?.token !== 'string' || !v.token || v.token.length > 512 || !Number.isFinite(exp)) throw new GitHubAppError('provider_error', 'GitHub returned no installation token');
    const got = v.permissions !== null && typeof v.permissions === 'object' ? v.permissions : {};
    const exact = Object.entries(permissions).every(([k, level]) => got[k] === level)
      && Object.entries(got).every(([k, level]) => permissions[k] === level || (k === 'metadata' && level === 'read'));
    const repos = Array.isArray(v.repositories) ? v.repositories : [];
    if (!exact || repos.length !== 1 || repos[0]?.id !== repositoryId) throw new GitHubAppError('not_granted', 'GitHub returned a token wider or narrower than asked');
    if (exp <= now()) throw new GitHubAppError('provider_error', 'GitHub returned an expired installation token');
    return { token: v.token, expires_at: new Date(exp).toISOString() };
  }

  /**
   * A REST call as the installation. A 401 means GitHub no longer takes the
   * cached token (revoked, the app's key rotated): forgotten, minted again, tried once more.
   * → {status, body} (body null when GitHub sent none).
   */
  async function request(installationId, method, path, body, { signal } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new GitHubAppError('validation', 'not an API path');
    for (let attempt = 0; ; attempt += 1) {
      const t = await token(installationId);
      const res = await send(`${API}${path}`, { method, body, signal, headers: { authorization: `Bearer ${t}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } });
      if (res.status === 401 && attempt === 0) { forget(installationId); continue; }
      let out = null;
      try { out = res.status === 204 ? null : await res.json(); } catch { out = null; }
      return { status: res.status, body: out };
    }
  }

  async function slug() {
    if (slugCache) return slugCache;
    const v = await json(await send(`${API}/app`, { headers: { authorization: `Bearer ${jwt()}` } }), 'GET /app');
    if (typeof v?.slug !== 'string' || !SLUG.test(v.slug) || v.id !== appId) throw new GitHubAppError('provider_error', 'GitHub returned another app');
    slugCache = v.slug;
    return slugCache;
  }

  /** The install page, carrying the hub's signed state through to the callback. */
  async function installUrl(state) {
    return `${WEB}/apps/${await slug()}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /**
   * The install callback's installation_id is the browser's to say, so it
   * counts only when the user GitHub signed in during the install (the
   * one-time `code`) can see that installation of this app. The user's token
   * is used for that one question, then revoked; it is never kept.
   * → {installation_id, account_login, account_type, repository_selection}
   */
  async function installationFor({ code, installationId }) {
    const id = String(installationId ?? '');
    if (!INSTALL_ID.test(id)) throw new GitHubAppError('validation', 'not an installation id');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(code ?? ''))) throw new GitHubAppError('validation', 'no sign-in code');
    const tr = await json(await send(`${WEB}/login/oauth/access_token`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: { client_id: clientId, client_secret: clientSecret, code },
    }), 'POST /login/oauth/access_token');
    const userToken = typeof tr?.access_token === 'string' && tr.access_token.length <= 512 ? tr.access_token : null;
    if (!userToken) throw new GitHubAppError('provider_refused', 'GitHub did not accept the sign-in code');
    try {
      for (let page = 1; page <= INSTALLATIONS_PAGES; page += 1) {
        const v = await json(await send(`${API}/user/installations?per_page=100&page=${page}`, { headers: { authorization: `Bearer ${userToken}` } }), 'GET /user/installations');
        const list = Array.isArray(v?.installations) ? v.installations : [];
        const hit = list.find((x) => String(x?.id) === id && x?.app_id === appId);
        if (hit) {
          const login = hit.account?.login;
          if (!LOGIN.test(login ?? '') || !['User', 'Organization'].includes(hit.account?.type)) throw new GitHubAppError('provider_error', 'GitHub returned a bad account');
          return { installation_id: Number(id), account_login: login, account_type: hit.account.type, repository_selection: hit.repository_selection === 'all' ? 'all' : 'selected' };
        }
        if (list.length < 100) break;
      }
      throw new GitHubAppError('not_owned', 'that installation is not one the signed-in GitHub user can see');
    } finally {
      // Best effort: an unrevoked token still expires on GitHub's side.
      send(`${API}/applications/${encodeURIComponent(clientId)}/token`, {
        method: 'DELETE', headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/json' }, body: { access_token: userToken },
      }).catch(() => {});
    }
  }

  /** The installation's repositories as GitHub lists them: [{id, full_name, private}], at most 500. */
  async function repositories(installationId) {
    const out = [];
    for (let page = 1; page <= REPOS_PAGES; page += 1) {
      const r = await request(installationId, 'GET', `/installation/repositories?per_page=100&page=${page}`);
      if (r.status !== 200) throw new GitHubAppError(r.status === 404 ? 'not_found' : 'provider_error', `GitHub GET /installation/repositories → ${r.status}`, r.status);
      const list = Array.isArray(r.body?.repositories) ? r.body.repositories : [];
      for (const x of list) if (posInt(x?.id) && FULL_NAME.test(x?.full_name ?? '')) out.push({ id: x.id, full_name: x.full_name, private: x.private === true });
      if (list.length < 100) break;
    }
    return out;
  }

  return {
    appId,
    jwt,
    token,
    repoToken,
    request,
    repositories,
    slug,
    installUrl,
    installationFor,
    forget,
    verify: ({ headers, rawBody }) => verifyWebhook({ headers, rawBody, secrets: { webhook_secret: webhookSecret } }),
    /** How many tokens are held (tests): never the tokens. */
    cached: () => tokens.size,
  };
}
