import {
  createIdentity, DeviceRegistry, PairingHost, PairingClient, parsePairingQr,
  InMemoryHub, createDesktopHandler, RemoteApprovals, MemoryPendingStore,
} from '../src/index.js';

import { b64url, utf8, concatBytes, fromB64url as fromB64urlLocal } from '../src/encoding.js';

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
  if ('sas' in r2.body) throw new Error('desktop must never display the code');
  const c = await desk.pairing.confirm(pid, sas); // the human types the phone's code
  if (!c.ok) throw new Error(`confirm failed: ${c.reason}`);
  const r3 = await desk.hub.forward({ v: 1, to: qr.did, kind: 'pair-poll', body: { pid } });
  return phone.onComplete(r3.body.complete);
}

export function bashRequest(overrides = {}) {
  return {
    requestId: `mac-s1-${Math.random().toString(36).slice(2)}`,
    sessionId: 's1', cardId: null, toolName: 'Bash',
    toolInput: { command: 'git status', description: 'Show status' },
    cwd: '/Users/alice/code/app', ownerId: 'alice', repoLabels: [], createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = concatBytes(new Uint8Array([0]), v);
    return concatBytes(new Uint8Array([0x02, v.length]), v);
  };
  const body = concatBytes(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

// A virtual platform authenticator (W2-B tests): one ES256 credential, UP+UV,
// counter 0 (like Apple passkeys) unless told otherwise.
export async function virtualAuthenticator({ rpId, origin, flags = 0x05 }) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const credentialId = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const authData = async (f, count) => concatBytes(await sha256(utf8(rpId)), new Uint8Array([f, 0, 0, 0, count]));
  return {
    credentialId,
    async register(challenge, o = {}) {
      const cd = utf8(JSON.stringify({ type: o.type ?? 'webauthn.create', challenge: b64url(challenge), origin: o.origin ?? origin }));
      // Attested credential data: aaguid ‖ id length ‖ id ‖ COSE EC2 key (canonical CBOR).
      const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      const id = fromB64urlLocal(o.credentialId ?? credentialId);
      const x = fromB64urlLocal(jwk.x), y = fromB64urlLocal(jwk.y);
      const cose = concatBytes(new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, new Uint8Array([0x22, 0x58, 0x20]), y);
      const att = o.noAttested ? new Uint8Array(0) : concatBytes(new Uint8Array(16), new Uint8Array([id.length >> 8, id.length & 255]), id, cose);
      const ad = concatBytes(await authData((o.flags ?? flags) | (o.noAttested ? 0 : 0x40), 0), att);
      return { credentialId, publicKey: b64url(o.spki ?? spki), algorithm: -7, authenticatorData: b64url(ad), clientDataJSON: b64url(cd) };
    },
    async assert(challenge, o = {}) {
      const cd = utf8(JSON.stringify({ type: 'webauthn.get', challenge: b64url(challenge), origin: o.origin ?? origin }));
      const ad = await authData(o.flags ?? flags, o.count ?? 0);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, concatBytes(ad, await sha256(cd))));
      return { authenticatorData: b64url(ad), clientDataJSON: b64url(cd), signature: b64url(rawToDer(raw)) };
    },
  };
}

