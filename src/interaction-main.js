'use strict';
// IPC for owned-session interaction. The actor is derived in main from the
// exact Overview document (contents + main frame + document counter); the
// renderer never names it. Effects need the foreground document; reads need
// the visible one. Pushes go only to the live document that owns the session.
//
// The actor follows the document, not focus: Buddy's `generation` also moves
// on every window blur and page switch, so keying ownership on it would reap
// a session whenever the user clicked another app. `document` moves only on a
// main-frame navigation (reload), renderer crash or destruction.
//
// The board is main-owned: launch and send are bound to the active workspace
// (as an opaque key, never its hub address), so after a workspace switch the
// session refuses as stale until the user switches back.
const crypto = require('node:crypto');
const { createInteractionHub } = require('./session-interaction');

const CHANNELS = Object.freeze({
  capabilities: 'interaction:capabilities', list: 'interaction:list', state: 'interaction:state',
  launch: 'interaction:launch', send: 'interaction:send', interrupt: 'interaction:interrupt', close: 'interaction:close',
  event: 'interaction:event',
});
const denied = { ok: false, status: 'forbidden', error: 'Focus Plexiform Overview and try again.' };
const BOARD_STALE = 'This session belongs to another board. Switch back to the board it started on to use it.';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const boardKey = (id) => (typeof id === 'string' && id ? `board:${crypto.createHash('sha256').update(id).digest('hex').slice(0, 16)}` : null);

// Only one Overview document is current. When it is replaced (reload, crash)
// the old actor's sessions are reaped and `documents` holds one entry.
function createInteractionMain({ context, readContext = context, adapters, workspace, currentBoard = () => null, now }) {
  const documents = new Map();
  const boardCurrent = (b) => b !== null && b === boardKey(currentBoard());
  const actorFor = (c) => `overview:${c.contents.id}:${c.document}`;
  const hub = createInteractionHub({
    adapters, workspace, boardCurrent, now,
    onEvent(actor, state) {
      const contents = documents.get(actor), c = readContext();
      // A reloaded document has not been reaped until its first request.
      if (contents && !contents.isDestroyed() && (!c || c.contents !== contents || actorFor(c) === actor)) contents.send(CHANNELS.event, state);
    },
  });
  async function actorOf(e, effect) {
    const c = effect ? context() : readContext();
    if (!c || (effect && !c.foreground) || !c.contents || c.contents.isDestroyed() || !Number.isSafeInteger(c.generation) || !Number.isSafeInteger(c.document)) return null;
    if (e.sender !== c.contents || e.senderFrame !== c.contents.mainFrame) return null;
    const actor = actorFor(c);
    if (!documents.has(actor)) {
      documents.clear(); documents.set(actor, c.contents);
      await hub.reap((a) => a === actor);
    }
    return actor;
  }
  const effects = {
    launch: (req, actor) => (object(req) && !Object.hasOwn(req, 'board') ? hub.launch({ ...req, board: boardKey(currentBoard()) }, actor) : hub.launch(null, actor)),
    async send(req, actor) {
      if (!object(req) || Object.hasOwn(req, 'board')) return hub.send(null, actor);
      const result = await hub.send({ ...req, board: boardKey(currentBoard()) }, actor);
      const session = result?.status === 'stale' ? hub.state({ session: req.session }, actor) : null;
      return session && session.board !== null && !boardCurrent(session.board) ? { ...result, error: BOARD_STALE } : result;
    },
    interrupt: (req, actor) => hub.interrupt(req, actor),
    close: (req, actor) => hub.close(req, actor),
  };
  const one = (args) => (args.length === 1 ? args[0] : undefined);
  return {
    hub,
    documents: () => documents.size,
    register(ipc) {
      // null (not []) when this document may not read, so the page keeps its last known state.
      ipc.handle(CHANNELS.capabilities, async (e) => ((await actorOf(e, false)) ? hub.capabilities() : null));
      ipc.handle(CHANNELS.list, async (e) => { const a = await actorOf(e, false); return a ? hub.list(a) : null; });
      ipc.handle(CHANNELS.state, async (e, ...args) => { const a = await actorOf(e, false); return a ? hub.state(one(args), a) : null; });
      for (const action of Object.keys(effects)) {
        ipc.handle(CHANNELS[action], async (e, ...args) => {
          const a = await actorOf(e, true);
          if (!a) return denied;
          return effects[action](one(args), a);
        });
      }
    },
    close() { hub.stopAll(); documents.clear(); },
  };
}

module.exports = { createInteractionMain, CHANNELS, boardKey };
