// /phone/ entry: wires the controller (phone-core.js), the vault and the
// renderer to the page. Event delegation only (no inline handlers: CSP).
import { render } from './h.js';
import { createApi, createController, createE2E } from './phone-core.js';
import { createVault, idbKv } from './phone-vault.js';
import { phoneView } from './phone-render.js';
import { createApprovals, approvalsView } from './phone-approvals.js';

const root = document.getElementById('app');
const guessName = () => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
};

const vault = createVault({ kv: idbKv() });
const e2e = createE2E({ store: vault });
const api = createApi({ fetch: (...a) => fetch(...a), uuid: () => crypto.randomUUID(), e2e }); // privacy-flow: phone-control
const ctl = createController({ api, vault, online: () => navigator.onLine, deviceName: guessName() });
const ui = { confirmClose: false };

// Phone approvals (phone-approvals.js). A pairing link's fragment is read once
// and removed from the address bar; it never reaches a server.
const swReg = 'serviceWorker' in navigator ? navigator.serviceWorker.register('/phone/sw.js', { scope: '/phone/' }).catch(() => null) : Promise.resolve(null);
const pushAdapter = 'PushManager' in globalThis ? {
  state: () => (globalThis.Notification?.permission === 'denied' ? 'denied' : 'off'),
  async subscribe(key) {
    const reg = await swReg;
    if (!reg) throw new Error('no service worker');
    return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); // privacy-flow: phone-push
  },
} : null;
const appr = createApprovals({ api, e2e, vault, credentials: navigator.credentials, push: pushAdapter, origin: location.origin, rpId: location.hostname, uuid: () => crypto.randomUUID(), deviceName: guessName() });
let pendingPair = location.hash.startsWith('#pair=') ? location.hash.slice(1) : '';
let wantApprovals = !!pendingPair || location.hash === '#approvals';
if (location.hash) history.replaceState(null, '', '/phone/');
const signedIn = () => !['boot', 'signin'].includes(ctl.state.view);
function openApprovals() { wantApprovals = false; const text = pendingPair; pendingPair = ''; appr.open(text); }
appr.subscribe(() => paint());
const DEPTH = { sessions: 1, session: 2 };
let lastView = null;

function paint() {
  if (appr.state.open && signedIn()) { render(root, approvalsView(appr.state, Date.now())); return; }
  if (wantApprovals && signedIn()) { openApprovals(); return; }
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
    case 'open-approvals': return openApprovals();
    case 'approvals-back': appr.close(); lastView = null; return paint();
    case 'approvals-refresh': return appr.load();
    case 'approve': case 'deny': {
      const [host, requestId] = String(id).split('|');
      return appr.decide(host, requestId, action === 'approve' ? 'allow' : 'deny');
    }
    case 'push-on': return appr.enablePush();
    case 'task-voice': return listen();
    case 'dismiss': return ctl.dismissNotice();
    case 'restart-signin': return ctl.restartSignIn();
    case 'signout': return ctl.signOut();
    case 'retry-signout': return ctl.retrySignOut();
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
  if (form === 'pair') return appr.pair(f.elements.link.value);
  if (form === 'task') return appr.startTask(f.elements.host.value, f.elements.provider.value, f.elements.text.value);
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

// Voice for "Start a task": the browser's own speech recognition, into the text box.
function listen() {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  const box = document.getElementById('task-text');
  if (!SR || !box) return;
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = false;
  rec.onresult = (ev) => { const t = Array.from(ev.results).map((r) => r[0]?.transcript ?? '').join(' ').trim(); if (t) box.value = box.value ? `${box.value} ${t}` : t; };
  rec.start(); // privacy-flow: phone-voice
}

// A notification tap while the app is open.
navigator.serviceWorker?.addEventListener?.('message', (e) => { if (e.data?.type === 'plexiform-open-approvals') { if (signedIn()) openApprovals(); else wantApprovals = true; } });
ctl.boot();
