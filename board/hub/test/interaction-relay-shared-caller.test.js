import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionRelay } from '../interaction-relay.js';

test('shared caller requires a valid desktop credential; hosting leaves own-device client guard intact', () => {
  const hub = { accounts: { credValid: c => c?.id === 'valid' }, db: { get: () => ({ r: 'host' }) } };
  const relay = new InteractionRelay(hub);
  const host = { user: { id: 'user-a' }, cred: { kind: 'device', id: 'valid' } };
  assert.doesNotThrow(() => relay.asSharedClient(host));
  assert.throws(() => relay.asClient(host), { code: 'FORBIDDEN' });
  hub.db.get = () => ({ r: 'client' });
  assert.doesNotThrow(() => relay.asSharedClient(host));
  assert.doesNotThrow(() => relay.asClient(host));
  assert.throws(() => relay.asSharedClient({ cred: { kind: 'session', id: 'valid' } }), { code: 'FORBIDDEN' });
  assert.throws(() => relay.asSharedClient(null), { code: 'FORBIDDEN' });
  assert.throws(() => relay.asSharedClient({ cred: { kind: 'device', id: 'revoked' } }), { code: 'UNAUTHENTICATED' });
  hub.accounts.credValid = () => { throw Error('unreadable'); };
  assert.throws(() => relay.asSharedClient(host), { code: 'UNAUTHENTICATED' });
});
