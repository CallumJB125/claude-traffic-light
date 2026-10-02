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
const { createLocalModels } = require('./local-models');

const CHANNELS = Object.freeze({
  capabilities: 'interaction:capabilities', list: 'interaction:list', state: 'interaction:state',
  launch: 'interaction:launch', send: 'interaction:send', interrupt: 'interaction:interrupt', close: 'interaction:close',
  event: 'interaction:event', localModels: 'interaction:local-models',
  shareList: 'interaction:share-list', shareCreate: 'interaction:share-create', shareStop: 'interaction:share-stop',
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noSharing = { ok: false, status: 'unavailable', error: 'To share, turn on "Let my other devices use sessions Plexiform started on this Mac" in Preferences and sign in to your team hub.' };
const denied = { ok: false, status: 'forbidden', error: 'Focus Plexiform Overview and try again.' };
const BOARD_STALE = 'This session belongs to another board. Switch back to the board it started on to use it.';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const boardKey = (id) => (typeof id === 'string' && id ? `board:${crypto.createHash('sha256').update(id).digest('hex').slice(0, 16)}` : null);

// Only one Overview document is current. When it is replaced (reload, crash)
// the old actor's sessions are reaped and `documents` holds one entry.
// Provider registration point: Plexiform-owned Claude Code (stream-json) and
// Gemini CLI (ACP) sessions join the adapters main.js passes in. A missing CLI
// stays listed with available:false and its reason.
function ownedAdapters({ env = process.env } = {}) {
  const Claude = require('./claude-code-session'), Gemini = require('./gemini-acp');
  const claudeBin = Claude.findClaudeBin({ env });
  return {
    claude: Object.assign(Claude.createClaudeCodeSession({ bin: claudeBin, env }), claudeBin ? {} : { available: false, reason: 'unavailable: claude not installed' }),
    gemini: Gemini.createGeminiAcp({ bin: Gemini.findGeminiBin({ env }), env }),
  };
}

// shares: () => the remote interaction host (src/remote-interaction.js) or null; team sharing goes through it.
function createInteractionMain({ context, readContext = context, adapters: given, owned = ownedAdapters, workspace, currentBoard = () => null, now, localModelsFile = null, localModels: givenLocalModels, compaction = null, shares = () => null }) {
  const adapters = { ...(owned ? owned() : {}), ...given };
  // Local models register into `adapters` as they are found.
  const localModels = givenLocalModels !== undefined ? givenLocalModels : createLocalModels({ adapters, configFile: localModelsFile });
  const documents = new Map();
  const boardCurrent = (b) => b !== null && b === boardKey(currentBoard());
  const actorFor = (c) => `overview:${c.contents.id}:${c.document}`;
  const hub = createInteractionHub({
    adapters, workspace, boardCurrent, now, compaction,
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
      // The reap awaited the provider: the document must still be the same one and, for an effect, still focused.
      const again = effect ? context() : readContext();
      if (!again || (effect && !again.foreground) || again.contents !== c.contents || again.document !== c.document) return null;
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
  // Team sharing of this document's sessions: only its own sessions, through the remote host.
  const owns = (session, actor) => typeof session === 'string' && UUID.test(session) && !!hub.state({ session }, actor);
  const sharing = {
    async [CHANNELS.shareList](req, actor) {
      const host = shares();
      if (!host) return noSharing;
      const r = await host.listShares();
      return r.ok ? { ok: true, teams: r.teams, shares: r.shares.filter((x) => owns(x.session, actor)) } : r;
    },
    async [CHANNELS.shareCreate](req, actor) {
      const host = shares();
      if (!host) return noSharing;
      if (!object(req) || !owns(req.session, actor)) return { ok: false, status: 'invalid', error: 'Check the selected session.' };
      return host.shareSession({ session: req.session, team: req.team, scope: req.scope, expiresInS: req.expiresInS ?? null });
    },
    async [CHANNELS.shareStop](req, actor) {
      const host = shares();
      if (!host) return noSharing;
      const sh = object(req) ? host.shared().find((x) => x.id === req.share) : null;
      if (!sh || !owns(sh.session, actor)) return { ok: false, status: 'stale', error: 'That share has already stopped.' };
      return host.stopSharing(sh.id);
    },
  };
  return {
    hub,
    documents: () => documents.size,
    // The remote host serves a shared session of the current document from this hub (never through 'list').
    sharedTarget(session) {
      for (const actor of documents.keys()) if (owns(session, actor)) return { hub, actor };
      return null;
    },
    // The Overview document was reloaded, crashed or destroyed: its sessions end now, not on the next request.
    retireDocuments() { documents.clear(); return hub.reap(() => false); },
    register(ipc) {
      // null (not []) when this document may not read, so the page keeps its last known state.
      ipc.handle(CHANNELS.capabilities, async (e) => ((await actorOf(e, false)) ? hub.capabilities() : null));
      ipc.handle(CHANNELS.list, async (e) => { const a = await actorOf(e, false); return a ? hub.list(a) : null; });
      // Local models register into `adapters` as they are found (read-only loopback probes + configured endpoints).
      ipc.handle(CHANNELS.localModels, async (e) => ((await actorOf(e, false)) && localModels ? localModels.refresh() : null));
      ipc.handle(CHANNELS.state, async (e, ...args) => { const a = await actorOf(e, false); return a ? hub.state(one(args), a) : null; });
      ipc.handle(CHANNELS.shareList, async (e) => { const a = await actorOf(e, false); return a ? sharing[CHANNELS.shareList](null, a) : null; });
      for (const ch of [CHANNELS.shareCreate, CHANNELS.shareStop]) {
        ipc.handle(ch, async (e, ...args) => { const a = await actorOf(e, true); return a ? sharing[ch](one(args), a) : denied; });
      }
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

module.exports = { createInteractionMain, ownedAdapters, CHANNELS, boardKey };
