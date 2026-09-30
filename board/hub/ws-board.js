// /ws/board (CONTRACT §5.3): read-only push to browsers. hello → welcome,
// subscribe → snapshot, then card.upsert / event.append / lease.tick for that
// board. Every mutation goes over HTTP (D18).

import { randomUUID } from 'node:crypto';
import { validate, compatible, PROTOCOL_VERSION, WS_CLOSE } from '../shared/protocol.js';
import { boardSnapshot } from './views.js';
import { publicMember } from './api.js';

const PING_MS = 20_000;

export class BrowserConn {
  // member: the resolved member, or null when the sign-in belongs to several
  // orgs and none was requested (the subscribed board's org decides).
  // user + cred: BOARD_AUTH=accounts (the device token or cookie session the
  // socket was opened with; revoking it closes the socket).
  constructor(hub, ws, { member = null, candidates = member ? [member] : [], expMs = null, user = null, cred = null } = {}) {
    this.hub = hub;
    this.ws = ws;
    this.member = member;
    this.candidates = candidates;
    this.expMs = expMs;
    this.user = user;
    this.cred = cred;
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

  // Called when membership may have changed: close if the member is gone.
  // Accounts: every live membership of the user, read fresh (a user with no
  // team yet keeps the socket; subscribe just finds nothing). Other modes:
  // the member rows the sign-in mapped to at upgrade, still active.
  liveCandidates() {
    if (this.user) return this.hub.db.all('SELECT * FROM members WHERE user_id = ? AND removed_at IS NULL', this.user.id);
    return this.candidates.map((c) => this.hub.activeMember(c.id)).filter(Boolean);
  }

  recheck() {
    if (this.cred && !this.hub.accounts?.credValid(this.cred)) { this.close(WS_CLOSE.UNAUTHENTICATED, 'signed out'); return; }
    const alive = this.liveCandidates();
    if (this.user && !this.member) { this.candidates = alive; return; }
    if (!alive.length || (this.member && !alive.some((c) => c.id === this.member.id))) { this.revoked(); return; }
    this.candidates = alive;
    if (this.member) this.member = alive.find((c) => c.id === this.member.id);
  }

  revoked() {
    this.boardId = null;
    this.close(WS_CLOSE.REVOKED, 'no longer a member of this board');
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
      const m = this.member ?? this.candidates[0];
      this.send({
        type: 'welcome', protocol: PROTOCOL_VERSION, hub_epoch: this.hub.epoch, member: m ? publicMember(m) : null,
        ...(this.user ? { user: { id: this.user.id, display_name: this.user.display_name } } : {}),
      });
      return;
    }
    if (!this.helloed) {
      this.send({ type: 'error', code: 'VALIDATION', message: 'hello must be the first frame' });
      return;
    }
    switch (msg.type) {
      case 'subscribe': {
        // Membership is re-read on every subscribe: a removed member gets nothing.
        const alive = this.liveCandidates();
        if (!alive.length && !this.user) { this.revoked(); return; }
        this.candidates = alive;
        const board = this.hub.board(msg.board_id);
        const m = board && (this.member && !this.user ? alive.find((c) => c.id === this.member.id && c.org_id === board.org_id) : alive.find((c) => c.org_id === board.org_id));
        if (!m) {
          this.send({ type: 'error', code: 'NOT_FOUND', message: 'board not found' });
          return;
        }
        this.member = m;
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
