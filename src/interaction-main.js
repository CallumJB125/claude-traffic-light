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
const { createLocalModels, probeEndpoint } = require('./local-models');
const { createDetector } = require('./local-model-detect');
const { localModelCard } = require('./local-model-card');

const CHANNELS = Object.freeze({
  capabilities: 'interaction:capabilities', list: 'interaction:list', state: 'interaction:state',
  launch: 'interaction:launch', discover: 'interaction:discover', attach: 'interaction:attach', send: 'interaction:send', interrupt: 'interaction:interrupt', close: 'interaction:close',
  event: 'interaction:event', localModels: 'interaction:local-models', fanout: 'interaction:fanout',
  proposalList: 'interaction:proposal-list', proposalApprove: 'interaction:proposal-approve', proposalRevoke: 'interaction:proposal-revoke',
  shareList: 'interaction:share-list', shareViewers: 'interaction:share-viewers', shareCreate: 'interaction:share-create', shareStop: 'interaction:share-stop',
  channelSetup: 'interaction:channel-setup', openAiTools: 'interaction:open-aitools',
  localEndpoints: 'interaction:local-endpoints', localEndpointSave: 'interaction:local-endpoint-save', localEndpointRemove: 'interaction:local-endpoint-remove',
});
const MAX_FANOUT = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noSharing = { ok: false, status: 'unavailable', error: 'To share, sign in to your team hub and enable automatic team sharing or device hosting in Preferences.' };
const denied = { ok: false, status: 'forbidden', error: 'Focus Plexiform Overview and try again.' };
const APPROVE_IN_THREAD = Object.freeze({ ok: false, status: 'forbidden', error: 'Approve proposals on the session’s thread in the sidebar.' });
const BOARD_STALE = 'This session belongs to another board. Switch back to the board it started on to use it.';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const boardKey = (id) => (typeof id === 'string' && id ? `board:${crypto.createHash('sha256').update(id).digest('hex').slice(0, 16)}` : null);

// Only one Overview document is current. When it is replaced (reload, crash)
// the old actor's sessions are reaped and `documents` holds one entry.
// Provider registration point: Plexiform-owned Claude Code (stream-json),
// Gemini CLI and the other ACP agents join the adapters main.js passes in. A
// missing or unverified CLI stays listed with available:false and its reason.
function ownedAdapters({ env = process.env, keyRoot } = {}) {
  const Claude = require('./claude-code-session'), Gemini = require('./gemini-acp'), Acp = require('./acp-agents');
  const claudeBin = Claude.findClaudeBin({ env });
  return {
    claude: Object.assign(Claude.createClaudeCodeSession({ bin: claudeBin, env, ...(keyRoot ? { keyRoot } : {}) }), claudeBin ? {} : { available: false, reason: 'unavailable: claude not installed' }),
    gemini: Gemini.createGeminiAcp({ bin: Gemini.findGeminiBin({ env }), env }),
    // Other documented ACP agents: listed with their exact unavailable reason (src/provider-capabilities.json).
    ...Object.fromEntries(Object.keys(Acp.ACP_AGENTS).map((id) => [id, Acp.createAcpAgent(id, { env })])),
  };
}

// A provider the AI tools page finds not installed or not connected shows that
// page's reading (src/ai-tools.js nextStep) and a button to its row, instead of
// a bare "Unavailable"; every other unavailable provider keeps its exact reason.
function explainCapabilities(caps, rows) {
  const { nextStep } = require('./ai-tools');
  const byId = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
  return caps.map((c) => {
    if (c.available !== false) return c;
    const step = nextStep(byId.get(c.provider));
    return step ? { ...c, reason: step.reason, next: { label: step.action.label, provider: c.provider } } : c;
  });
}

// shares: () => the remote interaction host (src/remote-interaction.js) or null; team sharing goes through it.
function createInteractionMain({ context, readContext = context, adapters: given, owned = ownedAdapters, keyRoot = null, workspace, currentBoard = () => null, accountScope = () => null, now, localModelsFile = null, localModels: givenLocalModels, compaction = null, shares = () => null, prepareChannel = null, tools = () => null, openAiTools = null, endpointStore = null, fetch: fetchImpl = globalThis.fetch }) { // privacy-flow: local-models
  const adapters = { ...(owned ? owned({ keyRoot }) : {}), ...given };
  // Local models register into `adapters` as they are found.
  // The fixed loopback ports go through the detector (short timeout, backoff); endpoints the person added are probed as typed.
  const detector = givenLocalModels === undefined && typeof fetchImpl === 'function' ? createDetector({ fetch: fetchImpl }) : null;
  const secretFor = endpointStore ? (id) => endpointStore.secretFor(id) : null;
  const localModels = givenLocalModels !== undefined ? givenLocalModels : createLocalModels({ adapters, configFile: localModelsFile, secretFor, ...(detector ? { probe: (e, opts) => (e.source === 'discovered' ? detector.probe(e) : probeEndpoint(e, opts)) } : {}) });
  const withCard = (o) => (o && typeof o === 'object' ? { ...o, card: localModelCard(o) } : o);
  const documents = new Map();
  const ownedScopes = new Map();
  // T4a: moves whenever the owning Overview document changes (replaced, retired or closed), never back.
  // The chat-first sidebar keys its owned rows by it, so a row never outlives the document that held the session.
  let epoch = 0;
  // T4 (plan-t4 Rev 3 Q5): with the chat-first gate on, a proposal is approved only on its thread's review card,
  // so Overview's one-click approve is refused here and hidden in its panel. Set once by main, inside the gate.
  let approveInThread = false;
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
      documents.clear(); epoch++; documents.set(actor, c.contents);
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
    async launch(req, actor) {
      const owner = accountScope();
      const out = await (object(req) && !Object.hasOwn(req, 'board') ? hub.launch({ ...req, board: boardKey(currentBoard()) }, actor) : hub.launch(null, actor));
      if (out?.ok && out.state?.session) { ownedScopes.set(out.state.session, owner); while (ownedScopes.size > 64) ownedScopes.delete(ownedScopes.keys().next().value); }
      return out;
    },
    // Existing sessions on an opt-in provider (codex-daemon): metadata list, then subscribe to one by handle.
    discover: (req, actor) => hub.discover(req, actor),
    async attach(req, actor) {
      const owner = accountScope();
      const out = await (object(req) && !Object.hasOwn(req, 'board') ? hub.attach({ ...req, board: boardKey(currentBoard()) }, actor) : hub.attach(null, actor));
      // T4a: a terminal channel is shareable, so it is listed for the account that connected it (launch does the same).
      if (out?.ok && out.state?.session && out.state.provider?.id === 'claude-channel') { ownedScopes.set(out.state.session, owner); while (ownedScopes.size > 64) ownedScopes.delete(ownedScopes.keys().next().value); }
      return out;
    },
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
  const listed = (session, actor, account) => shareable(session, actor) && ownedScopes.has(session) && ownedScopes.get(session) === account;
  // L32 (D4): who is watching this person's shares, for Overview's chips. The read context already requires Overview
  // to be the page shown in a visible, unminimised window (A-S2). One listShares per host per 15 s, shared with the
  // share list's own reads, one in flight; between refreshes the host's own copy answers (names fresh ≤ 35 s).
  const VIEWERS_FLOOR_MS = 15_000;
  const clockNow = typeof now === 'function' ? now : Date.now;
  let listed15 = { host: null, at: -Infinity, pending: null };
  function listSharesFloored(host) {
    const t = clockNow();
    if (listed15.host === host && (listed15.pending || t - listed15.at < VIEWERS_FLOOR_MS)) return listed15.pending ?? Promise.resolve(null);
    const entry = { host, at: t, pending: null };
    listed15 = entry;
    entry.pending = Promise.resolve().then(() => host.listShares()).catch(() => null).finally(() => { entry.pending = null; });
    return entry.pending;
  }
  const sharing = {
    async [CHANNELS.shareViewers](req, actor) {
      const host = shares();
      if (!host) return { ok: true, sessions: {} };
      await listSharesFloored(host);
      const sessions = {};
      let list = [];
      try { list = host.shared(); } catch { list = []; }
      for (const s of Array.isArray(list) ? list : []) {
        if (!object(s) || typeof s.session !== 'string' || !owns(s.session, actor) || !Array.isArray(s.viewers) || !s.viewers.length) continue;
        const names = s.viewers.filter((n) => typeof n === 'string' && n).slice(0, 50).map((n) => n.slice(0, 80));
        sessions[s.session] = [...new Set([...(sessions[s.session] ?? []), ...names])].slice(0, 50);
      }
      return { ok: true, sessions };
    },
    async [CHANNELS.shareList](req, actor) {
      const host = shares();
      if (!host) return noSharing;
      listed15 = { host, at: clockNow(), pending: null };
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
    // Sessions page Message: only a session Plexiform started, sent as its owning
    // document through the same guarded send (board, generation, busy turn).
    async sendLocal(session, text) {
      if (typeof session !== 'string' || !UUID.test(session) || typeof text !== 'string' || !text.trim() || text.length > 500) return { ok: false, status: 'invalid', error: 'Write a message first.' };
      for (const actor of documents.keys()) {
        const state = hub.state({ session }, actor);
        if (!state) continue;
        if (state.ownership !== 'plexiform-owned') break;
        let result;
        try { result = await effects.send({ session, generation: state.generation, text }, actor); } catch { result = { ok: false, status: 'unavailable', error: 'The provider did not accept the message.' }; }
        return { ok: result?.ok === true, status: result?.status ?? 'unavailable', error: result?.ok === true ? null : result?.error ?? 'Could not send it.' };
      }
      return { ok: false, status: 'stale', error: 'Plexiform is not running that session any more. Refresh and try again.' };
    },
    // T4a: the chat-first sidebar's read of this document's shareable sessions, for the account that started them.
    // Read-only: never actorOf, reap or an effect, and `documents` is untouched. Main-only (actor, native id, folder).
    ownedView() {
      const account = accountScope(), sessions = [];
      for (const actor of documents.keys()) for (const state of hub.list(actor)) {
        if (!listed(state.session, actor, account)) continue;
        sessions.push({ actor, session: state.session, state, leaf: leaves.get(state.session) ?? null, nativeSessionId: hub.targetOf(state.session) });
      }
      return { epoch, account, sessions };
    },
    // One session's state, only while it is still listed in the same epoch.
    ownedState(at, actor, session) {
      if (at !== epoch || !documents.has(actor) || !listed(session, actor, accountScope())) return null;
      return hub.state({ session }, actor);
    },
    ownedEpoch: () => epoch,
    ownedAccount: () => accountScope(),
    // T4 (plan-t4 §2.1, Rev 1 S2): the one owned Codex session whose native target is this observed session.
    // Read-only, like ownedView. Only `codex` maps; a claude-channel target is a grant id and never matches.
    // Null when two owned sessions share the target, when the target is gone (replaceTarget) or it isn't listed.
    ownedTwin({ provider, nativeSessionId } = {}) {
      if (provider !== 'codex' || typeof nativeSessionId !== 'string' || !nativeSessionId) return null;
      const account = accountScope(), found = [];
      for (const actor of documents.keys()) for (const state of hub.list(actor)) {
        if (state.provider?.id !== 'codex' || state.status === 'ended') continue;
        const target = hub.targetOf(state.session);
        if (typeof target === 'string' && target === nativeSessionId) found.push({ actor, session: state.session });
      }
      if (found.length !== 1 || !listed(found[0].session, found[0].actor, account)) return null;
      return { epoch, actor: found[0].actor, session: found[0].session };
    },
    // Main, inside the chat-first gate only (main.js): Overview's one-click approve stops; the thread card approves.
    approveInThread() { approveInThread = true; },
    // Session directory: this document's owned sessions (public state + main-only folder name).
    listOwned() { const out = []; for (const actor of documents.keys()) for (const state of hub.list(actor)) out.push({ state, leaf: leaves.get(state.session) ?? null, nativeSessionId: hub.targetOf(state.session), nativeTurnId: hub.reportTurnOf(state.session) }); return out; },
    // Main-only outbox route. Never attach/relaunch, borrow a new generation,
    // or queue against an unmanaged terminal's permissions.
    followupTarget(session) {
      for (const actor of documents.keys()) {
        const s = hub.state({ session }, actor);
        if (s?.ownership !== 'plexiform-owned' || s.status === 'ended' || s.capabilities?.newTurn !== true || !boardCurrent(s.board) || !ownedScopes.has(session) || ownedScopes.get(session) !== accountScope()) continue;
        return { kind: 'owned', route: { session, actor, board: s.board, account: ownedScopes.get(session) }, generation: s.generation, provider: s.provider.id };
      }
      return null;
    },
    resolveFollowup(target, fresh) {
      const r = target?.route;
      const s = r && documents.has(r.actor) ? hub.state({ session: r.session }, r.actor) : null;
      if (!s || s.ownership !== 'plexiform-owned' || s.status === 'ended' || s.generation !== target.generation || s.provider.id !== target.provider || s.board !== r.board)
        return { ok: false, terminal: true, error: 'The original session ended or changed. Plexiform will not recreate or reattach it.' };
      if (!ownedScopes.has(r.session) || ownedScopes.get(r.session) !== r.account || r.account !== accountScope()) return { ok: false, error: 'Return to the account and board that started this session.' };
      const current = () => fresh() === true && documents.has(r.actor) && boardCurrent(r.board) && accountScope() === r.account
        && hub.state({ session: r.session }, r.actor)?.generation === target.generation;
      if (!boardCurrent(r.board)) return { ok: false, error: BOARD_STALE };
      if (s.capabilities.newTurn !== true) return { ok: false, terminal: true, error: 'This provider does not support a new-turn follow-up.' };
      return { ok: true, ready: s.status === 'ready' && s.activeTurn === null, current,
        reset: () => current() ? hub.resetEvidence(r.session, r.actor, target.generation) : null,
        send: (text, _id, keep) => hub.send({ session: r.session, generation: target.generation, board: r.board, text }, r.actor, { fresh: () => current() && keep() }) };
    },
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
    retireDocuments() { documents.clear(); epoch++; ownedScopes.clear(); return hub.reap(() => false); },
    register(ipc) {
      // null (not []) when this document may not read, so the page keeps its last known state.
      ipc.handle(CHANNELS.capabilities, async (e) => {
        if (!(await actorOf(e, false))) return null;
        let rows = null;
        try { rows = tools(); } catch { rows = null; }
        return explainCapabilities(hub.capabilities(), rows);
      });
      // Only a provider the AI tools page lists, and only from the foreground Overview.
      ipc.handle(CHANNELS.openAiTools, async (e, id) => {
        if (typeof id !== 'string' || !/^[a-z]{2,12}$/.test(id) || !openAiTools || !(await actorOf(e, true))) return false;
        let rows = null;
        try { rows = tools(); } catch { rows = null; }
        return Array.isArray(rows) && rows.some((r) => r && r.id === id) ? !!openAiTools(`aitools:${id}`) : false;
      });
      ipc.handle(CHANNELS.list, async (e) => { const a = await actorOf(e, false); return a ? hub.list(a) : null; });
      // Local models register into `adapters` as they are found (read-only loopback probes + configured endpoints).
      ipc.handle(CHANNELS.localModels, async (e) => ((await actorOf(e, false)) && localModels ? withCard(await localModels.refresh()) : null));
      // Custom endpoints (src/local-model-endpoints.js): read from the Overview, changed only from the foreground Overview.
      ipc.handle(CHANNELS.localEndpoints, async (e) => ((await actorOf(e, false)) && endpointStore ? endpointStore.list() : null));
      ipc.handle(CHANNELS.localEndpointSave, async (e, ...args) => {
        if (!(await actorOf(e, true)) || !endpointStore) return denied;
        let r;
        try { r = endpointStore.save(one(args)); } catch { r = { ok: false, error: 'Could not save that endpoint.' }; }
        if (r.ok) await localModels?.refresh({ force: true }).catch(() => null);
        return r;
      });
      ipc.handle(CHANNELS.localEndpointRemove, async (e, ...args) => {
        if (!(await actorOf(e, true)) || !endpointStore) return denied;
        const req = one(args);
        let r;
        try { r = endpointStore.remove(object(req) ? req.id : null); } catch { r = { ok: false, error: 'Could not remove that endpoint.' }; }
        if (r.ok) await localModels?.refresh({ force: true }).catch(() => null);
        return r;
      });
      ipc.handle(CHANNELS.state, async (e, ...args) => { const a = await actorOf(e, false); return a ? hub.state(one(args), a) : null; });
      ipc.handle(CHANNELS.shareList, async (e) => { const a = await actorOf(e, false); return a ? sharing[CHANNELS.shareList](null, a) : null; });
      ipc.handle(CHANNELS.shareViewers, async (e) => { const a = await actorOf(e, false); return a ? sharing[CHANNELS.shareViewers](null, a) : null; });
      for (const [name, method] of [['proposalList', 'proposalList'], ['proposalApprove', 'proposalApprove'], ['proposalRevoke', 'proposalRevoke']]) {
        ipc.handle(CHANNELS[name], async (e, ...args) => {
          // Gate on: refused before actorOf, so the refusal never reaps or replaces the Overview actor.
          if (name === 'proposalApprove' && approveInThread) return APPROVE_IN_THREAD;
          const effect = name !== 'proposalList', a = await actorOf(e, effect), req = one(args), host = shares();
          if (!a || !object(req) || typeof req.share !== 'string' || !host || typeof host[method] !== 'function') return denied;
          const sh = host.shared().find(s => s.id === req.share);
          if (!sh || !owns(sh.session, a)) return denied;
          const c = effect ? context() : readContext(), board = currentBoard(), account = accountScope();
          if (!c) return denied;
          const fresh = () => { const x = effect ? context() : readContext(); return !!x && (!effect || x.foreground) && x.contents === c.contents && x.document === c.document && x.generation === c.generation
            && currentBoard() === board && accountScope() === account && shares() === host && owns(sh.session, a); };
          if (!fresh()) return denied;
          const out = await host[method](name === 'proposalList' ? req.share : req, fresh);
          if (!fresh()) return denied;
          // The panel hides its approve button when told; gate off, the reply is unchanged.
          return name === 'proposalList' && approveInThread && object(out) && out.ok === true ? { ...out, approve: false } : out;
        });
      }
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
    // App start: one read-only check of the fixed loopback ports so Overview opens with an answer.
    detectLocalModels() { return localModels ? localModels.refresh({ force: true }).then(withCard, () => null) : Promise.resolve(null); },
    close() { hub.stopAll(); documents.clear(); epoch++; ownedScopes.clear(); },
  };
}

module.exports = { createInteractionMain, ownedAdapters, explainCapabilities, CHANNELS, boardKey };
