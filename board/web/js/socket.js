// /ws/board client (CONTRACT §5.3): hello → subscribe → snapshot + patches.
// Read-only push. On a drop it reports `lost` once and reconnects with the
// shared backoff; on reconnect the new snapshot replaces everything.
import { PROTOCOL_VERSION, WS_CLOSE, validate } from '../../shared/protocol.js';
import { reconnectDelay } from '../../shared/liveness.js';

export function connectBoard({ boardId, org = null, onMessage, onStatus, url, WebSocketImpl = globalThis.WebSocket, schedule = setTimeout, cancel = clearTimeout }) {
  let ws = null;
  let attempt = 0;
  let timer = null;
  let closed = false;
  let wasOpen = false;
  let retryAt = null;

  const wsUrl = url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/board${org ? `?org=${encodeURIComponent(org)}` : ''}`;

  function open() {
    timer = null;
    retryAt = null;
    onStatus({ status: wasOpen ? 'lost' : 'connecting', attempt, retryAt: null });
    try { ws = new WebSocketImpl(wsUrl); } catch { return retry(); } // privacy-flow: board-view
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION }));
      ws.send(JSON.stringify({ type: 'subscribe', board_id: boardId }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (validate('hub→browser', msg)) return; // unknown type or bad frame: ignore (§9)
      if (msg.type === 'snapshot') {
        attempt = 0;
        wasOpen = true;
        onStatus({ status: 'open', attempt: 0, retryAt: null });
      }
      if (msg.type === 'error' && msg.code === 'PROTOCOL_UNSUPPORTED') closed = true;
      onMessage(msg);
    };
    ws.onclose = (ev) => {
      ws = null;
      if (closed || ev.code === WS_CLOSE.PROTOCOL_UNSUPPORTED) {
        closed = true;
        onStatus({ status: ev.code === WS_CLOSE.PROTOCOL_UNSUPPORTED ? 'upgrade' : 'closed', attempt, retryAt: null });
        return;
      }
      // Signed out, session expired, or no longer a member: re-check who we are.
      if (ev.code === WS_CLOSE.UNAUTHENTICATED || ev.code === WS_CLOSE.REVOKED) {
        onStatus({ status: 'signed_out', attempt, retryAt: null });
        return;
      }
      retry();
    };
    ws.onerror = () => {};
  }

  function retry() {
    const delay = reconnectDelay(attempt++);
    retryAt = Date.now() + delay;
    // Before the first snapshot there is no board to call "lost" yet.
    onStatus({ status: wasOpen ? 'lost' : 'connecting', attempt, retryAt });
    timer = schedule(open, delay);
  }

  open();

  return {
    reconnectNow() {
      if (closed) return;
      if (timer) { cancel(timer); timer = null; }
      if (ws) return;
      attempt = 0;
      open();
    },
    close() {
      closed = true;
      if (timer) cancel(timer);
      ws?.close(1000);
    },
    get retryAt() { return retryAt; },
  };
}
