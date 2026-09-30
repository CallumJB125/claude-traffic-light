// Accounts-mode test rig: a real hub with BOARD_AUTH=accounts on loopback,
// fake clock, the outbox mailer (no mail leaves the process) and the dev
// fixture org (alice@dev.local owner, bob@dev.local member, board DEV).

import WebSocket from 'ws';
import { createApp } from '../app.js';
import { silentLogger } from '../log.js';
import { seedDev } from '../seed.js';
import { outboxMailer } from '../identity/mailer.js';
import { fakeClock, fakeGitHub, testConfig, FakeBrowser } from './helpers.js';

export async function startAccounts({ clock = fakeClock(), config = {} } = {}) {
  const mailer = outboxMailer();
  const cfg = testConfig({ auth: 'accounts', devLoginSecret: null, ...config });
  const app = createApp(cfg, { clock, log: silentLogger, github: fakeGitHub(), timers: false, mailer });
  seedDev(app.hub);
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const db = app.db;
  const org = db.get("SELECT * FROM orgs WHERE name = 'dev'");
  const ids = {
    org: org.id,
    board: db.get('SELECT id FROM boards WHERE org_id = ?', org.id).id,
    alice: db.get("SELECT id FROM members WHERE github_login = 'alice'").id,
    bob: db.get("SELECT id FROM members WHERE github_login = 'bob'").id,
  };
  const sockets = [];

  const h = {
    app, hub: app.hub, db, clock, base, ids, mailer,
    async call(method, path, { body, token, cookie, headers = {} } = {}) {
      const hs = { accept: 'application/json', ...headers };
      if (body !== undefined) hs['content-type'] = 'application/json';
      if (token) hs.authorization = `Bearer ${token}`;
      if (cookie) hs.cookie = cookie;
      const res = await fetch(`${base}${path}`, { method, headers: hs, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, body: json, text, headers: res.headers, cookies: res.headers.getSetCookie() };
    },
    codeFor(email) {
      const m = mailer.last(email);
      return m && /code: (\d{6})/.exec(m.text)[1];
    },
    async start(email, extra = {}, opts = {}) {
      return h.call('POST', '/api/auth/email/start', { body: { email, client: 'buddy_desktop', device_name: 'MacBook-Pro', platform: 'darwin-arm64', ...extra }, ...opts });
    },
    // Desktop sign-in: → {status, body:{user, device_token, device_id, teams}}
    async signIn(email, extra = {}) {
      const s = await h.start(email, extra);
      return h.call('POST', '/api/auth/email/verify', { body: { flow_id: s.body.flow_id, code: h.codeFor(email), device_name: 'MacBook-Pro', platform: 'darwin-arm64', form_factor: 'laptop' } });
    },
    // Web sign-in by code: → {cookie, csrf, body}
    async webSignIn(email) {
      const s = await h.start(email, { client: 'web' });
      const v = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: s.body.flow_id, code: h.codeFor(email) } });
      const c = v.cookies.find((x) => x.startsWith('__Host-buddy_session='));
      return { cookie: c && c.split(';')[0], csrf: v.body?.csrf_token, body: v.body, res: v };
    },
    async browser({ token, cookie, headers = {} } = {}) {
      const b = new FakeBrowser(base, cookie ?? '');
      sockets.push(b);
      await b.open({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers });
      return b;
    },
    // → the HTTP status of a refused upgrade, or 101 when it opened.
    upgradeStatus(headers = {}) {
      return new Promise((resolve) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/board`, { headers });
        ws.once('unexpected-response', (req, res) => { resolve(res.statusCode); req.destroy(); });
        ws.once('open', () => { resolve(101); ws.terminate(); });
        ws.once('error', () => {});
      });
    },
    async close() {
      for (const b of sockets) b.terminate();
      await app.close({ graceMs: 50 });
    },
  };
  return h;
}

/** Every text value in every table, for "the secret is stored nowhere" checks. */
export function dumpDb(db) {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
  return tables.map((t) => JSON.stringify(db.all(`SELECT * FROM "${t}"`))).join('\n');
}
