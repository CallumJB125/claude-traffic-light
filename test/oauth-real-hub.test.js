'use strict';
// Google and GitHub sign-in end to end against the REAL hub process
// (board/hub/server.js, BOARD_AUTH=accounts, a loopback BOARD_PUBLIC_URL, no
// mailer) and a fake provider served over HTTP on loopback. The hub's code is
// unchanged: a test-only `--import` preload (test/fixtures/oauth-provider-
// redirect.mjs) points its calls to Google/GitHub at the fake. Walks the
// desktop loopback flow through buddy-window/account-flow.js and the browser
// flow through the hub's own routes, including session cookie, /api/me, sign
// out, and the email code being refused when BOARD_EMAIL_SIGNIN is unset.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createAccountFlow } = require('../buddy-window/account-flow');
const { createAccountClient } = require('../buddy-window/accounts');
const { createWorkspaceStore, normalizeHubUrl, normalizeLinkHub, accessWsId } = require('../buddy-window/workspaces');

const BOARD = path.join(__dirname, '..', 'board');
const PRELOAD = path.join(__dirname, 'fixtures', 'oauth-provider-redirect.mjs');
// The hub resolves its dependencies from board/node_modules or the root one.
const ready = (() => { try { require.resolve('ws', { paths: [path.join(BOARD, 'hub')] }); return true; } catch { return false; } })();

const until = async (fn, ms = 15000, what = 'condition') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// The fake provider over HTTP: /<provider host>/<path> answers what
// https://<provider host>/<path> would (the hub test suite's fake-oauth.js),
// and the two authorize pages consent as the next queued person and redirect.
async function startFakeProvider(clients) {
  const { fakeProviders } = await import(path.join(BOARD, 'hub', 'test', 'fake-oauth.js'));
  const p = fakeProviders({ clock: { wall: () => Date.now() }, clients });
  const people = [];
  const server = http.createServer(async (req, res) => {
    const m = /^\/([a-z0-9.]+)(\/[^?]*)(\?.*)?$/.exec(req.url);
    if (!m) { res.writeHead(404).end(); return; }
    const url = `https://${m[1]}${m[2]}${m[3] ?? ''}`;
    if (url.startsWith('https://accounts.google.com/o/oauth2/v2/auth') || url.startsWith('https://github.com/login/oauth/authorize')) {
      const { code, state, params } = p.authorize(url, people.shift());
      const back = new URL(params.redirect_uri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await p.fetch(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, p,
    as(who) { people.push(who); },
    // What the system browser does with the hub's provider URL: the consent page, then its redirect.
    async consent(providerUrl) {
      const u = new URL(providerUrl);
      const r = await fetch(`${origin}/${u.hostname}${u.pathname}${u.search}`, { redirect: 'manual' });
      assert.equal(r.status, 302);
      return r.headers.get('location');
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

async function startHub(dir, fake, clients) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let err = '';
  const proc = spawn(process.execPath, ['--import', PRELOAD, path.join(BOARD, 'hub', 'server.js')], {
    env: {
      PATH: process.env.PATH, HOME: dir, LANG: 'en_US.UTF-8', BOARD_AUTH: 'accounts', BOARD_SIGNUP: 'open', BOARD_PUBLIC_URL: origin,
      BOARD_BIND: '127.0.0.1', BOARD_PORT: String(port), BOARD_DATA_DIR: dir, BOARD_SECRET: crypto.randomBytes(32).toString('hex'), BOARD_LOG_LEVEL: 'warn',
      BOARD_GOOGLE_CLIENT_ID: clients.googleClientId, BOARD_GOOGLE_CLIENT_SECRET: clients.googleClientSecret,
      BOARD_GITHUB_CLIENT_ID: clients.githubClientId, BOARD_GITHUB_CLIENT_SECRET: clients.githubClientSecret,
      BOARD_GOOGLE_WEB_CLIENT_ID: clients.googleWebClientId, BOARD_GOOGLE_WEB_CLIENT_SECRET: clients.googleWebClientSecret,
      BOARD_GITHUB_WEB_CLIENT_ID: clients.githubWebClientId, BOARD_GITHUB_WEB_CLIENT_SECRET: clients.githubWebClientSecret,
      PLEXIFORM_TEST_OAUTH_PROVIDER: fake.origin,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => { err += d; });
  await until(async () => {
    if (proc.exitCode != null) throw new Error(`hub exited ${proc.exitCode}: ${err}`);
    try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; }
  }, 15000, 'hub health');
  return {
    origin, proc, stderr: () => err,
    async stop() { proc.kill('SIGTERM'); await until(() => proc.exitCode != null || proc.signalCode != null, 10000, 'hub exit').catch(() => proc.kill('SIGKILL')); },
  };
}

// What buddy-window/index.js probeHub learns from /api/health, without Electron.
async function probe(origin) {
  const r = await fetch(`${origin}/api/health`, { redirect: 'manual' });
  if (r.status >= 300 && r.status < 400) return { ok: false, error: 'redirected' };
  const j = await r.json().catch(() => null);
  return r.status === 200 && j?.ok && j.protocol ? { ok: true, accessTeam: null, signedIn: true, auth: j.auth } : { ok: false, error: 'not a hub' };
}

function desktop(hub, fake, root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const allowOrigins = [hub.origin];
  let saved = null;
  const vault = { load: () => saved, save: (x) => { saved = JSON.parse(JSON.stringify(x)); }, clear: () => { saved = null; } };
  const signedIn = (o) => o === hub.origin && !!vault.load();
  const store = createWorkspaceStore(path.join(dir, 'ws.json'), { allowOrigins, signedIn });
  const client = createAccountClient({ origin: hub.origin, store: vault, onSignedOut: () => {} });
  const opened = [];
  const shown = [];
  const flow = createAccountFlow({
    store, clientFor: () => client, signedIn, userOf: () => vault.load()?.user ?? null,
    normHub: (u) => normalizeHubUrl(u, { allowOrigins }), normLink: (u) => normalizeLinkHub(u, { allowOrigins }),
    probe,
    makeDevice: () => ({ resume() {}, stop: async () => {}, running: () => false, setPresence() {}, status: () => ({}) }),
    deviceInfo: () => ({ deviceName: `${name} Mac`, platform: 'darwin-arm64' }),
    // The system browser: the provider's consent page, then its redirect to the loopback listener.
    openBrowser: async (url) => {
      opened.push(url);
      const back = await fake.consent(url);
      const r = await fetch(back);
      await r.text();
    },
    ui: { show(s, o) { shown.push([s, o]); }, select() {}, openClients: async () => {}, switchWorkspace: (id) => { if (id) store.setActive(id); }, pushState() {}, forgetHub() {}, hubSignedOut: async () => {}, isOpen: () => true, onHubPage: () => false, devicesChanged() {}, openMail() {} },
  });
  return { flow, A: flow.ACCT, store, client, opened, shown, saved: () => vault.load() };
}

// A cookie jar for one browser.
function browser(hub) {
  const jar = new Map();
  const take = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (v && !/Max-Age=0\b/.test(c)) jar.set(k, v); else jar.delete(k); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    jar,
    async req(method, url, { body, headers = {} } = {}) {
      const res = await fetch(url.startsWith('http') ? url : `${hub.origin}${url}`, {
        method, redirect: 'manual',
        headers: { ...(jar.size ? { cookie: cookie() } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      take(res);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, location: res.headers.get('location') };
    },
  };
}

test('Google and GitHub sign-in on the real hub: desktop loopback flow, browser flow, session, sign-out, no email code', { skip: !ready && 'board dependencies not installed', timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-oauth-e2e-'));
  const hex = (n) => crypto.randomBytes(n).toString('hex');
  const clients = {
    googleClientId: `${hex(6)}-desk.apps.test`, googleClientSecret: hex(18), githubClientId: `Iv-desk-${hex(6)}`, githubClientSecret: hex(20),
    googleWebClientId: `${hex(6)}-web.apps.test`, googleWebClientSecret: hex(18), githubWebClientId: `Iv-web-${hex(6)}`, githubWebClientSecret: hex(20),
  };
  const fake = await startFakeProvider(clients);
  let hub;
  try {
    hub = await startHub(path.join(root, 'hub'), fake, clients);
    const ada = { sub: `g-${hex(6)}`, email: 'ada@gmail.com', name: 'Ada' };
    const gh = { id: 4242, login: 'adagh', email: 'ada@gmail.com', name: 'Ada GH' };

    // What the sign-in screen offers: Google and GitHub, both clients; no email code by default.
    const methods = await (await fetch(`${hub.origin}/api/auth/methods`)).json();
    assert.deepEqual([methods.google, methods.github, methods.email, methods.web], [true, true, false, { google: true, github: true }]);
    const email = await fetch(`${hub.origin}/api/auth/email/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@gmail.com' }) });
    const ej = await email.json();
    assert.equal(ej.error?.code ?? ej.code, 'METHOD_DISABLED', JSON.stringify(ej));

    // An Access-era workspace for this hub: the desktop retires it once the hub answers itself.
    const d1 = desktop(hub, fake, root, 'one');
    d1.store.addAccess({ url: hub.origin, name: 'hub', accessTeam: null });
    assert.equal(await d1.flow.recheckAccess(d1.store.get(accessWsId(hub.origin))), true, 'the Access entry is retired');
    assert.equal(d1.store.get(accessWsId(hub.origin)) ?? null, null);
    assert.equal(d1.flow.acct.screen, 'email');
    const screen = await d1.A.state();
    assert.deepEqual(screen.methods, { google: true, github: true, email: false }, 'the desktop shows Google and GitHub only');
    assert.deepEqual(await d1.A.email('ada@gmail.com'), { ok: false, error: 'Sign in with Google or GitHub.' });

    // Desktop: Continue with Google.
    fake.as(ada);
    assert.equal((await d1.A.oauth('google')).ok, true);
    const r1 = await d1.flow.pendingOAuth();
    assert.equal(r1.ok, true, r1.error);
    assert.match(d1.opened[0], /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    const q = new URL(d1.opened[0]).searchParams;
    assert.equal(q.get('client_id'), clients.googleClientId);
    assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(q.get('code_challenge_method'), 'S256');
    const adaId = d1.saved().user.id;
    assert.equal(d1.saved().user.email ?? d1.saved().user.primary_email, 'ada@gmail.com');
    const me1 = await d1.client.me();
    assert.equal(me1.ok, true);
    assert.equal(me1.user.id, adaId);
    assert.ok(d1.store.list().some((w) => w.kind === 'team' && w.hub === hub.origin), 'first sign-in made a team in the switcher');

    // Desktop: the same Google account again on a second install is the same account.
    const d2 = desktop(hub, fake, root, 'two');
    assert.equal((await d2.A.hub(hub.origin)).ok, true);
    fake.as(ada);
    await d2.A.oauth('google');
    assert.equal((await d2.flow.pendingOAuth()).ok, true);
    assert.equal(d2.saved().user.id, adaId, 'second Google sign-in, same account');

    // Desktop: GitHub with the same address. GitHub is never authoritative for an
    // address (D83), so this is a separate account and the hub says so.
    const d3 = desktop(hub, fake, root, 'three');
    assert.equal((await d3.A.hub(hub.origin)).ok, true);
    fake.as(gh);
    await d3.A.oauth('github');
    const r3 = await d3.flow.pendingOAuth();
    assert.equal(r3.ok, true, r3.error);
    assert.match(d3.opened[0], /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    const ghId = d3.saved().user.id;
    assert.notEqual(ghId, adaId, 'GitHub with a Google-held address is a separate account');
    // That account holds no verified address (Google holds it), so it cannot make a team: the
    // create-team screen says why, with the separate-account words alongside.
    assert.equal(d3.flow.acct.screen, 'create-team');
    const s3 = await d3.A.state();
    assert.match(s3.notice ?? '', /new, separate account/);
    assert.match(s3.alert ?? '', /verify your email/i);
    // The same GitHub account again is that same GitHub account.
    const d4 = desktop(hub, fake, root, 'four');
    await d4.A.hub(hub.origin);
    fake.as(gh);
    await d4.A.oauth('github');
    assert.equal((await d4.flow.pendingOAuth()).ok, true);
    assert.equal(d4.saved().user.id, ghId, 'second GitHub sign-in, same account');
    assert.equal((await d4.A.state()).notice ?? null, null, 'no notice for the same GitHub account again');

    // Desktop sign-out: the device token stops working.
    const token = d2.saved().token;
    assert.equal((await d2.client.signOut()).ok, true);
    const after = await fetch(`${hub.origin}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(after.status, 401);

    // Browser: Google, through the hub's own routes and cookies.
    for (const [provider, who, expectId] of [['google', ada, adaId], ['github', gh, ghId]]) {
      const b = browser(hub);
      const cross = await b.req('POST', '/api/auth/oauth/web/start', { body: { provider }, headers: { origin: 'https://evil.test' } });
      assert.equal(cross.status, 403, 'a cross-origin start is refused');
      const start = await b.req('POST', '/api/auth/oauth/web/start', { body: { provider }, headers: { origin: hub.origin } });
      assert.equal(start.status, 200, JSON.stringify(start.json));
      const au = new URL(start.json.url);
      assert.equal(au.searchParams.get('client_id'), provider === 'google' ? clients.googleWebClientId : clients.githubWebClientId);
      assert.equal(au.searchParams.get('redirect_uri'), `${hub.origin}/api/auth/oauth/web/${provider}/callback`);
      fake.as(who);
      const cb = await b.req('GET', await fake.consent(start.json.url));
      assert.equal(cb.status, 303);
      assert.equal(cb.location, '/signin#oauth=web');
      assert.ok(b.jar.has('__Host-buddy_session'), 'the session cookie is set');
      const me = await b.req('GET', '/api/me');
      assert.equal(me.status, 200, JSON.stringify(me.json));
      assert.equal(me.json.user.id, expectId, `browser ${provider} sign-in reaches the same account as the desktop`);
      const csrf = me.json.csrf_token;
      assert.ok(csrf);
      const result = await b.req('POST', '/api/auth/oauth/web/result', { body: {}, headers: { origin: hub.origin, 'x-csrf-token': csrf } });
      assert.deepEqual([result.status, result.json?.ok], [200, true], JSON.stringify(result.json));
      // A replayed callback is refused and signs nobody in.
      const replay = browser(hub);
      const again = await replay.req('GET', `${hub.origin}${new URL(start.json.url).pathname}`);
      assert.notEqual(again.status, 200);
      const out = await b.req('POST', '/api/auth/signout', { body: {}, headers: { origin: hub.origin, 'x-csrf-token': csrf } });
      assert.equal(out.status, 200, JSON.stringify(out.json));
      assert.equal((await b.req('GET', '/api/me')).status, 401, 'signed out');
    }

    // Browser: a new GitHub account whose address a Google account holds gets a separate account, and the result says so.
    {
      const b = browser(hub);
      const start = await b.req('POST', '/api/auth/oauth/web/start', { body: { provider: 'github' }, headers: { origin: hub.origin } });
      fake.as({ id: 5151, login: 'ada2', email: 'ada@gmail.com', name: 'Ada Two' });
      assert.equal((await b.req('GET', await fake.consent(start.json.url))).status, 303);
      const me = await b.req('GET', '/api/me');
      assert.equal(me.status, 200);
      assert.ok(![adaId, ghId].includes(me.json.user.id), 'a separate account');
      const result = await b.req('POST', '/api/auth/oauth/web/result', { body: {}, headers: { origin: hub.origin, 'x-csrf-token': me.json.csrf_token } });
      assert.equal(result.json?.ok, true);
      assert.equal(result.json?.notice?.code, 'SEPARATE_ACCOUNT');
      assert.match(result.json.notice.message, /new, separate account/);
    }

    // The signin page itself is served for the browser flow.
    const page = await fetch(`${hub.origin}/signin`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /signin/i);

    // Nothing the provider issued reached the hub's log.
    for (const t of fake.p.issued) assert.ok(!hub.stderr().includes(t), 'no provider token in the hub log');
  } finally {
    await hub?.stop();
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
