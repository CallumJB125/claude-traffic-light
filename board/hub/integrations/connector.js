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
//
//   // Connect (in an in-app auth window). Either an OAuth-style redirect
//   // flow or a manual token. The registry makes and checks `state`.
//   connect: {
//     kind: 'oauth' | 'app_install' | 'token',
//     authorizeUrl({ state, redirectUri, config }) → string,          // oauth/app_install
//     async exchange({ query, redirectUri, config, fetch }) →          // oauth/app_install callback
//       { external_id, display_name, scopes: [...], secrets: {kind: value}, settings? },
//     async verifyToken({ token, fetch }) → { external_id, display_name, scopes, secrets }, // token
//   },
//
//   // Inbound webhooks at POST /integrations/<connection id>/webhook.
//   // MUST verify the provider signature over the raw body, in constant time,
//   // and return a dedupe key (delivery id) for replay protection.
//   verify({ headers, rawBody, secrets, now }) → { ok: true, dedupe_key } | { ok: false, reason },
//   async handleWebhook({ headers, payload, ctx }) → void,
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
//   // anything that speaks for a person or touches production asks).
//   actions: { 'card.move': { default: 'auto', reversible: true }, 'github.comment': { default: 'ask' }, … },
//
//   // State-machine facts it may raise (a subset of SYSTEM_EVENTS), each
//   // declared as action `system.<event>`. Only for a card linked to this
//   // connection (ctx.link); never from a card id or key in the payload.
//   systemEvents: ['pr_merged', 'pr_closed'],
//
//   async health(ctx) → { ok, detail? },
// })

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const CONNECT_KINDS = new Set(['oauth', 'app_install', 'token']);
export const AUTONOMY = Object.freeze(['auto', 'ask', 'off']);
// The only state-machine events an integration may raise as the system (D42):
// facts from a code host about a PR linked to a card. Chat connectors raise none.
export const SYSTEM_EVENTS = Object.freeze(['pr_merged', 'pr_closed']);

export function defineConnector(spec) {
  const errs = [];
  if (!ID_RE.test(spec?.id ?? '')) errs.push('id must match /^[a-z][a-z0-9-]{1,31}$/');
  if (!spec?.name) errs.push('name is required');
  if (!Array.isArray(spec?.scopes)) errs.push('scopes must be an array (the minimum the connector needs)');
  if (!Array.isArray(spec?.secrets)) errs.push('secrets must list the secret kinds it seals');
  if (!spec?.connect || !CONNECT_KINDS.has(spec.connect.kind)) errs.push(`connect.kind must be one of ${[...CONNECT_KINDS].join(', ')}`);
  if (spec?.connect?.kind === 'token' && typeof spec.connect.verifyToken !== 'function') errs.push('connect.verifyToken is required for token connectors');
  if (spec?.connect && spec.connect.kind !== 'token' && (typeof spec.connect.authorizeUrl !== 'function' || typeof spec.connect.exchange !== 'function')) errs.push('connect.authorizeUrl and connect.exchange are required for oauth/app_install');
  if (spec?.handleWebhook && typeof spec.verify !== 'function') errs.push('a connector that takes webhooks must implement verify() (signature check)');
  if (spec?.consumes && typeof spec.onEvent !== 'function') errs.push('consumes needs onEvent()');
  for (const [name, a] of Object.entries(spec?.actions ?? {})) {
    if (!AUTONOMY.includes(a?.default)) errs.push(`action ${name}: default must be auto|ask|off`);
  }
  for (const e of spec?.systemEvents ?? []) {
    if (!SYSTEM_EVENTS.includes(e)) errs.push(`systemEvents: ${e} is not an allowed system event (${SYSTEM_EVENTS.join(', ')})`);
    else if (!spec.actions?.[`system.${e}`]) errs.push(`systemEvents: declare the action system.${e} with its autonomy default`);
  }
  if (errs.length) throw new Error(`connector ${spec?.id ?? '?'}: ${errs.join('; ')}`);
  return Object.freeze({ consumes: [], actions: {}, systemEvents: [], ...spec });
}
