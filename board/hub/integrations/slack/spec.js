// Slack connector (I3), slice 1: connect a per-team Slack app, take signed
// slash commands and interactions, `/plex help | link | todo <text>`, and the
// "Create Plexiform card" message shortcut → modal → card with a permalink.
// No AI and no Events API subscription yet.
//
// The spec lives here and index.js wraps it in defineConnector: builder-5's
// slice A (parseBody, ackBody, ackEarly as a function, workspaceUnique),
// slice B (connect.prepare / handshake through a pending connection, the
// identity link whose id_token the registry verifies, ctx.memberFor) and
// slice C (settings.provider fixed at creation, ctx.hubUrl, ctx.linkState,
// onAckedFailure, rateSubject's per-user command limit). Tests import this
// module.
//
// Slack text is untrusted: it never reaches an agent, only the title a
// person confirmed is stored, and everything sent back is mrkdwn-escaped.
// Who may act comes only from ctx.memberFor (a verified identity link
// started from Plexiform), never from a payload field or an email.

import { createHash } from 'node:crypto';
import { BRAND } from '../../../shared/brand.js';
import {
  verify as verifyRequest, parseBody, ackEarly, bindingOf, responseUrlOk, escapeMrkdwn, cleanTitle,
  sealMeta, openMeta, metaExpired, isGrid, TEAM_ID, APP_ID, USER_ID, CHANNEL_ID, MESSAGE_TS,
} from './webhook.js';

const API = 'https://slack.com/api';
export const COMMAND = '/plex';
export const SHORTCUT_ID = 'plex_create_card';
export const MODAL_ID = 'plex_create_card_modal';
export const BOT_SCOPES = Object.freeze(['chat:write', 'commands']);
const TITLE_MAX = 120;
const CLIENT_ID = /^[0-9]{1,20}\.[0-9]{1,20}$/;
// Slack's client and signing secrets are 32 lowercase hex characters.
const CRED_SHAPE = /^[0-9a-f]{32}$/;
const PASTE_SHAPE = /^[A-Za-z0-9._-]{20,400}$/;
const CODE = /^[A-Za-z0-9._-]{1,300}$/;
const TRIGGER = /^[A-Za-z0-9.]{10,120}$/;
const ERROR_CODE = /^[a-z_]{1,40}$/;
// Built from parts so no token-shaped literal sits in the source.
const BOT_PREFIX = ['xo', 'xb-'].join('');

const tagged = (message, healthCode) => Object.assign(new Error(message), { healthCode });
const errOf = (v) => (typeof v === 'string' && ERROR_CODE.test(v) ? v : 'error');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const HELP = [
  '*Plexiform*',
  `\`${COMMAND} todo <text>\` adds a card to your team's board.`,
  `\`${COMMAND} link\` explains how to link your Slack account.`,
  'On any message: More actions (⋯) → *Create Plexiform card*.',
].join('\n');
// A link started from Slack is never accepted (anyone could send a victim
// their own link and bind the victim's account): linking starts in Plexiform.
export const LINK = 'To use Plexiform from Slack, link your account from Plexiform: open your team, then *Integrations → Slack → Link my account*. Links sent from Slack are never accepted.';
// Who can't add a card, as ctx.linkState tells them apart (C2). A removed
// member's link goes with the removal (023), so they read as unlinked
// upfront; INACTIVE is for access lost while the request ran.
export const UNLINKED = 'Link your Slack account in Plexiform: Integrations → Slack → Link my account.';
export const VIEWER = "You can view this team's board but not add cards; ask an admin for write access.";
export const INACTIVE = 'Your Plexiform access for this team is no longer active. Ask an admin.';
// onAckedFailure's and ackBody's rateLimited answers: fixed, nothing echoed.
export const FAILED = "Sorry, Plexiform couldn't do that. Try again in a moment.";
export const SLOW = 'You are sending Plexiform commands too fast. Wait a minute and try again.';
const USAGE = `Usage: \`${COMMAND} todo <text>\``;
export const EXTERNAL = 'Only members of this workspace can use Plexiform.';

const ephemeral = (text) => ({ response_type: 'ephemeral', text });

/** `/plex <sub> <rest>` → {name: 'help'|'link'|'todo', rest}. Anything unknown is help. */
export function parseCommand(text) {
  const t = String(text ?? '').trim();
  const m = /^(\S+)\s*([\s\S]*)$/.exec(t);
  const word = m ? m[1].toLowerCase() : '';
  return ['link', 'todo'].includes(word) ? { name: word, rest: m[2] } : { name: 'help', rest: '' };
}

// ── the modal ───────────────────────────────────────────────────────────

const TITLE_BLOCK = 'title_block';
const BOARD_BLOCK = 'board_block';
const EXPIRED = 'This form expired. Use the shortcut again.';
const plain = (text, max) => ({ type: 'plain_text', text: [...String(text)].slice(0, max).join('') || '-' });

function submitted(view) {
  const values = isObj(view?.state?.values) ? view.state.values : {};
  return {
    title: cleanTitle(values[TITLE_BLOCK]?.title?.value, { max: TITLE_MAX }),
    boardId: typeof values[BOARD_BLOCK]?.board?.selected_option?.value === 'string' ? values[BOARD_BLOCK].board.selected_option.value : null,
  };
}

/** The modal's own validation errors (shown by Slack in the modal), else null. */
export function submissionErrors(view) {
  const s = submitted(view);
  const errors = {};
  if (!s.title) errors[TITLE_BLOCK] = 'Give the card a title.';
  if (!s.boardId) errors[BOARD_BLOCK] = 'Pick a board.';
  return Object.keys(errors).length ? errors : null;
}

export function modalView({ title, boards, defaultBoardId, meta }) {
  const options = boards.filter((b) => typeof b?.id === 'string' && b.id.length <= 150).slice(0, 100)
    .map((b) => ({ text: plain(b.title ?? b.name ?? b.id, 75), value: b.id }));
  const initial = options.find((o) => o.value === defaultBoardId);
  return {
    type: 'modal',
    callback_id: MODAL_ID,
    title: plain('Create card', 24),
    submit: plain('Create', 24),
    close: plain('Cancel', 24),
    private_metadata: meta,
    blocks: [
      { type: 'input', block_id: TITLE_BLOCK, label: plain('Title', 50), element: { type: 'plain_text_input', action_id: 'title', max_length: TITLE_MAX, ...(title ? { initial_value: title } : {}) } },
      { type: 'input', block_id: BOARD_BLOCK, label: plain('Board', 50), element: { type: 'static_select', action_id: 'board', options, ...(initial ? { initial_option: initial } : {}) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Only this title and a link to the message are saved on the card.' }] },
    ],
  };
}

/**
 * F2 ackBody({payload, headers, rateLimited}): what Slack hears within 3 s.
 * help and link are answered here; `todo` and the shortcut are answered by
 * the handler; a modal with a missing title or board shows its errors. Over
 * the per-user command limit (C3) nothing runs: a command or a modal is told
 * to slow down (a shortcut's ack can carry no text).
 */
export function ackBody({ payload, rateLimited = false }) {
  const { kind, body } = payload ?? {};
  const modal = kind === 'interaction' && body.type === 'view_submission' && body.view?.callback_id === MODAL_ID;
  if (rateLimited) {
    if (kind === 'command') return ephemeral(SLOW);
    return modal ? { response_action: 'errors', errors: { [TITLE_BLOCK]: SLOW } } : undefined;
  }
  if (kind === 'url_verification') {
    const c = body?.challenge;
    // Plain text: Slack takes it, and it is the only answer a pending id gives (D97).
    return typeof c === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(c) ? c : undefined;
  }
  if (kind === 'command') {
    if (body.command !== COMMAND) return undefined;
    const sub = parseCommand(body.text);
    if (sub.name === 'help') return ephemeral(HELP);
    if (sub.name === 'link') return ephemeral(LINK);
    return undefined;
  }
  if (modal) {
    if (metaExpired(body.view.private_metadata)) return { response_action: 'errors', errors: { [TITLE_BLOCK]: EXPIRED } };
    const errors = submissionErrors(body.view);
    return errors ? { response_action: 'errors', errors } : undefined;
  }
  return undefined;
}

// ── Slack Web API, through the registry's host-checked fetch ──────────────

async function slackApi(ctx, method, args, { form = false } = {}) {
  const token = ctx.secret('bot_token');
  if (typeof token !== 'string' || !token.startsWith(BOT_PREFIX)) throw tagged('no bot token', 'not_connected');
  const res = await ctx.fetch(`${API}/${method}`, { // privacy-flow: integrations-hub
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
    body: form ? new URLSearchParams(args).toString() : JSON.stringify(args),
  });
  const out = await res.json().catch(() => null);
  if (out?.ok !== true) throw Object.assign(tagged(`slack ${method}: ${errOf(out?.error)}`, 'provider_error'), { slackError: errOf(out?.error) });
  return out;
}

// Slack saying this one request can't be done (the message or channel is
// gone, the trigger ran out): the connection is fine, so these are answered
// quietly instead of failing health and dead-lettering the delivery.
const QUIET_TRIGGER = new Set(['expired_trigger_id', 'trigger_expired']);
const QUIET = new Set(['channel_not_found', 'message_not_found', 'not_in_channel', ...QUIET_TRIGGER]);
const quiet = (e) => QUIET.has(e?.slackError);
const GONE = 'That message is no longer available.';
const TOO_SLOW = 'That took too long; use the shortcut again.';
const skipped = (ctx, e) => ctx.log?.('slack request skipped', { code: e.slackError });

const postReply = (fetch, responseUrl, text) => fetch(responseUrl, { // privacy-flow: integrations-hub
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ response_type: 'ephemeral', text, unfurl_links: false, unfurl_media: false }),
});

// Replies never fail the handler: the card (if any) is already made, and a
// throw would only dead-letter a delivery that did its work.
async function reply(ctx, responseUrl, text) {
  if (!responseUrlOk(responseUrl)) return false;
  try {
    return (await postReply(ctx.fetch, responseUrl, text)).ok;
  } catch {
    ctx.log?.('slack reply failed');
    return false;
  }
}

async function tellUser(ctx, channel, user, text) {
  try {
    await slackApi(ctx, 'chat.postEphemeral', { channel, user, text, unfurl_links: false, unfurl_media: false });
  } catch (e) {
    ctx.log?.('slack ephemeral failed', { code: e?.healthCode ?? 'error' });
  }
}

// A permalink is https on Slack's own domain, nothing else.
function permalinkOk(u) {
  let url;
  try { url = new URL(String(u)); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !/^(?:[a-z0-9-]{1,63}\.){1,3}slack\.com$/.test(url.hostname)) return null;
  return url.href.length <= 500 && !/[\s<>|]/.test(url.href) ? url.href : null;
}

// ── who, where, and the card link ───────────────────────────────────────────

/**
 * {member}: the member a Slack user is linked to here and who can write;
 * else {text}: why not, from ctx.linkState (never who the member is).
 */
function actorOf(ctx, slackUser) {
  if (!USER_ID.test(slackUser ?? '')) return { text: UNLINKED };
  const m = ctx.memberFor(slackUser);
  const id = typeof m === 'string' ? m : m?.id;
  if (typeof id === 'string' && id) return { member: id };
  const state = ctx.linkState(slackUser);
  return { text: state === 'unavailable' ? VIEWER : state === 'none' ? UNLINKED : INACTIVE };
}

// Access lost between actorOf and act(): demoted (still linked), else gone.
const lostText = (ctx, slackUser) => (ctx.linkState(slackUser) === 'unavailable' ? VIEWER : INACTIVE);

function boardsOf(ctx) {
  const list = typeof ctx.boards === 'function' ? ctx.boards() : [];
  return Array.isArray(list) ? list.filter((b) => typeof b?.id === 'string') : [];
}

// A connection must name one board and one opted channel. A missing or
// archived board pauses intake; the alphabetical picker never chooses for it.
export const TARGET_UNAVAILABLE = 'Ask an admin to select an available board and Slack channel in Integrations.';
export const TARGET_CHANGED = 'This Slack connection changed. Use the shortcut again.';
export function selectedBoard(ctx, channel) {
  const id = ctx.connection?.target_board_id;
  const chosenChannel = ctx.connection?.settings?.config?.channel_id;
  if (typeof id !== 'string' || !id || typeof chosenChannel !== 'string' || !CHANNEL_ID.test(chosenChannel) || channel !== chosenChannel) return null;
  const ids = typeof ctx.boardIds === 'function' ? ctx.boardIds() : [];
  if (!Array.isArray(ids) || ids[0] !== id) return null;
  return boardsOf(ctx).find((board) => board.id === id) ?? null;
}

// Opaque modal authority: no raw config, membership, or credentials goes to
// Slack. A fresh submit context must still describe exactly this connection,
// selected target, settings and linked member. The registry additionally
// checks current principal/connection authority inside the board queue.
export function modalAuthority(ctx, member) {
  return createHash('sha256').update(JSON.stringify({ connection: ctx.connection, member })).digest('hex');
}

const HUB_URL = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?$/;
const hubOk = (u) => (typeof u === 'string' && HUB_URL.test(u) ? u : null);

/**
 * What this connection is bound to, from what no settings PATCH can change
 * (C1): the workspace is external_id; the app and client id are
 * settings.provider's (written with the row, never again), which must name
 * no other team and agree with settings.pinned (D97) where it has them.
 * Throws, so nothing runs: 'reconnect_required' for a connection without
 * usable provider facts (made before 026: an admin reconnects),
 * 'wrong_workspace' when the fixed facts contradict each other. Links use
 * only ctx.hubUrl, and only an https origin (a dev hub's loopback http gets
 * none); provider.hub_url is diagnostic and config an admin's.
 */
export function installOf(connection, hubUrl = null) {
  const team = connection?.external_id;
  const settings = isObj(connection?.settings) ? connection.settings : {};
  const provider = isObj(settings.provider) ? settings.provider : null;
  if (typeof team !== 'string' || !TEAM_ID.test(team) || !provider || !APP_ID.test(provider.app_id ?? '') || !CLIENT_ID.test(provider.client_id ?? '')) {
    throw tagged('the connection has no provider facts to bind to', 'reconnect_required');
  }
  const fixed = { team_id: team, app_id: provider.app_id, client_id: provider.client_id };
  const pinned = isObj(settings.pinned) ? settings.pinned : {};
  if ((provider.team_id !== undefined && provider.team_id !== team) || Object.entries(pinned).some(([k, v]) => provider[k] !== v)) {
    throw tagged('the connection settings disagree with the install', 'wrong_workspace');
  }
  return { ...fixed, hub: hubOk(hubUrl) };
}

export function cardLink(hub, card) {
  const base = hubOk(hub);
  const key = escapeMrkdwn(card?.key ?? 'card');
  return base && typeof card?.id === 'string' ? `<${base}/#card=${encodeURIComponent(card.id)}|${key}>` : key;
}

function cardOf(ctx, out) {
  const id = out?.card?.id;
  const c = id && typeof ctx.card === 'function' ? ctx.card(id) : null;
  return c ?? out?.card ?? null;
}

/**
 * One card through act(): per-subject limit (F8), the board-only createCard
 * (F6), a request_id derived from Slack's ids so a retry or a repeat returns
 * the same card. → {card} | {limited} | {conflict} | {refused: decision}.
 */
async function createCard(ctx, { member, subject, board, channel, title, body, requestId, ref, thread, prepare }) {
  try {
    const r = await ctx.act('slack.create_card', { subject, external_ref: ref, detail: { board: board.id } }, async (s) => {
      if (selectedBoard(ctx, channel)?.id !== board.id || actorOf(ctx, subject).member !== member) throw Object.assign(new Error('current Slack target unavailable'), { code: 'FORBIDDEN', cacheable: false });
      // Capture the linked principal before any provider await. The held API
      // handle refuses a same-member-id user replacement afterwards as well.
      const actor = s.actAs(member);
      const input = prepare ? await prepare() : { body, thread };
      const out = await actor.createCard(board.id, { title, body: input.body, request_id: requestId });
      s.actAs(member); // current captured authority also fences completed/replayed results
      if (input.thread && out?.card?.id) s.link(out.card.id, 'thread', input.thread.id, input.thread.url);
      return out;
    });
    if (!r?.done) return { refused: r?.decision ?? 'skipped' };
    return { card: cardOf(ctx, r.result) };
  } catch (e) {
    if (e?.code === 'RATE_LIMITED') return { limited: true };
    if (e?.code === 'CONFLICT') return { conflict: true };
    // Demoted, removed or unlinked between actorOf and act() (C2: the act was
    // audited). The connecting member's own loss is the connection's health
    // too: answered, then rethrown so the registry records it.
    if (e?.code === 'ACTOR_UNAVAILABLE' || e?.code === 'FORBIDDEN') return { lost: e };
    throw e;
  }
}

async function lost(ctx, r, user, answer) {
  await answer(lostText(ctx, user));
  if (r.lost.code === 'ACTOR_UNAVAILABLE' && r.lost.scope === 'connection') throw r.lost;
}

const LIMITED = 'You have added a lot of cards from Slack in the last hour. Try again later.';
const REFUSED = 'An admin has turned off creating cards from Slack for this team.';
const created = (install, card, title) => `Created ${cardLink(install.hub, card)}: ${escapeMrkdwn(title)}`;
const already = (install, card) => `Already on the board as ${cardLink(install.hub, card)}: ${escapeMrkdwn(card.title)}`;
// A repeat of the same message returns the card someone already made: say
// so, with its stored title, rather than echo the title this person typed.
const outcome = (install, card, title) => (typeof card?.title === 'string' && card.title !== title ? already(install, card) : created(install, card, title));

// ── handlers ──────────────────────────────────────────────────────────────

async function onTodo(ctx, install, body, rest) {
  const url = body.response_url;
  const { member, text } = actorOf(ctx, body.user_id);
  if (!member) return reply(ctx, url, text);
  const title = cleanTitle(rest, { max: TITLE_MAX });
  if (!title) return reply(ctx, url, USAGE);
  if (!TRIGGER.test(body.trigger_id ?? '')) return reply(ctx, url, 'Slack sent an incomplete command. Try again.');
  const board = selectedBoard(ctx, body.channel_id);
  if (!board) return reply(ctx, url, TARGET_UNAVAILABLE);
  const r = await createCard(ctx, {
    member, subject: body.user_id, board, channel: body.channel_id, title, body: '', requestId: `cmd:${body.team_id}:${body.trigger_id}`, ref: `slack:cmd:${body.trigger_id}`,
  });
  if (r.limited) return reply(ctx, url, LIMITED);
  if (r.lost) return lost(ctx, r, body.user_id, (t) => reply(ctx, url, t));
  if (r.refused) return reply(ctx, url, REFUSED);
  if (r.conflict) return reply(ctx, url, 'That card already exists on another board.');
  return reply(ctx, url, created(install, r.card, title));
}

async function onShortcut(ctx, install, body) {
  const user = body.user?.id;
  const channel = body.channel?.id;
  const ts = body.message?.ts ?? body.message_ts;
  const who = actorOf(ctx, user);
  if (!who.member) return reply(ctx, body.response_url, who.text);
  if (!CHANNEL_ID.test(channel ?? '') || !MESSAGE_TS.test(ts ?? '') || !TRIGGER.test(body.trigger_id ?? '')) return reply(ctx, body.response_url, 'Slack sent an incomplete shortcut. Try again.');
  const board = selectedBoard(ctx, channel);
  if (!board) return reply(ctx, body.response_url, TARGET_UNAVAILABLE);
  const meta = sealMeta(ctx.secret('signing_secret'), { team: install.team_id, channel, ts, user, board: board.id, authority: modalAuthority(ctx, who.member) });
  // The trigger dies 3 s after Slack sent it: views.open comes first.
  try {
    await slackApi(ctx, 'views.open', {
      trigger_id: body.trigger_id,
      view: modalView({ title: cleanTitle(body.message?.text, { max: TITLE_MAX, firstLine: true }), boards: [board], defaultBoardId: board.id, meta }),
    });
  } catch (e) {
    if (!quiet(e)) throw e;
    skipped(ctx, e);
    return reply(ctx, body.response_url, QUIET_TRIGGER.has(e.slackError) ? TOO_SLOW : GONE);
  }
}

async function onSubmit(ctx, install, body) {
  const user = body.user?.id;
  // The view is the client's to edit: its metadata must carry our HMAC, for
  // this team and this user. Only that failing means tampering; a form left
  // open over an hour was told so by ackBody, and is dropped quietly.
  const meta = openMeta(ctx.secret('signing_secret'), body.view?.private_metadata, { team: body.team?.id, user });
  if (meta?.expired) {
    ctx.log?.('slack modal expired');
    return;
  }
  if (!meta) throw tagged('modal metadata refused', 'bad_metadata');
  const { member, text } = actorOf(ctx, user);
  if (!member) return tellUser(ctx, meta.channel, user, text);
  if (submissionErrors(body.view)) return; // shown in the modal by ackBody
  const { title, boardId } = submitted(body.view);
  const board = selectedBoard(ctx, meta.channel);
  if (!board || board.id !== boardId || meta.board !== boardId || meta.authority !== modalAuthority(ctx, member)) return tellUser(ctx, meta.channel, user, TARGET_CHANGED);
  const ext = `${meta.channel}:${meta.ts}`;
  let r;
  try {
    r = await createCard(ctx, {
      member, subject: user, board, channel: meta.channel, title, requestId: `msg:${ext}`, ref: `slack:${ext}`,
      prepare: async () => {
        const link = await slackApi(ctx, 'chat.getPermalink', { channel: meta.channel, message_ts: meta.ts }, { form: true });
        if (selectedBoard(ctx, meta.channel)?.id !== boardId || actorOf(ctx, user).member !== member || meta.authority !== modalAuthority(ctx, member)) throw Object.assign(new Error('current Slack target unavailable'), { code: 'FORBIDDEN', cacheable: false });
        const permalink = permalinkOk(link.permalink);
        if (!permalink) throw tagged('slack chat.getPermalink: bad permalink', 'provider_error');
        return { body: `From Slack: ${permalink}`, thread: { id: ext, url: permalink } };
      },
    });
  } catch (e) {
    if (!quiet(e)) throw e;
    skipped(ctx, e);
    return tellUser(ctx, meta.channel, user, QUIET_TRIGGER.has(e.slackError) ? TOO_SLOW : GONE);
  }
  if (r.limited) return tellUser(ctx, meta.channel, user, LIMITED);
  if (r.lost) return lost(ctx, r, user, (t) => tellUser(ctx, meta.channel, user, t));
  if (r.refused) return tellUser(ctx, meta.channel, user, REFUSED);
  if (r.conflict) {
    const prior = ctx.linked?.('thread', ext);
    const card = prior && typeof ctx.card === 'function' ? ctx.card(prior) : null;
    return tellUser(ctx, meta.channel, user, card ? already(install, card) : 'That message is already on another board.');
  }
  return tellUser(ctx, meta.channel, user, outcome(install, r.card, title));
}

export async function handleWebhook({ payload, ctx }) {
  if (!payload || payload.kind === 'ssl_check' || payload.kind === 'url_verification' || payload.kind === 'event') return;
  const install = installOf(ctx.connection, ctx.hubUrl);
  const { kind, body } = payload;
  const binding = bindingOf(payload, install);
  // Someone from a Slack Connect partner (a shortcut, or a command naming
  // their home team): told once, privately; the
  // connection is healthy, so no health failure and no dead letter.
  if (binding === 'external_user' || binding === 'external_team') {
    ctx.log?.('slack request refused', { code: binding });
    await reply(ctx, body.response_url, EXTERNAL);
    return;
  }
  // A correctly signed payload for another workspace or app: the registry
  // audits the failure and records the health code; nothing runs.
  if (binding) throw tagged('payload for another workspace or app', 'wrong_workspace');
  if (kind === 'command') {
    if (body.command !== COMMAND) return;
    const sub = parseCommand(body.text);
    if (sub.name === 'todo') await onTodo(ctx, install, body, sub.rest);
    return;
  }
  if (kind === 'interaction') {
    if (body.type === 'message_action' && body.callback_id === SHORTCUT_ID) await onShortcut(ctx, install, body);
    else if (body.type === 'view_submission' && body.view?.callback_id === MODAL_ID) await onSubmit(ctx, install, body);
  }
}

/** C3: the Slack user a command or interaction counts against (integration_user_cmd); null for anything else. */
export function rateSubject({ payload } = {}) {
  const id = payload?.kind === 'command' ? payload.body?.user_id : payload?.kind === 'interaction' ? payload.body?.user?.id : null;
  return typeof id === 'string' && USER_ID.test(id) ? id : null;
}

/**
 * C2: an early-acked handler failed or timed out. The person hears one fixed
 * "couldn't do that" through the payload's own response_url (allowlisted;
 * a modal submit has none), never the error or their input. An
 * actor_unavailable was already answered by the handler.
 */
export async function onAckedFailure({ payload, error_code: code, fetch }) {
  if (code === 'actor_unavailable') return;
  const url = payload?.body?.response_url;
  if (responseUrlOk(url)) await postReply(fetch, url, FAILED);
}

// ── connect: a per-team app from a manifest, installed with OAuth v2 ─────────

// The manifest names both callbacks: the install (redirectUri) and Sign in
// with Slack (identityRedirectUri, the exact string the registry's identity
// flow later sends), and declares the user scope openid that flow asks for.
export function manifest({ webhookUrl, redirectUri, identityRedirectUri, name = BRAND.name }) {
  return {
    display_information: { name: String(name).slice(0, 35), description: 'Turn Slack messages into Plexiform cards.' },
    features: {
      bot_user: { display_name: String(name).slice(0, 80), always_online: false },
      slash_commands: [{ command: COMMAND, url: webhookUrl, description: 'Add a card to your Plexiform board', usage_hint: 'help | link | todo <text>', should_escape: false }],
      shortcuts: [{ name: 'Create Plexiform card', type: 'message', callback_id: SHORTCUT_ID, description: 'Make a card from this message' }],
    },
    oauth_config: { redirect_urls: [redirectUri, identityRedirectUri], scopes: { bot: [...BOT_SCOPES], user: ['openid'] } },
    settings: { interactivity: { is_enabled: true, request_url: webhookUrl }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

/** When no config token is pasted: create the app from a prefilled link, then paste its values. */
export function manifestLink(urls) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest(urls)))}`;
}

// The client id is a provider fact (the pending row's prepare settings), never an admin's config.
export function authorizeUrl({ state, redirectUri, provider }) {
  if (!CLIENT_ID.test(provider?.client_id ?? '')) throw new Error('no client id');
  const q = new URLSearchParams({ client_id: provider.client_id, scope: BOT_SCOPES.join(','), redirect_uri: redirectUri });
  if (state) q.set('state', state);
  return `https://slack.com/oauth/v2/authorize?${q}`;
}

const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

async function postForm(fetch, method, args, headers = {}) {
  const res = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(args).toString() }); // privacy-flow: integrations-hub
  const out = await res.json().catch(() => null);
  if (!isObj(out) || out.ok !== true) throw new Error(`slack ${method}: ${errOf(out?.error)}`);
  return out;
}

const PASTED = Object.freeze(['app_id', 'client_id', 'client_secret', 'signing_secret']);
export const PREPARE_INPUTS = Object.freeze(['config_token', ...PASTED]);
const urlOk = (u) => typeof u === 'string' && /^https?:\/\/[^\s]{1,2000}$/.test(u);

/**
 * D97 connect.prepare. The admin's app configuration token (held for this
 * call only, never stored, logged or returned) creates the app from the
 * manifest; with nothing pasted, the answer asks for the app's four values
 * and links a prefilled create page; with those pasted, they are checked.
 * → {needs: {fields, create_url}} | {secrets, settings, match}. Errors are
 * fixed text (the registry drops them anyway).
 */
export async function prepare({ input, fetch, webhookUrl, redirectUri, identityRedirectUri }) {
  if (![webhookUrl, redirectUri, identityRedirectUri].every(urlOk)) throw new Error('no hub urls');
  const urls = { webhookUrl, redirectUri, identityRedirectUri };
  const given = isObj(input) ? input : {};
  let creds;
  if (typeof given.config_token === 'string') {
    if (!PASTE_SHAPE.test(given.config_token)) throw new Error('that does not look like an app configuration token');
    const out = await postForm(fetch, 'apps.manifest.create', { manifest: JSON.stringify(manifest(urls)) }, { authorization: `Bearer ${given.config_token}` });
    creds = { app_id: out.app_id, ...(isObj(out.credentials) ? out.credentials : {}) };
  } else if (!PASTED.some((k) => Object.hasOwn(given, k))) {
    return { needs: { fields: [...PASTED], create_url: manifestLink(urls) } };
  } else creds = given;
  const { app_id: appId, client_id: clientId, client_secret: clientSecret, signing_secret: signingSecret } = creds;
  if (!APP_ID.test(appId ?? '') || !CLIENT_ID.test(clientId ?? '') || !CRED_SHAPE.test(clientSecret ?? '') || !CRED_SHAPE.test(signingSecret ?? '')) {
    throw new Error('the app credentials are incomplete');
  }
  const app = { app_id: appId, client_id: clientId };
  return { secrets: { client_secret: clientSecret, signing_secret: signingSecret }, settings: { ...app }, match: { ...app } };
}

/** D97 connect.handshake: the one delivery a pending id answers (ackBody gives the challenge). */
export const handshake = ({ payload }) => payload?.kind === 'url_verification';

const sameScopes = (granted) => {
  const got = String(granted ?? '').split(',').map((s) => s.trim()).filter(Boolean).sort();
  return got.length === BOT_SCOPES.length && got.every((s, i) => s === [...BOT_SCOPES].sort()[i]);
};

/**
 * The OAuth callback: oauth.v2.access with the pending client secret. The
 * install must be one workspace (no Grid), with exactly the bot scopes asked
 * for and no user token. `match` carries the app Slack says it installed and
 * the client id used: the registry promotes only when it equals what
 * prepare pinned.
 */
export async function exchange({ query, redirectUri, provider, secrets, fetch }) {
  const code = String(query?.get?.('code') ?? query?.code ?? '');
  if (!CODE.test(code)) throw new Error('bad oauth code');
  if (!CLIENT_ID.test(provider?.client_id ?? '') || typeof secrets?.client_secret !== 'string') throw new Error('no pending app');
  const out = await postForm(fetch, 'oauth.v2.access', { code, redirect_uri: redirectUri, grant_type: 'authorization_code' }, { authorization: basic(provider.client_id, secrets.client_secret) });
  const bad = (what) => { throw new Error(`oauth.v2.access returned ${what}`); };
  if (out.token_type !== 'bot' || typeof out.access_token !== 'string' || !out.access_token.startsWith(BOT_PREFIX) || out.access_token.length > 400) bad('no bot token');
  if (!APP_ID.test(out.app_id ?? '')) bad('no app');
  if (!isObj(out.team) || !TEAM_ID.test(out.team.id ?? '')) bad('no team');
  if ((out.enterprise != null && out.enterprise !== false) || isGrid(out.is_enterprise_install)) bad('an enterprise install');
  if (!sameScopes(out.scope)) bad('other scopes than requested');
  if (out.authed_user?.access_token != null) bad('a user token');
  if (out.authed_user?.scope != null && out.authed_user.scope !== '') bad('user scopes');
  if (out.incoming_webhook != null) bad('an incoming webhook');
  if (!USER_ID.test(out.bot_user_id ?? '')) bad('no bot user');
  // No team_id (it is external_id) and no hub_url (ctx.hubUrl, slice C).
  return {
    external_id: out.team.id,
    display_name: typeof out.team.name === 'string' ? out.team.name.slice(0, 100) : out.team.id,
    scopes: [...BOT_SCOPES],
    secrets: { bot_token: out.access_token },
    settings: { bot_user_id: out.bot_user_id },
    match: { app_id: out.app_id, client_id: provider.client_id },
  };
}

// ── identity: Sign in with Slack (OIDC, openid only), started from Plexiform ──

// The registry verifies the id_token against settings.pinned.client_id, and
// the URL names the same client id, for the connection's own workspace.
function identityInstall(connection) {
  let install = null;
  try { install = installOf(connection); } catch { /* not connected */ }
  if (!install || install.client_id !== connection?.settings?.pinned?.client_id) throw new Error('not connected');
  return install;
}

export function identityAuthorizeUrl({ state, nonce, redirectUri, connection }) {
  const install = identityInstall(connection);
  if (![state, nonce].every((v) => typeof v === 'string' && v) || !urlOk(redirectUri)) throw new Error('incomplete link request');
  const q = new URLSearchParams({ response_type: 'code', scope: 'openid', client_id: install.client_id, state, nonce, redirect_uri: redirectUri, team: install.team_id });
  return `https://slack.com/openid/connect/authorize?${q}`;
}

const JWT = /^[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{1,6000}\.[A-Za-z0-9_-]{1,2000}$/;

/**
 * D98 identity.exchange → {id_token}: the code traded at openid.connect.token
 * with the app's client secret. The registry verifies the token (RS256 on
 * Slack's JWKS, iss, aud, exp, nonce, team = external_id, sub); the access
 * token Slack also returns is dropped here, never used or kept.
 */
export async function identityExchange({ query, redirectUri, connection, secrets, fetch }) {
  const code = String(query?.get?.('code') ?? query?.code ?? '');
  if (!CODE.test(code)) throw new Error('bad oauth code');
  const install = identityInstall(connection);
  if (typeof secrets?.client_secret !== 'string') throw new Error('not connected');
  const tok = await postForm(fetch, 'openid.connect.token', { code, redirect_uri: redirectUri, grant_type: 'authorization_code' }, { authorization: basic(install.client_id, secrets.client_secret) });
  if (typeof tok.id_token !== 'string' || !JWT.test(tok.id_token)) throw new Error('openid.connect.token returned no id_token');
  return { id_token: tok.id_token };
}

export const spec = {
  id: 'slack',
  name: 'Slack',
  scopes: [...BOT_SCOPES],
  secrets: ['bot_token', 'signing_secret', 'client_secret'],
  // api.slack.com only for the prefilled create link prepare hands back.
  hosts: ['slack.com', 'hooks.slack.com', 'api.slack.com'],
  // Slack publishes no stable ranges for its request senders.
  ingressCidrs: [],
  // F10: one Slack workspace belongs to one team on a hub (identity links are hub-wide).
  workspaceUnique: true,
  connect: { kind: 'oauth', prepareInputs: [...PREPARE_INPUTS], prepare, authorizeUrl, exchange, handshake, manifestLink },
  identity: {
    issuer: 'https://slack.com',
    jwksUrl: 'https://slack.com/openid/connect/keys',
    workspaceClaim: 'https://slack.com/team_id',
    subjectRe: USER_ID,
    authorizeUrl: identityAuthorizeUrl,
    exchange: identityExchange,
  },
  verify({ headers, rawBody, secrets, now }) {
    const r = verifyRequest({ headers, rawBody, secrets, now });
    return r.ok ? { ok: true, dedupe_key: r.dedupe_key } : { ok: false, reason: r.reason };
  },
  parseBody,
  ackEarly,
  ackBody,
  rateSubject,
  onAckedFailure,
  handleWebhook,
  // Explicit opted channel; the board uses the framework's target_board_id.
  // Workspace and app remain immutable provider facts.
  configKeys: ['channel_id'],
  actions: { 'slack.create_card': { default: 'auto' } },
  async health() { return { ok: true }; },
};
