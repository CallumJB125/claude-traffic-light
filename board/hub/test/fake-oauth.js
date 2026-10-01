// Fake Google + GitHub for the OAuth tests: an injected fetch that answers the
// token, JWKS, user and emails endpoints the hub calls, with a runtime RSA key.
// No network, no real client ids or secrets; every token-shaped value is made
// here at runtime (never a literal).

import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { GOOGLE, GITHUB } from '../identity/oauth.js';

const b64url = (b) => Buffer.from(b).toString('base64url');
const rnd = (n = 24) => randomBytes(n).toString('base64url');
const s256 = (v) => b64url(createHash('sha256').update(v).digest());

/** Client credentials for the hub config, assembled at runtime. */
export function fakeClients() {
  return {
    googleClientId: `${randomBytes(6).toString('hex')}-test.apps.example`,
    googleClientSecret: rnd(18),
    githubClientId: `Iv-test-${randomBytes(6).toString('hex')}`,
    githubClientSecret: randomBytes(20).toString('hex'),
  };
}

export function fakeProviders({ clock, clients }) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `kid-${randomBytes(4).toString('hex')}`;
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map();          // code → {provider, redirect_uri, challenge, nonce, who, over, used}
  const tokens = new Map();         // github access token → who
  const p = {
    kid, jwk, codes, requests: [], issued: [],
    jwksDown: false,
    tokenStatus: null,              // force the token endpoint to answer this status
    gate: null,                     // a promise the token endpoint waits on (concurrency tests)
    bigBody: false,                 // GitHub /user answers more than 64 KB
    signJwt(claims, { privateKey = key.privateKey, keyId = kid, alg = 'RS256' } = {}) {
      const head = b64url(JSON.stringify({ alg, kid: keyId, typ: 'JWT' }));
      const body = b64url(JSON.stringify(claims));
      return `${head}.${body}.${b64url(cryptoSign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey))}`;
    },
    /**
     * The user consents at the provider: → {code, state} as the loopback
     * listener would receive them. who: {sub|id, email, name, login, emails, hd}.
     * over: {claims} (Google id_token overrides), {sign} (signJwt options).
     */
    authorize(url, who, over = {}) {
      const u = new URL(url);
      const provider = u.origin === new URL(GOOGLE.authorize).origin ? 'google' : 'github';
      const code = over.code ?? `code-${rnd(16)}`;
      codes.set(code, { provider, client_id: u.searchParams.get('client_id'), redirect_uri: u.searchParams.get('redirect_uri'), challenge: u.searchParams.get('code_challenge'), nonce: u.searchParams.get('nonce'), who, over, used: false });
      return { code, state: u.searchParams.get('state'), params: Object.fromEntries(u.searchParams) };
    },
    fetch: async (url, init = {}) => {
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      p.requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null, headers, redirect: init.redirect });
      const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === GOOGLE.jwks) return p.jwksDown ? json(503, {}) : json(200, { keys: [jwk] });
      if (url === GOOGLE.token || url === GITHUB.token) {
        if (p.gate) await p.gate;
        if (p.tokenStatus) return json(p.tokenStatus, { error: 'server_error' });
        const provider = url === GOOGLE.token ? 'google' : 'github';
        const f = Object.fromEntries(new URLSearchParams(init.body));
        const c = codes.get(f.code);
        const bad = () => (provider === 'google' ? json(400, { error: 'invalid_grant' }) : json(200, { error: 'bad_verification_code' }));
        if (!c || c.used || c.provider !== provider) return bad();
        const mode = c.client_id === clients[`${provider}WebClientId`] ? 'Web' : '';
        if (f.client_id !== c.client_id || f.client_id !== clients[`${provider}${mode}ClientId`] || f.client_secret !== clients[`${provider}${mode}ClientSecret`]) return json(401, { error: 'invalid_client' });
        if (f.redirect_uri !== c.redirect_uri || s256(f.code_verifier ?? '') !== c.challenge) return bad();
        c.used = true;
        if (provider === 'google') {
          const t = Math.floor(clock.wall() / 1000);
          const claims = {
            iss: 'https://accounts.google.com', aud: c.client_id, sub: c.who.sub, email: c.who.email, email_verified: true,
            name: c.who.name ?? null, iat: t, exp: t + 3600, nonce: c.nonce, ...(c.who.hd ? { hd: c.who.hd } : {}), ...(c.over.claims ?? {}),
          };
          const access = `${['ya29', 'x'].join('.')}${rnd(30)}`;
          const idToken = p.signJwt(claims, c.over.sign);
          p.issued.push(access, idToken);
          return json(200, { access_token: access, id_token: idToken, expires_in: 3599, token_type: 'Bearer', scope: 'openid email profile' });
        }
        const access = `${['gh', 'o_'].join('')}${rnd(27)}`;
        tokens.set(access, c.who);
        p.issued.push(access);
        return json(200, { access_token: access, token_type: 'bearer', scope: 'read:user,user:email' });
      }
      if (url === GITHUB.user || url === GITHUB.emails) {
        const who = tokens.get(String(headers.authorization ?? '').replace(/^Bearer /, ''));
        if (!who) return json(401, { message: 'Bad credentials' });
        if (url === GITHUB.user) return json(200, { id: who.id, login: who.login, name: p.bigBody ? 'x'.repeat(70 * 1024) : who.name ?? null });
        return json(200, who.emails ?? [{ email: who.email, primary: true, verified: true, visibility: 'private' }]);
      }
      return json(404, {});
    },
  };
  return p;
}

export { s256, rnd };
