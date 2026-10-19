const id = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const status = document.getElementById('status');
const approve = document.getElementById('approve');
async function call(method, path, body, csrf) {
  const r = await fetch(path, { method, credentials: 'same-origin', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); // privacy-flow: phone-browser-signin
  return { status: r.status, body: await r.json() };
}
async function boot() {
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw Error('Start again from Plexiform on your phone.');
  const me = await call('GET', '/api/account');
  if (me.status === 401) { sessionStorage.setItem('plexiform-phone-return', id); document.getElementById('signin').hidden = false; status.textContent = 'Sign in, then confirm this phone.'; return; }
  if (me.status !== 200) throw Error('Could not check your account. Start again from your phone.');
  const flow = await call('GET', `/api/auth/phone/${id}`);
  if (flow.status !== 200 || flow.body.approved) throw Error('This phone sign-in expired or was already used. Start again.');
  status.textContent = `Connect to ${me.body.user?.display_name || me.body.user?.email || 'your account'}? This phone can access shared sessions. Approving commands still requires a separate pairing and passkey.`;
  document.getElementById('code').textContent = flow.body.code;
  approve.hidden = false;
  approve.onclick = async () => {
    approve.disabled = true;
    try {
      const r = await call('POST', '/api/auth/phone/approve', { id, code: flow.body.code }, me.body.csrf_token);
      if (r.status !== 200) throw Error('Could not connect. Start again from your phone.');
      const dest = new URL(r.body.url);
      if (dest.protocol !== 'https:' || dest.pathname !== '/phone/') throw Error('Invalid phone address.');
      location.replace(dest.href);
    } catch (e) { status.textContent = e.message; }
  };
}
boot().catch((e) => { status.textContent = e.message; });
