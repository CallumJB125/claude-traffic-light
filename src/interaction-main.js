'use strict';
// IPC for owned-session interaction. The actor is derived in main from the
// exact Overview document (contents + main frame + generation); the renderer
// never names it. Effects need the foreground document; reads need the
// visible one. Pushes go only to the document that owns the session.
const { createInteractionHub } = require('./session-interaction');

const CHANNELS = Object.freeze({
  capabilities: 'interaction:capabilities', list: 'interaction:list', state: 'interaction:state',
  launch: 'interaction:launch', send: 'interaction:send', interrupt: 'interaction:interrupt', close: 'interaction:close',
  event: 'interaction:event',
});
const denied = { ok: false, status: 'forbidden', error: 'Focus Plexiform Overview and try again.' };

// Only one Overview document is current. When it is replaced (reload or new
// generation) the old actor's sessions are reaped and `documents` holds one entry.
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

function createInteractionMain({ context, readContext = context, adapters: given, owned = ownedAdapters, workspace, boardCurrent, now }) {
  const adapters = { ...(owned ? owned() : {}), ...given };
  const documents = new Map();
  const hub = createInteractionHub({
    adapters, workspace, boardCurrent, now,
    onEvent(actor, state) {
      const contents = documents.get(actor);
      if (contents && !contents.isDestroyed()) contents.send(CHANNELS.event, state);
    },
  });
  async function actorOf(e, effect) {
    const c = effect ? context() : readContext();
    if (!c || (effect && !c.foreground) || !c.contents || c.contents.isDestroyed() || !Number.isSafeInteger(c.generation)) return null;
    if (e.sender !== c.contents || e.senderFrame !== c.contents.mainFrame) return null;
    const actor = `overview:${c.contents.id}:${c.generation}`;
    if (!documents.has(actor)) {
      documents.clear(); documents.set(actor, c.contents);
      await hub.reap((a) => a === actor);
    }
    return actor;
  }
  const one = (args) => (args.length === 1 ? args[0] : undefined);
  return {
    hub,
    documents: () => documents.size,
    register(ipc) {
      ipc.handle(CHANNELS.capabilities, async (e) => ((await actorOf(e, false)) ? hub.capabilities() : []));
      ipc.handle(CHANNELS.list, async (e) => { const a = await actorOf(e, false); return a ? hub.list(a) : []; });
      ipc.handle(CHANNELS.state, async (e, ...args) => { const a = await actorOf(e, false); return a ? hub.state(one(args), a) : null; });
      for (const action of ['launch', 'send', 'interrupt', 'close']) {
        ipc.handle(CHANNELS[action], async (e, ...args) => {
          const a = await actorOf(e, true);
          if (!a) return denied;
          return hub[action](one(args), a);
        });
      }
    },
    close() { hub.stopAll(); documents.clear(); },
  };
}

module.exports = { createInteractionMain, ownedAdapters, CHANNELS };
