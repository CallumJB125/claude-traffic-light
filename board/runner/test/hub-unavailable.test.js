// A hub that cannot check credentials right now (Access JWKS unreachable)
// closes 4503: the runner keeps backing off and reconnecting, and is back as
// soon as the hub is. 4401 (a real refusal) still stops it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { WS_CLOSE } from '../../shared/protocol.js';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, waitFor, fakeClock } from './helpers.js';

test('4503 is transient: the runner keeps retrying and reconnects; 4401 stops it', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, clock: fakeClock() });
  const refused = [];
  sup.on('local', (e) => { if (e.event === 'hub_refused') refused.push(e.code); });
  try {
    hub.closeWith = WS_CLOSE.UNAVAILABLE;
    hub.dropAll();
    await waitFor(() => !sup.connected, { what: 'disconnected' });
    const before = hub.upgrades;
    await waitFor(() => hub.upgrades >= before + 3, { what: 'three more attempts' });
    assert.deepEqual(refused, []);

    hub.closeWith = null;
    await waitFor(() => sup.connected, { what: 'reconnected' });

    hub.closeWith = WS_CLOSE.UNAUTHENTICATED;
    hub.dropAll();
    await waitFor(() => refused.length === 1, { what: 'refused' });
    assert.deepEqual(refused, [WS_CLOSE.UNAUTHENTICATED]);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
