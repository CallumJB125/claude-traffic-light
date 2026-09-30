// Team presence (CONTRACT D37b), desktop-app mode only. The app reports its
// local agent sessions ({session_id, agent, cwd, state, since, summary?});
// the runner maps each cwd to its repo's configured origin (D27), drops every
// session whose repo is not on one of the member's boards (the welcome
// allowlist: default deny), and sends only {hashed session_id, agent, repo_id,
// branch, state, since, summary?}: never a cwd or any path. The summary is a
// separate opt-in (share_summaries) and goes through redact plus a stricter
// presence-only pass (every home-style prefix anywhere, and every /-rooted run
// of 2+ segments, becomes <path>), clipped to 120.
// Sent on change at most every PRESENCE_MIN_MS, re-sent every
// PRESENCE_KEEPALIVE_MS; disabled (or never enabled) sends nothing, except one
// empty frame so the hub clears what it had.
import crypto from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { serializeOutbound, assertNoForeignBytes, matchRepo, redact } from '../shared/scope.js';
import { PRESENCE_AGENTS, PRESENCE_STATES, PRESENCE_MAX_SESSIONS, PRESENCE_SUMMARY_MAX, isPresenceSince, validate } from '../shared/protocol.js';
import { PRESENCE_MIN_MS, PRESENCE_KEEPALIVE_MS } from '../shared/liveness.js';
import { sessionOf, git } from './git.js';
import { clip } from './util.js';

const DEVICE_SCOPE = Object.freeze({ repo_id: '__device__', toplevel: null });
const HOME_PREFIX_ANYWHERE = /(?:\/Users\/|\/home\/|\/root\/|\/private\/|\/var\/folders\/|\/tmp\/|\/Volumes\/|~\/|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])\S*/g;
const ROOTED_RUN = /(?<![\w.-])\/[^\s/]+(?:\/[^\s/]*)+/g;

/** Presence summary text: redact, then no path-looking text at all survives. */
export function presenceSummary(text, toplevel) {
  const once = redact(text.replace(/\s+/g, ' ').trim(), toplevel);
  return clip(once.replace(HOME_PREFIX_ANYWHERE, '<path>').replace(ROOTED_RUN, '<path>'), PRESENCE_SUMMARY_MAX);
}

/** cwd → {toplevel, remote_url, branch} from git, or null (not a repo with an origin). */
export async function resolveCwd(cwd) {
  let s;
  try { s = await sessionOf(cwd); } catch { return null; }
  if (!s.toplevel || !s.remote_url) return null;
  const branch = await git(s.toplevel, ['rev-parse', '--abbrev-ref', 'HEAD']).then((x) => x.trim(), () => null);
  return { toplevel: s.toplevel, remote_url: s.remote_url, branch: branch && branch !== 'HEAD' ? branch : null };
}

export class PresenceReporter {
  constructor(sup, { minMs = PRESENCE_MIN_MS, keepaliveMs = PRESENCE_KEEPALIVE_MS, resolve = resolveCwd } = {}) {
    this.sup = sup;
    this.minMs = minMs;
    this.resolve = resolve;
    this.salt = crypto.randomBytes(32);   // per runner process: hashed ids never link across restarts
    this.enabled = false;
    this.shareSummaries = false;
    this.input = [];
    this.sessions = [];
    this.lastSig = null;
    this.lastSentAt = -Infinity;
    this.hubHas = false;                  // the hub holds a non-empty presence from us
    this.version = 0;
    this.timer = null;
    // A new connection: the allowlist may have changed and the hub may have
    // forgotten us; send the current view again (or the pending clear).
    this.onConnected = () => { this.lastSig = null; this.lastSentAt = -Infinity; this.refresh(); };
    sup.on('connected', this.onConnected);
    this.keepalive = setInterval(() => { if (this.enabled && this.sessions.length) this.#send(this.sessions); }, keepaliveMs);
    this.keepalive.unref?.();
  }

  /** The app's `runner.presence` message. → Promise (resolved once reduced and scheduled). */
  update(msg) {
    this.enabled = msg?.enabled === true;
    this.shareSummaries = this.enabled && msg.share_summaries === true;
    this.input = this.enabled && Array.isArray(msg.sessions) ? msg.sessions.slice(0, PRESENCE_MAX_SESSIONS) : [];
    return this.refresh();
  }

  async refresh() {
    const v = ++this.version;
    const out = [];
    for (const s of this.input) {
      const r = await this.#reduce(s);
      if (r) out.push(r);
    }
    if (v !== this.version) return;   // a newer update superseded this one
    this.sessions = out;
    this.#schedule();
  }

  stop() {
    clearInterval(this.keepalive);
    clearTimeout(this.timer);
    this.sup.off('connected', this.onConnected);
  }

  async #reduce(s) {
    if (!s || typeof s !== 'object' || typeof s.session_id !== 'string' || !s.session_id) return null;
    if (!PRESENCE_AGENTS.includes(s.agent) || !PRESENCE_STATES.includes(s.state)) return null;
    if (typeof s.cwd !== 'string' || !path.isAbsolute(s.cwd)) return null;
    if (!isPresenceSince(s.since)) return null;
    const { since } = s;
    const where = await this.resolve(s.cwd);
    if (!where) return null;
    const repoId = matchRepo(where.remote_url, this.sup.allowlist);
    if (!repoId) return null;   // not a repo linked to one of the member's boards
    const scope = { repo_id: repoId, toplevel: where.toplevel };
    const summary = this.shareSummaries && typeof s.summary === 'string' ? presenceSummary(s.summary, where.toplevel) : '';
    const out = {
      session_id: crypto.createHmac('sha256', this.salt).update(s.session_id).digest('base64url').slice(0, 22),
      agent: s.agent, repo_id: repoId, ...(where.branch ? { branch: clip(where.branch, 200) } : {}), state: s.state, since,
    };
    // The same guard as every hub-bound byte: a summary that still trips it is
    // dropped, anything else that trips it drops the session.
    for (const cand of summary ? [{ ...out, summary }, out] : [out]) {
      try { assertNoForeignBytes(cand, scope); return cand; } catch { /* next */ }
    }
    return null;
  }

  #schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.enabled) {
      if (this.hubHas) this.#send([]);   // disabled: the hub clears at once
      return;
    }
    const sig = JSON.stringify(this.sessions);
    if (sig === this.lastSig) return;
    if (!this.sessions.length && !this.hubHas) { this.lastSig = sig; return; }
    const wait = this.lastSentAt + this.minMs - performance.now();
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.#schedule(); }, wait);
      this.timer.unref?.();
      return;
    }
    this.#send(this.sessions);
  }

  #send(sessions) {
    const frame = { type: 'presence', sessions };
    if (validate('runner→hub', frame)) return false;
    let bytes;
    try { bytes = serializeOutbound(frame, DEVICE_SCOPE); } catch { return false; }
    if (!this.sup.connected || !this.sup.sendRaw(bytes)) return false;
    this.lastSentAt = performance.now();
    this.lastSig = JSON.stringify(sessions);
    this.hubHas = sessions.length > 0;
    return true;
  }
}
