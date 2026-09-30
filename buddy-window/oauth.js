// "Continue with Google / GitHub": the provider page opens in the system
// browser (Google refuses embedded web views) and comes back to a one-shot
// listener on 127.0.0.1, with PKCE so a code caught on the way is useless
// without the verifier that never leaves main. Electron-free: index.js injects
// shell.openExternal, tests drive it against the mock hub.
'use strict';

const http = require('node:http'); // privacy-flow: team-hub-account
const crypto = require('node:crypto');
const { isPrivateHost } = require('./workspaces');

const LISTEN_MS = 5 * 60_000;
const PROVIDERS = Object.freeze(['google', 'github']);
const PROVIDER_NAME = Object.freeze({ google: 'Google', github: 'GitHub' });
// The one-time code the hub puts on the loopback redirect, and our own state.
const CODE_RE = /^[A-Za-z0-9._~-]{1,512}$/;
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1']);

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** RFC 7636 S256: 32 random bytes as the verifier, base64url(sha256(verifier)) as the challenge. */
function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

/**
 * May the system browser be sent here? https on a public name only: never
 * loopback, a private or link-local address, or an IP literal we can't vet.
 * `allowOrigins` lets the dev-only mock hub's exact origin through.
 */
function providerUrlOk(url, { allowOrigins = [] } = {}) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  if (allowOrigins.includes(u.origin)) return true;
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h.startsWith('[') || h === 'localhost' || h.endsWith('.localhost') || !h.includes('.') || isPrivateHost(h)) return false;
  return true;
}

const same = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * The listener's request handler, on its own so tests can hand it requests a
 * real socket can't produce (another address, another Host). Answers are fixed
 * text: nothing from the request is ever echoed back. `finish` runs at most
 * once, for the one request that ends the flow.
 */
function callbackHandler({ port, state, brand, finish }) {
  // `state` is a string or a function: the hub mints it in oauth/start, after this listener (whose port
  // goes into redirect_uri) is already up. Until it is known every request is refused.
  const expected = typeof state === 'function' ? state : () => state;
  let done = false;
  const reply = (res, status, text, extra = {}) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', connection: 'close', ...extra });
    res.end(text);
  };
  const bad = `This sign-in link isn’t valid. Go back to ${brand} and try again.`;
  return (req, res) => {
    if (!LOOPBACK.has(req.socket?.remoteAddress)) { req.socket?.destroy?.(); return; }
    // A page elsewhere reaching us by a rebound name carries its own Host.
    if (req.headers.host !== `127.0.0.1:${port}`) { reply(res, 400, bad); return; }
    if (req.method !== 'GET') { reply(res, 405, bad, { allow: 'GET' }); return; }
    let u;
    try { u = new URL(req.url, `http://127.0.0.1:${port}`); } catch { reply(res, 400, bad); return; }
    if (u.pathname !== '/callback') { reply(res, 404, bad); return; }
    const want = expected();
    if (done || typeof want !== 'string' || !same(u.searchParams.get('state'), want)) { reply(res, 400, bad); return; }
    const code = u.searchParams.get('code');
    // The provider said no (or the member closed it): that ends the flow too.
    if (!code && u.searchParams.get('error')) {
      done = true;
      reply(res, 200, `Sign-in was cancelled. You can close this tab and go back to ${brand}.`);
      finish({ ok: false, reason: 'denied' });
      return;
    }
    if (!code || !CODE_RE.test(code)) { reply(res, 400, bad); return; }
    done = true;
    reply(res, 200, `You’re signed in to ${brand}, you can close this tab.`);
    finish({ ok: true, code });
  };
}

/**
 * One-shot listener on 127.0.0.1:<ephemeral>/callback. `result` resolves once:
 * {ok:true, code} for the one valid request, else {ok:false, reason:'timeout'|
 * 'cancelled'|'denied'}. The server closes as soon as it resolves.
 */
function listenOnce({ state, brand, timeoutMs = LISTEN_MS, createServer = http.createServer }) {
  return new Promise((resolve, reject) => {
    let expectedState = typeof state === 'string' ? state : null;
    let settle;
    const result = new Promise((r) => { settle = r; });
    let finished = false;
    const server = createServer();
    let timer = null;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Let the answer page leave before the sockets go.
      setImmediate(() => { server.close(); server.closeAllConnections?.(); });
      settle(r);
    };
    server.on('error', (e) => { if (!server.listening) reject(e); });
    server.listen(0, '127.0.0.1', () => { // privacy-flow: team-hub-account
      const { port } = server.address();
      server.on('request', callbackHandler({ port, state: () => expectedState, brand, finish }));
      timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
      timer.unref?.();
      resolve({ port, redirectUri: `http://127.0.0.1:${port}/callback`, address: server.address().address, result, expect: (s) => { expectedState = typeof s === 'string' ? s : null; }, close: () => finish({ ok: false, reason: 'cancelled' }) });
    });
  });
}

/**
 * The whole provider sign-in against one hub's account client:
 *   listener up → POST oauth/start → system browser → callback → POST oauth/exchange.
 * → {done: Promise<{ok, user?} | {ok:false, error, cancelled?}>, cancel()}.
 * The verifier and the code live only in this closure; nothing here logs them.
 */
function startProviderSignIn({ client, provider, device = {}, openExternal, brand, allowOrigins = [], timeoutMs = LISTEN_MS, log = () => {} }) {
  let cancelled = false;
  let listener = null;
  const host = new URL(client.origin).host;
  const done = (async () => {
    if (!PROVIDERS.includes(provider)) return { ok: false, error: 'Pick Google or GitHub.' };
    const { verifier, challenge } = pkcePair();
    try { listener = await listenOnce({ brand, timeoutMs }); } catch { return { ok: false, error: `${brand} couldn’t get ready for the browser sign-in. Try again.` }; }
    if (cancelled) { listener.close(); return { ok: false, cancelled: true }; }
    const start = await client.startOAuth(provider, { challenge, redirectUri: listener.redirectUri }, device);
    if (cancelled || !start.ok) { listener.close(); return cancelled ? { ok: false, cancelled: true } : start; }
    // The hub's state: the loopback callback must carry exactly this, and the exchange sends it back.
    listener.expect(start.state);
    if (!providerUrlOk(start.url, { allowOrigins })) {
      listener.close();
      log('provider sign-in refused: the hub gave a page this app will not open');
      return { ok: false, error: `${host} gave a sign-in page ${brand} won’t open.` };
    }
    openExternal(start.url); // privacy-flow: team-hub-account
    const cb = await listener.result;
    if (!cb.ok) {
      if (cb.reason === 'cancelled') return { ok: false, cancelled: true };
      if (cb.reason === 'timeout') return { ok: false, error: 'The browser sign-in timed out. Try again.' };
      return { ok: false, error: `Sign-in with ${PROVIDER_NAME[provider]} was cancelled.` };
    }
    if (cancelled) return { ok: false, cancelled: true };
    return client.exchangeOAuth({ flowId: start.flow_id, code: cb.code, state: start.state, verifier, provider }, device);
  })();
  return {
    done,
    cancel() { cancelled = true; listener?.close(); },
  };
}

module.exports = { pkcePair, providerUrlOk, callbackHandler, listenOnce, startProviderSignIn, PROVIDERS, PROVIDER_NAME, LISTEN_MS };
