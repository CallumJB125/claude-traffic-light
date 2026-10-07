// Keeps the cached entitlement token (src/entitlements.js reads it offline)
// fresh: once a day, and when someone signs in, it asks the signed-in team
// hub — and only that hub — for GET /api/entitlement with the device's own
// sign-in. Signed out: no request at all. Offline or refused: the cached token
// stays as it is (it carries its own 14-day grace past the paid period), and
// nothing here ever blocks or throws into startup. A token is written only
// after src/entitlements.js has verified it against the pinned key and it
// names the signed-in account; a hub answer of "free" removes it (your data
// is never touched, only paid features switch off).
//
// Also serves the Upgrade page (upgrade.html): plan, limits and days left in
// grace; Upgrade / Manage billing open the provider's hosted pages in the
// system browser.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Entitlements = require('./entitlements');

const DAY_MS = 86_400_000;
const FIRST_CHECK_MS = 30_000;
const IDENTITY_POLL_MS = 60_000;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 32 * 1024;

const PLAN_NAMES = Object.freeze({ free: 'Free', plus: 'Plus', team: 'Team' });

function baseOf(origin) {
  try {
    const u = new URL(origin);
    const loop = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) return null;
    return u.origin;
  } catch { return null; }
}

/** What the Upgrade page shows. Pure over Entitlements.status() and a clock. */
function describe(ent = Entitlements, now = Date.now()) {
  let s;
  try { s = ent.status(); } catch { s = { plan: 'free', reason: 'error', expiresAt: null, periodEnd: null, inGrace: false }; }
  let limits = {};
  try { limits = ent.limits(); } catch { limits = {}; }
  const daysLeft = s.inGrace && s.expiresAt ? Math.max(0, Math.ceil((s.expiresAt - now) / DAY_MS)) : null;
  let banner = null;
  if (s.reason === 'expired') banner = 'Your paid plan has ended, so paid features are off. Everything you made is still here. Renew to switch them back on.';
  else if (s.inGrace) banner = `Plexiform couldn't confirm your plan with your team hub. It stays on for ${daysLeft} more day${daysLeft === 1 ? '' : 's'}; connect to the internet while signed in to renew it.`;
  // Infinity does not survive structured clone as JSON: say "unlimited" instead.
  const shown = Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v === Infinity ? 'unlimited' : v]));
  return { plan: s.plan, planName: PLAN_NAMES[s.plan] ?? 'Free', reason: s.reason, periodEnd: s.periodEnd ?? null, expiresAt: s.expiresAt ?? null, inGrace: !!s.inGrace, daysLeft, banner, limits: shown };
}

/**
 * identity() → {origin, userId, token: () => string} | null (the signed-in team hub, main-only).
 * fetch: the network function (tests inject a fake). Never throws from check().
 */
function createRefresher({ identity, fetch, ent = Entitlements, log = () => {} }) {
  let last = { at: null, ok: null, reason: 'not-checked' };
  let running = null;

  const current = () => {
    let id = null;
    try { id = identity(); } catch { id = null; }
    if (!id || typeof id.userId !== 'string' || !id.userId || typeof id.token !== 'function') return null;
    const base = baseOf(id.origin);
    return base ? { ...id, base } : null;
  };

  async function call(id, method, route, body) {
    let token = '';
    try { token = id.token() || ''; } catch { token = ''; }
    if (!token) return { ok: false, reason: 'signed-out' };
    let res;
    try {
      res = await fetch(`${id.base}${route}`, { // privacy-flow: entitlement-check
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { return { ok: false, reason: 'offline' }; }
    let text = '';
    try { text = await res.text(); } catch { return { ok: false, reason: 'offline' }; }
    if (text.length > MAX_BODY) return { ok: false, reason: 'unreadable' };
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) return { ok: false, reason: res.status === 401 ? 'signed-out' : 'refused', status: res.status };
    return { ok: true, json };
  }

  function write(token) {
    const dir = ent.root();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `${ent.TOKEN_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ token }), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, ent.TOKEN_FILE));
  }

  async function run(reason) {
    const id = current();
    if (!id) return (last = { at: Date.now(), ok: false, reason: 'signed-out' });
    const got = await call(id, 'GET', '/api/entitlement');
    if (!got.ok) return (last = { at: Date.now(), ok: false, reason: got.reason });
    const j = got.json;
    if (j && j.plan === 'free' && j.token === null) {
      try { fs.rmSync(path.join(ent.root(), ent.TOKEN_FILE), { force: true }); } catch { /* stays; it expires on its own */ }
      return (last = { at: Date.now(), ok: true, reason: 'free' });
    }
    const claims = typeof j?.token === 'string' && j.token.length < 8192 ? ent.verify(j.token) : null;
    if (!claims || claims.sub !== id.userId || claims.plan !== j.plan) return (last = { at: Date.now(), ok: false, reason: 'unverified' });
    try { write(j.token); } catch (e) { log(`[entitlement] could not save the token: ${e?.message ?? e}`); return (last = { at: Date.now(), ok: false, reason: 'write' }); }
    log(`[entitlement] refreshed (${reason}): ${claims.plan}`);
    return (last = { at: Date.now(), ok: true, reason: 'ok' });
  }

  /** One refresh; concurrent callers share it. Resolves to {at, ok, reason}; never rejects. */
  function check(reason = 'manual') {
    if (!running) running = run(reason).catch(() => (last = { at: Date.now(), ok: false, reason: 'error' })).finally(() => { running = null; });
    return running;
  }

  /** Upgrade / Manage billing: the hub's hosted-page link for this account. → {ok, url?, reason?} */
  async function link(kind, interval) {
    const id = current();
    if (!id) return { ok: false, reason: 'signed-out' };
    const route = kind === 'portal' ? '/api/billing/portal' : '/api/billing/checkout';
    const body = kind === 'portal' ? { request_id: crypto.randomUUID() } : { request_id: crypto.randomUUID(), interval: interval === 'year' ? 'year' : 'month' };
    const got = await call(id, 'POST', route, body);
    const url = got.ok && typeof got.json?.url === 'string' && /^https:\/\//.test(got.json.url) ? got.json.url : null;
    if (url) return { ok: true, url };
    // Already subscribed, or no billing on this hub: the hub's own billing page explains.
    return { ok: false, reason: got.reason ?? 'refused', fallback: `${id.base}/billing` };
  }

  return { check, link, current, last: () => last };
}

/** paid-wiring.js package entry: timers, IPC for the Upgrade page. Never throws into startup. */
function register(ctx) {
  const { ipcMain, log = () => {} } = ctx;
  const { shell } = require('electron');
  const identity = () => ctx.buddy?.()?.interactionHostIdentity?.() ?? null;
  const refresher = createRefresher({ identity, fetch: (...a) => globalThis.fetch(...a), log }); // privacy-flow: entitlement-check
  const timers = [];
  const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); timers.push(t); };
  const every = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); timers.push(t); };
  // On sign-in (a new account on the signed-in hub): a local check, no request while signed out.
  let seen = null;
  const watch = () => {
    const id = refresher.current();
    const key = id ? `${id.base}\n${id.userId}` : null;
    if (key && key !== seen) refresher.check('sign-in');
    seen = key;
  };
  later(() => { watch(); refresher.check('startup'); }, FIRST_CHECK_MS);
  every(watch, IDENTITY_POLL_MS);
  every(() => refresher.check('daily'), DAY_MS);
  ctx.onQuit?.(() => { for (const t of timers) { clearTimeout(t); clearInterval(t); } });

  const fromUpgrade = (e) => { try { return ctx.fromPage(e, 'upgrade'); } catch { return false; } };
  const open = (url) => shell.openExternal(url); // privacy-flow: billing-checkout-link
  ipcMain.handle('entitlement:state', (e) => (fromUpgrade(e) ? { ...describe(), signedIn: !!refresher.current(), lastCheck: refresher.last() } : null));
  ipcMain.handle('entitlement:refresh', async (e) => { if (!fromUpgrade(e)) return null; await refresher.check('manual'); return { ...describe(), signedIn: !!refresher.current(), lastCheck: refresher.last() }; });
  ipcMain.handle('entitlement:open', async (e, kind, interval) => {
    if (!fromUpgrade(e)) return { ok: false };
    const r = await refresher.link(kind === 'portal' ? 'portal' : 'checkout', interval);
    const url = r.ok ? r.url : r.fallback;
    if (url) await open(url);
    return { ok: !!url, reason: r.reason ?? null };
  });
  return refresher;
}

module.exports = { register, createRefresher, describe };
