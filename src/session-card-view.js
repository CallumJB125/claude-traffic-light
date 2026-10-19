'use strict';
// The widget's per-session hover card (plan "more features" wave 1, lane A):
// what one session row says when the pointer rests on it. Pure: no Electron,
// no DOM. Every string here is built from session metadata the person's own
// hooks wrote (cwd, tool name, teammate name), so the renderer must only ever
// put it in textContent, never innerHTML.

const WAITING = new Set(['permission-ask', 'limit-hit', 'idle-nudge', 'stop', 'turn-failed', 'user-question', 'question-ask']);
const IDLE = new Set(['idle', 'idle-nudge', 'stop', 'session-end']);
const MAX = 80;

const str = (v, max = MAX) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, max) : '');
const stamp = (v) => { const t = typeof v === 'number' ? v : Date.parse(v || ''); return Number.isFinite(t) && t > 0 ? t : null; };

// The project folder's name, never the whole path (the path is the person's own business).
function titleOf(session) {
  const parts = str(session && session.cwd, 1000).split(/[\\/]/).filter(Boolean);
  const leaf = parts.at(-1);
  return leaf && leaf !== '.' && leaf !== '..' ? leaf.slice(0, MAX) : 'session';
}

// "2 min", "1 h 05", "3 days": coarse on purpose, it is read at a glance.
function words(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return 'under a minute';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);

// A teammate's display name reduced to initials for the avatar disc.
function initials(name) {
  const parts = str(name, 120).split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] || '';
  const last = parts.length > 1 ? [...parts.at(-1)][0] || '' : [...parts[0]][1] || '';
  return (first + last).toUpperCase() || '?';
}

const DEPLOY_WORD = { live: 'live', failed: 'failed', building: 'building', canceled: 'cancelled' };
// The deploy state line for a session's project, when a host row is known.
// deploy: {label, name, state, summary?} from src/deploy-status.js status().
function deployLine(deploy) {
  const d = deploy && typeof deploy === 'object' ? deploy : null;
  const word = d && DEPLOY_WORD[d.state];
  if (!word) return '';
  const who = [str(d.label, 30), str(d.name, 60)].filter(Boolean).join(' · ') || 'Deploy';
  const why = d.state === 'failed' && str(d.summary, 100) ? `: ${str(d.summary, 100)}` : '';
  return `${who}: ${word}${why}`;
}

/**
 * session: a row as the widget receives it ({sessionId, cwd, signal, tool,
 * updatedAt, signalSince, startedAt, remote, deviceName, model?, pinned?}).
 * spend: {cost_usd, unpriced} for this session, or null when unknown.
 * teammate: {name} when the session is a teammate's (team row), else null.
 * explain: {recap:{headline, line}|null, help:[{label, handle}], why} from explain mode, or null.
 * deploy: the project's deploy row (see deployLine), or null. nudgesPaused: a
 * "pause nudges" rule holds this burning session's nudges.
 * → {id, title, state, model, spend, teammate, actions, waiting, idle, remote, recap, deploy, help, helpWhy, nudgesPaused}
 */
function sessionCard(session, { now = Date.now(), spend = null, teammate = null, explain = null, deploy = null, nudgesPaused = false } = {}) {
  const s = session && typeof session === 'object' ? session : {};
  const signal = str(s.signal, 40);
  const tool = str(s.tool, 60);
  const waiting = WAITING.has(signal);
  const idle = !waiting && IDLE.has(signal);
  const since = stamp(s.signalSince) || stamp(s.updatedAt);
  const started = stamp(s.startedAt) || stamp(s.createdAt);
  const parts = [];
  if (waiting) {
    const ago = since ? words(now - since) : '';
    parts.push(`waiting on you${ago && ago !== 'under a minute' ? ` since ${ago}` : ''}`);
  } else if (idle) parts.push('idle');
  else if (tool) parts.push(tool);
  else parts.push('working');
  const runFor = started ? words(now - started) : !waiting && !idle && since ? words(now - since) : '';
  if (runFor && !(waiting && !started)) parts.push(`${started ? 'running' : 'on it'} for ${runFor}`);
  if (s.remote) parts.push(`on ${str(s.deviceName, 60) || 'another device'}`);
  // The model the session runs on (a local model's name, or the provider's model when its hooks report one).
  const model = str(s.model, 80);
  if (model) parts.push(model);
  const state = parts.join(' · ');
  const cost = spend && Number.isFinite(spend.cost_usd) ? spend.cost_usd : null;
  const spendLine = cost == null ? '' : `${money(cost)} this session${spend.unpriced > 0 ? ` (+${spend.unpriced} unpriced)` : ''}`;
  const mate = teammate && str(teammate.name, 120) ? { name: str(teammate.name, 120), initials: initials(teammate.name) } : null;
  const actions = [];
  if (!mate && !s.remote) actions.push('open');
  if (!mate && waiting && !s.remote) actions.push('answer');
  if (!mate) actions.push(s.pinned ? 'unpin' : 'pin');
  const paused = !mate && nudgesPaused === true;
  if (paused) actions.push('resume-nudges');
  const id = str(s.sessionId, 200) || null;
  const ex = !mate && explain && typeof explain === 'object' ? explain : null;
  const recap = ex && ex.recap && str(ex.recap.headline, 120) ? { headline: str(ex.recap.headline, 120), line: str(ex.recap.line, 160) } : null;
  const help = (ex && Array.isArray(ex.help) ? ex.help : []).filter((h) => h && str(h.label, 60) && typeof h.handle === 'string' && /^[\w-]{1,40}$/.test(h.handle)).slice(0, 3).map((h) => ({ label: str(h.label, 60), handle: h.handle }));
  return { id, title: str(s.title, MAX) || titleOf(s), state, model: model || null, spend: spendLine, teammate: mate, actions, waiting, idle, remote: !!s.remote, pinned: !!s.pinned,
    recap, deploy: mate ? '' : deployLine(deploy), help, helpWhy: help.length ? str(ex.why, 100) : '', nudgesPaused: paused };
}

module.exports = { deployLine, sessionCard, titleOf, words, initials, WAITING, IDLE };
