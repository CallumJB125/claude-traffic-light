// The connector interface (I1). A connector is a plain object; the registry
// (./registry.js) owns everything around it: secrets, webhook ingress,
// replay protection, the bus, retries, autonomy and the audit log. A
// connector never gets the DB handle or the vault key.
//
// export default defineConnector({
//   id: 'github',                       // lowercase, [a-z0-9-]
//   name: 'GitHub',
//   scopes: ['pull_requests:read', …],  // what the consent screen lists; the minimum
//   secrets: ['app_private_key', 'webhook_secret'],   // kinds this connector seals
//   hosts: ['api.github.com'],          // exact hostnames ctx.fetch / exchange / verifyToken may reach (https only)
//   workspaceUnique: false,             // optional: true = one live connection per external_id across ALL teams
//                                       // (a provider whose events reach one install only, e.g. one Slack app per
//                                       // workspace); a second is the same generic CONFLICT as within a team
//
//   // Connect (in an in-app auth window). Either an OAuth-style redirect
//   // flow or a manual token. The registry makes and checks `state`.
//   connect: {
//     kind: 'oauth' | 'app_install' | 'token',
//     authorizeUrl({ state, redirectUri, webhookUrl, config }) → string,   // oauth/app_install: a GET redirect
//     // or, app_install only, a POSTed form (GitHub's App-manifest flow):
//     formHost: 'github.com',                                          // one of `hosts`; the only host the form may post to
//     manifestForm({ state, redirectUri, webhookUrl, config }) → { action: 'https://<formHost>/…', fields: {name: string} },
//     async exchange({ query, redirectUri, webhookUrl, config, secrets, fetch }) →   // oauth/app_install callback
//       { external_id, display_name, scopes: [...], secrets: {kind: value},
//         settings?: {k: scalar} (non-secret, ≤ 2 KB, stored once as settings.provider: D42 addendum C1),
//         next_url?: 'https://<one of hosts>/…' (the callback page's one "Continue on <name>" link),
//         match?: {k: scalar} (required after prepare: exactly the pending match, D97) },
//     (`webhookUrl` is this connection's future webhook URL; `config` is
//     {...settings.config, ...settings.provider} of the org's newest active connection of
//     this provider, else {}, overlaid with the pending settings after prepare; `secrets` is the pending
//     row's unsealed secrets after prepare, else {}; exchange may add kinds, never replace one)
//
//     // Optional, oauth/app_install without manifestForm (D97): the app is
//     // made from input an admin pastes (Slack: a configuration token).
//     prepareInputs: ['config_token', 'app_id', …],  // 1–8 key names; only these keys of `input` reach prepare
//     async prepare({ input, webhookUrl, redirectUri, identityRedirectUri, config, fetch }) →
//       { needs: { fields: [key of prepareInputs], create_url: 'https://<one of hosts>/…' } }   // ask for a paste
//       | { secrets: {kind: string}, settings?: {k: scalar}, match: {k: scalar} (1–8), external_id? },
//     (`input` values are strings of 1–4096 bytes, held only for this call: never
//     put them in an error, a log line, secrets or settings. Any throw becomes a
//     fixed VALIDATION and is logged as a code only. `fetch` is the restricted
//     fetch without retries; its errors are fixed text with no `cause`.
//     `webhookUrl` names the pending id the connection keeps; `identityRedirectUri`
//     is exactly the redirectUri D98's identity flow will use.)
//     // Optional, prepare connectors only, needs ackBody (D97, slice B3): the one
//     // delivery a ready pending id answers. Called synchronously, only after
//     // verify() passed under that pending row's own secrets and parseBody;
//     // only a plain `true` counts. The answer is then ackBody's string, which
//     // must be 1–256 printable ASCII characters (Slack: the url_verification
//     // challenge); anything else, and every other delivery, is the
//     // unknown-connection 404. Nothing else runs (no handler, lease or audit).
//     handshake({ payload, headers }) → boolean,   // Slack: payload.type === 'url_verification'
//     async verifyToken({ token, fetch }) → { external_id, display_name, scopes, secrets, settings? }, // token (settings → settings.provider)
//     (`fetch` here is restricted to `hosts`, with a timeout; errors never reach users)
//   },
//
//   // Optional, workspaceUnique connectors only (D98): a member links their own
//   // provider account by OpenID Connect (scope openid). The registry makes and
//   // checks state and nonce and verifies the id_token (RS256 against jwksUrl,
//   // iss, aud = settings.pinned.client_id, exp/iat, nonce, workspaceClaim =
//   // external_id, sub ~ subjectRe); the connector only builds the URL and
//   // trades the code. `connection` is {external_id, settings: {pinned, provider}}
//   // (frozen, never config: take the client id from settings.pinned); `redirectUri` is the
//   // identityRedirectUri prepare got. Throw fixed text only: `secrets` holds
//   // the app's client secret.
//   identity: {
//     issuer: 'https://slack.com', jwksUrl: 'https://slack.com/openid/connect/keys',   // https on hosts
//     workspaceClaim: 'https://slack.com/team_id', subjectRe: /^[UW][A-Z0-9]{2,20}$/,
//     authorizeUrl({ state, nonce, redirectUri, connection, secrets, fetch }) → 'https://<one of hosts>/…',
//     async exchange({ query, state, redirectUri, connection, secrets, fetch }) → { id_token },
//   },
//
//   // Inbound webhooks at POST /integrations/<connection id>/webhook.
//   // MUST verify the provider signature over the raw body, in constant time,
//   // and return a dedupe key (delivery id) for replay protection.
//   verify({ headers, rawBody, secrets, now }) → { ok: true, dedupe_key } | { ok: false, reason },
//   async handleWebhook({ headers, payload, ctx }) → void,
//   // Optional: turn the raw body into `payload` (default: JSON.parse). Called
//   // only after verify() passed over those bytes, synchronously, on a body
//   // ≤ 1 MiB. A throw, or anything but a plain object (an array, a Promise,
//   // a class instance) or an object with an own top-level `__proto__`,
//   // `constructor` or `prototype` key, is a 400 VALIDATION with a fixed
//   // message. Dedupe keys never depend on it. (Slack: form-encoded bodies
//   // whose `payload=` field is JSON.)
//   parseBody({ rawBody, headers }) → { … },
//   // Optional, default false: answer 200 once the delivery is verified and
//   // leased, then run handleWebhook (same lease, timeout and ctx). For a
//   // provider that needs an answer within seconds (Slack: 3 s). A failure then
//   // reaches no provider retry: it is audited (action 'webhook', 'failed' +
//   // code) and the delivery marked done (a replay answers duplicate; D42
//   // addendum C2). A hub crash mid-handler loses the event until a manual
//   // redelivery once the lease expired.
//   ackEarly: false,
//   // …or per delivery: ackEarly({ payload, headers }) → boolean, called
//   // synchronously after verify() and parseBody; only `true` is early, a
//   // throw (or anything else) answers late (Slack: early for commands and
//   // interactions, late for retried events).
//   // Optional, only with ackEarly: the early answer's body (default
//   // {"ok":true,"accepted":true}). undefined → an empty 200; a string →
//   // text/plain; a plain object → JSON; over 4 KiB, unserialisable, any other
//   // type or a throw → an empty 200. Synchronous; runs before the handler.
//   // Never reflect request data in it, except a verified url_verification
//   // `challenge` string.
//   ackBody({ payload, headers }) → undefined | string | { … },
//   // Optional, only with ackEarly (C2): an acknowledged delivery's handler
//   // failed or timed out. Called once, after the audit; `error_code` is a
//   // short code, never the error; `fetch` is the restricted fetch (no
//   // retries, aborted after 10 s). For a fixed-text "couldn't do that" reply
//   // (Slack: response_url). Errors are swallowed; the answer was already sent.
//   async onAckedFailure({ payload, headers, error_code, fetch }) → void,
//
//   // Optional: the provider's published webhook source ranges (GitHub's
//   // `hooks` from https://api.github.com/meta). A delivery from one of them
//   // skips the per-connection in-flight read cap (it still needs a valid
//   // signature). The connector owner refreshes the list when the provider
//   // changes it. IPv4 /16 or narrower, IPv6 /32 or narrower.
//   ingressCidrs: ['192.30.252.0/22', …],
//
//   // Bus consumer: board events (journal rows, CONTRACT §15) this connector reacts to.
//   consumes: ['card.transition', 'card.notify', …],
//   async onEvent(row, ctx) → void,
//
//   // Periodic reconciliation (optional); the registry schedules it.
//   syncEveryMs?: number,
//   async sync(ctx) → void,
//
//   // Actions and their default autonomy (Callum's policy: facts are automatic,
//   // anything that speaks for a person or touches production asks). Every
//   // side effect runs inside ctx.act(action, meta, (s) => s.actAs(member)…);
//   // card actions are limited to cancel/stop/approve_done (approve_done only
//   // under an action declared 'ask'), comments are never for the agent.
//   // ctx.act(action, { subject: '<provider user id>' }, …) limits that
//   // user's createCard to integration_card_subject (5/h)too, and lets
//   // actAs only that user's linked member (ctx.memberFor(subject), D98):
//   // anyone else is FORBIDDEN. Without a subject actAs takes only
//   // ctx.connection.created_by, never another linked member.
//   // createCard(boardId, …) takes a board of the connection's team only
//   // (else NOT_FOUND, before any rate token) and the card starts in todo.
//   actions: { 'card.move': { default: 'auto', reversible: true }, 'github.comment': { default: 'ask' }, … },
//
//   // State-machine facts it may raise (a subset of SYSTEM_EVENTS), each
//   // declared as action `system.<event>`. Only for a card linked to this
//   // connection (the act() scope's link); never from a card id or key in the payload.
//   // Applied only for the card's hub-verified PR (ctx.verifiedPr): pass its `pr` and `repo`.
//   systemEvents: ['pr_merged', 'pr_closed'],
//
//   // Optional (D42 addendum C1): the settings.config keys an admin may set
//   // through PATCH (1–32 names, ^[A-Za-z][A-Za-z0-9_-]{0,63}$). Undeclared: any such name.
//   configKeys: ['default_board_id'],
//
//   async health(ctx) → { ok, detail? },
//
//   // Pure reads a handler may use (org-scoped, nothing secret):
//   // ctx.boards() → [{id, title}] (≤ 100, by title); ctx.card(id) →
//   // {id, key, title, board_id, column_name} | null (never body or labels).
//   // ctx.memberFor(subject) → member_id | null (linked on this connection and
//   // able to write); ctx.subjectFor(member_id) → subject | null (a viewer's too).
//   // ctx.linkState(subject) → 'active' | 'unavailable' | 'none' (this connection
//   // only; never a member id). actAs for a linked member who can no longer act
//   // throws { code: 'ACTOR_UNAVAILABLE', scope: 'member' } ('connection' for
//   // created_by): answer the user with fixed text (D42 addendum C2).
//   // ctx.hubUrl → the hub's https origin (BOARD_PUBLIC_URL, read at boot) | null:
//   // the only base for a link to the hub (never config, provider.hub_url or a payload).
//   // ctx.connection.settings.provider → what the provider said at connect time
//   // (immutable; undefined on a connection made before migration 026: fail closed).
//   // Read provider facts from it, settings.pinned or ctx.connection.external_id, never config.
// })

import { isIP } from 'node:net'; // privacy-flow: hub-server

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CONNECT_KINDS = new Set(['oauth', 'app_install', 'token']);
const PREPARE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const PREPARE_INPUTS_MAX = 8;
const CONFIG_KEYS_MAX = 32;
// A settings.config key an admin may write (D42 addendum C1): never a path, a
// prototype key or the name of another settings namespace, in any case.
export const CONFIG_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const RESERVED_CONFIG_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype', 'provider', 'pinned', 'autonomy', 'config']);
export const configKeyOk = (k) => typeof k === 'string' && CONFIG_KEY_RE.test(k) && !RESERVED_CONFIG_KEYS.includes(k.toLowerCase());
export const AUTONOMY = Object.freeze(['auto', 'ask', 'off']);
// The only state-machine events an integration may raise as the system (D42):
// facts from a code host about a PR linked to a card. Chat connectors raise none.
export const SYSTEM_EVENTS = Object.freeze(['pr_merged', 'pr_closed']);

// What a link's status may say (the card face renders these, nothing else).
export const LINK_STATUS = Object.freeze({
  state: Object.freeze(['open', 'draft', 'merged', 'closed']),
  checks: Object.freeze(['passing', 'failing', 'pending', 'none']),
  review: Object.freeze(['none', 'requested', 'changes_requested', 'approved']),
});
/** Only allowlisted keys with allowlisted values; everything else is dropped. */
export function cleanLinkStatus(v) {
  const out = {};
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, allowed] of Object.entries(LINK_STATUS)) if (Object.hasOwn(v, k) && allowed.includes(v[k])) out[k] = v[k];
  return out;
}

/** 'a.b.c.d/n' | 'x::/n' → {address, prefix, type: 'ipv4'|'ipv6'} | null; too wide a range is null. */
export function parseCidr(v) {
  const m = typeof v === 'string' ? /^([^/\s]+)\/(\d{1,3})$/.exec(v) : null;
  const family = m ? isIP(m[1]) : 0;
  if (!family) return null;
  const prefix = Number(m[2]);
  const [min, max] = family === 4 ? [16, 32] : [32, 128];
  return prefix >= min && prefix <= max ? { address: m[1], prefix, type: family === 4 ? 'ipv4' : 'ipv6' } : null;
}

export function defineConnector(spec) {
  const errs = [];
  if (!ID_RE.test(spec?.id ?? '')) errs.push('id must match /^[a-z][a-z0-9-]{1,31}$/');
  if (!spec?.name) errs.push('name is required');
  if (!Array.isArray(spec?.scopes)) errs.push('scopes must be an array (the minimum the connector needs)');
  if (!Array.isArray(spec?.secrets)) errs.push('secrets must list the secret kinds it seals');
  if (!Array.isArray(spec?.hosts) || spec.hosts.some((x) => typeof x !== 'string' || !HOST_RE.test(x))) errs.push('hosts must list the exact lowercase hostnames it calls (https only; no wildcards, ports or schemes)');
  if (!spec?.connect || !CONNECT_KINDS.has(spec.connect.kind)) errs.push(`connect.kind must be one of ${[...CONNECT_KINDS].join(', ')}`);
  if (spec?.connect?.kind === 'token' && typeof spec.connect.verifyToken !== 'function') errs.push('connect.verifyToken is required for token connectors');
  const cn = spec?.connect;
  if (cn && cn.kind !== 'token') {
    if (typeof cn.exchange !== 'function') errs.push('connect.exchange is required for oauth/app_install');
    if (cn.manifestForm !== undefined) {
      if (cn.kind !== 'app_install' || typeof cn.manifestForm !== 'function') errs.push('connect.manifestForm is a function, for app_install only');
      if (cn.authorizeUrl !== undefined) errs.push('connect: authorizeUrl or manifestForm, not both');
      // The web's CSP form-action names this host, so it is static.
      if (typeof cn.formHost !== 'string' || !spec.hosts?.includes?.(cn.formHost)) errs.push('connect.formHost (the host the manifest form posts to) must be one of hosts');
    } else if (typeof cn.authorizeUrl !== 'function') errs.push('connect.authorizeUrl (or, for app_install, manifestForm) is required for oauth/app_install');
  }
  if (cn && (cn.prepare !== undefined || cn.prepareInputs !== undefined)) {
    const keys = cn.prepareInputs;
    if (typeof cn.prepare !== 'function') errs.push('connect.prepare is a function, declared together with connect.prepareInputs');
    if (!Array.isArray(keys) || !keys.length || keys.length > PREPARE_INPUTS_MAX || new Set(keys).size !== keys.length
      || keys.some((k) => typeof k !== 'string' || !PREPARE_KEY_RE.test(k) || ['constructor', 'prototype'].includes(k))) {
      errs.push(`connect.prepareInputs lists 1–${PREPARE_INPUTS_MAX} distinct input names (^[a-z][a-z0-9_]{0,39}$)`);
    }
    if (cn.kind === 'token' || cn.manifestForm !== undefined) errs.push('connect.prepare is for an oauth/app_install connector with authorizeUrl (not token, not manifestForm)');
  }
  if (cn?.handshake !== undefined && (typeof cn.handshake !== 'function' || typeof cn.prepare !== 'function' || typeof spec.ackBody !== 'function')) {
    errs.push('connect.handshake is a function, for a connector that declares connect.prepare and ackBody');
  }
  if (spec?.handleWebhook && typeof spec.verify !== 'function') errs.push('a connector that takes webhooks must implement verify() (signature check)');
  if (spec?.ackEarly !== undefined && (!['boolean', 'function'].includes(typeof spec.ackEarly) || !spec.handleWebhook)) errs.push('ackEarly is a boolean or a function ({payload, headers}) → boolean, for a connector that takes webhooks');
  if (spec?.ackBody !== undefined && (typeof spec.ackBody !== 'function' || !spec.handleWebhook || !spec.ackEarly)) errs.push('ackBody is a function, for a connector that declares ackEarly');
  if (spec?.parseBody !== undefined && (typeof spec.parseBody !== 'function' || !spec.handleWebhook)) errs.push('parseBody is a function, for a connector that takes webhooks');
  if (spec?.onAckedFailure !== undefined && (typeof spec.onAckedFailure !== 'function' || !spec.handleWebhook || !spec.ackEarly)) errs.push('onAckedFailure is a function ({payload, headers, error_code, fetch}), for a connector that declares ackEarly');
  if (spec?.ingressCidrs !== undefined && (!Array.isArray(spec.ingressCidrs) || (spec.ingressCidrs.length && (!spec.handleWebhook || spec.ingressCidrs.some((x) => !parseCidr(x)))))) {
    errs.push('ingressCidrs lists CIDR ranges (IPv4 /16 or narrower, IPv6 /32 or narrower), for a connector that takes webhooks');
  }
  if (spec?.workspaceUnique !== undefined && typeof spec.workspaceUnique !== 'boolean') errs.push('workspaceUnique is a boolean');
  if (spec?.configKeys !== undefined) {
    const k = spec.configKeys;
    if (!Array.isArray(k) || !k.length || k.length > CONFIG_KEYS_MAX || new Set(k).size !== k.length || !k.every(configKeyOk)) {
      errs.push(`configKeys lists 1–${CONFIG_KEYS_MAX} distinct config key names (^[A-Za-z][A-Za-z0-9_-]{0,63}$, not a prototype key or a settings namespace)`);
    }
  }
  if (spec?.identity !== undefined) {
    const idn = spec.identity;
    const onHosts = (u) => {
      if (typeof u !== 'string') return false;
      try { const x = new URL(u); return x.protocol === 'https:' && !x.port && !x.username && !x.password && !!spec.hosts?.includes?.(x.hostname); } catch { return false; }
    };
    // The hub-wide UNIQUE (provider, workspace_id, subject) is sound only when one live connection owns a workspace.
    if (spec.workspaceUnique !== true) errs.push('identity needs workspaceUnique: true');
    if (!idn || typeof idn !== 'object') errs.push('identity is an object');
    else {
      if (!onHosts(idn.issuer)) errs.push('identity.issuer is an https URL on hosts');
      if (!onHosts(idn.jwksUrl)) errs.push('identity.jwksUrl is an https URL on hosts');
      if (typeof idn.workspaceClaim !== 'string' || !idn.workspaceClaim) errs.push('identity.workspaceClaim names the id_token claim holding the workspace');
      // g/y make test() stateful (lastIndex): one subject would pass and the next fail.
      if (!(idn.subjectRe instanceof RegExp) || idn.subjectRe.global || idn.subjectRe.sticky) errs.push('identity.subjectRe is a RegExp without the g or y flag');
      if (typeof idn.authorizeUrl !== 'function' || typeof idn.exchange !== 'function') errs.push('identity.authorizeUrl and identity.exchange are functions');
    }
  }
  if (spec?.consumes && typeof spec.onEvent !== 'function') errs.push('consumes needs onEvent()');
  for (const [name, a] of Object.entries(spec?.actions ?? {})) {
    if (!AUTONOMY.includes(a?.default)) errs.push(`action ${name}: default must be auto|ask|off`);
  }
  for (const e of spec?.systemEvents ?? []) {
    if (!SYSTEM_EVENTS.includes(e)) errs.push(`systemEvents: ${e} is not an allowed system event (${SYSTEM_EVENTS.join(', ')})`);
    else if (!spec.actions?.[`system.${e}`]) errs.push(`systemEvents: declare the action system.${e} with its autonomy default`);
  }
  if (errs.length) throw new Error(`connector ${spec?.id ?? '?'}: ${errs.join('; ')}`);
  // The registry filters pasted input by prepareInputs: a connector can't widen it later.
  const connect = Array.isArray(cn?.prepareInputs) ? Object.freeze({ ...cn, prepareInputs: Object.freeze([...cn.prepareInputs]) }) : spec.connect;
  return Object.freeze({
    consumes: [], actions: {}, systemEvents: [], ...spec, connect, hosts: Object.freeze([...spec.hosts]), ingressCidrs: Object.freeze([...(spec.ingressCidrs ?? [])]),
    ...(spec.identity ? { identity: Object.freeze({ ...spec.identity }) } : {}),
    ...(spec.configKeys ? { configKeys: Object.freeze([...spec.configKeys]) } : {}),
  });
}
