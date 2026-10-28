'use strict';
// The widget's per-session hover card (plan "more features" wave 1, lane A):
// what one session row says when the pointer rests on it. Pure: no Electron,
// no DOM. Every string here is built from session metadata the person's own
// hooks wrote (cwd, tool name, teammate name), so the renderer must only ever
// put it in textContent, never innerHTML.

const WAITING = new Set(['permission-ask', 'limit-hit', 'idle-nudge', 'stop', 'turn-failed', 'user-question', 'question-ask']);
const IDLE = new Set(['idle', 'idle-nudge', 'stop', 'session-end']);
const MAX = 80;
const Organise = require('./work-organise.js');
const Actions = require('./session-row-actions.js');

const str = (v, max = MAX) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, max) : '');
const stamp = (v) => { const t = typeof v === 'number' ? v : Date.parse(v || ''); return Number.isFinite(t) && t > 0 ? t : null; };

// The project's name (projectOf), never the whole path (the path is the person's own business).
function titleOf(session) {
  return Organise.projectOf({ cwd: str(session && session.cwd, 1000) || null }).heading;
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
 * QoL2: home (the home folder, for `~`), platform (names the file manager), resumable (main found the session has
 * ended and has a resume command for it: only then is copy-resume offered).
 * → {id, title, state, model, spend, teammate, actions, waiting, idle, remote, recap, deploy, help, helpWhy, nudgesPaused,
 *    folder, folderApp, waitFor}
 */
function sessionCard(session, { now = Date.now(), spend = null, teammate = null, explain = null, deploy = null, nudgesPaused = false, home = null, platform = process.platform, resumable = false } = {}) {
  const s = session && typeof session === 'object' ? session : {};
  const signal = str(s.signal, 40);
  const tool = str(s.tool, 60);
  const waiting = WAITING.has(signal);
  const idle = !waiting && IDLE.has(signal);
  const since = stamp(s.signalSince) || stamp(s.updatedAt);
  const started = stamp(s.startedAt) || stamp(s.createdAt);
  const parts = [];
  // State words are the bucket headings (work-organise.js); a running tool says more than "Working on it".
  if (waiting || idle) {
    const bucket = Organise.bucketOf(signal);
    const ago = bucket === 'needs' && since ? words(now - since) : '';
    parts.push(`${Organise.headingOf(bucket)}${ago && ago !== 'under a minute' ? ` since ${ago}` : ''}`);
  } else if (tool) parts.push(tool);
  else parts.push(Organise.headingOf('working'));
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
  // QoL2: your own sessions on this computer show their folder; a teammate's or another device's never does.
  const own = !mate && !s.remote;
  const folder = own ? Actions.folderLabel(str(s.cwd, 4096), home) : null;
  const waitFor = waiting && since ? Actions.waitShort(now - since) : '';
  const actions = [];
  if (own) actions.push('open');
  if (own && waiting) actions.push('answer');
  if (own && resumable === true) actions.push('copy-resume');
  if (own && folder) actions.push('finder', 'editor');
  if (!mate) actions.push(s.pinned ? 'unpin' : 'pin');
  const paused = !mate && nudgesPaused === true;
  if (paused) actions.push('resume-nudges');
  const id = str(s.sessionId, 200) || null;
  const ex = !mate && explain && typeof explain === 'object' ? explain : null;
  const recap = ex && ex.recap && str(ex.recap.headline, 120) ? { headline: str(ex.recap.headline, 120), line: str(ex.recap.line, 160) } : null;
  const help = (ex && Array.isArray(ex.help) ? ex.help : []).filter((h) => h && str(h.label, 60) && typeof h.handle === 'string' && /^[\w-]{1,40}$/.test(h.handle)).slice(0, 3).map((h) => ({ label: str(h.label, 60), handle: h.handle }));
  return { id, title: str(s.title, MAX) || titleOf(s), state, model: model || null, spend: spendLine, teammate: mate, actions, waiting, idle, remote: !!s.remote, pinned: !!s.pinned,
    recap, deploy: mate ? '' : deployLine(deploy), help, helpWhy: help.length ? str(ex.why, 100) : '', nudgesPaused: paused,
    folder, folderApp: Actions.folderApp(platform), waitFor };
}

// A short tag per row when two or more rows share a provider and project, so
// two "Claude Code · notes-app" cards can be told apart before one is answered
// or opened. rows: [{provider, project, tmux?, title?, id?, startedAt?}].
// → one string per row ('' when its provider+project is unique). Each tag stands
// on its own row, so a session joining the group never relabels the others: the
// session id's tail (4 characters, 6 then 8 only when two tails clash), with the
// tmux window or terminal title in front when the row has one. Without an id,
// the start time.
const SUFFIX_LENGTHS = [4, 6, 8];
const idOf = (r) => str(r.id, 200).replace(/[^A-Za-z0-9]/g, '');
const startOf = (r) => { const t = stamp(r.startedAt); return t ? `${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}` : ''; };
const unique = (v) => v.every(Boolean) && new Set(v).size === v.length;
function disambiguate(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  list.forEach((r, i) => {
    const key = `${r && r.provider}\u0000${r && r.project}`;
    groups.set(key, [...(groups.get(key) || []), i]);
  });
  const tags = list.map(() => '');
  for (const at of groups.values()) {
    if (at.length < 2) continue;
    const ids = at.map((i) => idOf(list[i]));
    const length = SUFFIX_LENGTHS.find((n) => unique(ids.map((x) => x.slice(-n)))) || SUFFIX_LENGTHS[SUFFIX_LENGTHS.length - 1];
    const tails = ids.map((x) => x.slice(-length));
    const clash = !unique(tails);
    at.forEach((i, k) => {
      const r = list[i];
      const own = clash ? [tails[k], startOf(r)].filter(Boolean).join(' ') || str(r.tmux, 24) || str(r.title, 24) : tails[k] || startOf(r);
      const extra = str(r.tmux, 24) || str(r.title, 24);
      tags[i] = extra && own && extra !== own ? `${extra} ${own}` : own || extra;
    });
  }
  return tags;
}

module.exports = { deployLine, disambiguate, sessionCard, titleOf, words, initials, WAITING, IDLE };
