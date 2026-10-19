import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { checkDelivery } from '../scripts/verify-connector-delivery.mjs';
test('synthetic capture: exact bytes and timestamp required; output contains no payload or secret', () => {
  const secret = randomBytes(32).toString('hex'); const now = Date.now();
  for (const provider of ['linear', 'jira']) {
    const rawBody = Buffer.from(JSON.stringify({ webhookTimestamp: now, timestamp: now, description: 'private fixture' }));
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    const headers = provider === 'linear' ? { 'Linear-Signature': signature } : { 'X-Hub-Signature': `sha256=${signature}` };
    const args = { provider, rawBody, headers, secret, receivedAt: now };
    const ok = checkDelivery(args); assert.equal(ok.signatureAccepted, true);
    assert.doesNotMatch(JSON.stringify(ok), /private fixture|description/); assert.ok(!JSON.stringify(ok).includes(secret));
    assert.equal(checkDelivery({ ...args, rawBody: Buffer.concat([rawBody, Buffer.from(' ')]) }).signatureAccepted, false);
    assert.equal(checkDelivery({ ...args, receivedAt: now + 2 * 86400000 }).signatureAccepted, false);
  }
});
