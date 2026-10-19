// Stripe, behind the hub's billing-provider interface. The rest of the hub
// never sees a Stripe object: it asks a provider for a hosted Checkout or
// customer-portal URL and hands it webhook deliveries, which come back as
// provider-neutral events. A Merchant of Record (Paddle, Lemon Squeezy) is a
// second file exporting the same shape, registered in entitlements.js
// PROVIDERS; nothing else changes.
//
// Provider interface:
//   name                                     'stripe'
//   checkout({price, quantity, subject, plan, interval, customer, email, successUrl, cancelUrl, idempotencyKey})
//                                            → Promise<{url}>   (hosted page: card data never touches the hub)
//   portal({customer, returnUrl})            → Promise<{url}>
//   verify(headers, rawBody, nowSec)         → the parsed event, or throws WebhookInvalid
//   normalize(event)                         → NormalizedEvent | null (null: not a billing event we act on)
//
// NormalizedEvent: {id, type, created (unix s), kind: 'checkout'|'subscription'|'invoice_paid'|'payment_failed',
//   subject: {type:'user'|'org', id}|null, customer, subscription, plan?, interval?, seats?,
//   status?, periodEnd?, cancelAtPeriodEnd?, paidThrough?}
// Only ids, plan, seats, status and period times are read from a payload;
// payment-method details in it are never looked at, kept or logged.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { HubError } from '../db.js';

export const STRIPE_API = 'https://api.stripe.com';
export const SIGNATURE_TOLERANCE_S = 300;
const ID_RE = /^[A-Za-z0-9_-]{1,255}$/;
const STATUSES = new Set(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused']);
const SUBJECTS = new Set(['user', 'org']);
const PLANS = new Set(['plus', 'team']);
const INTERVALS = new Set(['month', 'year']);

export class WebhookInvalid extends Error {
  constructor() { super('invalid webhook signature'); this.name = 'WebhookInvalid'; }
}

const id = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : typeof v?.id === 'string' && ID_RE.test(v.id) ? v.id : null);
const secs = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function subjectOf(meta) {
  const m = obj(meta);
  return SUBJECTS.has(m.subject_type) && typeof m.subject_id === 'string' && ID_RE.test(m.subject_id) ? { type: m.subject_type, id: m.subject_id } : null;
}

// Stripe's form encoding: nested keys as a[b][c]=v.
function form(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

/**
 * @param {{apiKey: string, webhookSecret: string, prices: object, fetchImpl: Function, api?: string}} opts
 * prices: {'plus:month': 'price_…', 'plus:year': …, 'team:month': …} → reverse-mapped for events.
 */
export function createStripeProvider({ apiKey, webhookSecret, prices = {}, fetchImpl, api = STRIPE_API }) {
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('stripe: an API key is required');
  if (typeof webhookSecret !== 'string' || !webhookSecret) throw new Error('stripe: a webhook secret is required');
  const byPrice = new Map(Object.entries(prices).filter(([, p]) => typeof p === 'string' && p).map(([k, p]) => [p, k.split(':')]));

  async function post(path, params, idempotencyKey) {
    let res;
    try {
      res = await fetchImpl(`${api}${path}`, { // privacy-flow: hub-billing
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
        body: form(params).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HubError('PROVIDER_UNAVAILABLE', 'the payment provider could not be reached; try again');
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    // Never the provider's error text: it may echo request details.
    if (!res.ok) throw new HubError('PROVIDER_ERROR', 'the payment provider refused the request');
    const url = typeof body?.url === 'string' && body.url.startsWith('https://') ? body.url : null;
    if (!url) throw new HubError('PROVIDER_ERROR', 'the payment provider sent an unusable answer');
    return { url };
  }

  function planOf(item, meta) {
    const fromPrice = byPrice.get(id(item?.price));
    if (fromPrice && PLANS.has(fromPrice[0])) return { plan: fromPrice[0], interval: INTERVALS.has(fromPrice[1]) ? fromPrice[1] : null };
    const m = obj(meta);
    return PLANS.has(m.plan) ? { plan: m.plan, interval: INTERVALS.has(m.interval) ? m.interval : null } : { plan: null, interval: null };
  }

  return {
    name: 'stripe',

    checkout({ price, quantity, subject, plan, interval, customer, email, successUrl, cancelUrl, idempotencyKey }) {
      const metadata = { subject_type: subject.type, subject_id: subject.id, plan, interval };
      return post('/v1/checkout/sessions', {
        mode: 'subscription',
        line_items: { 0: { price, quantity } },
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: `${subject.type}:${subject.id}`,
        ...(customer ? { customer } : email ? { customer_email: email } : {}),
        metadata,
        subscription_data: { metadata },
      }, idempotencyKey);
    },

    portal({ customer, returnUrl }) {
      return post('/v1/billing_portal/sessions', { customer, return_url: returnUrl });
    },

    // Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">[,v1=…]
    verify(headers, rawBody, nowSec) {
      const header = headers['stripe-signature'];
      if (typeof header !== 'string' || header.length > 2048 || !Buffer.isBuffer(rawBody)) throw new WebhookInvalid();
      let t = null;
      const sigs = [];
      for (const part of header.split(',')) {
        const [k, v] = part.split('=', 2).map((x) => x?.trim());
        if (k === 't' && /^\d{1,12}$/.test(v ?? '')) t = Number(v);
        else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v ?? '')) sigs.push(Buffer.from(v, 'hex'));
      }
      if (t == null || !sigs.length || Math.abs(nowSec - t) > SIGNATURE_TOLERANCE_S) throw new WebhookInvalid();
      const want = createHmac('sha256', webhookSecret).update(`${t}.`).update(rawBody).digest();
      if (!sigs.some((s) => timingSafeEqual(s, want))) throw new WebhookInvalid();
      let event;
      try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookInvalid(); }
      if (!event || typeof event !== 'object' || !id(event.id) || typeof event.type !== 'string') throw new WebhookInvalid();
      return event;
    },

    normalize(event) {
      const o = obj(event?.data?.object);
      const base = { id: event.id, type: event.type, created: secs(event.created) ?? 0, customer: id(o.customer) };
      switch (event.type) {
        case 'checkout.session.completed': {
          if (o.mode !== 'subscription') return null;
          const m = obj(o.metadata);
          return { ...base, kind: 'checkout', subscription: id(o.subscription), subject: subjectOf(m),
            plan: PLANS.has(m.plan) ? m.plan : null, interval: INTERVALS.has(m.interval) ? m.interval : null };
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const item = obj(o.items?.data?.[0]);
          const { plan, interval } = planOf(item, o.metadata);
          const status = event.type === 'customer.subscription.deleted' ? 'canceled' : STATUSES.has(o.status) ? o.status : null;
          if (!status) return null;
          return { ...base, kind: 'subscription', subscription: id(o.id), subject: subjectOf(o.metadata), plan, interval,
            seats: Number.isSafeInteger(item.quantity) && item.quantity >= 1 ? item.quantity : null,
            status, periodEnd: secs(o.current_period_end) ?? secs(item.current_period_end), cancelAtPeriodEnd: o.cancel_at_period_end === true };
        }
        case 'invoice.paid':
        case 'invoice.payment_failed': {
          // The subscription and its metadata moved under parent.subscription_details in newer API versions.
          const details = obj(o.parent?.subscription_details ?? o.subscription_details);
          const subscription = id(o.subscription) ?? id(details.subscription);
          if (!subscription) return null;
          const ends = (Array.isArray(o.lines?.data) ? o.lines.data : []).map((l) => secs(l?.period?.end)).filter(Boolean);
          return { ...base, kind: event.type === 'invoice.paid' ? 'invoice_paid' : 'payment_failed', subscription, subject: subjectOf(details.metadata),
            paidThrough: ends.length ? Math.max(...ends) : secs(o.period_end) };
        }
        default:
          return null;
      }
    },
  };
}
