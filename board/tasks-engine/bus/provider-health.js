// Provider health for the agent bus (BACKBONE plan G4): one circuit breaker per provider, so a hand-off to an AI
// that is out of quota, signed out or not installed is refused at once with PROVIDER_UNAVAILABLE and retry_at,
// instead of sitting offered until it fails. Shapes and cooldowns are src/bus-contract.js's. Kept in bus.db's
// state (survives a restart), never holds a CLI's text: only a reason code and times.
import { createRequire } from 'node:module';

const C = createRequire(import.meta.url)('../../../src/bus-contract.js');
const STATE_KEY = 'provider_health';
const MAX_RETRY_MS = 14 * 24 * 60 * 60 * 1000;
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';

/**
 * When a provider says it can be used again, from its own message ("try again at Nov 12th, 2026 7:42 PM",
 * "try again in 3 hours", "resets at 2026-11-12T19:42:00Z"), or null. Bounded to the next 14 days.
 */
export function parseRetryAt(text, now) {
  const t = String(text ?? '').slice(0, 2000);
  const rel = /(?:try again|retry|resets?)\s+in\s+(\d{1,4})\s*(second|sec|minute|min|hour|hr|day)s?/i.exec(t);
  if (rel) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2][0].toLowerCase()];
    return now + Number(rel[1]) * unit;
  }
  const abs = /(?:try again|retry|resets?|available)\s+(?:at|after|on)\s+([^.;\n]{4,60})/i.exec(t);
  if (!abs) return null;
  let s = abs[1].trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/\s+at\s+/i, ' ');
  if (!new RegExp(`\\d{4}|${MONTHS}`, 'i').test(s) && /^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(s)) {
    // A time only: today, or tomorrow if that time has passed.
    const d = new Date(now);
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
    let h = Number(m[1]) % 12 + (m[3] && m[3].toLowerCase() === 'pm' ? 12 : 0);
    if (!m[3]) h = Number(m[1]);
    d.setHours(h, Number(m[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    s = d.toISOString();
  }
  const at = Date.parse(s.replace(/(\d)\s*(am|pm)\b/i, '$1 $2'));
  return Number.isFinite(at) && at > now && at - now <= MAX_RETRY_MS ? at : null;
}

/**
 * What a failed start or run says about its provider: a breaker reason, or null (the task's own fault).
 * failKind is shared/failure.js's (limit, auth, provider, network, error); code is a createTask error code;
 * parkReason is the engine's park (limit, auth; user is the person's own pause, never the provider's).
 */
export function reasonOf({ failKind = null, code = null, parkReason = null } = {}) {
  if (code === 'AI_UNAVAILABLE') return C.BREAKER_REASON.MISSING;
  // The engine parks a run that hit its usage limit or was signed out (parkReason) and leaves failKind null.
  if (parkReason === 'limit') return C.BREAKER_REASON.QUOTA;
  if (parkReason === 'auth') return C.BREAKER_REASON.AUTH;
  if (failKind === 'limit') return C.BREAKER_REASON.QUOTA;
  if (failKind === 'auth') return C.BREAKER_REASON.AUTH;
  if (failKind === 'provider' || failKind === 'network') return C.BREAKER_REASON.CRASH;
  return null;
}

/** log: openBusLog() (state/setState); now(): ms. */
export function createProviderHealth({ log, now = Date.now, onChange = () => {} }) {
  const load = () => {
    const raw = log.state(STATE_KEY, {});
    const out = {};
    for (const p of C.PROVIDERS) {
      const h = raw && typeof raw === 'object' && raw[p] && typeof raw[p] === 'object' ? raw[p] : {};
      out[p] = C.providerHealth(p, {
        state: Object.values(C.BREAKER_STATE).includes(h.state) ? h.state : C.BREAKER_STATE.CLOSED,
        reason: Object.values(C.BREAKER_REASON).includes(h.reason) ? h.reason : null,
        retry_at: Number.isFinite(h.retry_at) ? h.retry_at : null,
        since: Number.isFinite(h.since) ? h.since : 0,
        failures: Number.isInteger(h.failures) && h.failures >= 0 ? Math.min(h.failures, 1000) : 0,
      });
    }
    return out;
  };
  const health = load();
  const save = (p, prev) => {
    log.setState(STATE_KEY, health);
    if (prev.state !== health[p].state) onChange({ ...health[p] });
  };

  // Open breakers whose retry time has come are half open: runs start again, and the next provider failure re-opens
  // it at once (no CRASH count). Not limited to one probe: the dispatcher's cursor never revisits an offer it passed.
  function get(p) {
    const h = health[p];
    if (!h) return null;
    if (h.state === C.BREAKER_STATE.OPEN && h.retry_at != null && h.retry_at <= now()) return { ...h, state: C.BREAKER_STATE.HALF_OPEN };
    return { ...h };
  }
  /** Whether a new run may start on p now. */
  function admits(p) {
    const h = get(p);
    return !!h && h.state !== C.BREAKER_STATE.OPEN;
  }

  // retryAt: the provider's own reset time when the run reported one (a limit park's limitResetAt), else parsed from text.
  function failed(p, reason, { text = null, retryAt = null } = {}) {
    if (!health[p] || !reason) return get(p);
    const prev = { ...health[p] };
    const failures = prev.failures + 1;
    const opens = reason !== C.BREAKER_REASON.CRASH || failures >= C.CRASH_THRESHOLD || prev.state !== C.BREAKER_STATE.CLOSED;
    if (!opens) { health[p] = { ...prev, failures, reason }; save(p, prev); return get(p); }
    const t = now();
    const known = Number.isFinite(retryAt) && retryAt > t && retryAt - t <= MAX_RETRY_MS ? retryAt : null;
    const said = reason === C.BREAKER_REASON.QUOTA ? known ?? parseRetryAt(text, t) : null;
    health[p] = C.providerHealth(p, { state: C.BREAKER_STATE.OPEN, reason, retry_at: said ?? t + C.BREAKER_COOLDOWN_MS[reason], since: t, failures });
    save(p, prev);
    return get(p);
  }
  function succeeded(p) {
    if (!health[p]) return;
    const prev = { ...health[p] };
    if (prev.state === C.BREAKER_STATE.CLOSED && prev.failures === 0) return;
    health[p] = C.providerHealth(p, { since: now() });
    save(p, prev);
  }
  /** The person or a test resets a provider (Preferences "try again now"). */
  function reset(p) { if (health[p]) { const prev = { ...health[p] }; health[p] = C.providerHealth(p, { since: now() }); save(p, prev); } }

  /**
   * The provider a hand-off goes to. want: a provider name, 'any', or a list (in the caller's order).
   * order: the person's fallback order; fallback: whether 'any' and lists may move past an unavailable one.
   * Returns {provider, rest} (rest: the providers still to try if this one fails for a provider reason) or
   * {unavailable: {provider, retry_at, reason}} for the earliest-recovering candidate.
   */
  function choose(want, { order = C.DEFAULT_FALLBACK, fallback = true } = {}) {
    const recv = new Set(C.RECEIVE_PROVIDERS);
    // A list is the caller's order over the person's: an AI the person left out of the fallback order is never in it
    // (security review #5). A single named provider is the caller's explicit pick, as before.
    const allowed = new Set(Array.isArray(order) ? order : []);
    const list = (Array.isArray(want) ? want.filter((p) => allowed.has(p)) : want === C.ANY_PROVIDER || want == null ? order : [want]).filter((p, i, a) => recv.has(p) && a.indexOf(p) === i);
    const candidates = fallback || (!Array.isArray(want) && want !== C.ANY_PROVIDER && want != null) ? list : list.slice(0, 1);
    for (let i = 0; i < candidates.length; i += 1) {
      if (admits(candidates[i])) return { provider: candidates[i], rest: candidates.slice(i + 1) };
    }
    if (!candidates.length) return { unavailable: { provider: Array.isArray(want) ? want[0] ?? null : want ?? null, retry_at: null, reason: null } };
    const soonest = candidates.map(get).sort((a, b) => (a.retry_at ?? Infinity) - (b.retry_at ?? Infinity))[0];
    return { unavailable: { provider: soonest.provider, retry_at: soonest.retry_at, reason: soonest.reason } };
  }

  return { get, all: () => C.PROVIDERS.map(get), admits, failed, succeeded, reset, choose };
}
