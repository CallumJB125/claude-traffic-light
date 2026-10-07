// Sync page: turn on, recovery code (shown once), restore, devices (approve,
// remove), sync now. Text only via textContent; main does all the work.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.sync;
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const gb = (n) => `${(n / 1024 ** 3).toFixed(n < 1024 ** 3 / 10 ? 2 : 1)} GB`;
  let current = null;

  function say(r, ok) {
    if (r && r.ok === false && r.message) $('note').textContent = r.message;
    else if (r && r.ok === false && r.code) $('note').textContent = `Sync failed (${r.code}).`;
    else $('note').textContent = ok || '';
  }

  function device(d, hub) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const name = document.createElement('div');
    name.textContent = `${d.name || 'Computer'}${d.current ? ' (this computer)' : ''}${d.revoked ? ' · removed' : !d.has_key ? ' · waiting for approval' : ''}`;
    const sub = document.createElement('div');
    sub.className = 'fp';
    sub.textContent = `Last sync ${when(d.last_sync_at)}`;
    left.append(name, sub);
    li.append(left);
    if (!d.revoked && !d.current) {
      const buttons = document.createElement('div');
      buttons.className = 'buttons';
      if (!d.has_key && current?.local?.hasKeys) {
        const b = document.createElement('button');
        b.textContent = 'Approve';
        b.addEventListener('click', async () => {
          if (!window.confirm(`Approve this computer? Its code must match what it shows on its Sync page.`)) return;
          say(await api.approve(d.device_id).catch(() => null), 'Approved.');
          refresh();
        });
        buttons.append(b);
      }
      if (current?.local?.hasKeys && hub.mode !== 'none') {
        const r = document.createElement('button');
        r.textContent = 'Remove';
        r.addEventListener('click', async () => {
          if (!window.confirm('Remove this computer from sync? It keeps what it already has but can never read anything synced after this.')) return;
          say(await api.revoke(d.device_id).catch(() => null), 'Removed. The sync key was changed.');
          refresh();
        });
        buttons.append(r);
      }
      li.append(buttons);
    }
    return li;
  }

  function show(s) {
    if (!s) return;
    current = s;
    const hub = s.hub && !s.hub.error ? s.hub : null;
    $('upsell').hidden = s.entitled || (s.enabled && hub && hub.mode === 'read_only');
    $('banner').hidden = !(hub && hub.mode === 'read_only');
    $('banner').textContent = hub && hub.mode === 'read_only'
      ? `Your plan has ended, so sync is read-only. Your synced data is deleted from the server on ${new Date(hub.read_only_until).toLocaleDateString()} unless you renew.` : '';
    const on = s.enabled && s.signedIn;
    $('headline').textContent = !s.signedIn ? 'Sign in to sync' : on ? (s.local.hasKeys ? 'On' : 'Waiting for a key') : 'Off';
    $('detail').textContent = !s.signedIn ? 'Sign in to your team hub (Account) to sync this computer.'
      : on && hub ? `Last sync ${s.local.lastSync ? new Date(s.local.lastSync).toLocaleString() : 'not yet'} · ${gb(hub.bytes_used || 0)} of ${gb(hub.limits.bytes)} · ${hub.devices.filter((d) => !d.revoked).length} of ${hub.limits.devices} computers`
        : s.hub && s.hub.error ? (s.hub.message || "Couldn't reach your team hub.") : '';
    $('enable').hidden = !s.entitled || !s.signedIn || (on && s.local.hasKeys);
    $('now').hidden = !on || !s.local.hasKeys;
    $('disable').hidden = !s.enabled;
    $('restore').hidden = !(on && !s.local.hasKeys && hub && hub.initialized);
    $('my-fp').textContent = s.local.fingerprint || '';
    $('devices-card').hidden = !(on && hub && hub.devices.length);
    $('new-code').hidden = !s.local.hasKeys;
    $('devices').replaceChildren(...(hub ? hub.devices.map((d) => device(d, hub)) : []));
  }

  function showCode(code) {
    if (!code) return;
    $('code').textContent = code;
    $('code-card').hidden = false;
  }

  async function refresh() { show(await api.state().catch(() => null)); }

  if (!api) return;
  $('enable').addEventListener('click', async () => {
    $('note').textContent = 'Turning on…';
    const r = await api.enable().catch(() => null);
    if (r && r.ok) { showCode(r.recoveryCode); say(null, r.recoveryCode ? '' : 'Sync is on.'); }
    else if (r && r.waiting === 'approval') say(null, `Approve this computer on one you already sync, or use your recovery code. This computer's code: ${r.fingerprint}`);
    else say(r);
    refresh();
  });
  $('now').addEventListener('click', async () => { $('note').textContent = 'Syncing…'; const r = await api.now().catch(() => null); say(r && r.ok === false ? r : null, 'Synced.'); refresh(); });
  $('disable').addEventListener('click', async () => { await api.disable().catch(() => null); say(null, 'Sync is off on this computer. Nothing was deleted.'); refresh(); });
  $('recover').addEventListener('click', async () => {
    const r = await api.recover($('code-input').value).catch(() => null);
    $('code-input').value = '';
    say(r, 'Restored. Syncing…');
    refresh();
  });
  $('new-code').addEventListener('click', async () => {
    if (!window.confirm('Make a new recovery code? The old one stops working.')) return;
    const r = await api.newCode().catch(() => null);
    if (r && r.ok) showCode(r.recoveryCode); else say(r);
  });
  $('code-done').addEventListener('click', () => { $('code').textContent = ''; $('code-card').hidden = true; });
  window.addEventListener('focus', refresh);
  refresh();
})();
