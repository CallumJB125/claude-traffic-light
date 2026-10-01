// Invite landing page (/invite#<token>, CONTRACT D64, D70). The token is in
// the URL fragment, so it never reaches the server, its logs or a Referer.
// This script reads it, drops it from the address bar, asks the hub for the
// three preview fields, then:
// - signed in on this browser: offers to join here (POST /api/invites/accept
//   with the session's CSRF token), and the app as a second choice;
// - signed out: tries the desktop app (plexiform://), offers the download, and
//   "Join in your browser", which signs in first (/signin#invite=<token>, the
//   fragment again) and comes back here.
// The token goes to the legacy claudebuddy:// scheme (which any app may
// claim) only when the person clicks "Open with older Buddy", offered if the
// page is still in front afterwards.

import { BRAND } from '../../shared/brand.js';
import { accountErrorText, INVITE_INVALID, INVITE_TOKEN_RE, WRONG_ACCOUNT } from './account-text.js';

const $ = (id) => document.getElementById(id);
const ROLE_TEXT = { admin: 'an admin', member: 'a member', viewer: 'a viewer' };

function fail(msg) {
  $('invite-lead').textContent = msg;
  $('open-app').hidden = true;
}

const LEGACY_AFTER_MS = 1500;

async function hub(method, path, { body, credentials = 'omit', csrf = null } = {}) {
  let res;
  let data = null;
  try {
    res = await fetch(path, { method, credentials, headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); // privacy-flow: board-view
    data = await res.json().catch(() => null);
  } catch {
    return { ok: false, status: 0, data: null };
  }
  return { ok: res.ok, status: res.status, data };
}

const errOf = (r) => ({ status: r.status, code: r.data?.error?.code ?? null, extra: r.data?.error ?? {} });

let token = null;
try { token = decodeURIComponent(location.hash.slice(1)).trim(); } catch { token = null; }
history.replaceState(null, '', location.pathname);

const boardFor = (team) => `/?org=${encodeURIComponent(String(team?.id ?? ''))}`;

function joinHere(team, csrf) {
  const join = $('join-web');
  join.textContent = `Join ${team}`;
  join.hidden = false;
  join.addEventListener('click', async () => {
    join.disabled = true;
    const r = await hub('POST', '/api/invites/accept', { body: { t: token }, credentials: 'same-origin', csrf });
    if (r.ok) { location.replace(boardFor(r.data?.team)); return; }
    join.disabled = false;
    const e = errOf(r);
    $('invite-lead').textContent = accountErrorText(e, 'invite');
    if (e.code === 'ALREADY_MEMBER' && e.extra.team?.id) {
      join.hidden = true;
      $('open-board').href = boardFor(e.extra.team);
      $('open-board').hidden = false;
    }
    if (e.code === 'WRONG_ACCOUNT') {
      $('invite-lead').textContent = WRONG_ACCOUNT;
      join.hidden = true;
      const sw = $('switch-web');
      sw.hidden = false;
      sw.addEventListener('click', async () => {
        sw.disabled = true;
        await hub('POST', '/api/auth/signout', { body: {}, credentials: 'same-origin', csrf });
        location.assign(`/signin#invite=${token}`);
      }, { once: true });
    }
    if (e.code === 'INVALID_TOKEN') join.hidden = true;
  });
}

async function main() {
  if (token == null) {
    fail(INVITE_INVALID);
    return;
  }
  if (!INVITE_TOKEN_RE.test(token)) {
    fail('This invite link is incomplete. Open it straight from the email, or ask for a new invite.');
    return;
  }
  const pv = await hub('POST', '/api/invites/preview', { body: { t: token } });
  if (pv.status === 0) {
    fail('Could not reach the board. Check your connection and reload.');
    return;
  }
  if (!pv.ok) {
    fail(pv.status === 429 ? 'Too many tries. Wait a few minutes and reload.' : INVITE_INVALID);
    return;
  }
  const data = pv.data;
  const role = ROLE_TEXT[data.role] ?? data.role;
  $('invite-title').textContent = `Join ${data.team_name} on ${BRAND.name}`;
  $('invite-lead').textContent = `${data.inviter_first_name} invited you to join ${data.team_name} as ${role}.`;
  const primary = `${BRAND.deepLinkScheme}://invite/${token}`;
  const open = $('open-app');
  open.href = primary;
  open.hidden = false;
  // Signed in on this browser already: join here; the app stays a choice, not a jump.
  const acct = await hub('GET', '/api/account', { credentials: 'same-origin' });
  if (acct.ok && typeof acct.data?.csrf_token === 'string') {
    open.className = 'btn';
    joinHere(data.team_name, acct.data.csrf_token);
    return;
  }
  $('no-app').hidden = false;
  const methods = await hub('GET', '/api/auth/methods');
  if (methods.ok && methods.data?.email === true) {
    const web = $('join-web');
    web.textContent = 'Join in your browser';
    web.className = 'btn';
    web.hidden = false;
    web.addEventListener('click', () => { location.assign(`/signin#invite=${token}`); }, { once: true });
  }
  // Try the app. If the page is still in front (nothing handled it), offer
  // older builds, which register only the legacy scheme: on a click only.
  location.href = primary;
  setTimeout(() => {
    if (document.visibilityState !== 'visible') return;
    const older = $('open-legacy');
    older.hidden = false;
    older.addEventListener('click', () => { location.href = `${BRAND.legacyDeepLinkScheme}://invite/${token}`; }, { once: true });
  }, LEGACY_AFTER_MS);
}

main();
