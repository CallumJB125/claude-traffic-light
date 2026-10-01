// Accounts-mode sign-in page (/signin, /auth/email): email → 6-digit code →
// cookie session. A magic link carries #f=<flow_id>&c=<code> in the fragment,
// which never reaches the server; this script POSTs it, so a link scanner's
// GET consumes nothing. Another browser than the one that asked must confirm.
// An invite opened while signed out sends people here with #invite=<token>;
// once signed in their explicit join resumes; failures return to /invite
// with it (fragment only, never stored).
import { accountErrorText, EMAIL_OFF, INVITE_TOKEN_RE, resendWaitS, resendWaitText } from './account-text.js';

const $ = (id) => document.getElementById(id);
let flowId = null;
let email = '';
let busy = false;
let invite = null;
const asked = new Map(); // email → when this page asked for its codes

async function call(method, path, body, { csrf = null } = {}) {
  let res;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); // privacy-flow: board-view
  } catch {
    return { ok: false, status: 0, error: null, data: null };
  }
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, error: data?.error ?? null, data };
}

const errOf = (r) => ({ status: r.status, code: r.error?.code ?? null, extra: r.error ?? {} });

function showError(msg) {
  $('signin-error').textContent = msg ?? '';
  $('signin-error').hidden = !msg;
}

function codeStep(lead) {
  $('signin-lead').textContent = lead;
  $('email-form').hidden = true;
  $('oauth-options').hidden = true;
  $('code-form').hidden = false;
  $('code-foot').hidden = false;
  $('code').value = '';
  $('code').focus();
}

async function askForCode() {
  const times = asked.get(email) ?? [];
  const wait = resendWaitS(times, Date.now(), { resend: flowId != null });
  if (wait) { showError(resendWaitText(wait)); return false; }
  const r = await call('POST', '/api/auth/email/start', { email, client: 'web' });
  if (!r.ok || typeof r.data?.flow_id !== 'string') { showError(accountErrorText(errOf(r), 'start')); return false; }
  asked.set(email, [...times, Date.now()]);
  flowId = r.data.flow_id;
  return true;
}

async function continueSignedIn(data) {
  if (invite) {
    const joined = await call('POST', '/api/invites/accept', { t: invite }, { csrf: data?.csrf_token });
    const team = joined.data?.team ?? (joined.data?.error?.code === 'ALREADY_MEMBER' ? joined.data.error.team : null);
    if (team?.id && (joined.ok || joined.data?.error?.code === 'ALREADY_MEMBER')) {
      location.replace(`/?org=${encodeURIComponent(String(team.id))}`);
      return;
    }
    // Wrong-account, expired or rate-limited invitations retain their
    // existing recovery actions; a failed join never creates a team.
    location.replace(`/invite#${invite}`);
    return;
  }
  location.replace('/');
  return;
}

async function verify(body) {
  showError(null);
  const r = await call('POST', '/api/auth/email/verify', body);
  if (r.ok) {
    await continueSignedIn(r.data);
    return;
  }
  if (r.error?.code === 'CONFIRM_REQUIRED') {
    $('email-form').hidden = true;
    $('code-form').hidden = true;
    $('code-foot').hidden = true;
    $('confirm-text').textContent = `Sign in as ${r.error.email_masked}? This link was requested from another browser.`;
    $('confirm').hidden = false;
    $('confirm-yes').onclick = () => { $('confirm').hidden = true; verify({ ...body, confirm: true }); };
    return;
  }
  showError(accountErrorText(errOf(r), 'verify'));
  // A magic link that failed leaves nothing to type into: start again from the email.
  if (body.via === 'link') $('email-form').hidden = false;
}

async function guarded(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } finally { busy = false; }
}

$('email-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  guarded(async () => {
    showError(null);
    email = String($('email').value ?? '').trim();
    // "Asked for", not "sent": the hub answers before it mails, so it can't know the mail went.
    if (await askForCode()) codeStep(`We’ve asked for a 6-digit code to be sent to ${email}. It works for 10 minutes.`);
  });
});

$('code-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  guarded(() => verify({ flow_id: flowId, code: String($('code').value ?? '').trim() }));
});

$('resend').addEventListener('click', () => {
  guarded(async () => {
    showError(null);
    if (await askForCode()) codeStep('We’ve asked for a new code. Use the newest email: older codes stop working.');
  });
});

$('other-email').addEventListener('click', () => {
  showError(null);
  flowId = null;
  $('code-form').hidden = true;
  $('code-foot').hidden = true;
  $('email-form').hidden = false;
  $('signin-lead').textContent = 'We’ll email you a 6-digit code. No password.';
  offerMethods();
  $('email').focus();
});

const frag = new URLSearchParams(location.hash.slice(1));
if (location.hash) history.replaceState(null, '', location.pathname);
if (INVITE_TOKEN_RE.test(frag.get('invite') ?? '')) {
  invite = frag.get('invite');
  $('signin-lead').textContent = 'Sign in to accept your invite.';
}
function oauthError(code) {
  if (code === 'SIGNUP_CLOSED') return 'Sign-up is invite-only right now. Ask a team owner for an invite.';
  if (code === 'RATE_LIMITED') return 'Too many sign-in attempts. Wait a few minutes and try again.';
  if (code === 'PROVIDER_UNAVAILABLE') return 'We couldn’t reach the sign-in provider. Try again shortly.';
  if (code === 'EMAIL_UNVERIFIED') return 'Choose an account with a verified email address.';
  return 'Sign-in didn’t finish. Try again or choose another method.';
}

async function oauthStart(provider) {
  showError(null);
  const invitation = invite ? { kind: 'team', token: invite } : null;
  const r = await call('POST', '/api/auth/oauth/web/start', { provider, ...(invitation ? { invitation } : {}) });
  if (!r.ok || typeof r.data?.url !== 'string') { showError(oauthError(r.error?.code)); return; }
  // The server supplies fixed provider URLs; reject a poisoned response too.
  let u;
  try { u = new URL(r.data.url); } catch { showError(oauthError(null)); return; }
  if (!((provider === 'google' && u.origin === 'https://accounts.google.com' && u.pathname === '/o/oauth2/v2/auth')
    || (provider === 'github' && u.origin === 'https://github.com' && u.pathname === '/login/oauth/authorize'))) { showError(oauthError(null)); return; }
  location.assign(u.href);
}
for (const provider of ['google', 'github']) $(provider + '-signin').addEventListener('click', () => guarded(() => oauthStart(provider)));

async function offerMethods() {
  const r = await call('GET', '/api/auth/methods');
  if (!r.ok) return;
  $('email-form').hidden = r.data?.email === false;
  const google = r.data?.web?.google === true; const github = r.data?.web?.github === true;
  $('google-signin').hidden = !google; $('github-signin').hidden = !github;
  $('oauth-options').hidden = !google && !github;
  if (r.data?.email === false) {
    $('email-form').hidden = true;
    $('signin-lead').textContent = google || github ? (invite ? 'Sign in to accept your invite.' : 'Choose how to sign in.') : EMAIL_OFF;
  }
}
async function oauthFinish() {
  $('email-form').hidden = true;
  const account = await call('GET', '/api/account');
  const r = await call('POST', '/api/auth/oauth/web/result', {}, { csrf: account.data?.csrf_token });
  if (r.ok) {
    if (r.data?.invitation?.kind === 'team' && INVITE_TOKEN_RE.test(r.data.invitation.token)) invite = r.data.invitation.token;
    if (r.data?.ok === true && account.ok) { await continueSignedIn(account.data); return; }
  }
  showError(oauthError(r.data?.error?.code));
  await offerMethods();
}
if (frag.get('oauth') === 'web') {
  guarded(oauthFinish);
} else if (frag.get('f') && frag.get('c')) {
  $('email-form').hidden = true;
  verify({ flow_id: frag.get('f'), code: frag.get('c'), via: 'link' });
} else {
  if (frag.get('oauth') === 'invalid') showError(oauthError('INVALID_TOKEN'));
  offerMethods();
}
