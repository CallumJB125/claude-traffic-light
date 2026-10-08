// Settings → Phone (phone-pairing.html): turn phone approvals on, pair a
// phone by QR (src/qr.js) and a code typed from the phone, see and remove
// paired phones. Renderer only: everything goes through window.phonePairing
// (phone-pairing-preload.js → src/remote-approvals-main.js). Text is set with
// textContent only; a phone's name is the phone's own claim, shown as such.
'use strict';
(() => {
  const api = window.phonePairing;
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const button = (text, onClick) => { const b = node('button', text); b.type = 'button'; b.addEventListener('click', onClick); return b; };
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');
  let state = null, lastLink = null, shownConfirm = null, message = null;

  function qrSvg(text) {
    const q = window.PlexQR.encode(text, { ecc: 'M' });
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const n = q.size + 8;
    svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
    svg.setAttribute('class', 'qr');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Pairing code for your phone');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', window.PlexQR.svgPath(q, 4));
    svg.append(path);
    return svg;
  }

  function statusLine(s) {
    if (!s.ready) return 'Phone approvals could not load their keys on this computer.';
    if (!s.entitled) return 'Off: phone approvals are part of Plexiform Plus.';
    if (!s.enabled) return 'Off.';
    if (!s.signedIn) return 'Sign in to your team hub (Team → Account) first: your phone reaches this computer through it.';
    if (!s.hostConnected) return 'Waiting: turn on “Let my other devices use sessions” in Preferences, and keep this computer awake.';
    return 'On.';
  }

  function renderPairing(s) {
    const box = $('pairing');
    const p = s.pairing;
    if (!p) { box.replaceChildren(); lastLink = null; shownConfirm = null; $('pair').hidden = false; return; }
    $('pair').hidden = true;
    if (p.stage === 'confirm') {
      lastLink = null;
      if (shownConfirm === p.pid) return; // keep what is being typed
      shownConfirm = p.pid;
      const input = node('input', null, 'code');
      Object.assign(input, { id: 'sas', inputMode: 'numeric', autocomplete: 'off', maxLength: 7 });
      const label = node('label', `Type the 6-digit code shown on the phone that calls itself “${p.deviceName || 'Phone'}”:`);
      label.htmlFor = 'sas';
      const go = button('Pair', async () => {
        const r = await api.confirm(p.pid, input.value);
        message = r?.ok ? `Paired “${r.device.name}”. Finish on the phone: it asks for Face ID, Touch ID or your fingerprint to add its passkey.` : r?.error ?? 'Pairing failed.';
        refresh();
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
      box.replaceChildren(label, node('br'), input, ' ', go, ' ', button('Cancel', async () => { await api.cancel(); refresh(); }),
        node('p', 'Only pair a phone you have in your hand. A wrong code cancels the pairing.', 'muted'));
      input.focus();
      return;
    }
    if (lastLink === p.link) return;
    lastLink = p.link;
    const link = node('input', null, 'link');
    Object.assign(link, { readOnly: true, value: p.link, ariaLabel: 'Pairing link' });
    box.replaceChildren(
      qrSvg(p.link),
      node('p', `Valid until ${new Date(p.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}, once.`, 'muted'),
      link,
      node('p', null, 'actions'),
    );
    box.lastChild.append(
      button('Copy link', () => { link.select(); navigator.clipboard?.writeText(p.link).catch(() => {}); }),
      button('Cancel', async () => { await api.cancel(); refresh(); }),
    );
  }

  function renderDevices(s) {
    const box = $('devices');
    if (!s.devices.length) { box.replaceChildren(node('p', 'No phones are paired with this computer.', 'muted')); return; }
    box.replaceChildren(...s.devices.map((d) => {
      const row = node('div', null, 'device');
      const info = node('div');
      info.append(...[node('strong', d.name), node('p', `Paired ${when(d.createdAt)} · last answer ${when(d.lastUsedAt)}`, 'muted'),
        d.otherAccount ? node('p', 'Paired while another account was signed in here: it can’t do anything until that account signs in again.', 'muted') : null,
        d.passkey ? node('p', 'Passkey added', 'muted') : node('p', 'No passkey yet: this phone can’t approve. Remove it and pair again.', 'warn')].filter(Boolean));
      row.append(info, button('Remove', async () => {
        if (!window.confirm(`Remove “${d.name}”? It can’t answer requests or use sessions on this computer any more. To also stop its notifications, remove it in Account → Devices.`)) return;
        await api.revoke(d.deviceId);
        refresh();
      }));
      return row;
    }));
  }

  function render(s) {
    state = s;
    $('plan').hidden = s.entitled;
    $('enabled').checked = s.enabled;
    $('enabled').disabled = !s.entitled;
    $('status').textContent = message ? `${statusLine(s)} ${message}` : statusLine(s);
    const canPair = s.entitled && s.enabled && s.signedIn && s.hostConnected;
    $('pair').disabled = !canPair || s.devices.length >= s.limit;
    $('pair-box').hidden = !s.entitled;
    renderPairing(s);
    renderDevices(s);
  }

  async function refresh() { const s = await api.state(); if (s) render(s); }

  $('enabled').addEventListener('change', async (e) => { message = null; const s = await api.set({ enabled: e.target.checked }); if (s) render(s); });
  $('upgrade').addEventListener('click', () => api.upgrade());
  $('pair').addEventListener('click', async () => {
    message = null;
    const r = await api.start();
    if (r && !r.ok) message = r.error;
    refresh();
  });
  api.changed(() => refresh());
  // Expiry and the phone's progress show without a click.
  setInterval(() => { if (state?.pairing) refresh(); }, 2000);
  refresh();
})();
