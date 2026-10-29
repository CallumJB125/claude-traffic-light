'use strict';
// One authority check for a queued follow-up, run again at every dispatch (nothing is cached between ticks).
// Shared by the main-level pump and Overview's review-time check. A team target must still be the same
// signed-in account, a live interact share, the same idle session; owned targets keep the owner-side rule.
const { takeLock } = require('./team-session-controls');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const safe = (fn, fallback) => { try { return fn() ?? fallback; } catch { return fallback; } };
const clean = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, n) : '');
const viewerOf = hub => { const v = safe(() => hub?.viewer?.(), null); return object(v) && typeof v.id === 'string' && v.id ? { id: v.id } : null; };
const MSG = {
  signIn: 'Sign in to continue.',
  signInAgain: 'Sign in again to continue.',
  other: "Signed in as someone else; this follow-up won't be sent.",
  wrongAccount: 'Signed in as someone else. Waiting for the original account.',
  gone: 'The share is no longer available. Nothing will be sent.',
  watch: "The owner changed this share to watch only; this follow-up won't be sent.",
  offline: "The owner's computer is offline. Waiting.",
  ended: 'The original shared session ended or changed. Nothing will be sent.',
  newTurn: 'This connection does not support a new-turn follow-up.',
};
const expired = (at, now) => at !== null && at !== undefined && (!Number.isFinite(Date.parse(at)) || Date.parse(at) <= now());

// t: the stored target. teamHub(): the signed-in hub client or null. local: followupLocal. scope(): the follow-up scope.
// gate(): an extra freshness term from the caller (Overview: focus + route epoch); the pump passes none.
async function resolveFollowup(t, { teamHub, local, scope, gate = () => true, now = Date.now } = {}) {
  const owner = scope();
  const fresh = () => owner !== null && scope() === owner && safe(gate, false) === true;
  if (t.kind === 'owned') return local?.resolve?.(t, fresh) ?? { ok: false, terminal: true, error: 'The original session is no longer held by Plexiform.' };
  const r = t.route, hub = safe(teamHub, null), viewer = viewerOf(hub);
  if (!hub || hub.origin !== r.origin || !viewer) return { ok: false, error: MSG.signIn };
  // Not terminal here: one reading is not proof (an account switch passes through it). The stable two-pass sweep is the only terminal path.
  if (viewer.id !== r.viewer) return { ok: false, error: MSG.wrongAccount };
  const current = () => fresh() && safe(teamHub, null) === hub && viewerOf(hub)?.id === r.viewer;
  let out;
  try { out = await hub.inspect(viewer, r.team, r.ref); } catch { return { ok: false, error: 'The shared session is temporarily unavailable.' }; }
  if (!current()) return { ok: false, error: 'The view or account changed.' };
  if (!out?.ok) {
    if (out?.signIn === true) return { ok: false, error: MSG.signInAgain };
    if (!['stale', 'forbidden', 'unavailable'].includes(out?.status)) return { ok: false, error: clean(out?.error, 400) || 'The original share is unavailable.' };
    // A 404 also means the owner's computer is offline: only the hub's own list says whether the share is gone.
    let entry = null, listed;
    try { listed = await hub.sharedEntries(viewer); } catch { return { ok: false, error: clean(out?.error, 400) || MSG.offline }; }
    if (!current() || listed?.viewerChanged === true) return { ok: false, error: 'The view or account changed.' };
    for (const team of Array.isArray(listed?.teams) ? listed.teams : []) for (const e of Array.isArray(team?.entries) ? team.entries : []) if (e?.ref === r.ref) entry = { ...e, teamId: team.id };
    if (!entry || entry.teamId !== r.team || entry.owner?.id === viewer.id || expired(entry.share?.expiresAt, now)) return { ok: false, terminal: true, error: MSG.gone };
    return { ok: false, error: MSG.offline };
  }
  const share = out.share;
  if (!object(share) || share.scope !== 'interact' || expired(share.expiresAt, now)) return { ok: false, terminal: true, error: MSG.watch };
  const s = out.state;
  if (!s || s.generation !== t.generation || s.provider?.id !== t.provider || s.status === 'ended') return { ok: false, terminal: true, error: MSG.ended };
  if (s.capabilities?.newTurn !== true || typeof hub.act !== 'function') return { ok: false, terminal: true, error: MSG.newTurn };
  // Idle only: a working session keeps the item queued; a queued item never steers or interrupts.
  const idle = s.status === 'ready' && s.activeTurn === null;
  // Nothing is locked here (Overview's review and enqueue call this too). The pump calls acquire() right before the
  // durable marker and releases in its finally, so no other action starts between marker and send; null = waits.
  return {
    ok: true, ready: idle, current, acquire: () => takeLock({ hub, viewer, team: r.team, ref: r.ref }),
    send: (text, id, keep) => hub.act(viewer, r.team, r.ref, { operation: 'send', generation: t.generation, turn: null, text }, id, () => current() && keep()),
  };
}

module.exports = { resolveFollowup, viewerOf, MSG };
