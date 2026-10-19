// Paid plans on the hub (W3-A): who is entitled to what, Team seat limits,
// hosted Checkout / portal hand-off, and the signed entitlement token the
// desktop app verifies offline (src/entitlements.js).
//
// Token: a compact JWT, EdDSA (Ed25519), claims {sub, plan, iat, exp,
// period_end}; exp = period_end + 14 days of offline grace. The private key is
// read from BOARD_ENTITLEMENT_KEY_FILE (made by scripts/gen-entitlement-key.mjs,
// whose public half is pinned in the app's src/entitlement-keys.js).
//
// Access: a subscription grants its plan until its access end — the current
// period's end while active/trialing; otherwise the end of the last paid
// period (dunning: a failed renewal is not paid for), falling back to the
// period end for a cancellation. Cancelling therefore keeps access to the end
// of the period already paid for. Hub-side, a team with a live Team plan is
// 'pro' (×10 quotas) and its member count is capped by its paid seats.

import { createPrivateKey, randomUUID, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HubError } from '../db.js';
import { quotaFor } from '../identity/teams.js';
import { createStripeProvider } from './stripe.js';

export const GRACE_S = 14 * 86_400;
export const SEATS_MAX = 1000;
// Merchant-of-Record providers register here with the same interface (stripe.js header).
export const PROVIDERS = Object.freeze({ stripe: createStripeProvider });
const RANK = Object.freeze({ free: 0, plus: 1, team: 2 });
const LIVE = new Set(['active', 'trialing']);
const PRICE_KEYS = Object.freeze(['plus:month', 'plus:year', 'team:month', 'team:year']);

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** Unix seconds until which a row grants its plan (0 = none). */
export function accessUntil(row) {
  if (!row) return 0;
  if (LIVE.has(row.status)) return row.current_period_end ?? row.paid_through ?? 0;
  if (row.paid_through) return row.paid_through;
  return row.status === 'canceled' ? row.current_period_end ?? 0 : 0;
}

/** Sign {sub, plan, iat, exp, period_end} as an EdDSA compact JWT. */
export function signEntitlement(privateKey, claims) {
  const head = b64url({ alg: 'EdDSA', typ: 'JWT' });
  const body = b64url(claims);
  return `${head}.${body}.${cryptoSign(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}

export function loadSigningKey(file) {
  if (!file) return null;
  const key = createPrivateKey(readFileSync(file, 'utf8'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('BOARD_ENTITLEMENT_KEY_FILE must hold an Ed25519 private key');
  return key;
}

export class Billing {
  /**
   * @param hub   the Hub (db, config, clock, teams)
   * @param opts  {provider?: a provider object (tests), fetchImpl, signingKey?: KeyObject}
   */
  constructor(hub, { provider = null, fetchImpl, signingKey } = {}) {
    this.hub = hub;
    this.db = hub.db;
    const c = hub.config;
    this.prices = Object.fromEntries(PRICE_KEYS.map((k) => [k, c.billingPrices?.[k] ?? null]));
    this.provider = provider ?? (c.billingProvider && PROVIDERS[c.billingProvider]
      ? PROVIDERS[c.billingProvider]({ apiKey: c.billingApiKey, webhookSecret: c.billingWebhookSecret, prices: this.prices, fetchImpl })
      : null);
    this.signingKey = signingKey !== undefined ? signingKey : loadSigningKey(c.entitlementKeyFile);
  }

  get configured() { return !!this.provider && !!this.hub.config.publicUrl; }
  nowS() { return Math.floor(this.hub.wallMs() / 1000); }

  requireConfigured() {
    if (!this.configured) throw new HubError('METHOD_DISABLED', 'billing is not set up on this hub');
  }

  row(type, id) { return this.db.get('SELECT * FROM entitlements WHERE subject_type = ? AND subject_id = ?', type, id); }
  live(row) { return accessUntil(row) > this.nowS(); }

  /** Members a team may have: its paid seats while Team is live, otherwise the plan quota. */
  memberLimit(org) {
    const row = this.row('org', org.id);
    return row && this.live(row) ? row.seats : quotaFor(org.plan, 'members');
  }

  /** Teams whose Team plan started or lapsed: orgs.plan follows (never touches self_hosted). */
  syncOrgPlans() {
    for (const r of this.db.all("SELECT * FROM entitlements WHERE subject_type = 'org'")) {
      const want = this.live(r) ? 'pro' : 'free';
      this.db.run("UPDATE orgs SET plan = ? WHERE id = ? AND plan IN ('free','pro') AND plan <> ?", want, r.subject_id, want);
    }
  }

  /** The best live entitlement for a user: their own Plus, or a Team plan of a team they are in. */
  effective(userId) {
    const rows = [
      this.row('user', userId),
      ...this.db.all(`SELECT e.* FROM entitlements e JOIN members m ON m.org_id = e.subject_id JOIN orgs o ON o.id = m.org_id
        WHERE e.subject_type = 'org' AND m.user_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL`, userId),
    ].filter((r) => r && this.live(r));
    rows.sort((a, b) => RANK[b.plan] - RANK[a.plan] || accessUntil(b) - accessUntil(a));
    return rows[0] ?? null;
  }

  /** GET /api/entitlement → {plan:'free', token:null} | {plan, period_end, expires_at, token}. */
  token(ident) {
    if (!this.signingKey) throw new HubError('METHOD_DISABLED', 'entitlements are not set up on this hub');
    this.syncOrgPlans();
    const row = this.effective(ident.user.id);
    if (!row) return { plan: 'free', token: null };
    const iat = this.nowS();
    const periodEnd = accessUntil(row);
    const claims = { sub: ident.user.id, plan: row.plan, iat, exp: periodEnd + GRACE_S, period_end: periodEnd };
    return { plan: row.plan, period_end: periodEnd, expires_at: claims.exp, token: signEntitlement(this.signingKey, claims) };
  }

  view(row, extra = {}) {
    if (!row) return { plan: 'free', ...extra };
    const until = accessUntil(row);
    return {
      plan: this.live(row) ? row.plan : 'free', subscribed_plan: row.plan, interval: row.interval, seats: row.seats, status: row.status,
      period_end: row.current_period_end, access_until: until || null, cancel_at_period_end: !!row.cancel_at_period_end,
      manageable: !!row.provider_customer, ...extra,
    };
  }

  /** GET /api/billing: the caller's own plan and the teams they run. */
  summary(ident) {
    this.syncOrgPlans();
    const teams = this.db.all(`SELECT o.id, o.name, o.plan AS team_plan, m.role FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL AND m.role IN ('owner','admin') ORDER BY o.name, o.id`, ident.user.id);
    return {
      configured: this.configured,
      prices: Object.fromEntries(PRICE_KEYS.map((k) => [k, !!this.prices[k]])),
      effective_plan: this.effective(ident.user.id)?.plan ?? 'free',
      plus: this.view(this.row('user', ident.user.id)),
      teams: teams.map((t) => this.teamView(t)),
    };
  }

  teamView(org) {
    return this.view(this.row('org', org.id), { team: { id: org.id, name: org.name, role: org.role }, seats_used: this.hub.teams.activeSeats(org.id) });
  }

  /** GET /api/teams/:team_id/billing (owners and admins). */
  team(member) {
    if (!['owner', 'admin'].includes(member.role)) throw new HubError('FORBIDDEN', 'only team owners and admins see billing');
    this.syncOrgPlans();
    const org = this.hub.teams.org(member.org_id);
    return this.teamView({ ...org, role: member.role });
  }

  base() { return this.hub.config.publicUrl.replace(/\/+$/, ''); }

  price(plan, interval) {
    const p = this.prices[`${plan}:${interval}`];
    if (!p) throw new HubError('VALIDATION', `no ${plan} price for interval '${interval}' on this hub`);
    return p;
  }

  async checkout({ subject, plan, interval, seats, email, idempotencyKey }) {
    const row = this.row(subject.type, subject.id);
    if (row && this.live(row)) throw new HubError('CONFLICT', 'already subscribed: use Manage billing to change the plan');
    return this.provider.checkout({
      price: this.price(plan, interval), quantity: seats, subject, plan, interval,
      customer: row?.provider === this.provider.name ? row.provider_customer : null, email,
      successUrl: `${this.base()}/billing?checkout=done`, cancelUrl: `${this.base()}/billing?checkout=cancelled`,
      idempotencyKey,
    });
  }

  /** POST /api/billing/checkout {interval}: Plus for the caller. */
  checkoutPlus(ident, body) {
    this.requireConfigured();
    const interval = body.interval ?? 'month';
    if (!['month', 'year'].includes(interval)) throw new HubError('VALIDATION', "interval must be 'month' or 'year'");
    if (!ident.user.primary_email) throw new HubError('EMAIL_UNVERIFIED', 'a verified email is needed to subscribe');
    return this.checkout({ subject: { type: 'user', id: ident.user.id }, plan: 'plus', interval, seats: 1, email: ident.user.primary_email, idempotencyKey: idem(body) });
  }

  /** POST /api/teams/:team_id/billing/checkout {seats, interval}: Team for a team (owner only). */
  checkoutTeam(member, ident, body) {
    this.requireConfigured();
    if (member.role !== 'owner') throw new HubError('FORBIDDEN', 'only a team owner can change its plan');
    const interval = body.interval ?? 'month';
    if (!['month', 'year'].includes(interval)) throw new HubError('VALIDATION', "interval must be 'month' or 'year'");
    const seats = body.seats;
    if (!Number.isSafeInteger(seats) || seats < 1 || seats > SEATS_MAX) throw new HubError('VALIDATION', `seats must be a whole number from 1 to ${SEATS_MAX}`);
    const used = this.hub.teams.activeSeats(member.org_id);
    if (seats < used) throw new HubError('VALIDATION', `this team already has ${used} members: buy at least ${used} seats`, { seats_used: used });
    return this.checkout({ subject: { type: 'org', id: member.org_id }, plan: 'team', interval, seats, email: ident.user.primary_email ?? null, idempotencyKey: idem(body) });
  }

  async portalFor(row) {
    this.requireConfigured();
    if (!row?.provider_customer || row.provider !== this.provider.name) throw new HubError('NOT_FOUND', 'no subscription to manage');
    return this.provider.portal({ customer: row.provider_customer, returnUrl: `${this.base()}/billing` });
  }

  portalPlus(ident) { return this.portalFor(this.row('user', ident.user.id)); }

  portalTeam(member) {
    if (member.role !== 'owner') throw new HubError('FORBIDDEN', 'only a team owner can manage its plan');
    return this.portalFor(this.row('org', member.org_id));
  }

  // ── webhook events (webhook.js verifies and de-duplicates; this applies) ──

  /** Apply one normalized provider event inside the caller's transaction. → 'applied' | 'ignored'. */
  apply(evt) {
    const provider = this.provider.name;
    let row = evt.subscription ? this.db.get('SELECT * FROM entitlements WHERE provider = ? AND provider_subscription = ?', provider, evt.subscription) : null;
    if (!row && evt.subject && this.subjectExists(evt.subject)) row = this.row(evt.subject.type, evt.subject.id);
    const now = this.hub.iso();
    if (!row) {
      // A row is born only from an event that names its subject and plan.
      const plan = evt.plan ?? (evt.subject?.type === 'org' ? 'team' : evt.subject?.type === 'user' ? 'plus' : null);
      if (!evt.subject || !this.subjectExists(evt.subject) || !plan || (plan === 'team') !== (evt.subject.type === 'org')) return 'ignored';
      row = { id: randomUUID(), subject_type: evt.subject.type, subject_id: evt.subject.id, plan, interval: evt.interval ?? null, seats: 1,
        status: 'incomplete', cancel_at_period_end: 0, current_period_end: null, paid_through: null, state_at: 0,
        provider, provider_customer: null, provider_subscription: null, created_at: now, updated_at: now };
      this.db.insert('entitlements', row);
    }
    const next = { ...row };
    if (evt.customer) next.provider_customer = evt.customer;
    if (evt.subscription && next.provider_subscription !== evt.subscription) {
      // A new subscription for the same subject (re-subscribing after a lapse) starts its own state.
      if (next.provider_subscription && evt.kind !== 'checkout' && evt.kind !== 'subscription') return 'ignored';
      if (next.provider_subscription) Object.assign(next, { status: 'incomplete', paid_through: null, current_period_end: null, cancel_at_period_end: 0, state_at: 0 });
      next.provider_subscription = evt.subscription;
    }
    const fresh = evt.created >= next.state_at;
    switch (evt.kind) {
      case 'checkout':
        if (evt.interval && !next.interval) next.interval = evt.interval;
        break;
      case 'subscription':
        if (!fresh) break;
        next.status = evt.status;
        if (evt.plan && (evt.plan === 'team') === (next.subject_type === 'org')) next.plan = evt.plan;
        if (evt.interval) next.interval = evt.interval;
        if (evt.seats) next.seats = Math.min(evt.seats, 10_000);
        if (evt.periodEnd) next.current_period_end = evt.periodEnd;
        next.cancel_at_period_end = evt.cancelAtPeriodEnd ? 1 : 0;
        next.state_at = evt.created;
        break;
      case 'invoice_paid':
        if (evt.paidThrough) next.paid_through = Math.max(next.paid_through ?? 0, evt.paidThrough);
        if (evt.paidThrough && !next.current_period_end) next.current_period_end = evt.paidThrough;
        if (fresh && ['incomplete', 'past_due', 'unpaid'].includes(next.status)) { next.status = 'active'; next.state_at = evt.created; }
        break;
      case 'payment_failed':
        if (fresh && LIVE.has(next.status)) { next.status = 'past_due'; next.state_at = evt.created; }
        break;
      default:
        return 'ignored';
    }
    next.updated_at = now;
    const cols = ['plan', 'interval', 'seats', 'status', 'cancel_at_period_end', 'current_period_end', 'paid_through', 'state_at', 'provider_customer', 'provider_subscription', 'updated_at'];
    this.db.run(`UPDATE entitlements SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => next[c]), row.id);
    if (next.subject_type === 'org') this.syncOrgPlans();
    return 'applied';
  }

  subjectExists({ type, id }) {
    return type === 'user'
      ? !!this.db.get('SELECT 1 AS x FROM users WHERE id = ? AND deleted_at IS NULL', id)
      : !!this.db.get('SELECT 1 AS x FROM orgs WHERE id = ? AND deleted_at IS NULL', id);
  }
}

const idem = (body) => (typeof body.request_id === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.request_id) ? `checkout-${body.request_id}` : undefined);
