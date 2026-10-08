// Slack requests, the pure half: the v0 signature over the raw bytes with a
// timestamp window, a replay key from signed content, strict body parsing
// (form posts for commands and interactivity, JSON for events), workspace
// binding, the response_url allowlist, mrkdwn escaping, title cleaning and
// the modal's HMAC-bound private_metadata. No I/O, so every branch is
// testable with recorded fixtures.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const WINDOW_S = 300;
const TS_RE = /^[0-9]{1,12}$/;
const SIG_RE = /^v0=[0-9a-f]{64}$/;
const FORM_MAX = 256 * 1024;
const FIELD_MAX = 8 * 1024;
const FORM_KEY = /^[a-z_]{1,40}$/;
const EVENT_ID = /^Ev[A-Za-z0-9]{6,40}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const TEAM_ID = /^T[A-Z0-9]{2,20}$/;
export const APP_ID = /^A[A-Z0-9]{6,20}$/;
export const USER_ID = /^[UW][A-Z0-9]{2,20}$/;
export const CHANNEL_ID = /^[CGD][A-Z0-9]{2,20}$/;
export const MESSAGE_TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
export const TRIGGER_ID = /^[0-9]{1,20}\.[0-9]{1,20}\.[0-9a-f]{16,64}$/;

const header = (headers, name) => {
  const v = headers?.[name] ?? headers?.[name.toLowerCase()];
  // A repeated header is ambiguous (which one did Slack sign?): refused as empty.
  return Array.isArray(v) ? (v.length === 1 ? String(v[0]) : '') : v == null ? '' : String(v);
};
const asBuf = (raw) => (Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? '')));
const sha32 = (raw) => createHash('sha256').update(raw).digest('hex').slice(0, 32);

export function sign(secret, ts, rawBody) {
  return `v0=${createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`v0:${ts}:`), asBuf(rawBody)])).digest('hex')}`;
}

/**
 * {ok: true, dedupe_key} | {ok: false, reason}. The reason is a fixed code,
 * never anything from the request.
 */
export function verify({ headers, rawBody, secrets, now = Date.now() }) {
  const secret = secrets?.signing_secret;
  if (typeof secret !== 'string' || secret.length < 16) return { ok: false, reason: 'no signing secret' };
  const ts = header(headers, 'x-slack-request-timestamp');
  if (!TS_RE.test(ts)) return { ok: false, reason: 'bad timestamp' };
  // Stale or future: a captured request can't be replayed after its dedupe row is swept.
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > WINDOW_S) return { ok: false, reason: 'timestamp outside window' };
  const sig = header(headers, 'x-slack-signature');
  if (!SIG_RE.test(sig)) return { ok: false, reason: 'bad signature format' };
  const body = asBuf(rawBody);
  const got = Buffer.from(sig);
  const want = Buffer.from(sign(secret, ts, body));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true, dedupe_key: dedupeKey(ts, body) };
}

// Events carry a signed event_id that stays the same across Slack's retries
// (each retry is signed again with a new timestamp). Commands and
// interactions have no id: the signed timestamp plus the body hash, so a
// replay inside the window is a duplicate and one outside it fails verify.
export function dedupeKey(ts, rawBody) {
  const body = asBuf(rawBody);
  if (body[0] === 0x7b) {
    let p = null;
    try { p = JSON.parse(body.toString('utf8')); } catch { /* parseBody answers 400 */ }
    if (p?.type === 'event_callback' && typeof p.event_id === 'string' && EVENT_ID.test(p.event_id)) return `ev:${p.event_id}`;
    if (p?.type === 'url_verification') return `uv:${ts}:${sha32(body)}`;
  }
  return `ia:${ts}:${sha32(body)}`;
}

// Prototype keys anywhere in a JSON body are refused outright.
function strictJson(text) {
  const out = JSON.parse(text, (k, v) => {
    if (BAD_KEYS.has(k)) throw new Error('forbidden key');
    return v;
  });
  if (out === null || typeof out !== 'object' || Array.isArray(out)) throw new Error('not an object');
  return out;
}

function parseForm(text) {
  const fields = {};
  for (const [k, v] of new URLSearchParams(text)) {
    if (!FORM_KEY.test(k) || BAD_KEYS.has(k) || Object.hasOwn(fields, k)) throw new Error('bad form field');
    if (v.length > (k === 'payload' ? FORM_MAX : FIELD_MAX)) throw new Error('form field too long');
    fields[k] = v;
  }
  return fields;
}

/** Slack sends is_enterprise_install as a boolean, but a form or a proxy may make it 1 or 'true'. */
export const isGrid = (v) => v === true || v === 1 || v === 'true' || v === '1';

const enterprise = (p) => {
  const id = p?.enterprise_id ?? p?.enterprise?.id ?? p?.team?.enterprise_id;
  return (typeof id === 'string' && id !== '') || isGrid(p?.is_enterprise_install);
};

/**
 * F1 parseBody({rawBody, headers}) → {kind, body}, called after verify().
 *   kind: 'command' | 'interaction' | 'event' | 'url_verification' | 'ssl_check'
 * Throws on anything else (the registry answers a generic 400). Enterprise
 * Grid payloads are refused in v1.
 */
export function parseBody({ rawBody, headers }) {
  const body = asBuf(rawBody);
  if (body.length > FORM_MAX) throw new Error('body too large');
  const type = header(headers, 'content-type').split(';')[0].trim().toLowerCase();
  const text = body.toString('utf8');
  let out;
  if (type === 'application/x-www-form-urlencoded') {
    const f = parseForm(text);
    if (Object.hasOwn(f, 'payload')) {
      if (Object.keys(f).length !== 1) throw new Error('payload must be the only field');
      const p = strictJson(f.payload);
      if (typeof p.type !== 'string') throw new Error('interaction without type');
      out = { kind: 'interaction', body: p };
    } else if (f.ssl_check === '1') {
      out = { kind: 'ssl_check', body: {} };
    } else {
      if (typeof f.command !== 'string' || typeof f.team_id !== 'string' || typeof f.user_id !== 'string') throw new Error('not a command');
      out = { kind: 'command', body: f };
    }
  } else if (type === 'application/json') {
    const p = strictJson(text);
    if (p.type === 'url_verification') out = { kind: 'url_verification', body: { challenge: p.challenge } };
    else if (p.type === 'event_callback') out = { kind: 'event', body: p };
    else throw new Error('unknown event type');
  } else throw new Error('unsupported content type');
  if (enterprise(out.body)) throw new Error('enterprise grid is not supported');
  return out;
}

// Commands and interactions must be answered within 3 s, and ackBody (the
// only way to send url_verification's challenge or an empty ssl_check
// answer) runs only for early acks. Events stay late: Slack retries them,
// so a hub crash mid-handler is recovered.
const EARLY = new Set(['command', 'interaction', 'url_verification', 'ssl_check']);
export const ackEarly = ({ payload }) => EARLY.has(payload?.kind);

/**
 * The team and app a payload claims, from the places Slack puts them:
 * commands (team_id, api_app_id), interactions (team.id, api_app_id,
 * view.team_id, view.app_id), events (team_id, api_app_id).
 */
function claims({ kind, body }) {
  if (kind === 'command' || kind === 'event') return { teams: [body.team_id], apps: [body.api_app_id] };
  if (kind === 'interaction') {
    const teams = [body.team?.id, body.view?.team_id].filter((x) => x !== undefined);
    const apps = [body.api_app_id, body.view?.app_id].filter((x) => x !== undefined);
    return { teams, apps, appOptional: body.type === 'message_action', userTeam: body.user?.team_id };
  }
  return null;
}

/**
 * null when the payload belongs to this connection's workspace and app, else
 * 'wrong_workspace'. Every team id it names must equal the connection's. An
 * app id is required (and must match) except on a message shortcut, whose
 * documented shape has none; the per-connection signing secret binds the app
 * there. 'external_user' when the workspace and app are ours but the person
 * is from another workspace (Slack Connect): not a misconfiguration, so the
 * caller answers them instead of failing the connection's health. Slash
 * commands carry no user.team_id, so a Slack Connect member's command names
 * their home team: with our app id (this per-team app's signed request) and
 * no enterprise, that is 'external_team': the same answer, told apart in logs.
 */
export function bindingOf(payload, config) {
  const c = claims(payload ?? {});
  if (!c) return null;
  const team = config?.team_id;
  const app = config?.app_id;
  if (typeof team !== 'string' || typeof app !== 'string') return 'wrong_workspace';
  if (!c.teams.length || c.teams.some((t) => t !== team)) {
    const connect = payload.kind === 'command' && TEAM_ID.test(c.teams[0] ?? '') && c.apps.length === 1 && c.apps[0] === app && !enterprise(payload.body);
    return connect ? 'external_team' : 'wrong_workspace';
  }
  if (c.apps.some((a) => a !== app)) return 'wrong_workspace';
  if (!c.apps.length && !c.appOptional) return 'wrong_workspace';
  if (c.userTeam !== undefined && c.userTeam !== team) return 'external_user';
  return null;
}

// A bearer capability for ephemeral replies: Slack's own host and paths only,
// https, no port or userinfo, no query or fragment.
const RESPONSE_URL = /^https:\/\/hooks\.slack\.com\/(?:commands|actions|app-actions)\/[A-Za-z0-9/_-]{1,400}$/;
export const responseUrlOk = (u) => typeof u === 'string' && RESPONSE_URL.test(u);

/** Outgoing mrkdwn: no mentions, channel pings or links can come from a title. */
export const escapeMrkdwn = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Default-ignorables and the blank-looking letters (Hangul fillers, the
// combining grapheme joiner, the braille blank) render as nothing, so a
// title made only of them would look empty on the card.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u034F\u115F\u1160\u3164\uFFA0\u2800]/gu;
/**
 * A card title from Slack text: Slack's own markup made plain (links show
 * their label, mentions their name or id), entities decoded, control, format
 * and bidi characters removed, whitespace collapsed, capped by code point.
 * `firstLine` keeps only the first non-empty line (a message's prefill).
 */
export function cleanTitle(text, { max = 120, firstLine = false } = {}) {
  let t = typeof text === 'string' ? text : '';
  if (firstLine) t = t.split(/\r?\n/).find((l) => l.trim()) ?? '';
  t = t
    .replace(/<([@#!])([A-Za-z0-9^_-]{1,40})(?:\|([^<>]{0,80}))?>/g, (_, sigil, id, label) => (sigil === '!' ? `@${label || id}` : `${sigil}${label || id}`))
    .replace(/<((?:https?|mailto):[^<>|\s]{1,500})(?:\|([^<>]{0,200}))?>/g, (_, url, label) => label || url)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(INVISIBLE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...t].slice(0, max).join('').trim();
}

// ── private_metadata: bound to (team, channel, message ts, user) by an HMAC
// under a key derived from the connection's signing secret, so an edited
// view can't aim the card at another message, or at someone else.

const META_MAX_AGE_MS = 60 * 60_000;
const metaKey = (signingSecret) => createHmac('sha256', String(signingSecret)).update('plexiform-slack-modal-v1').digest();
const metaMac = (key, body) => createHmac('sha256', key).update(body).digest('base64url');

export function sealMeta(signingSecret, { team, channel, ts, user, board, authority }, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ t: team, c: channel, m: ts, u: user, i: now, ...(board !== undefined ? { b: board } : {}), ...(authority !== undefined ? { a: authority } : {}) })).toString('base64url');
  return `${body}.${metaMac(metaKey(signingSecret), body)}`;
}

/**
 * → {team, channel, ts, user}; {expired: true} when it is ours, intact and for
 * this user and team but over an hour old (a form left open: not an attack);
 * null when tampered, malformed or for another user or team.
 */
export function openMeta(signingSecret, sealed, { team, user }, now = Date.now()) {
  if (typeof sealed !== 'string' || sealed.length > 3000 || typeof signingSecret !== 'string' || signingSecret.length < 16) return null;
  const parts = sealed.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const got = Buffer.from(parts[1]);
  const want = Buffer.from(metaMac(metaKey(signingSecret), parts[0]));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let m;
  try { m = strictJson(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (![m.t, m.c, m.m, m.u].every(v => typeof v === 'string')) return null;
  if (!TEAM_ID.test(m.t ?? '') || !CHANNEL_ID.test(m.c ?? '') || !MESSAGE_TS.test(m.m ?? '') || !USER_ID.test(m.u ?? '')) return null;
  if (m.t !== team || m.u !== user) return null;
  if (!Number.isSafeInteger(m.i) || m.i > now + 60_000) return null;
  if (now - m.i > META_MAX_AGE_MS) return { expired: true };
  if (m.b !== undefined && (typeof m.b !== 'string' || !m.b || m.b.length > 150)) return null;
  if (m.a !== undefined && (typeof m.a !== 'string' || !/^[a-f0-9]{64}$/.test(m.a))) return null;
  return { team: m.t, channel: m.c, ts: m.m, user: m.u, ...(m.b !== undefined ? { board: m.b } : {}), ...(m.a !== undefined ? { authority: m.a } : {}) };
}

/**
 * Whether sealed metadata is over an hour old, from its age alone (no
 * secret, no MAC check): ackBody's hint to show "expired" in the modal. The
 * handler still decides with openMeta.
 */
export function metaExpired(sealed, now = Date.now()) {
  if (typeof sealed !== 'string' || sealed.length > 3000) return false;
  const parts = sealed.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) return false;
  try {
    const m = strictJson(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return Number.isSafeInteger(m.i) && now - m.i > META_MAX_AGE_MS;
  } catch { return false; }
}
