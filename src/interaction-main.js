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
const path = require('node:path');
const { createInteractionHub } = require('./session-interaction');
const { createLocalModels } = require('./local-models');

const CHANNELS = Object.freeze({
  capabilities: 'interaction:capabilities', list: 'interaction:list', state: 'interaction:state',
  launch: 'interaction:launch', discover: 'interaction:discover', attach: 'interaction:attach', send: 'interaction:send', interrupt: 'interaction:interrupt', close: 'interaction:close',
  event: 'interaction:event', localModels: 'interaction:local-models', fanout: 'interaction:fanout',
  shareList: 'interaction:share-list', shareCreate: 'interaction:share-create', shareStop: 'interaction:share-stop',
  channelSetup: 'interaction:channel-setup',
});
const MAX_FANOUT = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noSharing = { ok: false, status: 'unavailable', error: 'To share, sign in to your team hub and enable automatic team sharing or device hosting in Preferences.' };
const denied = { ok: false, status: 'forbidden', error: 'Focus Plexiform Overview and try again.' };
const BOARD_STALE = 'This session belongs to another board. Switch back to the board it started on to use it.';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const boardKey = (id) => (typeof id === 'string' && id ? `board:${crypto.createHash('sha256').update(id).digest('hex').slice(0, 16)}` : null);

// Only one Overview document is current. When it is replaced (reload, crash)
// the old actor's sessions are reaped and `documents` holds one entry.
// Provider registration point: Plexiform-owned Claude Code (stream-json),
// Gemini CLI and the other ACP agents join the adapters main.js passes in. A
// missing or unverified CLI stays listed with available:false and its reason.
function ownedAdapters({ env = process.env } = {}) {
  const Claude = require('./claude-code-session'), Gemini = require('./gemini-acp'), Acp = require('./acp-agents');
  const claudeBin = Claude.findClaudeBin({ env });
  return {
    claude: Object.assign(Claude.createClaudeCodeSession({ bin: claudeBin, env }), claudeBin ? {} : { available: false, reason: 'unavailable: claude not installed' }),
    gemini: Gemini.createGeminiAcp({ bin: Gemini.findGeminiBin({ env }), env }),
    // Other documented ACP agents: listed with their exact unavailable reason (src/provider-capabilities.json).
    ...Object.fromEntries(Object.keys(Acp.ACP_AGENTS).map((id) => [id, Acp.createAcpAgent(id, { env })])),
  };
}

// shares: () => the remote interaction host (src/remote-interaction.js) or null; team sharing goes through it.
function createInteractionMain({ context, readContext = context, adapters: given, owned = ownedAdapters, workspace, currentBoard = () => null, now, localModelsFile = null, localModels: givenLocalModels, compaction = null, shares = () => null, prepareChannel = null }) {
  const adapters = { ...(owned ? owned() : {}), ...given };
  // Local models register into `adapters` as they are found.
  const localModels = givenLocalModels !== undefined ? givenLocalModels : createLocalModels({ adapters, configFile: localModelsFile });
  const documents = new Map();
  const boardCurrent = (b) => b !== null && b === boardKey(currentBoard());
  const actorFor = (c) => `overview:${c.contents.id}:${c.document}`;
  // Workspace folder name per owned session, main-only: lets the Overview
  // directory fold a hook report from that folder into the owned session.
  const leaves = new Map();
  const hub = createInteractionHub({
    adapters, boardCurrent, now, compaction,
    workspace(id) {
      const dir = typeof workspace === 'function' ? workspace(id) : null;
      if (typeof dir === 'string' && dir) { leaves.set(id, path.basename(dir)); while (leaves.size > 64) leaves.delete(leaves.keys().next().value); }
      return dir;
    },
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
    async channelSetup(req, actor) {
      if (req !== undefined || !prepareChannel) return { ok: false, status: 'unavailable', error: 'Claude terminal setup is unavailable.' };
      const board = currentBoard();
      const fresh = () => { const c = context(); return !!c?.foreground && !c.contents.isDestroyed() && actorFor(c) === actor && currentBoard() === board; };
      return prepareChannel({ actor, board, fresh });
    },
    launch: (req, actor) => (object(req) && !Object.hasOwn(req, 'board') ? hub.launch({ ...req, board: boardKey(currentBoard()) }, actor) : hub.launch(null, actor)),
    // Existing sessions on an opt-in provider (codex-daemon): metadata list, then subscribe to one by handle.
    discover: (req, actor) => hub.discover(req, actor),
    attach: (req, actor) => (object(req) && !Object.hasOwn(req, 'board') ? hub.attach({ ...req, board: boardKey(currentBoard()) }, actor) : hub.attach(null, actor)),
    async send(req, actor) {
      if (!object(req) || Object.hasOwn(req, 'board')) return hub.send(null, actor);
      const result = await hub.send({ ...req, board: boardKey(currentBoard()) }, actor);
      const session = result?.status === 'stale' ? hub.state({ session: req.session }, actor) : null;
      return session && session.board !== null && !boardCurrent(session.board) ? { ...result, error: BOARD_STALE } : result;
    },
    interrupt: (req, actor) => hub.interrupt(req, actor),
    close: (req, actor) => hub.close(req, actor),
    // Ask all: each target goes through the same per-session send (and every
    // guard in it); one refused or stale target never blocks the others.
    async fanout(req, actor) {
      const list = object(req) && Object.keys(req).length === 2 && Array.isArray(req.sessions) && typeof req.text === 'string' ? req.sessions : null;
      const ok = list && list.length >= 1 && list.length <= MAX_FANOUT && list.every((t) => object(t) && Object.keys(t).length === 2 && typeof t.session === 'string' && Number.isSafeInteger(t.generation));
      if (!ok || new Set(list.map((t) => t.session)).size !== list.length) return { ok: false, status: 'invalid', error: 'Choose between 1 and 6 different sessions.' };
      const results = await Promise.all(list.map(async ({ session, generation }) => {
        let result;
        try { result = await effects.send({ session, generation, text: req.text }, actor); } catch { result = { ok: false, status: 'unavailable', error: 'The provider did not accept the message.' }; }
        return { session, ...result };
      }));
      return { ok: results.some((r) => r.ok === true), status: 'fanned-out', results };
    },
  };
  const one = (args) => (args.length === 1 ? args[0] : undefined);
  // Team sharing of this document's sessions: only its own sessions, through the remote host.
  const owns = (session, actor) => typeof session === 'string' && UUID.test(session) && !!hub.state({ session }, actor);
  // A session started outside Plexiform (codex-daemon) runs with its own permissions: never shared with a team.
  const shareable = (session, actor) => owns(session, actor) && (hub.state({ session }, actor).ownership === 'plexiform-owned' || hub.state({ session }, actor).provider.id === 'claude-channel');
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
      if (!object(req) || !shareable(req.session, actor)) return { ok: false, status: 'invalid', error: 'Check the selected session.' };
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
      for (const actor of documents.keys()) if (shareable(session, actor)) return { hub, actor };
      return null;
    },
    // Session directory: this document's owned sessions (public state + main-only folder name).
    listOwned() { const out = []; for (const actor of documents.keys()) for (const state of hub.list(actor)) out.push({ state, leaf: leaves.get(state.session) ?? null, nativeSessionId: hub.targetOf(state.session), nativeTurnId: hub.reportTurnOf(state.session) }); return out; },
    // Match native provider session identity, never a folder/project label.
    reportHooks(rows) {
      if(!Array.isArray(rows))return;
      const Machine = require('../hooks/session-machine'), Reports = require('./agent-self-report');
      const time = now ? now() : Date.now();
      for (const actor of documents.keys()) for (const state of hub.list(actor)) {
        if (state.ownership !== 'plexiform-owned' || state.provider.id !== 'codex' || state.status === 'ended') continue;
        const native = hub.targetOf(state.session);
        const matches = rows.filter(r => r?.source === 'codex' && !r.remote && !r.device && r.sessionId === native && r.codexLifecycle === 1);
        if (matches.length !== 1) continue;
        const raw = matches[0], at = Date.parse(raw.codexHookAt);
        const turn = hub.reportTurnOf(state.session);
        if (!turn || raw.codexTurnId !== turn) continue;
        if (!Number.isFinite(at) || at < 0 || at > time || time - at > 90_000) continue;
        hub.report({ session: state.session, generation: state.generation, source: 'observed', observedAt: at, inputNeeded: state.activeTurn !== null && Machine.codexInputPending(raw, time) }, actor);
        for (const c of (Array.isArray(raw.codexAgents) ? raw.codexAgents : []).slice(0,20)) {
          if(!object(c))continue;
          const childAt = Date.parse(c.updatedAt ?? c.since), created = Date.parse(c.createdAt ?? c.since ?? c.updatedAt);
          if(typeof c.id!=='string'||!['working','waiting','done','stopped'].includes(c.status)||!Number.isFinite(childAt)||childAt>time||!Number.isFinite(created)||created>childAt)continue;
          hub.report({session:state.session,generation:state.generation,source:'observed',children:[{id:c.id,name:typeof c.name==='string'?c.name:'Agent',taskTitle:typeof c.taskTitle==='string'?c.taskTitle:'',state:['done','stopped'].includes(c.status)?'ended':c.status==='waiting'?'waiting':'working',observedAt:childAt,createdAt:created}]},actor);
        }
        for (const c of Reports.project(raw, time).slice(0, 20)) hub.report({ session: state.session, generation: state.generation, source: 'self-reported', children: [{ id: c.id, name: c.name, taskTitle: c.taskTitle, state: c.status === 'done' ? 'ended' : c.status === 'waiting' ? 'waiting' : 'working', observedAt: c.observedAt, createdAt: c.observedAt }] }, actor);
      }
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
