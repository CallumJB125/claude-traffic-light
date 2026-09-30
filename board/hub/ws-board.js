// /ws/board (CONTRACT §5.3): read-only push to browsers. hello → welcome,
// subscribe → snapshot, then card.upsert / event.append / lease.tick for that
// board. Every mutation goes over HTTP (D18).

import { randomUUID } from 'node:crypto';
import { validate, compatible, PROTOCOL_VERSION, WS_CLOSE } from '../shared/protocol.js';
import { boardSnapshot } from './views.js';
import { publicMember } from './api.js';

const PING_MS = 20_000;

export class BrowserConn {
  constructor(hub, ws, member) {
    this.hub = hub;
    this.ws = ws;
    this.member = member;
    this.boardId = null;
    this.helloed = false;
    this.ticks = new Map();
    this.key = randomUUID();
    hub.browsers.add(this);
    this.ping = setInterval(() => { try { ws.ping(); } catch { /* closed */ } }, PING_MS);
    this.ping.unref?.();
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.onClose());
    ws.on('error', () => {});
  }

  send(frame) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  close(code, reason) {
    try { this.ws.close(code, reason); } catch { /* already closed */ }
  }

  onClose() {
    clearInterval(this.ping);
    this.hub.browsers.delete(this);
  }

  onMessage(data) {
    const rl = this.hub.limiter.take('ws_browser', this.key);
    if (!rl.ok) {
      this.send({ type: 'error', code: 'RATE_LIMITED', message: 'too many frames; slow down' });
      return;
    }
    let msg;
    try { msg = JSON.parse(String(data)); } catch {
      this.send({ type: 'error', code: 'VALIDATION', message: 'frame is not JSON' });
      return;
    }
    const bad = validate('browser→hub', msg);
    if (bad) {
      this.send({ type: 'error', code: bad.code, message: bad.message });
      return;
    }
    if (msg.type === 'hello') {
      if (!compatible(msg.protocol)) {
        this.send({ type: 'error', code: 'PROTOCOL_UNSUPPORTED', message: `hub speaks protocol ${PROTOCOL_VERSION}` });
        this.close(WS_CLOSE.PROTOCOL_UNSUPPORTED, 'protocol unsupported');
        return;
      }
      this.helloed = true;
      this.send({ type: 'welcome', protocol: PROTOCOL_VERSION, hub_epoch: this.hub.epoch, member: publicMember(this.member) });
      return;
    }
    if (!this.helloed) {
      this.send({ type: 'error', code: 'VALIDATION', message: 'hello must be the first frame' });
      return;
    }
    switch (msg.type) {
      case 'subscribe': {
        const board = this.hub.board(msg.board_id);
        if (!board || board.org_id !== this.member.org_id) {
          this.send({ type: 'error', code: 'NOT_FOUND', message: 'board not found' });
          return;
        }
        this.boardId = board.id;
        this.ticks.clear();
        this.send({ type: 'snapshot', ...boardSnapshot(this.hub, board.id, this.member.id) });
        return;
      }
      case 'unsubscribe':
        if (msg.board_id === this.boardId) this.boardId = null;
        return;
      case 'ping':
        this.send({ type: 'pong' });
        return;
      default:
    }
  }
}
