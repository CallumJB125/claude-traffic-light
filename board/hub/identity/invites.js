// BOARD_AUTH=accounts, P3 (ACCOUNTS-API.md "Invites", CONTRACT D64–D65):
// email-bound team invites. An admin or owner invites an address as a role no
// higher than their own (never owner). The link is https://<hub>/invite#<token>:
// the token rides in the URL fragment, so it never reaches the server or its
// logs; the /invite page POSTs it to preview (no auth, three fields) and the
// desktop app (plexiform://invite/<token>) POSTs it to accept. Acceptance needs
// a signed-in user whose VERIFIED email is the invite's. Tokens are 32 random
// bytes stored as sha256, single use, 7 days; a resend revokes the old one.

import { createHmac, hkdfSync, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { HubError } from '../db.js';
import { sha256hex } from '../auth.js';
import { limitOrThrow } from '../ratelimit.js';
import { emailOnlyIdentity } from '../views.js';
import { can, canInviteAs, INVITABLE_ROLES } from '../permissions.js';
import { BRAND } from '../../shared/brand.js';
import { ipPrefix, maskEmail, normalizeEmail } from './accounts.js';
import { publicTeam, quotaFor } from './teams.js';

export const INVITE_TTL_MS = 7 * 86_400_000;
export const TOKEN_RE = /^inv_[A-Za-z0-9_-]{43}$/;
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

const invalid = () => new HubError('INVALID_TOKEN', 'this invite is not valid: it may have expired, been used or been withdrawn. Ask for a new one.');

/**
 * A name people chose (team, inviter), made safe for a plain-text mail line:
 * no control/format characters, quotes or angle brackets, one line, bounded,
 * and nothing a mail client would turn into a link.
 */
export function mailName(s, max = 60) {
  return String(s ?? '')
    .replace(/[\p{C}"<>`]/gu, ' ')
    .replace(/[a-z][a-z0-9+.-]*:\/\//gi, '')
    .replace(/\b([a-z0-9-]+)\.([a-z]{2,})\b/gi, '$1[.]$2')
    .replace(/\s+/g, ' ').trim().slice(0, max) || 'Someone';
}

export const firstName = (name) => mailName(String(name ?? '').trim().split(/\s+/)[0], 30);

const when = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export class Invites {
  constructor(hub, { accounts, teams }) {
    this.hub = hub;
    this.db = hub.db;
    this.accounts = accounts;
    this.teams = teams;
    this.kCode = Buffer.from(hkdfSync('sha256', String(hub.secret), Buffer.alloc(0), 'board-accounts:invite-code', 32));
  }

  codeHash(email, code) { return createHmac('sha256', this.kCode).update(`${email}:${code.replace('-', '')}`).digest('hex'); }

  audit(action, { member = null, user = null, org = null, target = null, detail = null, ip = null }) {
    this.accounts.audit(action, { user: user ?? member?.user_id ?? null, org: org ?? member?.org_id ?? null, target, detail, ip });
  }

  now() { return this.hub.iso(); }

  /** Link origin: BOARD_PUBLIC_URL, else (loopback hub only) the loopback Host. */
  link(token, req) {
    const origin = this.accounts.linkOrigin(req);
    if (!origin) throw new HubError('VALIDATION', 'the hub has no BOARD_PUBLIC_URL to build invite links with');
    return `${origin}/invite#${token}`;
  }

  pendingCount(orgId) {
    return this.db.get('SELECT COUNT(*) AS n FROM invites WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', orgId, this.now()).n;
  }

  /** Live, pending, unexpired, in a team that isn't deleted. */
  usable(inv) {
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at <= this.now()) return false;
    return !!this.teams.org(inv.org_id);
  }

  view(inv) { return { id: inv.id, email: inv.email, role: inv.role, expires_at: inv.expires_at }; }

  // Every verified address the user holds: the primary one, and verified sign-in identities.
  verifiedEmails(user) {
    const set = new Set();
    if (user.primary_email && user.primary_email_verified_at) set.add(user.primary_email.toLowerCase());
    for (const r of this.db.all('SELECT email FROM identities WHERE user_id = ? AND email_verified = 1 AND email IS NOT NULL', user.id)) set.add(r.email.toLowerCase());
    return [...set];
  }

  // ── admin side ────────────────────────────────────────────────────────────

  /**
   * POST /api/teams/:team_id/invites {email, role} → {invite, link, code, mailed}.
   * The link (and so the token) and the short code are shown once; the hub
   * mails them only when it has a mailer (D66).
   */
  create(member, body, { ip, req }) {
    if (!can(member, 'invite.create')) throw new HubError('FORBIDDEN', 'only admins can invite');
    const email = normalizeEmail(body.email);
    const role = body.role ?? 'member';
    if (role !== 'owner' && !INVITABLE_ROLES.includes(role)) throw new HubError('VALIDATION', `role must be one of ${INVITABLE_ROLES.join(', ')}`);
    if (!canInviteAs(member, role)) throw new HubError('FORBIDDEN', role === 'owner' ? 'invites never make owners: invite, then change the role' : 'you cannot invite above your own role');
    const inviter = this.accounts.liveUser(member.user_id);
    if (!inviter?.primary_email_verified_at) throw new HubError('EMAIL_UNVERIFIED', 'verify your email address before inviting');
    const org = this.teams.org(member.org_id);
    const already = this.db.get(`SELECT 1 AS x FROM members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.removed_at IS NULL AND (lower(m.email) = ? OR u.primary_email = ?)`, org.id, email, email);
    if (already) throw new HubError('ALREADY_MEMBER', 'that address is already in the team', { team: { id: org.id, name: org.name } });
    const open = this.db.get('SELECT id FROM invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', org.id, email, this.now());
    if (open) throw new HubError('CONFLICT', 'that address already has a pending invite: resend it instead', { invite_id: open.id });
    this.checkQuota(org);
    this.limits(member, ip);
    return this.issue(member, org, { email, role }, { ip, req, action: 'invite.create' });
  }

  checkQuota(org, { replacing = null } = {}) {
    const pending = this.pendingCount(org.id) - (replacing ? 1 : 0);
    const pLimit = quotaFor(org.plan, 'pending_invites');
    if (pending >= pLimit) throw new HubError('QUOTA_EXCEEDED', `at most ${pLimit} pending invites per team`, { resource: 'pending_invites', limit: pLimit });
    const mLimit = quotaFor(org.plan, 'members');
    if (this.teams.activeMembers(org.id) + pending >= mLimit) throw new HubError('QUOTA_EXCEEDED', `this team's plan allows at most ${mLimit} members (pending invites count)`, { resource: 'members', limit: mLimit });
  }

  limits(member, ip) {
    limitOrThrow(this.hub, 'invite_team', member.org_id);
    limitOrThrow(this.hub, 'invite_user', member.user_id);
    limitOrThrow(this.hub, 'invite_ip', ip);
  }

  issue(member, org, { email, role, replaces = null }, { ip, req, action }) {
    const token = `inv_${randomBytes(32).toString('base64url')}`;
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const link = this.link(token, req);
    const now = this.now();
    const inv = {
      id: randomUUID(), org_id: org.id, token_hash: sha256hex(token), code_hash: this.codeHash(email, code), email, role,
      created_by: member.id, created_at: now, expires_at: new Date(this.hub.wallMs() + INVITE_TTL_MS).toISOString(), replaces, ip_prefix: ipPrefix(ip),
    };
    this.hub.txn(() => {
      if (replaces) this.db.run("UPDATE invites SET revoked_at = ?, revoke_reason = 'resent' WHERE id = ? AND accepted_at IS NULL", now, replaces);
      this.db.insert('invites', inv);
      this.audit(action, { member, target: inv.id, detail: { role, email_ref: this.accounts.emailRef(email), ...(replaces ? { replaces } : {}) }, ip });
    });
    const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
    // No mailer (D66): nothing is sent; the inviter shares the link or code themselves.
    const mailer = this.accounts.mailer;
    if (mailer) {
      const mail = inviteMail({ team: org.name, inviter: member.display_name, role, link, code: shown, email, expiresAt: inv.expires_at });
      mailer.send({ to: email, ...mail, idempotencyKey: inv.id })
        .catch((e) => this.hub.log.warn('invite mail failed', { mailer: mailer.kind, err: e.message }));
    }
    return { invite: this.view(inv), link, code: shown, mailed: !!mailer };
  }

  /** GET /api/teams/:team_id/invites: pending ones only, never tokens. */
  list(member) {
    if (!can(member, 'invite.list')) throw new HubError('FORBIDDEN', 'only admins can see invites');
    const rows = this.db.all(`SELECT i.*, m.display_name AS by_name FROM invites i JOIN members m ON m.id = i.created_by
      WHERE i.org_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? ORDER BY i.created_at, i.id`, member.org_id, this.now());
    return { invites: rows.map((r) => ({ ...this.view(r), created_at: r.created_at, created_by_name: r.by_name })) };
  }

  teamInvite(member, id) {
    const inv = this.db.get('SELECT * FROM invites WHERE id = ? AND org_id = ?', id, member.org_id);
    if (!inv) throw new HubError('NOT_FOUND', 'invite not found');
    return inv;
  }

  /** DELETE /api/teams/:team_id/invites/:invite_id */
  revoke(member, id, { ip }) {
    if (!can(member, 'invite.revoke')) throw new HubError('FORBIDDEN', 'only admins can withdraw invites');
    const inv = this.teamInvite(member, id);
    if (inv.accepted_at || inv.revoked_at) throw new HubError('NOT_FOUND', 'invite not found');
    this.hub.txn(() => {
      this.db.run("UPDATE invites SET revoked_at = ?, revoke_reason = 'revoked' WHERE id = ? AND accepted_at IS NULL", this.now(), inv.id);
      this.audit('invite.revoke', { member, target: inv.id, ip });
    });
    return { ok: true };
  }

  /** POST /api/teams/:team_id/invites/:invite_id/resend → {invite, link, code, mailed}: a new token and code; the old ones die. */
  resend(member, id, { ip, req }) {
    if (!can(member, 'invite.create')) throw new HubError('FORBIDDEN', 'only admins can invite');
    const inv = this.teamInvite(member, id);
    if (inv.accepted_at || inv.revoked_at) throw new HubError('NOT_FOUND', 'invite not found');
    if (!canInviteAs(member, inv.role)) throw new HubError('FORBIDDEN', 'you cannot invite above your own role');
    const org = this.teams.org(member.org_id);
    this.checkQuota(org, { replacing: inv.expires_at > this.now() ? inv.id : null });
    this.limits(member, ip);
    return this.issue(member, org, { email: inv.email, role: inv.role, replaces: inv.id }, { ip, req, action: 'invite.resend' });
  }

  /** Revoke pending invites (team deleted, inviter removed); runs inside the caller's transaction. */
  revokeWhere(column, value, reason) {
    this.db.run(`UPDATE invites SET revoked_at = ?, revoke_reason = ? WHERE ${column} = ? AND accepted_at IS NULL AND revoked_at IS NULL`, this.now(), reason, value);
  }

  // ── invitee side ──────────────────────────────────────────────────────────

  /** POST /api/invites/preview {t} (no auth): {team_name, inviter_first_name, role}; never the address. */
  preview(body, { ip }) {
    limitOrThrow(this.hub, 'invite_preview_ip', ip);
    const inv = typeof body.t === 'string' && TOKEN_RE.test(body.t) ? this.db.get('SELECT * FROM invites WHERE token_hash = ?', sha256hex(body.t)) : null;
    if (!this.usable(inv)) throw invalid();
    const org = this.teams.org(inv.org_id);
    return { team_name: org.name, inviter_first_name: firstName(this.hub.memberName(inv.created_by)), role: inv.role };
  }

  /**
   * POST /api/invites/accept {t} | {invite_id} | {code} (Bearer or cookie).
   * With the token: a bad, used, expired or withdrawn one → INVALID_TOKEN; a
   * valid one for another address → WRONG_ACCOUNT {email_masked}. Without it
   * (invite_id from pending_invites, or the short code from the mail) only
   * invites addressed to one of the caller's verified emails exist at all, so
   * anything else is INVALID_TOKEN. The address is matched at accept time.
   * Accepting again as the same user answers the same {team, member}.
   */
  accept(ident, body, { ip }) {
    limitOrThrow(this.hub, 'invite_accept_ip', ip);
    limitOrThrow(this.hub, 'invite_accept_user', ident.user.id);
    const user = ident.user;
    const emails = this.verifiedEmails(user);
    let inv = null;
    if (body.t != null) {
      inv = typeof body.t === 'string' && TOKEN_RE.test(body.t) ? this.db.get('SELECT * FROM invites WHERE token_hash = ?', sha256hex(body.t)) : null;
    } else if (body.invite_id != null) {
      const row = typeof body.invite_id === 'string' ? this.db.get('SELECT * FROM invites WHERE id = ?', body.invite_id) : null;
      inv = row && emails.includes(row.email) ? row : null;
    } else if (body.code != null) {
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      if (CODE_RE.test(code)) {
        for (const e of emails) {
          inv = this.db.get('SELECT * FROM invites WHERE email = ? AND code_hash = ? ORDER BY created_at DESC LIMIT 1', e, this.codeHash(e, code));
          if (inv) break;
        }
      }
    } else {
      throw new HubError('VALIDATION', 'send t (the token from the link), invite_id or code');
    }
    if (!inv) throw invalid();
    // Same user again: the same answer (idempotent), as long as that membership still stands.
    if (inv.accepted_at) {
      const m = inv.accepted_by_user === user.id && this.hub.activeMember(inv.member_id);
      if (!m || !this.teams.org(inv.org_id)) throw invalid();
      return this.accepted(inv.org_id, m);
    }
    if (!this.usable(inv)) throw invalid();
    if (!emails.includes(inv.email)) {
      this.audit('invite.accept.wrong_account', { user: user.id, org: inv.org_id, target: inv.id, ip });
      throw new HubError('WRONG_ACCOUNT', `this invite is for ${maskEmail(inv.email)}: sign in with that address to accept it`, { email_masked: maskEmail(inv.email) });
    }
    const org = this.teams.org(inv.org_id);
    if (this.db.get('SELECT 1 AS x FROM members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL', org.id, user.id)) {
      throw new HubError('ALREADY_MEMBER', 'you are already in this team', { team: { id: org.id, name: org.name } });
    }
    const limit = quotaFor(org.plan, 'members');
    if (this.teams.activeMembers(org.id) >= limit) throw new HubError('QUOTA_EXCEEDED', `this team's plan allows at most ${limit} members`, { resource: 'members', limit });
    const now = this.now();
    let memberId;
    this.hub.txn(() => {
      memberId = this.join(org, user, inv, now);
      const r = this.db.run('UPDATE invites SET accepted_at = ?, accepted_by_user = ?, member_id = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL', now, user.id, memberId, inv.id);
      if (!Number(r.changes)) throw invalid();
      this.audit('invite.accept', { user: user.id, org: org.id, target: inv.id, detail: { member_id: memberId, role: inv.role }, ip });
    });
    this.notifyInviter(inv, org, user);
    return this.accepted(org.id, this.hub.member(memberId));
  }

  accepted(orgId, m) {
    return { team: publicTeam(this.teams.org(orgId)), member: { member_id: m.id, role: m.role } };
  }

  // The membership row: a removed one of the same user (or an unlinked
  // legacy row with this address) comes back, so history keeps pointing at it.
  join(org, user, inv, now) {
    const prev = this.db.get('SELECT * FROM members WHERE org_id = ? AND user_id = ?', org.id, user.id)
      ?? this.db.get('SELECT * FROM members WHERE org_id = ? AND user_id IS NULL AND lower(email) = ?', org.id, inv.email);
    if (prev) {
      this.db.run('UPDATE members SET removed_at = NULL, user_id = ?, role = ?, email = ?, display_name = ?, joined_via = ? WHERE id = ?',
        user.id, inv.role, inv.email, user.display_name, inv.id, prev.id);
      return prev.id;
    }
    const id = randomUUID();
    this.db.insert('members', {
      id, org_id: org.id, user_id: user.id, role: inv.role, display_name: user.display_name, email: inv.email,
      ...emailOnlyIdentity(inv.email), joined_via: inv.id, created_at: now,
    });
    return id;
  }

  notifyInviter(inv, org, user) {
    const by = this.hub.member(inv.created_by);
    const to = by && !by.removed_at && by.user_id ? this.accounts.liveUser(by.user_id)?.primary_email : null;
    if (!to || !this.accounts.mailer) return;
    const who = mailName(user.display_name);
    this.accounts.mailer.send({
      to,
      subject: `${who} joined ${mailName(org.name)} on ${BRAND.name}`,
      text: `${who} (${inv.email}) accepted your invite and joined the team "${mailName(org.name)}" on ${BRAND.name} as ${inv.role}.\n\nYou can change their role or remove them from the team's members page.\n`,
      idempotencyKey: `${inv.id}:accepted`,
    }).catch((e) => this.hub.log.warn('invite accepted mail failed', { mailer: this.accounts.mailer.kind, err: e.message }));
  }

  /** GET /api/account pending_invites: open invites for the user's verified addresses, in teams they aren't in. */
  pendingFor(user) {
    const emails = this.verifiedEmails(user);
    if (!emails.length) return [];
    const rows = this.db.all(`SELECT i.*, o.name AS team_name, m.display_name AS by_name FROM invites i
      JOIN orgs o ON o.id = i.org_id JOIN members m ON m.id = i.created_by
      WHERE i.email IN (${emails.map(() => '?').join(',')}) AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
        AND o.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM members x WHERE x.org_id = i.org_id AND x.user_id = ? AND x.removed_at IS NULL)
      ORDER BY i.created_at, i.id`, ...emails, this.now(), user.id);
    return rows.map((r) => ({ id: r.id, team_name: r.team_name, inviter_first_name: firstName(r.by_name), role: r.role, expires_at: r.expires_at }));
  }
}

function inviteMail({ team, inviter, role, link, code, email, expiresAt }) {
  const t = mailName(team);
  const who = mailName(inviter);
  return {
    subject: `${who} invited you to ${t} on ${BRAND.name}`,
    text: `${who} invited you to join the team "${t}" on ${BRAND.name} as ${role === 'admin' ? 'an admin' : `a ${role}`}.\n\n`
      + `Accept the invite:\n${link}\n\n`
      + `Or, in the ${BRAND.name} app, choose Join a team and enter this code: ${code}\n\n`
      + `The invite works once, only for ${email}, and expires on ${when(expiresAt)}.\n\n`
      + `You got this because ${who} invited ${email}. Ignore it to decline.\n`,
  };
}
