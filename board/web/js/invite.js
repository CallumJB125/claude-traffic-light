// Invite landing page (/invite#<token>, CONTRACT D64, D70). The token is in
// the URL fragment, so it never reaches the server, its logs or a Referer.
// This script reads it, drops it from the address bar, asks the hub for the
// three preview fields, then tries the desktop app (plexiform://) and offers
// the download for people without the app. The token goes to the legacy
// claudebuddy:// scheme (which any app may claim) only when the person clicks
// "Open with older Buddy", offered if the page is still in front afterwards.

import { BRAND } from '../../shared/brand.js';

const $ = (id) => document.getElementById(id);
const TOKEN_RE = /^inv_[A-Za-z0-9_-]{43}$/;
const ROLE_TEXT = { admin: 'an admin', member: 'a member', viewer: 'a viewer' };

function fail(msg) {
  $('invite-lead').textContent = msg;
  $('open-app').hidden = true;
}

const INVALID = 'This invite is not valid: it may have expired, been used or been withdrawn. Ask for a new one.';
const LEGACY_AFTER_MS = 1500;

let token = null;
try { token = decodeURIComponent(location.hash.slice(1)).trim(); } catch { token = null; }
history.replaceState(null, '', location.pathname);

async function main() {
  if (token == null) {
    fail(INVALID);
    return;
  }
  if (!TOKEN_RE.test(token)) {
    fail('This invite link is incomplete. Open it straight from the email, or ask for a new invite.');
    return;
  }
  let res;
  let data = null;
  try {
    res = await fetch('/api/invites/preview', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ t: token }) });
    data = await res.json().catch(() => null);
  } catch {
    fail('Could not reach the board. Check your connection and reload.');
    return;
  }
  if (!res.ok) {
    fail(res.status === 429 ? 'Too many tries. Wait a few minutes and reload.' : INVALID);
    return;
  }
  const role = ROLE_TEXT[data.role] ?? data.role;
  $('invite-title').textContent = `Join ${data.team_name} on ${BRAND.name}`;
  $('invite-lead').textContent = `${data.inviter_first_name} invited you to join ${data.team_name} as ${role}.`;
  const primary = `${BRAND.deepLinkScheme}://invite/${token}`;
  const open = $('open-app');
  open.href = primary;
  open.hidden = false;
  $('no-app').hidden = false;
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
