'use strict';
// Board presence link (team depth lane C). One read-mostly `/ws/board` socket
// per linked team board (buddy-window teamMemoryLinks), signed in with the
// person's own bearer for that hub, that (a) keeps the latest `board.presence`
// the hub pushes (who is viewing which card, who is running a session in which
// repo) for the Overview's Team sessions page, and (b) sends `presence.view`
// beats for the shared session this computer is looking at, every BEAT_MS
// (src/session-presence.js) while one is open, `null` when it closes. Nothing
// is stored; a hub without the frame just answers VALIDATION and shows nothing.
// The same socket is one of the person's own member sockets, so the hub also
// pushes `inbox.item` (team depth lane B, hub.broadcastMember) down it; that
// frame goes to `onInbox(hub, item)` at once, so the badge and Home's Inbox do
// not wait for the 60 s poll in main.js (plan acceptance E3).
const { BEAT_MS } = require('./session-presence');

const PROTOCOL_VERSION = 1;              // board/shared/protocol.js (ESM; the number is the contract)
const RECONNECT_MIN_MS = 5_000, RECONNECT_MAX_MS = 60_000;
const MAX_MEMBERS = 200, MAX_VIEWERS = 200, STR = 200;
const str = (v, max = STR) => (typeof v === 'string' ? v.slice(0, max) : '');
const key = (route) => `${route.hub}|${route.team_id}|${route.board_id}`;
const wsUrl = (hub) => { const u = new URL(hub); u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:'; u.pathname = '/ws/board'; u.search = ''; return u.toString(); };

// Reduce one `board.presence` frame to what the page may see (names and titles are untrusted text).
function reduce(msg) {
  const members = (Array.isArray(msg.members) ? msg.members : []).slice(0, MAX_MEMBERS).filter((m) => m && typeof m === 'object' && str(m.member_id)).map((m) => ({
    member_id: str(m.member_id), name: str(m.name),
    sessions: (Array.isArray(m.sessions) ? m.sessions : []).slice(0, 50).filter((s) => s && typeof s === 'object').map((s) => ({ agent: str(s.agent, 20), repo_short: str(s.repo_short), branch: str(s.branch) || null, state: str(s.state, 20) })),
    viewing: m.viewing && typeof m.viewing === 'object' && str(m.viewing.card_id) ? { card_id: str(m.viewing.card_id), since: str(m.viewing.since, 40) } : null,
  }));
  const viewers = (Array.isArray(msg.viewers) ? msg.viewers : []).slice(0, MAX_VIEWERS).filter((v) => v && typeof v === 'object' && str(v.member_id) && str(v.card_id)).map((v) => ({
    member_id: str(v.member_id), name: str(v.name), card_id: str(v.card_id), key: str(v.key, 80) || null, title: str(v.title), at: str(v.at, 40),
  }));
  return { members, viewers };
}

function createPresenceLink({ links = async () => [], WebSocket, now = Date.now, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, log = () => {}, onChange = () => {}, onInbox = () => {} } = {}) {
  const conns = new Map();   // key → {route, ws, attempt, timer, beat, open, viewing, latest}
  let stopped = false;

  function send(c, frame) {
    if (!c.ws || !c.open) return false;
    try { c.ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }
  function sendView(c) { send(c, { type: 'presence.view', card_id: c.viewing }); }
  function armBeat(c) {
    if (c.beat) clearTimeout(c.beat);
    c.beat = c.viewing ? setTimeout(() => { c.beat = null; if (c.viewing) { sendView(c); armBeat(c); } }, BEAT_MS) : null;
    c.beat?.unref?.();
  }

  function connect(c) {
    if (stopped || !WebSocket) return;
    let token = '';
    try { token = typeof c.route.token === 'function' ? c.route.token() : ''; } catch { token = ''; }
    if (typeof token !== 'string' || !token) { schedule(c); return; }
    let ws;
    try {
      ws = new WebSocket(wsUrl(c.route.hub), { headers: { Authorization: `Bearer ${token}`, 'X-Board-Team': c.route.team_id, 'Board-Team': c.route.team_id }, handshakeTimeout: 15000 }); // privacy-flow: team-hub
    } catch { schedule(c); return; }
    c.ws = ws; c.open = false;
    const mine = () => c.ws === ws && !stopped;
    ws.on('open', () => {
      if (!mine()) return;
      c.open = true;
      send(c, { type: 'hello', protocol: PROTOCOL_VERSION });
      send(c, { type: 'subscribe', board_id: c.route.board_id });
    });
    ws.on('message', (data) => {
      if (!mine()) return;
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'snapshot' && msg.board_id === c.route.board_id) { c.attempt = 0; if (c.viewing) sendView(c); return; }
      if (msg.type === 'board.presence' && msg.board_id === c.route.board_id) { c.latest = { ...reduce(msg), at: now() }; onChange(); return; }
      if (msg.type === 'team.presence' && !c.latest) { c.latest = { ...reduce({ members: msg.members, viewers: [] }), at: now() }; onChange(); return; }
      if (msg.type === 'inbox.item' && msg.item && typeof msg.item === 'object' && str(msg.item.id, 100) && str(msg.item.kind, 40)) { try { onInbox(c.route.hub, msg.item); } catch { /* the poll reconciles */ } }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (c.ws !== ws) return;
      c.ws = null; c.open = false;
      if (c.latest) { c.latest = null; onChange(); }
      if (!stopped && conns.get(key(c.route)) === c) schedule(c);
    });
  }
  function schedule(c) {
    if (c.timer) clearTimeout(c.timer);
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(4, c.attempt++));
    c.timer = setTimeout(() => { c.timer = null; connect(c); }, delay);
    c.timer.unref?.();
  }
  function close(c) {
    if (c.timer) clearTimeout(c.timer);
    if (c.beat) clearTimeout(c.beat);
    c.timer = c.beat = null;
    const ws = c.ws; c.ws = null; c.open = false; c.latest = null;
    try { ws?.close(1000); } catch { /* already gone */ }
  }

  /** Re-read the linked routes: open sockets for new boards, close the ones that went away. */
  async function refresh() {
    if (stopped) return;
    let list = [];
    try { list = (await links()) ?? []; } catch { list = []; }
    const want = new Map();
    for (const l of list) {
      const r = l?.route;
      if (!r || typeof r.hub !== 'string' || !/^https?:\/\//.test(r.hub) || typeof r.team_id !== 'string' || !r.team_id || typeof r.board_id !== 'string' || !r.board_id) continue;
      const route = { hub: r.hub, team_id: r.team_id, board_id: r.board_id, token: typeof l.token === 'function' ? l.token : () => '' };
      want.set(key(route), route);
    }
    for (const [k, c] of conns) if (!want.has(k)) { conns.delete(k); close(c); }
    for (const [k, route] of want) {
      if (conns.has(k)) continue;
      const c = { route, ws: null, attempt: 0, timer: null, beat: null, open: false, viewing: null, latest: null };
      conns.set(k, c);
      connect(c);
    }
  }

  /** Tell the team's boards which card this computer is looking at (`null` clears); beats every BEAT_MS while set. */
  function view({ team, hub = null, card_id = null } = {}) {
    const id = typeof card_id === 'string' && card_id ? card_id.slice(0, 128) : null;
    let n = 0;
    for (const c of conns.values()) {
      if (c.route.team_id !== team || (hub && c.route.hub !== hub)) continue;
      if (c.viewing === id && id) continue;
      c.viewing = id;
      sendView(c);
      armBeat(c);
      n++;
    }
    return n;
  }

  /** The latest board.presence for a team, merged over its linked boards; null when no board is connected. */
  function latest(team) {
    const members = new Map(); const viewers = []; let any = false, at = 0;
    for (const c of conns.values()) {
      if (c.route.team_id !== team || !c.latest) continue;
      any = true; at = Math.max(at, c.latest.at);
      for (const m of c.latest.members) {
        const cur = members.get(m.member_id) ?? { member_id: m.member_id, name: m.name, sessions: [], viewing: null };
        cur.sessions.push(...m.sessions);
        if (!cur.viewing && m.viewing) cur.viewing = m.viewing;
        members.set(m.member_id, cur);
      }
      viewers.push(...c.latest.viewers);
    }
    return any ? { members: [...members.values()], viewers, at } : null;
  }

  function stop() { stopped = true; for (const c of conns.values()) close(c); conns.clear(); }

  return { refresh, view, latest, stop, size: () => conns.size };
}

module.exports = { createPresenceLink, reduce, BEAT_MS };
