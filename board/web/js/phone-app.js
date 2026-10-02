// /phone/ entry: wires the controller (phone-core.js), the vault and the
// renderer to the page. Event delegation only (no inline handlers: CSP).
import { render } from './h.js';
import { createApi, createController } from './phone-core.js';
import { createVault, idbKv } from './phone-vault.js';
import { phoneView } from './phone-render.js';

const root = document.getElementById('app');
const guessName = () => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
};

const api = createApi({ fetch: (...a) => fetch(...a), uuid: () => crypto.randomUUID() }); // privacy-flow: phone-control
const ctl = createController({ api, vault: createVault({ kv: idbKv() }), online: () => navigator.onLine, deviceName: guessName() });
const ui = { confirmClose: false };
const DEPTH = { sessions: 1, session: 2 };
let lastView = null;

function paint() {
  const st = ctl.state;
  if (st.view !== lastView) {
    // Going deeper adds a history entry, so the system back gesture works.
    if ((DEPTH[st.view] ?? 0) > (DEPTH[lastView] ?? 0)) history.pushState({ v: st.view }, '');
    ui.confirmClose = false;
    lastView = st.view;
    render(root, phoneView(st, Date.now(), ui));
    root.querySelector('h1')?.focus?.();
    return;
  }
  render(root, phoneView(st, Date.now(), ui));
}
ctl.subscribe(paint);
// Liveness and "checked … ago" labels age even when nothing arrives.
setInterval(paint, 1000);

root.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b || b.disabled) return;
  const id = b.getAttribute('data-id');
  const action = b.getAttribute('data-action');
  if (action !== 'close') ui.confirmClose = false;
  switch (action) {
    case 'dismiss': return ctl.dismissNotice();
    case 'restart-signin': return ctl.restartSignIn();
    case 'signout': return ctl.signOut();
    case 'refresh': return ctl.state.view === 'hosts' ? ctl.loadHosts() : ctl.loadSessions();
    case 'open-host': return ctl.openHost(id);
    case 'open-shared': return ctl.openShared(id);
    case 'open-session': return ctl.openSession(id);
    case 'launch': return ctl.launch(id);
    case 'back': return history.back();
    case 'interrupt': return ctl.interrupt();
    case 'close':
      if (!ui.confirmClose) { ui.confirmClose = true; return paint(); }
      ui.confirmClose = false;
      if (await ctl.close()) history.back();
      return undefined;
    default: return undefined;
  }
});

root.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const form = f.getAttribute('data-form');
  if (form === 'email') return ctl.startSignIn(f.elements.email.value, f.elements.device_name.value);
  if (form === 'code') return ctl.verifyCode(f.elements.code.value);
  if (form === 'send') {
    const box = f.elements.text;
    if (await ctl.send(box.value)) box.value = '';
  }
  return undefined;
});

// Enter sends on a hardware keyboard; Shift+Enter is a new line.
root.addEventListener('keydown', (e) => {
  if (e.target.id === 'message' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

// The system back gesture walks the same path as the back button.
addEventListener('popstate', () => { if (ctl.state.view === 'session' || ctl.state.view === 'sessions') ctl.back(); });
addEventListener('online', () => { ctl.wake(); paint(); });
addEventListener('offline', paint);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { ctl.wake(); paint(); } });

// Lists are refreshed while open (they are snapshots; the session screen long-polls).
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (ctl.state.view === 'hosts') ctl.loadHosts();
  else if (ctl.state.view === 'sessions') ctl.loadSessions();
}, 15_000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/phone/sw.js', { scope: '/phone/' }).catch(() => {});
ctl.boot();
