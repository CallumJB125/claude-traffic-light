// Accounts-mode sign-in page (/signin, /auth/email): email → 6-digit code →
// cookie session. A magic link carries #f=<flow_id>&c=<code> in the fragment,
// which never reaches the server; this script POSTs it, so a link scanner's
// GET consumes nothing. Another browser than the one that asked must confirm.

const $ = (id) => document.getElementById(id);
let flowId = null;

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, error: data?.error ?? null, data };
}

function showError(msg) {
  $('signin-error').textContent = msg ?? '';
  $('signin-error').hidden = !msg;
}

async function verify(body) {
  showError(null);
  const r = await post('/api/auth/email/verify', body);
  if (r.ok) { location.replace('/'); return; }
  if (r.error?.code === 'CONFIRM_REQUIRED') {
    $('email-form').hidden = true;
    $('code-form').hidden = true;
    $('confirm-text').textContent = `Sign in as ${r.error.email_masked}? This link was requested from another browser.`;
    $('confirm').hidden = false;
    $('confirm-yes').onclick = () => { $('confirm').hidden = true; verify({ ...body, confirm: true }); };
    return;
  }
  showError(r.error?.message ?? 'Something went wrong. Try again.');
}

$('email-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError(null);
  const r = await post('/api/auth/email/start', { email: $('email').value, client: 'web' });
  if (!r.ok) { showError(r.error?.message ?? 'Something went wrong. Try again.'); return; }
  flowId = r.data.flow_id;
  $('signin-lead').textContent = 'Check your email for a 6-digit code. It works for 10 minutes.';
  $('email-form').hidden = true;
  $('code-form').hidden = false;
  $('code').focus();
});

$('code-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  verify({ flow_id: flowId, code: $('code').value.trim() });
});

const frag = new URLSearchParams(location.hash.slice(1));
if (frag.get('f') && frag.get('c')) {
  history.replaceState(null, '', location.pathname);
  $('email-form').hidden = true;
  verify({ flow_id: frag.get('f'), code: frag.get('c'), via: 'link' });
}
