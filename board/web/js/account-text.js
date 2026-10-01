// The web pages' side of accounts mode (ACCOUNTS-API.md): plain sentences for
// the hub's error codes (its messages are written for developers), the gate
// on asking for another sign-in code, and what a pasted invite is. Pure, so
// the sign-in page, the invite page and the board app share it and tests
// import it.
import { BRAND } from '../../shared/brand.js';

export const SEND_FAILED = 'We couldn’t send the email. Try again in a minute.';
export const EMAIL_OFF = `Email sign-in is off on this board. Sign in with the ${BRAND.name} app instead.`;
export const INVITE_INVALID = 'This invite is not valid: it may have expired, been used or been withdrawn. Ask for a new one.';
export const WRONG_ACCOUNT = 'This invite was sent to a different email address. Sign in with that address to join.';
export const NO_REACH = 'Can’t reach the board. Check your connection and try again.';

export const INVITE_TOKEN_RE = /^inv_[A-Za-z0-9_-]{43}$/;
const INVITE_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

/** "a minute", "5 minutes", "2 hours": a lockout can run up to a day. */
export function waitFor(seconds) {
  const s = Number(seconds) > 0 ? Number(seconds) : 60;
  if (s <= 60) return 'a minute';
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} minutes`;
  const hrs = Math.ceil(m / 60);
  return `${hrs} hours`;
}

/**
 * One sentence for a failed accounts call. `err` is {status, code, extra}
 * (api.js's ApiError has that shape); `step` is where it failed: 'start'
 * (asking for a code), 'verify' (typing it), 'team' (creating one) or
 * 'invite' (joining, or making an invite).
 */
export function accountErrorText(err, step) {
  const status = err?.status ?? 0;
  const code = err?.code ?? null;
  const extra = err?.extra ?? {};
  if (code === 'RATE_LIMITED' || status === 429) return `Too many tries. Wait ${waitFor(extra.retry_after_s)} and try again.`;
  // The hub answers a start before it mails, so a failing mailer can't show here; a start that
  // fails outright is the nearest thing the page can see.
  if (step === 'start' && (status === 0 || status >= 500 || code === 'NETWORK')) return SEND_FAILED;
  if (status === 0 || code === 'NETWORK') return NO_REACH;
  if (status >= 500) return 'The board had a problem. Try again in a minute.';
  switch (code) {
    case 'METHOD_DISABLED': return EMAIL_OFF;
    case 'INVALID_TOKEN': {
      if (step !== 'verify') return step === 'invite' ? INVITE_INVALID : 'That didn’t work. Try again.';
      const n = extra.attempts_left;
      if (Number.isInteger(n) && n > 0) return `That code isn’t right. ${n} ${n === 1 ? 'try' : 'tries'} left.`;
      return 'That code has expired or had too many wrong tries. Ask for a new one.';
    }
    case 'VALIDATION':
      if (step === 'start') return 'Enter your email address, like you@example.com.';
      if (step === 'team') return 'Give the team a name, up to 60 characters.';
      if (step === 'invite') return 'Enter their email address.';
      return 'Check what you typed and try again.';
    case 'WRONG_ACCOUNT': return WRONG_ACCOUNT;
    case 'ALREADY_MEMBER': return step === 'invite' && !extra.team ? 'They’re already in this team.' : `You’re already in ${extra.team?.name ? String(extra.team.name).slice(0, 60) : 'this team'}.`;
    case 'CONFLICT': return extra.invite_id ? 'There’s already an invite waiting for that address.' : 'That clashes with something that changed. Reload and try again.';
    case 'QUOTA_EXCEEDED':
      if (extra.resource === 'teams') return 'You already own as many teams as your plan allows.';
      if (extra.resource === 'members') return 'This team is full.';
      return 'Your plan’s limit is reached.';
    case 'EMAIL_UNVERIFIED': return 'Confirm your email address first: sign out and sign in again with an email code.';
    case 'FORBIDDEN': return step === 'invite' ? 'Only the team’s owners and admins can invite people.' : 'You’re not allowed to do that.';
    case 'UNAUTHENTICATED': return 'Your session ended. Sign in again.';
    default: return 'Something went wrong. Try again.';
  }
}

// The hub's quiet limit on codes is 3 per 15 minutes for an address: past it
// the answer looks the same but no mail goes and the newest flow is a dud, so
// the page never asks a fourth time, and leaves a gap between asks.
export const RESEND = Object.freeze({ gapMs: 30_000, windowMs: 15 * 60_000, max: 3 });

/** Seconds to wait before asking for another code (0: now), from when codes were asked for. */
export function resendWaitS(sentAt, now) {
  const recent = sentAt.filter((t) => now - t < RESEND.windowMs).sort((a, b) => a - b);
  if (recent.length >= RESEND.max) return Math.ceil((recent[recent.length - RESEND.max] + RESEND.windowMs - now) / 1000);
  const last = recent.at(-1);
  return last != null && now - last < RESEND.gapMs ? Math.ceil((last + RESEND.gapMs - now) / 1000) : 0;
}

export const resendWaitText = (s) => (s <= 60 ? `You can ask for a new code in ${s} seconds.` : `You can ask for a new code in ${waitFor(s)}.`);

/**
 * What someone pasted into "Join with a code or invite link": {code}, {t},
 * or {error}. A link to another board is refused here: its token would only
 * be spent on (and shown to) this one.
 */
export function parseJoin(text, origin) {
  const s = String(text ?? '').trim();
  if (!s) return { error: 'Paste the invite link or type the code.' };
  if (INVITE_CODE_RE.test(s.toUpperCase())) return { code: s.toUpperCase() };
  if (INVITE_TOKEN_RE.test(s)) return { t: s };
  let u;
  try { u = new URL(s); } catch { return { error: 'That doesn’t look like an invite. Paste the whole link, or the code like ABCD-EFGH.' }; }
  if (u.protocol === 'https:' || u.protocol === 'http:') {
    if (u.origin !== origin) return { error: 'That invite is for another board. Open the link itself instead.' };
    let t = null;
    try { t = decodeURIComponent(u.hash.slice(1)).trim(); } catch { t = null; }
    if (u.pathname === '/invite' && t && INVITE_TOKEN_RE.test(t)) return { t };
  }
  return { error: 'That doesn’t look like an invite. Paste the whole link, or the code like ABCD-EFGH.' };
}
