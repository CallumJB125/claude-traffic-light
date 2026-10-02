// Messages and handoffs between people and permitted sessions (accounts mode).
// Contract: board/MESSAGING.md. Storage: migration 050 (msg_targets, msg_messages).
//
// Authority is only what the hub already proves: the request's credential
// (source user, never the body), user_devices (a host device that opted in,
// migration 048), members (team scope). A target is an opaque id the host
// device registered for one of its own sessions at one generation; it is never
// moved to a replacement session, whatever its label or folder.
//
// Delivery: msg_messages is the durable per-destination queue (ordered by
// seq). Every state change also writes a content-free `msg.state` journal row
// in the same transaction, for bus/Board/Overview projections; the bus is not
// the delivery path because a new consumer starts at the journal head.
// At-least-once to the receiver (which dedupes); an effect whose outcome is not
// known becomes `outcome_unknown` and is never retried. Routing never invokes a
// model; messages are task data, never approval or authorization.

import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { HubError } from './db.js';
import { limitOrThrow } from './ratelimit.js';
import { packetRelativePath } from '../shared/packet-text.js';

export const MESSAGING_LIMITS = Object.freeze({
  // A session receives the body framed (src/session-messaging.js frame()) through an
  // adapter that takes 4000 chars / 8192 bytes: body + handoff refs stay under this.
  bodyChars: 4000, bodyBytes: 8192, sessionBodyChars: 3200, sessionBodyBytes: 7168, responseChars: 16000, reportChars: 2000, labelChars: 120,
  ttlDefaultS: 3600, ttlMinS: 10, ttlMaxS: 86400, personTtlMaxS: 7 * 86400,
  perTarget: 32, perSender: 64, perPersonInbox: 200, targetsPerHost: 16,
  leaseMs: 60_000, busyBackoffMs: 5_000, pullWaitMaxMs: 20_000, pullBatch: 8, onlineMs: 60_000,
  maxHops: 3, orgSessionPerHour: 120, cardSessionPerHour: 60, retentionMs: 30 * 86_400_000,
  // Per target: people other than its owner (together), and the owner's own sends.
  teammateTurnsPerHour: 20, teammateParallel: 4, ownerTurnsPerHour: 240,
  registrationsPerHour: 64, parkedPulls: 2, sweepMs: 60_000,
  cardRefs: 8, artifacts: 16,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const STATES = ['queued', 'delivered', 'replied', 'rejected', 'expired', 'outcome_unknown'];
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (m = 'invalid message request') => new HubError('VALIDATION', m);
// Unknown, foreign, revoked and unshared all look the same: no oracle.
const missing = () => new HubError('NOT_FOUND', 'no such message or session');
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

function shape(v, keys, required = []) {
  if (!object(v) || Object.keys(v).some((k) => !keys.includes(k)) || required.some((k) => v[k] === undefined)) throw invalid();
  return v;
}
function uuid(v, optional = false) {
  if (optional && v == null) return null;
  if (typeof v !== 'string' || !UUID.test(v.toLowerCase())) throw invalid();
  return v.toLowerCase();
}
function id(v, optional = false) {
  if (optional && v == null) return null;
  if (typeof v !== 'string' || !ID.test(v)) throw invalid();
  return v;
}
function int(v, min, max, fallback) {
  if (v == null) return fallback;
  if (!Number.isSafeInteger(v) || v < min || v > max) throw invalid();
  return v;
}

export class Messaging {
  constructor(hub, limits = {}) {
    this.hub = hub;
    this.db = hub.db;
    this.limits = { ...MESSAGING_LIMITS, ...limits };
    this.waiters = new Map(); // host user_devices.id -> Set(wake)
  }

  nowMs() { return this.hub.clock.wall(); }
  at(ms = this.nowMs()) { return new Date(ms).toISOString(); }

  text(v, max, bytes = null, { optional = false } = {}) {
    if (optional && v == null) return null;
    if (typeof v !== 'string' || CONTROL.test(v)) throw invalid('message text is invalid');
    const s = v.trim();
    if (!s) throw invalid('message text is empty');
    if (s.length > max || (bytes && Buffer.byteLength(s) > bytes)) throw new HubError('PAYLOAD_TOO_LARGE', 'message too large');
    return s;
  }

  // ── authority ─────────────────────────────────────────────────────────────
  liveUser(uid) { return !!uid && !!this.hub.accounts?.liveUser(uid); }
  credOk(kind, cid) { try { return this.hub.accounts.credValid({ kind, id: cid }) === true; } catch { return false; } }
  userName(uid) { return this.db.get('SELECT display_name FROM users WHERE id = ?', uid)?.display_name ?? null; }
  member(uid, orgId) {
    if (!uid || !orgId) return null;
    return this.db.get(`SELECT m.* FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.org_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL`, uid, orgId);
  }
  // A card the user can see: in `orgId` when given, else in any team they are an active member of.
  card(uid, cardId, orgId) {
    const c = this.hub.card(cardId), b = c && this.hub.board(c.board_id);
    if (!c || !b || c.archived_at || b.archived_at || (orgId && b.org_id !== orgId)) return null;
    return this.member(uid, b.org_id) ? c : null;
  }
  target(tid) { return tid ? this.db.get('SELECT * FROM msg_targets WHERE id = ?', tid) : null; }
  automation(t) { return parse(t?.automation, null); }
  targetProblem(t) {
    if (!t) return 'target_gone';
    if (t.retired_at) return t.retire_reason ?? 'target_replaced';
    const d = this.db.get('SELECT * FROM user_devices WHERE id = ?', t.host_device_id);
    if (!d || d.revoked_at || d.user_id !== t.user_id || !this.credOk('device', d.id)) return 'device_revoked';
    if (d.interaction_role !== 'host') return 'hosting_off';
    if (!this.liveUser(t.user_id)) return 'owner_gone';
    if (t.scope === 'team' && !this.member(t.user_id, t.org_id)) return 'owner_removed';
    if (t.card_id && !this.card(t.user_id, t.card_id, t.org_id)) return 'card_gone';
    return null;
  }
  // Team membership never exposes a personal session.
  allowed(uid, t) { return t.scope === 'personal' ? uid === t.user_id : !!this.member(uid, t.org_id); }
  // A session speaks only inside its own scope: personal → its owner's own
  // personal sessions; team → that team's sessions and members.
  scopeOk(src, to) {
    if (to.kind === 'person') return src.scope === 'team' && to.org_id === src.org_id;
    return src.scope === 'personal' ? to.t.scope === 'personal' && to.t.user_id === src.user_id : to.t.scope === 'team' && to.t.org_id === src.org_id;
  }

  // Why message `m` may not proceed now, or null.
  problem(m) {
    const rej = (reason) => ({ state: 'rejected', reason });
    if (m.expires_at <= this.at()) return { state: 'expired', reason: 'expired' };
    if (!this.liveUser(m.source_user_id) || !this.liveUser(m.dest_user_id)) return rej('account_gone');
    if (m.source_kind === 'person' && !this.credOk(m.source_cred_kind, m.source_cred_id)) return rej('sender_revoked');
    if (m.source_kind === 'session') {
      const st = this.target(m.source_target_id), p = this.targetProblem(st);
      if (p) { this.retire(st, p); return rej(`source_${p}`); }
    }
    if (m.org_id && !this.member(m.source_user_id, m.org_id)) return rej('sender_removed');
    if (m.card_id && !this.card(m.source_user_id, m.card_id, m.org_id)) return rej('card_gone');
    if (m.dest_kind === 'session') {
      const t = this.target(m.dest_target_id), p = this.targetProblem(t);
      if (p) { this.retire(t, p); return rej(p); }
      if (t.generation !== m.authority_version) return rej('target_replaced');
      if (!this.allowed(m.source_user_id, t)) return rej('not_permitted');
      if (m.source_kind === 'session' && !this.automation(t)?.sessions) return rej('automation_off');
    } else if (!this.member(m.dest_user_id, m.org_id)) return rej('recipient_removed');
    return null;
  }

  // ── state changes (each with a content-free journal row) ─────────────────
  update(m, fields, journal = true) {
    const set = { ...fields, updated_at: this.at() };
    const keys = Object.keys(set);
    this.db.run(`UPDATE msg_messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => set[k]), m.id);
    Object.assign(m, set);
    if (journal) this.journal(m);
  }
  journal(m) {
    this.hub.journal({ board_id: m.card_id && this.hub.card(m.card_id) ? undefined : null, card_id: m.card_id && this.hub.card(m.card_id) ? m.card_id : null,
      actor_kind: 'system', kind: 'msg.state',
      payload: { message_id: m.id, kind: m.kind, state: m.state, reason: m.reason ?? null, handoff_state: m.handoff_state ?? null, source_kind: m.source_kind, dest_kind: m.dest_kind } });
  }
  // Ends a queued message once; a copy that is already stale (ended elsewhere in this pass) is left alone.
  finish(m, state, reason) {
    const now = this.db.get('SELECT state, phase FROM msg_messages WHERE id = ?', m.id);
    if (!now || now.state !== 'queued') { if (now) Object.assign(m, now); return; }
    const fields = { state, reason, phase: null };
    if (state === 'expired' && m.handoff_state === 'offered') fields.handoff_state = 'expired';
    this.update(m, fields);
  }
  retire(t, reason) {
    if (!t || t.retired_at) return;
    this.hub.txn(() => {
      this.db.run('UPDATE msg_targets SET retired_at = ?, retire_reason = ? WHERE id = ? AND retired_at IS NULL', this.at(), reason, t.id);
      t.retired_at = this.at(); t.retire_reason = reason;
      // In-flight (`accepted`) messages keep their lease: their outcome is reported or becomes unknown.
      for (const m of this.db.all("SELECT * FROM msg_messages WHERE dest_target_id = ? AND state = 'queued' AND (phase IS NULL OR phase = 'leased')", t.id)) this.finish(m, 'rejected', reason);
      this.hub.journal({ board_id: null, actor_kind: 'system', kind: 'msg.target', payload: { target: t.id, retired: reason } });
    });
  }

  // Per request: lapsed leases and expiry of queued messages only (msg_messages_queued index).
  sweep() {
    const now = this.at();
    this.hub.txn(() => {
      for (const m of this.db.all("SELECT * FROM msg_messages WHERE state = 'queued' AND phase = 'accepted' AND lease_until <= ?", now)) this.finish(m, 'outcome_unknown', 'receiver_lost');
      for (const m of this.db.all("SELECT * FROM msg_messages WHERE state = 'queued' AND expires_at <= ? AND (phase IS NULL OR phase = 'leased')", now)) this.finish(m, 'expired', 'expired');
      this.db.run("UPDATE msg_messages SET phase = NULL WHERE state = 'queued' AND phase = 'leased' AND lease_until <= ?", now);
    });
  }

  // On the hub's timer (app.js), never per request: retention, expired handoffs,
  // long-retired targets, and anything a deletion left (deletion purges at once).
  purge() {
    this.sweep();
    const now = this.at(), old = this.at(this.nowMs() - this.limits.retentionMs);
    this.hub.txn(() => {
      for (const m of this.db.all("SELECT * FROM msg_messages WHERE handoff_state = 'offered' AND expires_at <= ? AND state != 'queued'", now)) this.update(m, { handoff_state: 'expired' });
      this.db.run('DELETE FROM msg_messages WHERE created_at < ?', old);
      this.db.run('DELETE FROM msg_targets WHERE retired_at < ?', old);
      this.db.run(`DELETE FROM msg_messages WHERE source_user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)
        OR dest_user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)`);
      this.db.run('DELETE FROM msg_targets WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)');
      this.hub.dropDeletedTeamMessages();
    });
  }

  // ── projection ────────────────────────────────────────────────────────────
  project(m, viewer) {
    const dt = this.target(m.dest_target_id), st = this.target(m.source_target_id);
    // A response is team/session data: withheld from a sender who lost access.
    const see = viewer === m.dest_user_id || (m.dest_kind === 'person' ? !!this.member(viewer, m.org_id) : !!dt && this.allowed(viewer, dt));
    const h = parse(m.handoff, null);
    return {
      id: m.id, request_id: m.request_id, kind: m.kind, conversation_id: m.conversation_id, reply_to: m.reply_to, caused_by: m.caused_by,
      card_id: m.card_id, org_id: m.org_id,
      source: { kind: m.source_kind, user_id: m.source_user_id, name: this.userName(m.source_user_id),
        ...(st ? { target: st.id, provider: st.provider } : {}), identity_source: m.source_kind === 'session' ? 'hub_host_device' : 'hub_credential' },
      to: { kind: m.dest_kind, user_id: m.dest_user_id, name: this.userName(m.dest_user_id), ...(dt ? { target: dt.id, provider: dt.provider } : {}) },
      body: m.body, state: m.state, reason: m.reason ?? null,
      response: see ? m.response ?? null : null, response_source: see && m.response != null ? 'provider_reported' : null,
      handoff: h ? { brief: m.body, card_refs: h.card_refs, artifacts: h.artifacts, state: this.handoffExpired(m) ? 'expired' : m.handoff_state, report: m.handoff_report ?? null } : null,
      hop: m.hop, authority_version: m.authority_version, created_at: m.created_at, expires_at: m.expires_at,
      delivered_at: m.delivered_at ?? null, replied_at: m.replied_at ?? null, grants_execution: false, approval: false,
    };
  }
  handoffExpired(m) { return m.handoff_state === 'offered' && m.expires_at <= this.at(); }
  // Re-check a queued message on every read: revocation retires pending effects.
  fresh(m) {
    if (m.state === 'queued' && m.phase !== 'accepted') { const p = this.problem(m); if (p) this.hub.txn(() => this.finish(m, p.state, p.reason)); }
    return m;
  }

  // ── people ────────────────────────────────────────────────────────────────
  targets(ident) {
    limitOrThrow(this.hub, 'messaging_read_user', ident.user.id);
    this.sweep();
    const uid = ident.user.id, online = this.at(this.nowMs() - this.limits.onlineMs);
    const rows = this.db.all(`SELECT * FROM msg_targets WHERE retired_at IS NULL AND (user_id = ? OR (scope = 'team'
      AND org_id IN (SELECT org_id FROM members WHERE user_id = ? AND removed_at IS NULL))) ORDER BY registered_at, id`, uid, uid);
    const out = [];
    for (const t of rows) {
      const p = this.targetProblem(t);
      if (p) { this.retire(t, p); continue; }
      if (!this.allowed(uid, t)) continue;
      out.push({ target: t.id, scope: t.scope, org_id: t.org_id, card_id: t.card_id, provider: t.provider, label: t.label, label_source: 'self_declared',
        owner: { user_id: t.user_id, name: this.userName(t.user_id) }, mine: t.user_id === uid, online: t.seen_at >= online,
        accepts_sessions: !!this.automation(t)?.sessions });
    }
    return { targets: out };
  }

  send(ident, body) {
    shape(body, ['request_id', 'to', 'body', 'kind', 'card_id', 'conversation_id', 'reply_to', 'ttl_s', 'handoff'], ['request_id', 'to', 'body']);
    return this.create({ kind: 'person', user_id: ident.user.id, cred: ident.cred, target: null }, body);
  }

  // Shared by people and sessions. `src`: {kind, user_id, cred, target}.
  create(src, body) {
    this.sweep();
    const L = this.limits;
    const request = uuid(body.request_id);
    const to = shape(body.to, ['target', 'user_id', 'org_id']);
    if (to.target != null && (to.user_id != null || to.org_id != null)) throw invalid();
    const dest = to.target != null ? { target: uuid(to.target) } : { user_id: id(to.user_id), org_id: id(to.org_id) };
    const kind = body.kind ?? 'message';
    if (!['message', 'handoff'].includes(kind)) throw invalid();
    const text = this.text(body.body, L.bodyChars, L.bodyBytes);
    const cardId = id(body.card_id, true), replyTo = uuid(body.reply_to, true), convo = uuid(body.conversation_id, true), causedBy = uuid(body.caused_by, true);
    let handoff = null;
    if (body.handoff != null) {
      if (kind !== 'handoff') throw invalid();
      const h = shape(body.handoff, ['card_refs', 'artifacts']);
      const refs = h.card_refs ?? [], arts = h.artifacts ?? [];
      if (!Array.isArray(refs) || refs.length > L.cardRefs || !Array.isArray(arts) || arts.length > L.artifacts) throw invalid('too many handoff references');
      handoff = { card_refs: [...new Set(refs.map((r) => id(r)))], artifacts: arts.map((a) => {
        shape(a, ['kind', 'path'], ['kind', 'path']);
        const p = a.kind === 'path' ? packetRelativePath(a.path) : null;
        if (!p) throw invalid('artifact must be a permitted relative path');
        return { kind: 'path', path: p };
      }) };
    } else if (kind === 'handoff') handoff = { card_refs: [], artifacts: [] };
    const fingerprint = digest({ from: src.target?.id ?? null, dest, kind, text, cardId, replyTo, convo, causedBy, ttl: body.ttl_s ?? null, handoff });
    // Same request_id: the same message (dedupe), never a second one.
    const prior = this.db.get('SELECT * FROM msg_messages WHERE source_user_id = ? AND request_id = ?', src.user_id, request);
    if (prior) {
      if (prior.request_hash !== fingerprint) throw new HubError('CONFLICT', 'request_id belongs to another message', { reason: 'REQUEST_REUSED' });
      return { message: this.project(this.fresh(prior), src.user_id), deduped: true };
    }

    // Destination, resolved and checked now; again before every delivery.
    let t = null, destUser, orgId;
    if (dest.target) {
      t = this.target(dest.target);
      if (!t || t.retired_at || this.targetProblem(t) || !this.allowed(src.user_id, t)) throw missing();
      destUser = t.user_id; orgId = t.scope === 'team' ? t.org_id : null;
    } else {
      if (!this.member(src.user_id, dest.org_id) || !this.member(dest.user_id, dest.org_id) || !this.liveUser(dest.user_id)) throw missing();
      destUser = dest.user_id; orgId = dest.org_id;
    }
    if (src.target && !this.scopeOk(src.target, t ? { kind: 'session', t } : { kind: 'person', org_id: orgId })) throw missing();
    for (const c of [cardId, ...(handoff?.card_refs ?? [])]) if (c && !this.card(src.user_id, c, orgId)) throw missing();
    if (t) {
      const refs = handoff ? [...handoff.card_refs, ...handoff.artifacts.map((a) => a.path)].join(', ') : '';
      if (text.length + refs.length > L.sessionBodyChars || Buffer.byteLength(text) + Buffer.byteLength(refs) > L.sessionBodyBytes) {
        throw new HubError('PAYLOAD_TOO_LARGE', 'message too large for a session', { reason: 'SESSION_BODY_LIMIT' });
      }
    }
    const ttlMax = t ? L.ttlMaxS : L.personTtlMaxS;
    const ttl = int(body.ttl_s, L.ttlMinS, ttlMax, t ? L.ttlDefaultS : L.personTtlMaxS);

    let reply = null, cause = null;
    if (replyTo) {
      reply = this.db.get('SELECT * FROM msg_messages WHERE id = ?', replyTo);
      // Only inside the same team (or both personal) and the same conversation.
      if (!reply || (reply.source_user_id !== src.user_id && reply.dest_user_id !== src.user_id)
        || (reply.org_id ?? null) !== orgId || (convo && convo !== reply.conversation_id)) throw missing();
    }
    // hop: session-sourced forwards in this chain (a person's message is 0).
    // Derived from every message this session was handed in the last hour, never
    // from the caller: omitting or choosing caused_by cannot restart the count,
    // and the window is fixed so a sender's short ttl_s cannot shorten it.
    let hop = 0, visited = [];
    const hour = this.at(this.nowMs() - 3_600_000);
    if (src.target) {
      const recent = "dest_target_id = ? AND state NOT IN ('rejected','expired') AND created_at > ?";
      if (causedBy) {
        // A cause handed to someone else is refused; one that has aged out is just dropped.
        if (!this.db.get('SELECT 1 FROM msg_messages WHERE id = ? AND dest_target_id = ?', causedBy, src.target.id)) throw missing();
        cause = this.db.get(`SELECT * FROM msg_messages WHERE id = ? AND ${recent}`, causedBy, src.target.id, hour) ?? null;
      }
      hop = 1 + (this.db.get(`SELECT MAX(hop) h FROM msg_messages WHERE ${recent}`, src.target.id, hour)?.h ?? 0);
      for (const r of this.db.all(`SELECT DISTINCT visited FROM msg_messages WHERE ${recent} AND source_kind = 'session'`, src.target.id, hour)) visited.push(...parse(r.visited, []));
      visited = [...new Set([...visited, src.target.id])];
      if (t) {
        const policy = this.automation(t);
        if (!policy?.sessions) throw new HubError('FORBIDDEN', 'that session does not accept messages from AI sessions', { reason: 'AUTOMATION_OFF' });
        if (t.id === src.target.id || visited.includes(t.id)) throw new HubError('CONFLICT', 'message loop refused', { reason: 'LOOP' });
        if (hop > Math.min(L.maxHops, policy.max_hops)) throw new HubError('CONFLICT', 'hop limit reached; ask a person before continuing', { reason: 'HOP_LIMIT' });
        if (this.db.get("SELECT COUNT(*) n FROM msg_messages WHERE dest_target_id = ? AND source_kind = 'session' AND created_at > ?", t.id, hour).n >= policy.turns_per_hour
          || this.db.get("SELECT COUNT(*) n FROM msg_messages WHERE dest_target_id = ? AND source_kind = 'session' AND state = 'queued'", t.id).n >= policy.parallel) throw new HubError('RATE_LIMITED', 'that session\'s automation limit is reached', { retry_after_s: 60, reason: 'AUTOMATION_LIMIT' });
      }
      if ((orgId && this.db.get("SELECT COUNT(*) n FROM msg_messages WHERE org_id = ? AND source_kind = 'session' AND created_at > ?", orgId, hour).n >= L.orgSessionPerHour)
        || (cardId && this.db.get("SELECT COUNT(*) n FROM msg_messages WHERE card_id = ? AND source_kind = 'session' AND created_at > ?", cardId, hour).n >= L.cardSessionPerHour)) throw new HubError('RATE_LIMITED', 'team or task automation limit reached', { retry_after_s: 60, reason: 'AUTOMATION_LIMIT' });
    }
    // People: everyone but the target's owner shares one hourly turn and parallel budget per target.
    if (t && !src.target) {
      const owner = src.user_id === t.user_id;
      const who = `dest_target_id = ? AND source_kind = 'person' AND source_user_id ${owner ? '=' : '!='} ?`;
      if (this.db.get(`SELECT COUNT(*) n FROM msg_messages WHERE ${who} AND created_at > ?`, t.id, t.user_id, hour).n >= (owner ? L.ownerTurnsPerHour : L.teammateTurnsPerHour)
        || (!owner && this.db.get(`SELECT COUNT(*) n FROM msg_messages WHERE ${who} AND state = 'queued'`, t.id, t.user_id).n >= L.teammateParallel)) {
        throw new HubError('RATE_LIMITED', 'that session has had enough messages for now', { retry_after_s: 60, reason: 'TURN_LIMIT' });
      }
    }
    // Bounded, scoped offline queues.
    if (t && this.db.get("SELECT COUNT(*) n FROM msg_messages WHERE dest_target_id = ? AND state = 'queued'", t.id).n >= L.perTarget) throw new HubError('RATE_LIMITED', 'that session has too many waiting messages', { retry_after_s: 30, reason: 'QUEUE_FULL' });
    if (!t && this.db.get("SELECT COUNT(*) n FROM msg_messages WHERE dest_kind = 'person' AND dest_user_id = ? AND state = 'queued'", destUser).n >= L.perPersonInbox) throw new HubError('RATE_LIMITED', 'that person has too many unread messages', { retry_after_s: 30, reason: 'QUEUE_FULL' });
    if (this.db.get("SELECT COUNT(*) n FROM msg_messages WHERE source_user_id = ? AND state = 'queued'", src.user_id).n >= L.perSender) throw new HubError('RATE_LIMITED', 'too many of your messages are waiting', { retry_after_s: 30, reason: 'QUEUE_FULL' });

    const now = this.nowMs();
    const m = {
      id: randomUUID(), request_id: request, request_hash: fingerprint, kind, source_kind: src.kind, source_user_id: src.user_id,
      source_cred_kind: src.cred.kind, source_cred_id: src.cred.id, source_target_id: src.target?.id ?? null,
      dest_kind: t ? 'session' : 'person', dest_target_id: t?.id ?? null, dest_user_id: destUser, org_id: orgId, card_id: cardId,
      conversation_id: reply?.conversation_id ?? convo ?? null, reply_to: reply?.id ?? null, caused_by: cause?.id ?? null, body: text,
      handoff: handoff ? JSON.stringify(handoff) : null, handoff_state: handoff ? 'offered' : null, hop, visited: JSON.stringify(visited),
      authority_version: t ? t.generation : 0, state: 'queued', attempts: 0, created_at: this.at(now), expires_at: this.at(now + ttl * 1000), updated_at: this.at(now),
    };
    m.conversation_id ??= m.id;
    return this.hub.txn(() => {
      this.db.insert('msg_messages', m);
      this.journal(m);
      // A person's reply answers the message it replies to.
      if (reply && !t && reply.dest_kind === 'person' && reply.dest_user_id === src.user_id && ['queued', 'delivered'].includes(reply.state)) {
        this.update(reply, { state: 'replied', replied_at: this.at(), phase: null, ...(reply.delivered_at ? {} : { delivered_at: this.at() }) });
      }
      if (t) this.hub.later(() => this.wake(t.host_device_id));
      return { message: this.project(this.db.get('SELECT * FROM msg_messages WHERE id = ?', m.id), src.user_id) };
    });
  }

  mine(ident, mid) {
    const m = typeof mid === 'string' && UUID.test(mid) ? this.db.get('SELECT * FROM msg_messages WHERE id = ?', mid) : null;
    const uid = ident.user.id;
    if (!m || (m.source_user_id !== uid && m.dest_user_id !== uid)) throw missing();
    // A recipient (person, or owner of a shared session) who left the team no longer sees it.
    if (m.dest_user_id === uid && m.source_user_id !== uid && m.org_id && !this.member(uid, m.org_id)) throw missing();
    return this.fresh(m);
  }
  get(ident, mid) { limitOrThrow(this.hub, 'messaging_read_user', ident.user.id); this.sweep(); return { message: this.project(this.mine(ident, mid), ident.user.id) }; }

  list(ident, query) {
    limitOrThrow(this.hub, 'messaging_read_user', ident.user.id);
    this.sweep();
    const box = query?.get?.('box') ?? 'inbox';
    if (!['inbox', 'sent'].includes(box)) throw invalid();
    const limit = Math.min(50, Math.max(1, Number.parseInt(query?.get?.('limit') ?? '50', 10) || 50));
    const uid = ident.user.id;
    const rows = box === 'sent' ? this.db.all('SELECT * FROM msg_messages WHERE source_user_id = ? ORDER BY seq DESC LIMIT ?', uid, limit)
      : this.db.all('SELECT * FROM msg_messages WHERE dest_user_id = ? ORDER BY seq DESC LIMIT ?', uid, limit * 2)
        .filter((m) => !m.org_id || m.source_user_id === uid || this.member(uid, m.org_id)).slice(0, limit);
    return { messages: rows.map((m) => this.project(this.fresh(m), uid)) };
  }

  receipt(ident, mid, body) {
    shape(body, ['state'], ['state']);
    if (body.state !== 'delivered') throw invalid();
    this.sweep();
    const m = this.mine(ident, mid);
    if (m.dest_kind !== 'person' || m.dest_user_id !== ident.user.id) throw missing();
    if (m.state === 'queued') this.hub.txn(() => this.update(m, { state: 'delivered', delivered_at: this.at() }));
    return { message: this.project(m, ident.user.id) };
  }

  decide(ident, mid, body) {
    shape(body, ['decision', 'report'], ['decision']);
    this.sweep();
    const m = this.mine(ident, mid);
    if (m.dest_kind !== 'person' || m.dest_user_id !== ident.user.id || m.kind !== 'handoff') throw missing();
    this.decideHandoff(m, body);
    return { message: this.project(m, ident.user.id) };
  }

  decideHandoff(m, body) {
    if (!['accept', 'decline'].includes(body.decision)) throw invalid();
    const report = this.text(body.report, this.limits.reportChars, null, { optional: true });
    if (!['queued', 'delivered', 'replied'].includes(m.state) || m.handoff_state !== 'offered' || this.handoffExpired(m) || (m.state === 'queued' && m.phase === 'accepted')) throw new HubError('CONFLICT', 'this handoff can no longer be decided');
    this.hub.txn(() => this.update(m, { handoff_state: body.decision === 'accept' ? 'accepted' : 'declined', handoff_report: report,
      ...(m.state === 'queued' ? { state: 'delivered', delivered_at: this.at(), phase: null } : {}) }));
  }

  // ── host devices ──────────────────────────────────────────────────────────
  asHost(ident) {
    if (ident?.cred?.kind !== 'device') throw new HubError('FORBIDDEN', 'hosting sessions needs the desktop app');
    const d = this.db.get('SELECT interaction_role, user_id, revoked_at FROM user_devices WHERE id = ?', ident.cred.id);
    if (!d || d.revoked_at || d.user_id !== ident.user.id || d.interaction_role !== 'host') throw new HubError('FORBIDDEN', 'turn on hosting on this device first');
    return ident.cred.id;
  }

  syncTargets(ident, body) {
    const dev = this.asHost(ident), uid = ident.user.id, L = this.limits;
    shape(body, ['targets'], ['targets']);
    if (!Array.isArray(body.targets) || body.targets.length > L.targetsPerHost) throw invalid('too many sessions');
    const wanted = body.targets.map((x) => {
      shape(x, ['session', 'generation', 'provider', 'label', 'scope', 'org_id', 'card_id', 'automation'], ['session', 'generation', 'provider', 'scope']);
      if (typeof x.provider !== 'string' || !PROVIDER.test(x.provider) || !['personal', 'team'].includes(x.scope)
        || (x.scope === 'personal' && x.org_id != null)) throw invalid();
      const w = { session: uuid(x.session), generation: int(x.generation, 1, Number.MAX_SAFE_INTEGER), provider: x.provider,
        label: x.label == null ? null : this.text(x.label, L.labelChars).replace(/\s+/g, ' '), scope: x.scope,
        org_id: x.scope === 'team' ? id(x.org_id) : null, card_id: id(x.card_id, true), automation: null };
      if (x.automation != null) {
        const a = shape(x.automation, ['sessions', 'max_hops', 'turns_per_hour', 'parallel'], ['sessions']);
        if (typeof a.sessions !== 'boolean') throw invalid();
        w.automation = a.sessions ? JSON.stringify({ sessions: true, max_hops: int(a.max_hops, 1, L.maxHops, 1), turns_per_hour: int(a.turns_per_hour, 1, 30, 6), parallel: int(a.parallel, 1, 4, 1) }) : null;
      }
      // Only the owner's own team, and only a card they can see in it.
      if (w.scope === 'team' && !this.member(uid, w.org_id)) throw missing();
      if (w.card_id && !this.card(uid, w.card_id, w.org_id)) throw missing();
      return w;
    });
    if (new Set(wanted.map((w) => w.session)).size !== wanted.length) throw invalid();
    const now = this.at();
    const same = (t, w) => t && t.user_id === uid && t.generation === w.generation && t.scope === w.scope && t.org_id === w.org_id && t.provider === w.provider;
    return this.hub.txn(() => {
      const live = new Map(this.db.all('SELECT * FROM msg_targets WHERE host_device_id = ? AND retired_at IS NULL', dev).map((t) => [t.session, t]));
      // Each new generation or scope is a new row: bounded per host per hour.
      const fresh = wanted.filter((w) => !same(live.get(w.session), w)).length;
      if (fresh && this.db.get('SELECT COUNT(*) n FROM msg_targets WHERE host_device_id = ? AND registered_at > ?', dev, this.at(this.nowMs() - 3_600_000)).n + fresh > L.registrationsPerHour) {
        throw new HubError('RATE_LIMITED', 'too many session changes from this device; try again later', { retry_after_s: 300, reason: 'TARGET_CHURN' });
      }
      const out = [];
      for (const w of wanted) {
        const t = live.get(w.session);
        live.delete(w.session);
        if (same(t, w)) {
          this.db.run('UPDATE msg_targets SET label = ?, card_id = ?, automation = ?, seen_at = ? WHERE id = ?', w.label, w.card_id, w.automation, now, t.id);
          out.push({ session: w.session, generation: w.generation, target: t.id });
          continue;
        }
        if (t) this.retire(t, t.generation !== w.generation || t.provider !== w.provider ? 'target_replaced' : 'unshared');
        const row = { id: randomUUID(), user_id: uid, host_device_id: dev, ...w, registered_at: now, seen_at: now };
        this.db.insert('msg_targets', row);
        this.hub.journal({ board_id: null, actor_kind: 'system', kind: 'msg.target', payload: { target: row.id, registered: row.scope } });
        out.push({ session: w.session, generation: w.generation, target: row.id });
      }
      for (const t of live.values()) this.retire(t, 'target_gone');
      return { targets: out };
    });
  }

  async pull(ident, body) {
    const dev = this.asHost(ident);
    shape(body, ['wait_ms']);
    const wait = int(body.wait_ms, 0, this.limits.pullWaitMaxMs, 0);
    let out = this.lease(dev);
    if (!out.length && wait) {
      if ((this.waiters.get(dev)?.size ?? 0) >= this.limits.parkedPulls) throw new HubError('RATE_LIMITED', 'this device is already waiting for messages', { retry_after_s: 5 });
      await this.waitFor(dev, Math.min(wait, this.nextRetryMs(dev) ?? wait));
      // Revoked or turned off while waiting: nothing is handed out.
      if (!this.hub.accounts.credValid(ident.cred)) throw new HubError('UNAUTHENTICATED', 'device token unknown or revoked: sign in again');
      this.asHost(ident);
      out = this.lease(dev);
    }
    return { messages: out };
  }

  nextRetryMs(dev) {
    const r = this.db.get(`SELECT MIN(m.lease_until) u FROM msg_messages m JOIN msg_targets t ON t.id = m.dest_target_id
      WHERE t.host_device_id = ? AND m.state = 'queued' AND m.phase IS NULL AND m.lease_until IS NOT NULL`, dev)?.u;
    return r ? Math.max(50, Date.parse(r) - this.nowMs()) : null;
  }

  lease(dev) {
    this.sweep();
    const now = this.at(), L = this.limits;
    return this.hub.txn(() => {
      this.db.run('UPDATE msg_targets SET seen_at = ? WHERE host_device_id = ? AND retired_at IS NULL', now, dev);
      const rows = this.db.all(`SELECT m.* FROM msg_messages m JOIN msg_targets t ON t.id = m.dest_target_id
        WHERE t.host_device_id = ? AND m.state = 'queued' AND m.phase IS NULL AND (m.lease_until IS NULL OR m.lease_until <= ?)
        ORDER BY m.seq LIMIT ?`, dev, now, L.pullBatch * 4);
      const out = [];
      for (const m of rows) {
        if (out.length >= L.pullBatch) break;
        // Re-validated immediately before it is handed out.
        const p = this.problem(m);
        if (p) { this.finish(m, p.state, p.reason); continue; }
        const lease = randomBytes(18).toString('base64url');
        this.update(m, { phase: 'leased', lease, lease_until: this.at(this.nowMs() + L.leaseMs), attempts: m.attempts + 1 }, false);
        const t = this.target(m.dest_target_id);
        out.push({ ...this.project(m, t.user_id), lease, session: t.session, generation: t.generation });
      }
      return out;
    });
  }

  report(ident, mid, body) {
    const dev = this.asHost(ident);
    shape(body, ['lease', 'phase', 'reason', 'response', 'turn', 'decision', 'report'], ['lease', 'phase']);
    this.sweep();
    const m = typeof mid === 'string' && UUID.test(mid) ? this.db.get('SELECT * FROM msg_messages WHERE id = ?', mid) : null;
    const t = this.target(m?.dest_target_id);
    if (!m || !t || t.host_device_id !== dev || t.user_id !== ident.user.id || !sameSecret(body.lease, m.lease)) throw missing();
    const reason = body.reason == null ? null : this.text(body.reason, 60).replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const inflight = m.state === 'queued' && (m.phase === 'leased' || m.phase === 'accepted');
    const conflict = () => new HubError('CONFLICT', 'that report does not fit this message now', { state: m.state });
    const L = this.limits;
    return this.hub.txn(() => {
      switch (body.phase) {
        case 'accepted': {
          if (m.state !== 'queued' || m.phase !== 'leased') return { state: m.state, proceed: false };
          // Re-validated after the awaited pull, before any side effect.
          const p = this.problem(m);
          if (p) { this.finish(m, p.state, p.reason); return { state: m.state, proceed: false }; }
          this.update(m, { phase: 'accepted', lease_until: this.at(this.nowMs() + L.leaseMs) }, false);
          return { state: 'queued', proceed: true };
        }
        case 'not_sent':
          if (!inflight) throw conflict();
          this.update(m, { phase: null, reason: reason ?? 'busy', lease_until: this.at(this.nowMs() + L.busyBackoffMs) }, false);
          return { state: 'queued' };
        case 'rejected':
          if (!inflight) throw conflict();
          this.finish(m, 'rejected', `receiver_${reason ?? 'refused'}`);
          return { state: m.state };
        case 'unknown':
          if (!(m.state === 'queued' && m.phase === 'accepted')) throw conflict();
          this.finish(m, 'outcome_unknown', `receiver_${reason ?? 'unknown'}`);
          return { state: m.state };
        case 'delivered':
          // A late but real provider acknowledgement replaces an unknown outcome.
          if (!((m.state === 'queued' && m.phase === 'accepted') || m.state === 'outcome_unknown')) throw conflict();
          this.update(m, { state: 'delivered', phase: null, reason: null, delivered_at: this.at() });
          return { state: m.state };
        case 'replied': {
          if (m.state !== 'delivered') throw conflict();
          const response = this.text(body.response, L.responseChars, L.responseChars * 4);
          this.update(m, { state: 'replied', response, replied_at: this.at() });
          return { state: m.state };
        }
        case 'turn_ended':
          // Once, and only for a turn that did not answer (an answer is `replied`).
          if (m.state !== 'delivered' || !['interrupted', 'failed'].includes(body.turn) || m.reason != null) throw conflict();
          this.update(m, { reason: `turn_${body.turn}` });
          return { state: m.state };
        case 'handoff':
          if (m.kind !== 'handoff' || !['delivered', 'replied'].includes(m.state)) throw conflict();
          // The deciding session must still be the one it was handed to, under the same authority.
          if (this.targetProblem(t) || t.generation !== m.authority_version) throw conflict();
          this.decideHandoff(m, { decision: body.decision, report: body.report });
          return { state: m.state, handoff_state: m.handoff_state };
        default: throw invalid();
      }
    });
  }

  hostSend(ident, body) {
    const dev = this.asHost(ident);
    shape(body, ['request_id', 'from', 'to', 'body', 'kind', 'card_id', 'caused_by', 'handoff', 'ttl_s'], ['request_id', 'from', 'to', 'body']);
    const from = shape(body.from, ['session', 'generation'], ['session', 'generation']);
    const src = this.db.get('SELECT * FROM msg_targets WHERE host_device_id = ? AND session = ? AND retired_at IS NULL', dev, uuid(from.session));
    if (!src || src.user_id !== ident.user.id || src.generation !== from.generation || this.targetProblem(src)) throw missing();
    const { from: _f, ...rest } = body;
    return this.create({ kind: 'session', user_id: ident.user.id, cred: ident.cred, target: src }, rest);
  }

  // ── long-poll ─────────────────────────────────────────────────────────────
  waitFor(dev, ms) {
    return new Promise((resolve) => {
      let set = this.waiters.get(dev);
      if (!set) { set = new Set(); this.waiters.set(dev, set); }
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size && this.waiters.get(dev) === set) this.waiters.delete(dev); resolve(); };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      set.add(done);
    });
  }
  wake(dev) { for (const f of [...(this.waiters.get(dev) ?? [])]) f(); }
  close() { for (const set of [...this.waiters.values()]) for (const f of [...set]) f(); }

  routes(route) {
    const p = '/api/messaging/v1';
    const o = { auth: 'user', replay: false };
    route('GET', `${p}/targets`, ({ ident }) => this.targets(ident), o);
    route('POST', `${p}/messages`, ({ ident, body }) => this.send(ident, body), { ...o, strictBody: true, maxBody: 32 * 1024 });
    route('GET', `${p}/messages`, ({ ident, query }) => this.list(ident, query), o);
    route('GET', `${p}/messages/:id`, ({ ident, params }) => this.get(ident, params.id), o);
    route('POST', `${p}/messages/:id/receipt`, ({ ident, params, body }) => this.receipt(ident, params.id, body), { ...o, strictBody: true });
    route('POST', `${p}/messages/:id/handoff`, ({ ident, params, body }) => this.decide(ident, params.id, body), { ...o, strictBody: true });
    route('PUT', `${p}/host/targets`, ({ ident, body }) => this.syncTargets(ident, body), { ...o, strictBody: true, maxBody: 32 * 1024 });
    route('POST', `${p}/host/pull`, ({ ident, body }) => this.pull(ident, body), { ...o, strictBody: true });
    route('POST', `${p}/host/messages/:id/report`, ({ ident, params, body }) => this.report(ident, params.id, body), { ...o, strictBody: true, maxBody: 96 * 1024 });
    route('POST', `${p}/host/send`, ({ ident, body }) => this.hostSend(ident, body), { ...o, strictBody: true, maxBody: 32 * 1024 });
  }
}

export { STATES as MESSAGE_STATES };
