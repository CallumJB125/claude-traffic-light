import test from 'node:test';
import assert from 'node:assert/strict';
import { connectBoard } from '../js/socket.js';
import { WS_CLOSE } from '../../shared/protocol.js';

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
  open() { this.onopen?.(); }
  push(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop(code = 1006) { this.onclose?.({ code }); }
}

function harness() {
  FakeWS.all = [];
  const statuses = [];
  const messages = [];
  const scheduled = [];
  const conn = connectBoard({
    boardId: 'b1', url: 'ws://x/ws/board', WebSocketImpl: FakeWS,
    onStatus: (s) => statuses.push(s.status), onMessage: (m) => messages.push(m),
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; }, cancel: () => {},
  });
  return { conn, statuses, messages, scheduled, ws: () => FakeWS.all.at(-1) };
}

const snapshot = { type: 'snapshot', board_id: 'b1', board: {}, cards: [], members: [] };

test('hello then subscribe; snapshot marks the board open', () => {
  const h = harness();
  h.ws().open();
  assert.deepEqual(h.ws().sent, [{ type: 'hello', protocol: 1 }, { type: 'subscribe', board_id: 'b1' }]);
  h.ws().push(snapshot);
  assert.equal(h.statuses.at(-1), 'open');
  assert.equal(h.messages[0].type, 'snapshot');
});

test('invalid or unknown frames are ignored, not surfaced', () => {
  const h = harness();
  h.ws().open();
  h.ws().push({ type: 'card.upsert', board_id: 'b1' });
  h.ws().push({ type: 'mystery' });
  assert.equal(h.messages.length, 0);
});

test('a drop after open reports lost and schedules a capped-backoff reconnect; a new snapshot reopens', () => {
  const h = harness();
  h.ws().open();
  h.ws().push(snapshot);
  h.ws().drop();
  assert.equal(h.statuses.at(-1), 'lost');
  assert.equal(h.scheduled.length, 1);
  assert.ok(h.scheduled[0].ms <= 30_000);
  h.scheduled[0].fn();
  assert.equal(h.statuses.at(-1), 'lost', 'still lost until the new snapshot arrives');
  h.ws().open();
  h.ws().push(snapshot);
  assert.equal(h.statuses.at(-1), 'open');
});

test('before the first snapshot a failure is "connecting", never "lost"', () => {
  const h = harness();
  h.ws().drop();
  assert.equal(h.statuses.at(-1), 'connecting');
});

test('4426 stops reconnecting; 4401 asks for sign-in', () => {
  const a = harness();
  a.ws().drop(WS_CLOSE.PROTOCOL_UNSUPPORTED);
  assert.equal(a.statuses.at(-1), 'upgrade');
  assert.equal(a.scheduled.length, 0);
  const b = harness();
  b.ws().drop(WS_CLOSE.UNAUTHENTICATED);
  assert.equal(b.statuses.at(-1), 'signed_out');
});
