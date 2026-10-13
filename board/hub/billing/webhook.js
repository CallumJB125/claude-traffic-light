// POST /api/billing/webhook: one provider delivery → {status, body}.
// Signature first (HMAC with the hub's webhook secret, timestamp within the
// provider's tolerance): anything unsigned, mis-signed or stale is 400 and
// touches nothing. A verified event is applied at most once: its id is
// recorded in billing_events in the same transaction as its effect, so a
// repeated delivery answers 200 and changes nothing, and a failed apply rolls
// back and is retried by the provider. Nothing from the payload is logged.

import { WebhookInvalid } from './stripe.js';

export function handleWebhook(hub, billing, { headers, rawBody }) {
  const provider = billing?.provider;
  if (!provider) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such route' } } };
  let event;
  try {
    event = provider.verify(headers, rawBody, Math.floor(hub.wallMs() / 1000));
  } catch (e) {
    if (e instanceof WebhookInvalid) return { status: 400, body: { error: { code: 'VALIDATION', message: 'invalid signature' } } };
    throw e;
  }
  const outcome = hub.txn(() => {
    if (hub.db.get('SELECT 1 AS x FROM billing_events WHERE provider = ? AND event_id = ?', provider.name, event.id)) return 'duplicate';
    const evt = provider.normalize(event);
    const result = evt ? billing.apply(evt) : 'ignored';
    hub.db.insert('billing_events', { provider: provider.name, event_id: event.id, type: String(event.type).slice(0, 100), outcome: result, received_at: hub.iso() });
    return result;
  });
  return { status: 200, body: { received: true, ...(outcome === 'duplicate' ? { duplicate: true } : {}) } };
}
