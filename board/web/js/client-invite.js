import { clientCall, CLIENT_TOKEN_RE } from './client-api.js';
const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const lead = $('client-invite-lead');
let csrf;
async function main() {
  if (!CLIENT_TOKEN_RE.test(token)) { lead.textContent = 'Open the full invitation link from your email, or ask for a new invitation.'; return; }
  try {
    const preview = await clientCall('POST', '/api/client-invites/preview', { t: token });
    $('client-invite-title').textContent = `Join ${preview.workspace_name}`;
    lead.textContent = `${preview.inviter_first_name} invited you to view your shared client projects in ${preview.workspace_name}.`;
    const account = await clientCall('GET', '/api/account').catch(() => null);
    csrf = account?.csrf_token;
    if (!account?.user) {
      $('client-signin').href = `/signin#client_invite=${token}`;
      $('client-signin').hidden = false;
      return;
    }
    $('client-join').hidden = false;
  } catch (e) { lead.textContent = e.message; }
}
$('client-join').addEventListener('click', async () => {
  $('client-join').disabled = true;
  try {
    const result = await clientCall('POST', '/api/client-invites/accept', { t: token }, csrf);
    location.replace(`/clients?workspace=${encodeURIComponent(result.workspace.id)}`);
  } catch (e) {
    lead.textContent = e.message;
    $('client-join').disabled = false;
    if (e.code === 'WRONG_ACCOUNT') { $('client-join').hidden = true; $('client-switch').hidden = false; }
  }
});
$('client-switch').addEventListener('click', async () => {
  try { await clientCall('POST', '/api/auth/signout', {}, csrf); location.replace(`/signin#client_invite=${token}`); }
  catch (e) { lead.textContent = e.message; }
});
main();
