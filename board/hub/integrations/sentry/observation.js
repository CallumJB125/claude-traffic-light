// Private server capability, never a JSON option or a connector-supplied callback.
import { HubError } from '../../db.js';
const contexts = new WeakMap();
const STATES = Object.freeze({ issue: ['unresolved', 'regressed', 'resolved', 'ignored'], alert: ['critical', 'warning', 'resolved'] });
const ACTIONS = Object.freeze({ issue: 'sentry.status', alert: 'sentry.incident-status' });
const ID = /^\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const observationAction = kind => Object.hasOwn(ACTIONS, kind) ? ACTIONS[kind] : null;
export function validObservation(v) {
  return v?.provider === 'sentry' && Object.hasOwn(STATES, v.kind) && v.action === ACTIONS[v.kind]
    && STATES[v.kind].includes(v.state) && typeof v.external_id === 'string' && ID.test(v.external_id)
    && typeof v.request_id === 'string' && v.request_id.startsWith(`sentry-${v.kind}-status-${v.external_id}-`)
    && /^[0-9a-f]{64}$/.test(v.request_id.slice(`sentry-${v.kind}-status-${v.external_id}-`.length))
    && ['connection_id', 'member_id', 'card_id'].every(k => typeof v[k] === 'string' && UUID.test(v[k]))
    && (v.user_id === null || (typeof v.user_id === 'string' && UUID.test(v.user_id)));
}
export function createObservation(fields) {
  if (!validObservation(fields)) throw new HubError('VALIDATION', 'invalid Sentry observation');
  const token = Object.freeze({});
  const { provider, action, kind, state, external_id, connection_id, member_id, user_id, card_id, request_id } = fields;
  contexts.set(token, Object.freeze({ provider, action, kind, state, external_id, connection_id, member_id, user_id, card_id, request_id }));
  return token;
}
export const observationContext = token => token != null && (typeof token === 'object' || typeof token === 'function') ? contexts.get(token) ?? null : null;
export function sentryStatus(v, kind) {
  const out = {};
  if (!Object.hasOwn(STATES, kind) || v === null || typeof v !== 'object' || Array.isArray(v)) return out;
  if (Object.hasOwn(v, 'sentry_state') && STATES[kind].includes(v.sentry_state)) out.sentry_state = v.sentry_state;
  if (typeof v.hub_observed_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.hub_observed_at) && Number.isFinite(Date.parse(v.hub_observed_at))) out.hub_observed_at = v.hub_observed_at;
  if (typeof v.sentry_comment_id === 'string' && UUID.test(v.sentry_comment_id)) out.sentry_comment_id = v.sentry_comment_id;
  return out;
}
