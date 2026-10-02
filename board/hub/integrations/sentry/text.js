// What a Sentry issue may put on a card (CONTRACT D42 addendum "the Sentry
// connector", Card text). A project's DSN is public, so every string in an
// issue payload can be written by anyone on the internet: a card is a fixed
// template of validated parts, and the only free text (the culprit, and the
// message when an admin turns it on) goes through scrub().

export const SUGGESTION = 'Suggested: review this issue, choose an AI and start a fix from the card.';
// Most severe first: min_level drops anything with a higher index.
export const LEVELS = Object.freeze(['fatal', 'error', 'warning', 'info', 'debug']);
export const ISSUE_ID_RE = /^\d{1,20}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const TITLE_MAX = 120;
const BODY_MAX = 1500;
const CULPRIT_MAX = 60;
const MESSAGE_MAX = 80;
const TYPE_RE = /^[A-Za-z_][\w.]{0,60}$/;
const SHORT_ID_RE = /^[A-Z0-9_-]{1,64}-[A-Z0-9]{1,16}$/;
const COUNT_RE = /^\d{1,15}$/;
const ORG_RE = /^[a-z0-9-]{1,50}$/;
const HOSTS = new Set(['sentry.io', 'us.sentry.io', 'de.sentry.io']);
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

// Scrub. Work is bounded before any regex runs (a 1 MiB culprit must not be
// a slow request); the output is at most 80 code points anyway.
const SCRUB_INPUT_MAX = 2048;
const REDACTED = '[redacted]';
const MARK = '\u0000'; // stands in for a redaction: \p{C} is gone by then, so no input can forge it
const SPACING = /[\t\n\v\f\r\p{Zl}\p{Zp}]/gu;
const INVISIBLE = /\p{C}/gu;
const WRAPPED_MENTION = /<[@!#][^>]*>/g;
const URL_ANY = /\b[a-z][a-z0-9+.-]{0,31}:\/\/\S*|\b(?:javascript|vbscript|data|file|mailto|tel|sms|blob|about|ftp|wss?|https?):\S*|\bwww\.\S+/gi;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const AT_MENTION = /@[\w.-]+/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:)+:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*/gi;
const OPAQUE_RUN = /[A-Za-z0-9_-]{24,}/g;
const LONG_DIGITS = /\d{9,}/g;
// Markdown, HTML and chat markup, and the angle/backtick lookalikes NFKC leaves alone.
const MARKUP = /[<>`*_[\]()#|~\\\u2039\u203a\u02c2\u02c3]/g;

const own = (o, k) => (o !== null && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, k) ? o[k] : undefined);
export { own };

// On code points; a cut never leaves half a [redacted] to read as brackets.
function cap(s, max) {
  const cp = [...s];
  if (cp.length <= max) return s;
  return `${cp.slice(0, max - 3).join('').replace(/\[(?:r(?:e(?:d(?:a(?:c(?:t(?:e(?:d)?)?)?)?)?)?)?)?$/, '').trimEnd()}...`;
}

/** Plain text from a hostile string: no controls, markup, mentions, links, addresses or ids; ≤ max code points. */
export function scrub(value, max) {
  if (typeof value !== 'string') return '';
  let t = value;
  // A token cut by the bound must not survive as a short, unredacted stub.
  if (t.length > SCRUB_INPUT_MAX) t = t.slice(0, SCRUB_INPUT_MAX).replace(/[A-Za-z0-9_-]+$/, '');
  t = t.normalize('NFKC').replace(SPACING, ' ').replace(INVISIBLE, '');
  t = t.replace(WRAPPED_MENTION, MARK).replace(URL_ANY, MARK).replace(EMAIL, MARK).replace(AT_MENTION, MARK)
    .replace(IPV4, MARK).replace(IPV6, MARK).replace(OPAQUE_RUN, MARK).replace(LONG_DIGITS, MARK)
    .replace(MARKUP, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replaceAll(MARK, REDACTED);
  return cap(t, max);
}

/** Epoch ms of a strict ISO-8601 date-time with a zone (a real calendar date), else null. */
export function parseIso(v) {
  const m = typeof v === 'string' ? ISO_RE.exec(v) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (h > 23 || mi > 59 || s > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s, Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3)));
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (m[8] === 'Z') return t;
  const oh = Number(m[8].slice(1, 3));
  const om = Number(m[8].slice(4, 6));
  if (oh > 23 || om > 59) return null;
  return t - (m[8][0] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
}

/**
 * The issue's web_url, never taken on trust: https on sentry.io (or a region
 * or an org's subdomain), no port, credentials, query or fragment, the path of
 * THIS issue; rebuilt from those parts. Anything else is null (no link).
 */
export function issueLink(issue) {
  const id = own(issue, 'id');
  const raw = own(issue, 'web_url');
  if (typeof id !== 'string' || !ISSUE_ID_RE.test(id) || typeof raw !== 'string' || raw.length > 500) return null;
  if (!raw.startsWith('https://') || /[?#@\\\s%]/.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash) return null;
  const host = u.hostname;
  const sub = host.endsWith('.sentry.io') ? host.slice(0, -'.sentry.io'.length) : null;
  if (!HOSTS.has(host) && !(sub && ORG_RE.test(sub))) return null;
  const m = /^\/(?:organizations\/([a-z0-9-]{1,50})\/)?issues\/(\d{1,20})\/?$/.exec(u.pathname);
  if (!m || m[2] !== id) return null;
  return `https://${host}/${m[1] ? `organizations/${m[1]}/` : ''}issues/${id}/`;
}

const count = (v) => {
  if (typeof v === 'string' && COUNT_RE.test(v)) return Number(v);
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
};

/** {title ≤ 120, body ≤ 1500}: the fixed template; the message only with includeMessage. */
export function cardText(issue, { includeMessage = false } = {}) {
  const meta = own(issue, 'metadata');
  const rawType = own(meta, 'type');
  const type = typeof rawType === 'string' && TYPE_RE.test(rawType) ? rawType : 'Error';
  const culprit = scrub(own(issue, 'culprit'), CULPRIT_MAX);
  let title = `Sentry: ${type}${culprit ? ` in ${culprit}` : ''}`;
  if (includeMessage) {
    const value = own(meta, 'value');
    const message = scrub(typeof value === 'string' && value ? value : own(issue, 'title'), MESSAGE_MAX);
    if (message) title += ` : ${message}`;
  }
  const lines = [];
  const level = own(issue, 'level');
  if (LEVELS.includes(level)) lines.push(`Level: ${level}`);
  const slug = own(own(issue, 'project'), 'slug');
  if (typeof slug === 'string' && SLUG_RE.test(slug)) lines.push(`Project: ${slug}`);
  const shortId = own(issue, 'shortId');
  if (typeof shortId === 'string' && SHORT_ID_RE.test(shortId)) lines.push(`Issue: ${shortId}`);
  const events = count(own(issue, 'count'));
  if (events !== null) lines.push(`Events: ${events}`);
  const users = count(own(issue, 'userCount'));
  if (users !== null) lines.push(`Users: ${users}`);
  const first = parseIso(own(issue, 'firstSeen'));
  if (first !== null) lines.push(`First seen: ${new Date(first).toISOString()}`);
  const link = issueLink(issue);
  if (link) lines.push(`Sentry: ${link}`);
  lines.push('', SUGGESTION);
  return { title: cap(title, TITLE_MAX), body: lines.join('\n').slice(0, BODY_MAX) };
}
