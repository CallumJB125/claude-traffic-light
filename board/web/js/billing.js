// /billing: your plan (Plus) and the teams you run (Team seats), with
// Subscribe and Manage billing. Payment happens on the provider's hosted
// pages: this page only follows the {url} the hub hands back, and never sees
// or asks for card details.
import { h, render } from './h.js';
import { api, setCsrf } from './api.js';

const PRICE = { 'plus:month': '$5 / month', 'plus:year': '$48 / year', 'team:month': '$15 / seat / month', 'team:year': 'per seat / year' };
const STATUS = { active: 'Active', trialing: 'Trial', past_due: 'Payment failed: retrying', unpaid: 'Unpaid', canceled: 'Cancelled', incomplete: 'Waiting for payment', incomplete_expired: 'Payment not completed', paused: 'Paused' };

const date = (s) => (s ? new Date(s * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null);
const btn = (label, action, extra = {}, primary = false) => h('button', { type: 'button', class: primary ? 'btn btn-primary' : 'btn', 'data-action': action, ...extra }, label);

/** One subscription's facts, in words. */
function facts(v) {
  if (!v.status) return h('p', { class: 'client-lead' }, 'Free plan.');
  const end = date(v.access_until ?? v.period_end);
  const lines = [h('p', {}, `${STATUS[v.status] ?? v.status}${v.interval ? `, billed every ${v.interval}` : ''}.`)];
  if (v.plan === 'free') lines.push(h('p', {}, end ? `Ended ${end}. Your data is kept.` : 'Not active.'));
  else if (v.cancel_at_period_end || v.status === 'canceled') lines.push(h('p', {}, `Cancelled: you keep ${v.subscribed_plan === 'team' ? 'Team' : 'Plus'} until ${end}.`));
  else if (v.status === 'past_due' || v.status === 'unpaid') lines.push(h('p', { role: 'alert' }, `The last payment failed. Access continues until ${end}; update your card in Manage billing.`));
  else if (end) lines.push(h('p', {}, `Renews ${end}.`));
  return lines;
}

/** Pure: the page for a GET /api/billing answer (tests render it without a DOM). */
export function billingView(state) {
  const s = state.summary;
  if (state.signedOut) return h('div', {}, h('h1', {}, 'Billing'), h('p', {}, 'Sign in to see your plan.'), h('a', { href: '/signin', class: 'btn btn-primary' }, 'Sign in'));
  if (!s) return h('p', { role: 'status' }, state.error ?? 'Loading your plan…');
  const plus = s.plus;
  return h('div', {},
    h('header', { class: 'client-heading' }, h('h1', {}, 'Billing'), h('a', { href: '/', class: 'btn' }, 'Team board')),
    h('p', { class: 'client-lead' }, 'Payments are handled by our payment provider on its own pages. Plexiform never sees or stores your card details.'),
    state.notice ? h('p', { role: 'status' }, state.notice) : null,
    state.error ? h('p', { role: 'alert', class: 'client-error' }, state.error) : null,
    !s.configured ? h('p', { role: 'status' }, 'Paid plans are not available on this hub.') : null,
    h('section', { class: 'client-section', 'data-section': 'plus' },
      h('h2', {}, `Your plan: ${s.effective_plan === 'team' ? 'Team' : s.effective_plan === 'plus' ? 'Plus' : 'Free'}`),
      facts(plus),
      plus.manageable ? btn('Manage billing', 'portal', { disabled: state.busy || !s.configured }) : null,
      s.configured && plus.plan === 'free' ? h('div', { class: 'client-actions' },
        s.prices['plus:month'] ? btn(`Get Plus · ${PRICE['plus:month']}`, 'plus', { 'data-interval': 'month', disabled: state.busy }, true) : null,
        s.prices['plus:year'] ? btn(`Get Plus · ${PRICE['plus:year']}`, 'plus', { 'data-interval': 'year', disabled: state.busy }) : null) : null),
    s.teams.map((t) => h('section', { class: 'client-section', key: t.team.id, 'data-team': t.team.id },
      h('h2', {}, `${t.team.name}: ${t.plan === 'team' ? 'Team' : 'Free'}`),
      h('p', {}, t.status ? `${t.seats_used} of ${t.seats} paid seats used.` : `${t.seats_used} members.`),
      facts(t),
      t.manageable && t.team.role === 'owner' ? btn('Manage billing', 'team-portal', { 'data-team': t.team.id, disabled: state.busy || !s.configured }) : null,
      s.configured && t.plan === 'free' && t.team.role === 'owner' && s.prices['team:month']
        ? h('form', { class: 'client-form', 'data-form': 'team', 'data-team': t.team.id },
          h('label', {}, 'Seats', h('input', { class: 'input', name: 'seats', type: 'number', min: Math.max(1, t.seats_used), max: 1000, value: Math.max(1, t.seats_used), required: true })),
          h('button', { type: 'submit', class: 'btn btn-primary', disabled: state.busy }, `Get Team · ${PRICE['team:month']}`))
        : t.team.role !== 'owner' ? h('p', { class: 'client-lead' }, 'Only the team owner can change its plan.') : null)),
  );
}

const root = typeof document !== 'undefined' ? document.getElementById('billing') : null;
if (root) {
  const state = { summary: null, error: null, notice: null, busy: false, signedOut: false };
  const draw = () => render(root, billingView(state));
  const q = new URL(location.href).searchParams.get('checkout');
  if (q === 'done') state.notice = 'Thanks! Your plan updates as soon as the payment provider confirms it.';
  if (q === 'cancelled') state.notice = 'Checkout cancelled: nothing was charged.';
  const load = async () => {
    try {
      const me = await api.me();
      setCsrf(me.csrf_token);
      state.summary = await api.billing();
      state.error = null;
    } catch (e) {
      if (e.status === 401) state.signedOut = true;
      else state.error = e.message;
    }
    draw();
  };
  // The hub answers {url} on the provider's own https origin; the page goes there and comes back to /billing.
  const go = async (fn) => {
    state.busy = true; state.error = null; draw();
    try { const r = await fn(); if (typeof r?.url === 'string' && r.url.startsWith('https://')) { location.assign(r.url); return; } state.error = 'The payment provider did not answer. Try again.'; } catch (e) { state.error = e.message; }
    state.busy = false; draw();
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b || b.disabled) return;
    if (b.dataset.action === 'plus') go(() => api.billingCheckout(b.dataset.interval));
    if (b.dataset.action === 'portal') go(() => api.billingPortal());
    if (b.dataset.action === 'team-portal') go(() => api.teamPortal(b.dataset.team));
  });
  root.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-form="team"]');
    if (!f) return;
    e.preventDefault();
    go(() => api.teamCheckout(f.dataset.team, Number(new FormData(f).get('seats')), 'month'));
  });
  draw();
  load();
}
