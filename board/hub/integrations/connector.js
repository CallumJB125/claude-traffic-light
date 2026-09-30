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
//
//   // Connect (in an in-app auth window). Either an OAuth-style redirect
//   // flow or a manual token. The registry makes and checks `state`.
//   connect: {
//     kind: 'oauth' | 'app_install' | 'token',
//     authorizeUrl({ state, redirectUri, webhookUrl, config }) → string,   // oauth/app_install: a GET redirect
//     // or, app_install only, a POSTed form (GitHub's App-manifest flow):
//     formHost: 'github.com',                                          // one of `hosts`; the only host the form may post to
//     manifestForm({ state, redirectUri, webhookUrl, config }) → { action: 'https://<formHost>/…', fields: {name: string} },
//     async exchange({ query, redirectUri, webhookUrl, config, fetch }) →   // oauth/app_install callback
//       { external_id, display_name, scopes: [...], secrets: {kind: value},
//         settings?: {k: scalar} (non-secret, ≤ 2 KB, stored as settings.config),
//         next_url?: 'https://<one of hosts>/…' (the callback page's one "Continue on <name>" link) },
//     (`webhookUrl` is this connection's future webhook URL; `config` is the
//     stored settings.config of the org's active connection of this provider, else {})
//     async verifyToken({ token, fetch }) → { external_id, display_name, scopes, secrets }, // token
//     (`fetch` here is restricted to `hosts`, with a timeout; errors never reach users)
//   },
//
//   // Inbound webhooks at POST /integrations/<connection id>/webhook.
//   // MUST verify the provider signature over the raw body, in constant time,
//   // and return a dedupe key (delivery id) for replay protection.
//   verify({ headers, rawBody, secrets, now }) → { ok: true, dedupe_key } | { ok: false, reason },
//   async handleWebhook({ headers, payload, ctx }) → void,
//   // Optional, default false: answer 200 once the delivery is verified and
//   // leased, then run handleWebhook (same lease, timeout and ctx). For a
//   // provider that needs an answer within seconds (Slack: 3 s). A failure then
//   // reaches no provider retry: it is audited (action 'webhook', 'failed' +
//   // code) and the lease released, so a manual redelivery runs it.
//   ackEarly: false,
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
//   actions: { 'card.move': { default: 'auto', reversible: true }, 'github.comment': { default: 'ask' }, … },
//
//   // State-machine facts it may raise (a subset of SYSTEM_EVENTS), each
//   // declared as action `system.<event>`. Only for a card linked to this
//   // connection (the act() scope's link); never from a card id or key in the payload.
//   // Applied only for the card's hub-verified PR (ctx.verifiedPr): pass its `pr` and `repo`.
//   systemEvents: ['pr_merged', 'pr_closed'],
//
//   async health(ctx) → { ok, detail? },
// })

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CONNECT_KINDS = new Set(['oauth', 'app_install', 'token']);
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
  if (spec?.handleWebhook && typeof spec.verify !== 'function') errs.push('a connector that takes webhooks must implement verify() (signature check)');
  if (spec?.ackEarly !== undefined && (typeof spec.ackEarly !== 'boolean' || !spec.handleWebhook)) errs.push('ackEarly is a boolean, for a connector that takes webhooks');
  if (spec?.consumes && typeof spec.onEvent !== 'function') errs.push('consumes needs onEvent()');
  for (const [name, a] of Object.entries(spec?.actions ?? {})) {
    if (!AUTONOMY.includes(a?.default)) errs.push(`action ${name}: default must be auto|ask|off`);
  }
  for (const e of spec?.systemEvents ?? []) {
    if (!SYSTEM_EVENTS.includes(e)) errs.push(`systemEvents: ${e} is not an allowed system event (${SYSTEM_EVENTS.join(', ')})`);
    else if (!spec.actions?.[`system.${e}`]) errs.push(`systemEvents: declare the action system.${e} with its autonomy default`);
  }
  if (errs.length) throw new Error(`connector ${spec?.id ?? '?'}: ${errs.join('; ')}`);
  return Object.freeze({ consumes: [], actions: {}, systemEvents: [], ...spec, hosts: Object.freeze([...spec.hosts]) });
}
