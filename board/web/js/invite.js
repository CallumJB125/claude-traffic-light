// Invite landing page (/invite#<token>, CONTRACT D64). The token is in the URL
// fragment, so it never reaches the server, its logs or a Referer. This script
// reads it, drops it from the address bar, asks the hub for the three preview
// fields, then tries the desktop app (plexiform://, then the legacy
// claudebuddy:// alias) and offers the download for people without the app.

import { BRAND } from '../../shared/brand.js';

const $ = (id) => document.getElementById(id);
const TOKEN_RE = /^inv_[A-Za-z0-9_-]{43}$/;
const ROLE_TEXT = { admin: 'an admin', member: 'a member', viewer: 'a viewer' };

function fail(msg) {
  $('invite-lead').textContent = msg;
  $('open-app').hidden = true;
}

const token = decodeURIComponent(location.hash.slice(1)).trim();
history.replaceState(null, '', location.pathname);

async function main() {
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
    fail(res.status === 429 ? 'Too many tries. Wait a few minutes and reload.' : 'This invite is not valid: it may have expired, been used or been withdrawn. Ask for a new one.');
    return;
  }
  const role = ROLE_TEXT[data.role] ?? data.role;
  $('invite-title').textContent = `Join ${data.team_name} on ${BRAND.name}`;
  $('invite-lead').textContent = `${data.inviter_first_name} invited you to join ${data.team_name} as ${role}.`;
  const primary = `${BRAND.deepLinkScheme}://invite/${token}`;
  const legacy = `${BRAND.legacyDeepLinkScheme}://invite/${token}`;
  const open = $('open-app');
  open.href = primary;
  open.hidden = false;
  $('no-app').hidden = false;
  // Try the app: the current scheme first, then the legacy one if the page is
  // still in front (nothing handled the first).
  location.href = primary;
  setTimeout(() => { if (document.visibilityState === 'visible') location.href = legacy; }, 1200);
}

main();
