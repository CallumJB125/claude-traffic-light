// LOCAL / DISPOSABLE PROOF RIG — not production account acceptance.
// An in-process accounts-mode hub on a loopback port with the dev team
// (alice owner, bob member) and an outsider (carol). Alice's "Mac" hosts
// sessions backed by the FAKE codex app-server fixture; her "Windows" and
// other people message them through board/hub/messaging.js.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { startAccounts } from './accounts-helpers.js';
import { createLogger } from '../log.js';

const require = createRequire(import.meta.url);
const { createRemoteInteractionHost } = require('../../../src/remote-interaction.js');
const { createSessionMessagingHost, createMessagingClient } = require('../../../src/session-messaging.js');
const { createCodexAppServer } = require('../../../src/codex-app-server.js');
const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'fake-codex-app-server.js');

export const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)); } };

export async function messagingRig({ limits } = {}) {
  const lines = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  const h = await startAccounts({ log, config: limits ? { messagingLimits: limits } : {} });
  const signIn = async (email, name) => {
    const r = await h.signIn(email, { device_name: name });
    assert.equal(r.status, 200, r.text);
    return { token: r.body.device_token, device: r.body.device_id, user: r.body.user.id };
  };
  const macA = await signIn('alice@dev.local', 'Alice Mac');
  const winA = await signIn('alice@dev.local', 'Alice Windows');
  const bob = await signIn('bob@dev.local', 'Bob Windows');
  const carol = await signIn('carol@dev.local', 'Carol Laptop');
  const org = h.ids.org;
  const stops = [];
  // A Mac that opted in to hosting, with one owned (fake Codex) session and the message receiver.
  async function mac(dev = macA, { shares = () => null, start = true, ...opts } = {}) {
    const adapter = createCodexAppServer({ bin: FAKE });
    const remote = createRemoteInteractionHost({ userId: dev.user, adapters: { codex: adapter }, boardCurrent: (b) => b === null });
    const st = await remote.enable({ baseUrl: h.base, token: dev.token, WebSocket });
    assert.equal(st.state, 'connected');
    const recv = createSessionMessagingHost({ baseUrl: h.base, token: dev.token, remote, shares, pollMs: 20, waitMs: 300, ...opts });
    stops.push(() => { recv.stop(); remote.close(); });
    const launch = async () => { const r = await remote.hub.launch({ provider: 'codex', board: null }, remote.actor); assert.equal(r.ok, true); return r.state; };
    const session = await launch();
    if (start) recv.start();
    return { remote, recv, adapter, session, launch };
  }
  const client = (dev) => createMessagingClient({ baseUrl: h.base, token: dev.token });
  const api = (dev, method, path, body) => h.call(method, `/api/messaging/v1${path}`, { token: dev.token, body });
  return {
    h, lines, macA, winA, bob, carol, org, mac, client, api,
    async close() { for (const s of stops) s(); await h.close(); },
  };
}

export async function targetOf(c, pred = () => true) {
  const r = await c.targets();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.targets.find(pred) ?? null;
}
