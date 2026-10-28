'use strict';
// T2: the thread document's whole view of a teammate's shared session. A fixed
// projection of one relayed `state` read (team-hub-client inspect) plus the share's
// current terms. Nothing here is a ref, card id, entry id, selection, capability
// or hub object; the renderer sets every string with textContent.
const { capabilitiesOf } = require('./team-session-controls');
const MAX_DELIVERIES = 10; // the newest; the hub client already keeps at most 20
const MAX_TEXT = 4000;
const MAX_RESPONSE = 16000; // the relay's own bound for a response
const STALE_MS = 90_000;
const STATES = Object.freeze(['queued', 'accepted', 'acknowledged', 'echoed', 'responding', 'replied', 'completed', 'interrupted', 'unconfirmed', 'failed', 'unknown']);
const CATEGORIES = Object.freeze(['Thinking', 'Running a command', 'Editing files', 'Reading files', 'Searching', 'Using a tool', 'Coordinating agents']);
const TOP_KEYS = Object.freeze(['header', 'banner', 'activity', 'deliveries', 'status', 'generation', 'canSendLater', 'controls']);
// T3: what the interact layout may offer, as booleans and fixed reasons only. Main checks every one again.
const CONTROL_KEYS = Object.freeze(['send', 'steer', 'interrupt', 'propose']);
const HEADER_KEYS = Object.freeze(['title', 'owner', 'initials', 'provider', 'scope', 'expiresAt', 'fake']);
const DELIVERY_KEYS = Object.freeze(['id', 'by', 'text', 'state', 'response', 'at']);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const prose = (v, max) => (typeof v === 'string' ? v.replace(CONTROL, '').slice(0, max) : '');
const line = (v, max) => prose(v, max).replace(/\s+/g, ' ').trim();
const initialsOf = (name) => { const w = line(name, 80).split(' ').filter(Boolean); return ((w[0]?.[0] ?? '?') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase().slice(0, 2); };

function controlsOf(scope, s, owner) {
  const valid = ['ready', 'working', 'compacting', 'ended'].includes(s.status) && Number.isSafeInteger(s.generation);
  const state = { status: valid ? s.status : 'ended', activeTurn: typeof s.activeTurn === 'string' ? s.activeTurn : null, capabilities: s.capabilities };
  const c = capabilitiesOf(scope, state), pick = (v) => ({ available: v.available === true, reason: v.available ? '' : prose(v.reason, 200) });
  // Propose is idle-only, like the hub's proposal send (plan-t3 M2).
  const propose = c.send.available ? { available: true, reason: '' }
    : { available: false, reason: scope !== 'interact' || state.status === 'ended' ? c.send.reason : `${owner}'s session is busy. Propose when it's idle.` };
  return { send: pick(c.send), steer: pick(c.steer), interrupt: pick(c.interrupt), propose: pick(propose) };
}

// T4a reuses these two for the owned thread, so both kinds keep the same bounds and cleaners.
function activityOf(s, now) {
  const act = s.activity && typeof s.activity === 'object' && CATEGORIES.includes(s.activity.label) && Number.isSafeInteger(s.activity.observed_at) ? s.activity : null;
  const ageMs = act ? Math.max(0, now - act.observed_at) : null;
  return { category: act ? act.label : null, ageMs, stale: act ? ageMs > STALE_MS : false };
}
function deliveriesOf(s) {
  return (Array.isArray(s.deliveries) ? s.deliveries : []).slice(-MAX_DELIVERIES).map((d) => (d && typeof d === 'object' && typeof d.id === 'string' && d.id ? {
    id: line(d.id, 80),
    by: line(d.by, 80) || null,
    text: prose(d.text, MAX_TEXT),
    state: STATES.includes(d.state) ? d.state : 'unknown',
    response: prose(d.response, MAX_RESPONSE),
    at: Number.isSafeInteger(d.sentAt) ? d.sentAt : null,
  } : null)).filter(Boolean);
}

function project({ state, share, route, now }) {
  const s = state && typeof state === 'object' ? state : {};
  const provider = line(s.provider?.label, 60) || 'AI';
  const owner = line(route.ownerName, 80) || 'Teammate';
  const scope = share?.scope === 'interact' ? 'interact' : 'watch';
  const exp = typeof share?.expiresAt === 'string' ? Date.parse(share.expiresAt) : NaN;
  const deliveries = deliveriesOf(s);
  return {
    header: { title: line(s.task_title, 120) || `${owner}'s ${provider} session`, owner, initials: initialsOf(owner), provider, scope, expiresAt: Number.isFinite(exp) ? new Date(exp).toISOString() : null, fake: route.fake === true },
    banner: true,
    activity: activityOf(s, now),
    deliveries,
    status: ['ready', 'working', 'compacting', 'ended'].includes(s.status) ? s.status : 'ready',
    generation: Number.isSafeInteger(s.generation) ? s.generation : 0,
    canSendLater: scope === 'interact',
    controls: controlsOf(scope, s, owner),
  };
}

module.exports = { project, activityOf, deliveriesOf, prose, line, TOP_KEYS, CONTROL_KEYS, HEADER_KEYS, DELIVERY_KEYS, MAX_DELIVERIES, MAX_TEXT, MAX_RESPONSE, STALE_MS, STATES, CATEGORIES };
