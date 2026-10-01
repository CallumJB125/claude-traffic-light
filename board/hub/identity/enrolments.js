// BOARD_AUTH=accounts, P4 (CONTRACT D79–D81, ACCOUNTS-API.md "Runner
// enrolment"): an install of the desktop app enrols as a runner in one team
// and gets a runner token (`brt_` + 32 random bytes, shown once, stored as
// sha256) bound to that team and that install. The runner socket presents it
// with `Board-Team`; the hub resolves the enrolment to its `devices` row, so
// RunnerConn works as before. Every reaper pass re-checks each enrolled socket.

import { randomBytes, randomUUID } from 'node:crypto';
import { WS_CLOSE } from '../../shared/protocol.js';
import { HubError } from '../db.js';
import { sha256hex } from '../auth.js';
import { can } from '../permissions.js';
import { limitOrThrow } from '../ratelimit.js';
import { ipPrefix } from './accounts.js';

export const RUNNER_TOKEN_PREFIX = 'brt_';
export const MAX_PER_USER_TEAM = 5;
export const MAX_PER_USER = 20;
const LIST_MAX = 200;
const TOUCH_MS = 60_000;
// One answer for every token the hub can't use for that team: unknown, or
// another team's (T-RUN-2).
export const BAD_RUNNER_TOKEN = 'runner token unknown or not for this team';

export const newRunnerToken = () => `${RUNNER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
export const isRunnerToken = (t) => typeof t === 'string' && t.startsWith(RUNNER_TOKEN_PREFIX);

export class Enrolments {
  constructor(hub, { accounts }) {
    this.hub = hub;
    this.db = hub.db;
    this.accounts = accounts;
  }

  audit(action, { user, org, target, detail = null, ip = null }) {
    this.accounts.audit(action, { user, org, target, detail, ip });
  }

  // The desktop app's own device token: enrolment is per install (D79).
  requireDevice(ident) {
    if (ident?.cred.kind !== 'device') throw new HubError('FORBIDDEN', 'enrolling a runner needs the desktop app (its device token)');
    return ident.cred.id;
  }

  active(userDeviceId, orgId) {
    return this.db.get('SELECT * FROM runner_enrollments WHERE user_device_id = ? AND org_id = ? AND revoked_at IS NULL', userDeviceId, orgId);
  }

  /**
   * POST /api/teams/:team_id/enrol {device_name?} → {enrollment_id, team_id, runner_token}.
   * Enrolling the same install in the same team again rotates: the old token dies at once.
   */
  enrol(member, ident, body, { ip }) {
    const udId = this.requireDevice(ident);
    if (!can(member, 'device.enrol')) throw new HubError('FORBIDDEN', 'viewers cannot run cards: ask an admin for the member role');
    let name = body.device_name;
    if (name != null && (typeof name !== 'string' || name.length > 100 || /[\p{C}]/u.test(name))) throw new HubError('VALIDATION', 'device_name must be a string ≤ 100, no control characters');
    const ud = this.db.get('SELECT * FROM user_devices WHERE id = ?', udId);
    name = (name ?? '').trim() || ud.name;
    limitOrThrow(this.hub, 'runner_enrol_user', ident.user.id);
    const old = this.active(udId, member.org_id);
    const inTeam = this.db.get('SELECT COUNT(*) AS n FROM runner_enrollments WHERE user_id = ? AND org_id = ? AND revoked_at IS NULL', ident.user.id, member.org_id).n - (old ? 1 : 0);
    if (inTeam >= MAX_PER_USER_TEAM) throw new HubError('QUOTA_EXCEEDED', `at most ${MAX_PER_USER_TEAM} runners per person in a team: remove one first`, { resource: 'runner_enrollments', limit: MAX_PER_USER_TEAM });
    const all = this.db.get('SELECT COUNT(*) AS n FROM runner_enrollments WHERE user_id = ? AND revoked_at IS NULL', ident.user.id).n - (old ? 1 : 0);
    if (all >= MAX_PER_USER) throw new HubError('QUOTA_EXCEEDED', `at most ${MAX_PER_USER} runner enrolments per person: remove one first`, { resource: 'runner_enrollments', limit: MAX_PER_USER });
    const now = this.hub.iso();
    const token = newRunnerToken();
    const id = randomUUID();
    // Reuse the runner device of the enrolment being rotated (its outbox seq
    // carries on) while it is still this membership's and not revoked.
    const prev = old && this.db.get('SELECT * FROM devices WHERE id = ? AND member_id = ? AND revoked_at IS NULL', old.device_id, member.id);
    const deviceId = prev?.id ?? randomUUID();
    this.hub.txn(() => {
      if (old) this.revokeRow(old, 'rotated', now);
      if (!prev) {
        // Never a legacy device token: this hash matches no token.
        this.db.insert('devices', { id: deviceId, member_id: member.id, name, kind: 'runner', token_hash: `enrolment:${randomUUID()}`, created_at: now });
      } else if (prev.name !== name) {
        this.db.run('UPDATE devices SET name = ? WHERE id = ?', name, deviceId);
      }
      this.db.insert('runner_enrollments', {
        id, org_id: member.org_id, user_id: ident.user.id, user_device_id: udId, member_id: member.id, device_id: deviceId, name,
        token_hash: sha256hex(token), session_epoch: this.accounts.epoch(), created_at: now, last_ip_prefix: ipPrefix(ip),
      });
      this.audit('runner.enrol', { user: ident.user.id, org: member.org_id, target: id, detail: { device_id: deviceId, ...(old ? { rotated: old.id } : {}) }, ip });
    });
    if (old) this.closeFor(old, WS_CLOSE.REVOKED, 'runner token rotated');
    return { enrollment_id: id, team_id: member.org_id, runner_token: token };
  }

  revokeRow(e, reason, now = this.hub.iso()) {
    this.db.run('UPDATE runner_enrollments SET revoked_at = ?, revoked_reason = ?, token_hash = NULL WHERE id = ? AND revoked_at IS NULL', now, reason, e.id);
  }

  // A runner socket authenticated by this enrolment (another one may use its device row now).
  closeFor(e, code, reason) {
    const conn = this.hub.runners.get(e.device_id);
    if (conn?.enrollmentId === e.id) {
      conn.close(code, reason);
      this.hub.presence.dropDevice(e.device_id);
    }
  }

  /** DELETE /api/teams/:team_id/enrol: this install stops being a runner in this team. The app stays signed in. */
  unenrol(member, ident, { ip }) {
    const udId = this.requireDevice(ident);
    const e = this.active(udId, member.org_id);
    if (!e) throw new HubError('NOT_FOUND', 'this device is not enrolled in this team');
    this.hub.txn(() => {
      this.revokeRow(e, 'unenrolled');
      this.audit('runner.unenrol', { user: ident.user.id, org: member.org_id, target: e.id, ip });
    });
    this.closeFor(e, WS_CLOSE.REVOKED, 'runner unenrolled');
    return { ok: true };
  }

  /** GET /api/teams/:team_id/enrolments: admins see the team's, others their own. */
  list(member, ident) {
    const all = can(member, 'repo.manage');
    const rows = this.db.all(`SELECT e.*, u.display_name FROM runner_enrollments e JOIN users u ON u.id = e.user_id
      WHERE e.org_id = ? ${all ? '' : 'AND e.user_id = ?'} ORDER BY e.created_at DESC, e.id LIMIT ${LIST_MAX}`, member.org_id, ...(all ? [] : [member.user_id]));
    return {
      enrolments: rows.map((e) => ({
        id: e.id, user: { id: e.user_id, display_name: e.display_name }, name: e.name, created_at: e.created_at, last_seen_at: e.last_seen_at,
        revoked_at: e.revoked_at, online: !e.revoked_at && this.hub.runners.get(e.device_id)?.enrollmentId === e.id,
        current: ident?.cred.kind === 'device' && ident.cred.id === e.user_device_id && !e.revoked_at,
      })),
    };
  }

  /** DELETE /api/teams/:team_id/enrolments/:enrollment_id: an admin, or the enrolment's own user. */
  revoke(member, id, { ip }) {
    const e = this.db.get('SELECT * FROM runner_enrollments WHERE id = ? AND org_id = ?', id, member.org_id);
    if (!e || e.revoked_at) throw new HubError('NOT_FOUND', 'enrolment not found');
    if (e.user_id !== member.user_id && !can(member, 'repo.manage')) throw new HubError('FORBIDDEN', 'only admins can remove other people\'s runners');
    this.hub.txn(() => {
      this.revokeRow(e, e.user_id === member.user_id ? 'removed_by_owner' : 'removed_by_admin');
      this.audit('runner.revoke', { user: member.user_id, org: member.org_id, target: e.id, ip });
    });
    this.closeFor(e, WS_CLOSE.REVOKED, 'runner removed');
    return { ok: true };
  }

  // ── sockets ───────────────────────────────────────────────────────────────

  /**
   * Is this enrolment good for a runner socket right now? → null, or
   * {close, reason}. Revoked, removed, demoted to viewer, team deleted →
   * 4403; the install signed out, the account deleted or a restore → 4401.
   */
  problem(e) {
    const epoch = this.accounts.epoch();
    if (!e) return { close: WS_CLOSE.REVOKED, reason: 'runner revoked' };
    // The install signed out (which also revokes its enrolments), the account went, or a restore: 4401.
    const ud = this.db.get('SELECT revoked_at, token_hash, session_epoch FROM user_devices WHERE id = ?', e.user_device_id);
    if (!ud || ud.revoked_at || !ud.token_hash || ud.session_epoch !== epoch || e.session_epoch !== epoch || !this.accounts.liveUser(e.user_id)) {
      return { close: WS_CLOSE.UNAUTHENTICATED, reason: 'signed out' };
    }
    if (e.revoked_at || !e.token_hash) return { close: WS_CLOSE.REVOKED, reason: 'runner revoked' };
    if (this.db.get('SELECT 1 AS x FROM orgs WHERE id = ? AND deleted_at IS NOT NULL', e.org_id)) return { close: WS_CLOSE.REVOKED, reason: 'team deleted' };
    const m = this.hub.activeMember(e.member_id);
    if (!m || m.user_id !== e.user_id || m.org_id !== e.org_id) return { close: WS_CLOSE.REVOKED, reason: 'member removed' };
    if (!can(m, 'device.enrol')) return { close: WS_CLOSE.REVOKED, reason: 'viewers cannot run cards' };
    const d = this.hub.device(e.device_id);
    if (!d || d.revoked_at || d.member_id !== e.member_id) return { close: WS_CLOSE.REVOKED, reason: 'runner revoked' };
    return null;
  }

  /** Upgrade auth for `Authorization: Bearer brt_…` + `Board-Team`: → {device, enrollmentId} or {close, reason}. */
  authenticate(token, team, { ip = null } = {}) {
    const e = this.db.get('SELECT * FROM runner_enrollments WHERE token_hash = ?', sha256hex(token));
    // Unknown, missing team, or another team's: the same answer (T-RUN-2).
    if (!e || typeof team !== 'string' || team !== e.org_id) return { close: WS_CLOSE.UNAUTHENTICATED, reason: BAD_RUNNER_TOKEN };
    const bad = this.problem(e);
    if (bad) return bad;
    if (this.hub.ageOf(e.last_seen_at) == null || this.hub.ageOf(e.last_seen_at) >= TOUCH_MS) {
      this.db.run('UPDATE runner_enrollments SET last_seen_at = ?, last_ip_prefix = COALESCE(?, last_ip_prefix) WHERE id = ?', this.hub.iso(), ipPrefix(ip), e.id);
    }
    return { device: this.hub.device(e.device_id), enrollmentId: e.id };
  }

  /** The backstop on every reaper pass (and after membership or credential changes). */
  recheck() {
    for (const conn of [...this.hub.runners.values()]) {
      if (!conn.enrollmentId) continue;
      const bad = this.problem(this.db.get('SELECT * FROM runner_enrollments WHERE id = ?', conn.enrollmentId));
      if (!bad) continue;
      conn.close(bad.close, bad.reason);
      this.hub.presence.dropDevice(conn.device_id);
    }
  }

  /** Signing an install out (or revoking it) ends its runner enrolments too, inside the caller's transaction. */
  revokeForUserDevice(userDeviceId, reason) {
    this.db.run("UPDATE runner_enrollments SET revoked_at = ?, revoked_reason = ?, token_hash = NULL WHERE user_device_id = ? AND revoked_at IS NULL", this.hub.iso(), reason, userDeviceId);
  }
}
