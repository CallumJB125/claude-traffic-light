import {
  createIdentity, DeviceRegistry, PairingHost, PairingClient, parsePairingQr,
  InMemoryHub, createDesktopHandler, RemoteApprovals, MemoryPendingStore,
} from '../src/index.js';

export const HUB_URL = 'https://hub.example.ts.net';

// A fake clock the tests can move.
export function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => { t += ms; };
  return clock;
}

// One member's desktop: identity, registry, pending store, approvals gate,
// pairing host, connected to a hub.
export async function makeDesktop({ ownerId = 'alice', hub = new InMemoryHub(), clock = fakeClock(), rules, authorize } = {}) {
  const identity = await createIdentity();
  const registry = new DeviceRegistry({ clock });
  const pending = new MemoryPendingStore();
  const audit = [];
  const approvals = new RemoteApprovals({ identity, registry, pending, clock, audit: (e) => audit.push(e), ...(rules ? { rules } : {}), ...(authorize ? { authorize } : {}) });
  const pairing = new PairingHost({ identity, registry, ownerId, hubUrl: HUB_URL, clock, audit: (e) => audit.push(e) });
  const disconnect = hub.connect(identity.desktopId, createDesktopHandler({ approvals, pairing }));
  return { ownerId, hub, clock, identity, registry, pending, approvals, pairing, audit, disconnect };
}

// Full pairing through the hub; returns what the phone keeps.
export async function pairPhone(desk, { deviceName = 'Alice iPhone' } = {}) {
  const { qrText, pid } = await desk.pairing.start();
  const qr = parsePairingQr(qrText, { now: desk.clock() });
  const phone = await PairingClient.begin(qr, { deviceName });
  const r1 = await desk.hub.forward({ v: 1, to: qr.did, kind: 'pair-init', body: phone.init });
  if (!r1.body?.ok) throw new Error(`pair-init failed: ${r1.body?.reason}`);
  const { reveal, sas } = await phone.onChallenge(r1.body.challenge);
  const r2 = await desk.hub.forward({ v: 1, to: qr.did, kind: 'pair-reveal', body: reveal });
  if (!r2.body?.ok) throw new Error(`pair-reveal failed: ${r2.body?.reason}`);
  if (r2.body.sas !== sas) throw new Error('SAS mismatch');
  await desk.pairing.confirm(pid, true);
  const r3 = await desk.hub.forward({ v: 1, to: qr.did, kind: 'pair-poll', body: { pid } });
  return phone.onComplete(r3.body.complete);
}

export function bashRequest(overrides = {}) {
  return {
    requestId: `mac-s1-${Math.random().toString(36).slice(2)}`,
    sessionId: 's1', cardId: null, toolName: 'Bash',
    toolInput: { command: 'npm test', description: 'Run tests' },
    cwd: '/Users/alice/code/app', ownerId: 'alice', repoLabels: [], createdAt: new Date().toISOString(),
    ...overrides,
  };
}
