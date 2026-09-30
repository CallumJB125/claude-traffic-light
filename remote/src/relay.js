// Relay contract between phone, hub and desktop, plus a reference in-memory
// hub for tests. The hub is a dumb, untrusted pipe: it routes by desktopId and
// never needs to understand, and cannot forge, what it carries.
//
// HubMessage (phone → hub → desktop)
//   { v: 1, to: desktopId, kind: 'decision' | 'pair-init' | 'pair-reveal' | 'pair-poll', body }
//   body is opaque to the hub: a signed decision envelope, or a pairing message.
//
// RelayOutcome (hub → phone)
//   { status: 'delivered', body }   body = whatever the desktop answered (signed)
//   { status: 'desktop-offline' }   no live connection from that desktop
//   { status: 'timeout' }           delivered, no answer in time — outcome unknown
//   { status: 'bad-request' }       the hub refused the message shape
//
// The phone treats only a desktop-signed 'applied' result as success
// (decision.js interpretResult). A hub that lies can make a decision look
// failed (denial of service), never make one look applied.
//
// Desktop → hub (not modelled here): the desktop keeps an authenticated
// outbound connection (WebSocket over Tailscale/Access) and pushes signed
// request notices to its owner's devices.

import { signDecision, interpretResult } from './decision.js';

const KINDS = new Set(['decision', 'pair-init', 'pair-reveal', 'pair-poll']);

export class InMemoryHub {
  constructor({ timeoutMs = 5000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.desktops = new Map();
    this.log = []; // everything the hub saw, for tests
  }

  // A desktop comes online with a handler (msg) → Promise<body>.
  connect(desktopId, handler) {
    this.desktops.set(desktopId, handler);
    return () => { if (this.desktops.get(desktopId) === handler) this.desktops.delete(desktopId); };
  }

  async forward(msg) {
    this.log.push(structuredClone(msg));
    if (!msg || msg.v !== 1 || typeof msg.to !== 'string' || !KINDS.has(msg.kind)) return { status: 'bad-request' };
    const handler = this.desktops.get(msg.to);
    if (!handler) return { status: 'desktop-offline' };
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout' }), this.timeoutMs); });
    try {
      return await Promise.race([
        Promise.resolve(handler(structuredClone(msg))).then((body) => ({ status: 'delivered', body }), () => ({ status: 'timeout' })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

// The desktop's side of the relay: routes hub messages to the pairing host
// and the approvals gate. Pairing confirm is deliberately NOT reachable from
// the relay — only the local desktop UI can call pairing.confirm().
export function createDesktopHandler({ approvals, pairing }) {
  return async (msg) => {
    switch (msg.kind) {
      case 'decision': return (await approvals.handleDecision(msg.body)).body;
      case 'pair-init': return pairing ? pairing.handleInit(msg.body) : { ok: false, reason: 'pairing-closed' };
      case 'pair-reveal': return pairing ? pairing.handleReveal(msg.body) : { ok: false, reason: 'pairing-closed' };
      case 'pair-poll': return pairing ? pairing.poll(msg.body?.pid) : { ok: false, reason: 'pairing-closed' };
      default: return { ok: false, reason: 'unknown-kind' };
    }
  };
}

// Phone helper: sign → relay → interpret, in one call.
// `paired` is what PairingClient.onComplete returned (kept on the phone).
export async function sendDecision(hub, { paired, notice, decision, now }) {
  const device = { deviceId: paired.deviceId, privateKey: paired.keyPair.privateKey };
  const { envelope, payload } = await signDecision({ device, desktopId: paired.desktopId, request: notice, decision, now });
  const outcome = await hub.forward({ v: 1, to: paired.desktopId, kind: 'decision', body: envelope });
  return { ...(await interpretResult(outcome, { desktopPubRaw: paired.desktopPub, sent: payload })), envelope, outcome };
}
