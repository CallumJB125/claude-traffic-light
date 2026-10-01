// Accounts-mode sign-in page (/signin, /auth/email): email → 6-digit code →
// cookie session. A magic link carries #f=<flow_id>&c=<code> in the fragment,
// which never reaches the server; this script POSTs it, so a link scanner's
// GET consumes nothing. Another browser than the one that asked must confirm.
// An invite opened while signed out sends people here with #invite=<token>;
// once signed in they go back to /invite with it (fragment only, never stored).
import { accountErrorText, EMAIL_OFF, INVITE_TOKEN_RE, resendWaitS, resendWaitText } from './account-text.js';

const $ = (id) => document.getElementById(id);
let flowId = null;
let email = '';
let busy = false;
let invite = null;
const asked = new Map(); // email → when this page asked for its codes

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); // privacy-flow: board-view
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

async function verify(body) {
  showError(null);
  const r = await call('POST', '/api/auth/email/verify', body);
  if (r.ok) { location.replace(invite ? `/invite#${invite}` : '/'); return; }
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
    if (await askForCode()) codeStep(`We sent a 6-digit code to ${email}. It works for 10 minutes.`);
  });
});

$('code-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  guarded(() => verify({ flow_id: flowId, code: String($('code').value ?? '').trim() }));
});

$('resend').addEventListener('click', () => {
  guarded(async () => {
    showError(null);
    if (await askForCode()) codeStep('We sent a new code. Use the newest email: older codes stop working.');
  });
});

$('other-email').addEventListener('click', () => {
  showError(null);
  flowId = null;
  $('code-form').hidden = true;
  $('code-foot').hidden = true;
  $('email-form').hidden = false;
  $('signin-lead').textContent = 'We’ll email you a 6-digit code. No password.';
  $('email').focus();
});

const frag = new URLSearchParams(location.hash.slice(1));
if (location.hash) history.replaceState(null, '', location.pathname);
if (INVITE_TOKEN_RE.test(frag.get('invite') ?? '')) {
  invite = frag.get('invite');
  $('signin-lead').textContent = 'Sign in to accept your invite. We’ll email you a 6-digit code.';
}
if (frag.get('f') && frag.get('c')) {
  $('email-form').hidden = true;
  verify({ flow_id: frag.get('f'), code: frag.get('c'), via: 'link' });
} else {
  // A hub with no mailer answers every code route with METHOD_DISABLED: say so before anyone types.
  call('GET', '/api/auth/methods').then((r) => {
    if (r.ok && r.data?.email === false) {
      $('email-form').hidden = true;
      $('signin-lead').textContent = EMAIL_OFF;
    }
  });
}
