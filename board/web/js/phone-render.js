// Phone control screens as pure vnode trees (h.js): no DOM, so tests read
// them directly. Provider text only ever becomes text nodes (h.js has no
// innerHTML path). Buttons carry data-action; phone-app.js delegates.
import { h } from './h.js';
import { sessionView, ago, DELIVERY_LABEL, STATUS_LABEL, MAX_TEXT, LIST_STALE_MS } from './phone-core.js';

const btn = (action, label, { kind = '', id, disabled = false, extra = {} } = {}) =>
  h('button', { type: 'button', class: `btn ${kind}`.trim(), 'data-action': action, 'data-id': id ?? null, disabled: disabled || null, ...extra }, label);

function noticeBar(n) {
  if (!n) return null;
  return h('div', { class: `notice ${n.tone}`, role: n.tone === 'error' ? 'alert' : 'status' },
    h('p', null, n.text),
    btn('dismiss', 'Dismiss', { kind: 'quiet small' }));
}

function header(title, { backLabel = null, right = null } = {}) {
  return h('header', { class: 'bar' },
    backLabel ? btn('back', h('span', { 'aria-hidden': 'true' }, '‹'), { kind: 'icon', extra: { 'aria-label': backLabel } }) : h('span', { class: 'bar-spacer' }),
    h('h1', { tabindex: '-1' }, title),
    right ?? h('span', { class: 'bar-spacer' }));
}

// "Checked 40 s ago" under a list: lists are snapshots, never live.
function freshness(loadedAt, now, error) {
  const old = loadedAt == null || now - loadedAt > LIST_STALE_MS;
  return h('div', { class: 'fresh' },
    h('p', { class: old ? 'muted warn-text' : 'muted' }, error ? error : loadedAt == null ? 'Loading…' : `Checked ${ago(now - loadedAt)}`),
    btn('refresh', 'Refresh', { kind: 'quiet small' }));
}

function signin(st) {
  const a = st.auth;
  const err = a.error ? h('p', { class: 'field-error', role: 'alert', id: 'auth-error' }, a.error) : null;
  const described = a.error ? 'auth-error' : null;
  if (!a.flowId) {
    return h('main', { class: 'screen signin' },
      h('div', { class: 'brand' }, h('img', { src: '/web/phone-icon-192.png', alt: '', width: '56', height: '56' }), h('h1', null, 'Plexiform on your phone')),
      h('p', { class: 'lead' }, 'Sign in with the email you use for Plexiform. We email you a 6-digit code.'),
      noticeBar(st.notice),
      h('form', { class: 'stack', 'data-form': 'email', novalidate: true },
        h('label', { for: 'email' }, 'Email'),
        h('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', required: true, 'aria-describedby': described, value: a.email }),
        h('label', { for: 'device-name' }, 'Name for this phone'),
        h('input', { id: 'device-name', name: 'device_name', type: 'text', maxlength: '60', autocomplete: 'off', value: a.deviceName }),
        h('p', { class: 'muted small' }, 'It shows in your account’s device list, where you can remove this phone at any time.'),
        err,
        h('button', { type: 'submit', class: 'btn primary', disabled: st.busy || null }, st.busy ? 'Sending…' : 'Email me a code')));
  }
  return h('main', { class: 'screen signin' },
    h('h1', null, 'Check your email'),
    h('p', { class: 'lead' }, 'Enter the code we sent to ', h('strong', null, a.email), '.'),
    h('form', { class: 'stack', 'data-form': 'code', novalidate: true },
      h('label', { for: 'code' }, '6-digit code'),
      h('input', { id: 'code', name: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: '6', required: true, 'aria-describedby': described }),
      err,
      h('button', { type: 'submit', class: 'btn primary', disabled: st.busy || null }, st.busy ? 'Checking…' : 'Sign in'),
      btn('restart-signin', 'Use a different email', { kind: 'quiet' })));
}

function hosts(st, now) {
  const items = st.hosts.items;
  let body;
  if (items == null) body = h('p', { class: 'muted' }, st.hosts.error ? '' : 'Looking for your computers…');
  else if (!items.length) {
    body = h('div', { class: 'empty' },
      h('h2', null, 'No computers are sharing sessions'),
      h('p', null, 'On your Mac or PC, open Plexiform, sign in with this account and turn on “Let my other devices use sessions”. Keep it awake.'));
  } else {
    body = h('ul', { class: 'list', role: 'list' }, items.map((x) => h('li', { key: x.id },
      h('button', { type: 'button', class: 'row', 'data-action': 'open-host', 'data-id': x.id },
        h('span', { class: 'row-title' }, x.name || 'Computer'),
        h('span', { class: 'row-sub' }, platformLabel(x.platform))))));
  }
  return h('main', { class: 'screen' },
    header('Your computers', { right: btn('signout', 'Sign out', { kind: 'quiet small', disabled: st.busy }) }),
    noticeBar(st.notice),
    freshness(st.hosts.loadedAt, now, st.hosts.error),
    body);
}

function platformLabel(p) {
  if (!p) return 'Plexiform';
  if (/^darwin/.test(p)) return 'Mac';
  if (/^win/.test(p)) return 'Windows';
  if (/^linux/.test(p)) return 'Linux';
  return 'Plexiform';
}

function sessions(st, now) {
  const s = st.sessions;
  const providers = (s.providers ?? []).filter((p) => p.available !== false);
  const list = s.items == null ? null : !s.items.length
    ? h('p', { class: 'empty' }, 'No sessions started from your devices on this computer yet.')
    : h('ul', { class: 'list', role: 'list' }, s.items.map((x) => {
      const last = x.deliveries?.at(-1);
      return h('li', { key: x.session },
        h('button', { type: 'button', class: 'row', 'data-action': 'open-session', 'data-id': x.session, disabled: st.busy || null },
          h('span', { class: 'row-title' }, x.provider?.label ?? 'Session'),
          h('span', { class: 'row-sub' }, `Last known: ${STATUS_LABEL[x.status] ?? 'Unknown'}`),
          last ? h('span', { class: 'row-preview' }, last.text) : null));
    }));
  return h('main', { class: 'screen' },
    header(st.host?.name || 'Computer', { backLabel: 'Back to your computers' }),
    noticeBar(st.notice),
    freshness(s.loadedAt, now, s.error),
    list,
    providers.length ? h('section', { class: 'start', 'aria-label': 'Start a session' },
      providers.map((p) => btn('launch', `Start a ${p.label ?? p.provider} session`, { id: p.provider, disabled: st.busy }))) : null);
}

function delivery(d) {
  const reply = d.response
    ? h('p', { class: 'reply-text' }, d.response)
    : ['acknowledged', 'recorded', 'responding', 'sending'].includes(d.state) ? h('p', { class: 'muted' }, 'Waiting for a reply…') : null;
  return h('li', { key: d.id, class: 'turn' },
    h('div', { class: 'bubble mine' },
      h('p', { class: 'msg-text' }, d.text),
      h('p', { class: 'meta' }, `${d.mode === 'steer' ? 'Steer · ' : ''}${DELIVERY_LABEL[d.state] ?? d.state}`)),
    reply || d.error || d.notices?.length ? h('div', { class: 'bubble theirs' },
      reply,
      d.error ? h('p', { class: 'err-text' }, d.error) : null,
      (d.notices ?? []).map((n) => h('p', { class: 'notice-text' }, n))) : null);
}

function session(st, now, ui) {
  const sess = st.session;
  const v = sessionView(sess, now);
  const s = sess.state;
  const pillTone = v.ended ? 'ended' : !v.live ? 'stale' : v.status;
  return h('main', { class: 'screen session' },
    header(s.provider?.label ?? 'Session', { backLabel: 'Back to sessions' }),
    h('div', { class: 'status-row', role: 'status', 'aria-live': 'polite' },
      h('span', { class: `pill ${pillTone}` }, v.label),
      v.detail ? h('span', { class: 'muted small' }, v.detail) : null),
    !v.live && !v.ended ? h('p', { class: 'stale-note' }, sess.error ?? 'Not connected to your computer. What you see may be out of date.') : null,
    noticeBar(st.notice),
    h('ol', { class: 'log', role: 'log', 'aria-label': 'Conversation', 'aria-live': 'polite' },
      s.deliveries.length ? s.deliveries.map(delivery) : h('li', { class: 'muted' }, 'No messages yet.')),
    v.ended ? h('div', { class: 'ended' },
      h('p', null, 'This session has ended.'),
      btn('close', ui.confirmClose ? 'Tap again to remove it' : 'Remove session', { kind: 'danger', disabled: !!sess.pending }))
      : h('form', { class: 'composer', 'data-form': 'send' },
        h('label', { for: 'message', class: 'sr-only' }, v.canSteer ? 'Steer the running turn' : 'Message'),
        h('textarea', { id: 'message', name: 'text', rows: '3', maxlength: String(MAX_TEXT), placeholder: v.canSteer ? 'Steer the running turn…' : 'Message…', disabled: !v.canSend || null }),
        h('div', { class: 'actions' },
          h('button', { type: 'submit', class: 'btn primary', disabled: !v.canSend || null }, sess.pending ? 'Sending…' : v.canSteer ? 'Steer' : 'Send'),
          v.working ? btn('interrupt', 'Interrupt', { disabled: !v.canInterrupt }) : null,
          btn('close', ui.confirmClose ? 'Tap again to close' : 'Close session', { kind: 'danger quiet', disabled: !v.live || !!sess.pending }))));
}

export function phoneView(st, now, ui = { confirmClose: false }) {
  if (st.view === 'boot') return h('main', { class: 'screen' }, h('p', { class: 'muted' }, 'Loading…'));
  if (st.view === 'signin') return signin(st);
  if (st.view === 'hosts') return hosts(st, now);
  if (st.view === 'sessions') return sessions(st, now);
  if (st.view === 'session' && st.session) return session(st, now, ui);
  return h('main', { class: 'screen' }, h('p', null, 'Something went wrong. Reload the page.'));
}
