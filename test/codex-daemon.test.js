'use strict';
// codex-daemon adapter (existing Codex CLI sessions on the shared daemon)
// against a FAKE, hostile daemon on a real private Unix socket.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createInteractionHub, ERRORS, NOTICES } = require('../src/session-interaction');
const { createInteractionMain, CHANNELS } = require('../src/interaction-main');
const { createCodexDaemon, REASONS, reasons, METHODS, threadMeta, checkSocket } = require('../src/codex-daemon');
const WebSocket = require('ws');
const { startFakeDaemon, SECRET } = require('./fixtures/fake-codex-daemon');

const ACTOR = 'overview:1:1', OTHER = 'overview:2:1';
const CURRENT = (b) => b === null;
const TRANSCRIPT_METHODS = ['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/inject_items', 'thread/fork'];
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function rig({ enabled = true, socketMode, withThread = true } = {}) {
  const fake = await startFakeDaemon({ socketMode });
  let on = enabled;
  const adapter = createCodexDaemon({ bin: '/usr/bin/true', enabled: () => on, socketPath: fake.socketPath });
  const events = [];
  const hub = createInteractionHub({ adapters: { 'codex-daemon': adapter }, boardCurrent: CURRENT, onEvent: (actor, s) => events.push({ actor, s }) });
  const A = withThread ? fake.addThread() : null;
  const handleOf = async (target = A, actor = ACTOR) => {
    const found = await hub.discover({ provider: 'codex-daemon' }, actor);
    assert.equal(found.ok, true);
    // Handles are opaque: map back through the title only because the test knows the fixture.
    const idx = [...fake.threads.values()].filter((t) => t.loaded && threadMeta(t)).findIndex((t) => t.id === target);
    return found.threads[idx]?.handle;
  };
  const attach = async (target = A, actor = ACTOR) => (await hub.attach({ provider: 'codex-daemon', handle: await handleOf(target, actor), board: null }, actor));
  const done = async () => { hub.stopAll(); await fake.close(); };
  const adapterEvents = [];
  adapter.on((e) => adapterEvents.push(e));
  return { fake, adapter, hub, events, adapterEvents, A, handleOf, attach, done, setEnabled: (v) => { on = v; } };
}
const noTranscriptCalls = (fake) => { for (const m of TRANSCRIPT_METHODS) assert.equal(fake.calls.some((c) => c.method === m), false, `${m} must never be called`); };

test('opt-in off: listed unavailable with the Preferences reason, and nothing connects', async () => {
  const r = await rig({ enabled: false });
  try {
    const cap = r.hub.capabilities().find((c) => c.provider === 'codex-daemon');
    assert.equal(cap.available, false); assert.equal(cap.reason, REASONS.off); assert.match(cap.reason, /Preferences/);
    assert.equal(cap.ownership, 'existing-unmanaged'); assert.equal(cap.capabilities.existingSessions, true); assert.equal(cap.capabilities.startSessions, false);
    assert.equal((await r.hub.discover({ provider: 'codex-daemon' }, ACTOR)).status, 'unavailable');
    assert.equal((await r.hub.launch({ provider: 'codex-daemon' }, ACTOR)).status, 'invalid', 'never offered as a session Plexiform starts');
    assert.equal(r.fake.connections, 0);
  } finally { await r.done(); }
});

test('opted in but the daemon is not running: exact human command in the reason, no start attempted', async () => {
  const bin = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  const adapter = createCodexDaemon({ bin, enabled: () => true, socketPath: path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cdx-none-')), 'missing.sock') });
  assert.equal(adapter.available, false);
  assert.equal(adapter.reason, reasons(bin).notRunning);
  assert(adapter.reason.includes(`\`'${bin}' app-server daemon start\``) && adapter.reason.includes(`\`'${bin}'\` (it attaches`), adapter.reason);
  assert(adapter.precondition.includes(`'${bin}'`));
  assert.match(REASONS.notRunning, /`codex app-server daemon start`/);
  await assert.rejects(adapter.discover(), /not running/);
});

test('a socket open to other users is refused before connecting', async () => {
  const r = await rig({ socketMode: 0o666 });
  try {
    assert.equal(r.adapter.available, false); assert.equal(r.adapter.reason, REASONS.unsafe);
    assert.equal((await r.hub.discover({ provider: 'codex-daemon' }, ACTOR)).status, 'unavailable');
    assert.equal(r.fake.connections, 0);
  } finally { await r.done(); }
});

test('discovery: only interactive CLI threads loaded on the daemon, metadata only, opaque handles, never transcript', async () => {
  const r = await rig();
  try {
    r.fake.addThread({ name: 'Not loaded', loaded: false });
    const sub = r.fake.addThread({ name: 'Sub-agent', parentThreadId: r.A, source: { subAgent: { thread_spawn: { parent_thread_id: r.A, depth: 1 } } } });
    const hidden = [sub, r.fake.addThread({ name: 'Exec', source: 'exec' }), r.fake.addThread({ name: 'App server', source: 'appServer' }), r.fake.addThread({ name: 'Ephemeral', ephemeral: true }), r.fake.addThread({ name: 'Spawned', source: { subAgent: 'review' } }), r.fake.addThread({ name: 'No source', source: undefined })];
    const found = await r.hub.discover({ provider: 'codex-daemon' }, ACTOR);
    assert.equal(found.ok, true);
    const titles = found.threads.map((t) => t.title);
    assert.deepEqual(titles, ['Fix the build'], 'loaded ids without valid CLI metadata are never listed (no blank fallback rows)');
    // A hidden thread cannot be attached even by its id: refused before any subscription.
    for (const id of hidden) await assert.rejects(r.adapter.attach({ target: id }), /interactive Codex CLI/);
    assert.equal(r.fake.calls.some((c) => c.method === 'thread/resume' && hidden.includes(c.params.threadId)), false, 'never resumed (subscribed)');
    const blob = JSON.stringify(found);
    assert(!blob.includes(SECRET) && !blob.includes('secret-branch') && !blob.includes('.jsonl') && !blob.includes(r.A), 'no preview, path, git info or thread id');
    assert.deepEqual(Object.keys(found.threads[0]).sort(), ['handle', 'open', 'project', 'status', 'title', 'updatedAt']);
    assert.equal(found.threads[0].project, 'app');
    noTranscriptCalls(r.fake);
    assert.deepEqual(threadMeta({ id: 'x', source: 'cli', ephemeral: false, preview: SECRET, cwd: '/a/b', name: 'n', status: { type: 'idle' }, updatedAt: 1, turns: [SECRET] }), { id: 'x', title: 'n', project: 'b', status: 'idle', updatedAt: 1 });
  } finally { await r.done(); }
});

test('attach + send: unmanaged label, resume without turns, provider ack, own echo, streamed reply to OUR message', async () => {
  const r = await rig();
  try {
    const at = await r.attach();
    assert.equal(at.ok, true);
    const S = at.state;
    assert.equal(S.ownership, 'existing-unmanaged'); assert.match(S.label, /started outside Plexiform/); assert.doesNotMatch(S.label, /Started by Plexiform/);
    assert.deepEqual(S.thread, { title: 'Fix the build', project: 'app', approvalPolicy: 'on-request', sandbox: 'workspaceWrite', permissions: 'Permissions: asks when it wants to go beyond its sandbox · can edit files in its folder', warnings: [S.thread.warnings[0]] });
    assert.match(S.thread.warnings[0], /cannot tell whether a Codex terminal is still attached/);
    const resume = r.fake.calls.find((c) => c.method === 'thread/resume');
    assert.deepEqual(resume.params, { threadId: r.A, excludeTurns: true }, 'no setting overrides, turns excluded');
    const sent = await r.hub.send({ session: S.session, generation: S.generation, text: 'ping' }, ACTOR);
    assert.equal(sent.status, 'acknowledged'); assert.equal(sent.delivery.mode, 'new-turn');
    const d = await until(() => r.hub.state({ session: S.session }, ACTOR).deliveries.find((x) => x.state === 'completed'));
    assert.equal(d.recorded, true); assert.equal(d.response, 'echo:ping');
    const start = r.fake.calls.find((c) => c.method === 'turn/start');
    assert.equal(start.params.threadId, r.A); assert.equal(Object.hasOwn(start.params, 'effort'), false, 'the user\'s own settings are left alone');
    assert(!JSON.stringify(r.events).includes(r.A), 'thread id never leaves main');
    noTranscriptCalls(r.fake);
  } finally { await r.done(); }
});

test('hostile: wrong/forged handle, other actor, forged actor on send, stale generation, wrong provider', async () => {
  const r = await rig();
  try {
    const handle = await r.handleOf();
    assert.equal((await r.hub.attach({ provider: 'codex-daemon', handle: '00000000-0000-4000-8000-000000000000', board: null }, ACTOR)).status, 'stale');
    assert.equal((await r.hub.attach({ provider: 'codex-daemon', handle, board: null }, OTHER)).status, 'forbidden');
    assert.equal((await r.hub.attach({ provider: 'codex', handle, board: null }, ACTOR)).status, 'invalid');
    assert.equal((await r.hub.attach({ provider: 'codex-daemon', handle, board: null, threadId: r.A }, ACTOR)).status, 'invalid', 'a thread id can never be named directly');
    const S = (await r.hub.attach({ provider: 'codex-daemon', handle, board: null }, ACTOR)).state;
    assert.equal((await r.hub.send({ session: S.session, generation: S.generation, text: 'x' }, OTHER)).status, 'forbidden');
    assert.equal((await r.hub.send({ session: S.session, generation: S.generation + 1, text: 'x' }, ACTOR)).status, 'stale');
    assert.equal((await r.hub.interrupt({ session: S.session, generation: S.generation, turn: '00000000-0000-4000-8000-000000000000' }, ACTOR)).status, 'stale');
    assert.equal(r.fake.calls.filter((c) => c.method.startsWith('turn/')).length, 0);
  } finally { await r.done(); }
});

test('hostile: a replacement thread with the same title and folder is not the same session', async () => {
  const r = await rig();
  try {
    const oldHandle = await r.handleOf();
    const S = (await r.hub.attach({ provider: 'codex-daemon', handle: oldHandle, board: null }, ACTOR)).state;
    // The old thread goes away; a new one appears with identical metadata.
    r.fake.threads.get(r.A).loaded = false;
    r.fake.note('thread/closed', { threadId: r.A });
    const B = r.fake.addThread();
    await until(() => r.hub.state({ session: S.session }, ACTOR)?.status === 'ended');
    assert.equal((await r.hub.send({ session: S.session, generation: S.generation, text: 'x' }, ACTOR)).status, 'stale');
    // A handle for the old thread does not resolve to the new one.
    const fresh = await r.hub.discover({ provider: 'codex-daemon' }, ACTOR);
    assert.equal((await r.hub.attach({ provider: 'codex-daemon', handle: oldHandle, board: null }, ACTOR)).status, 'stale', 'rediscovery retires old handles');
    assert.equal(fresh.threads.length, 1);
    const S2 = (await r.hub.attach({ provider: 'codex-daemon', handle: fresh.threads[0].handle, board: null }, ACTOR)).state;
    assert.notEqual(S2.session, S.session);
    assert.equal(r.fake.calls.filter((c) => c.method === 'thread/resume').at(-1).params.threadId, B);
    // An attach whose thread vanished between discovery and attach is refused, not redirected.
    const h3 = (await r.hub.discover({ provider: 'codex-daemon' }, ACTOR)).threads[0].handle;
    await r.hub.close({ session: S2.session, generation: S2.generation }, ACTOR);
    r.fake.threads.get(B).loaded = false; r.fake.addThread();
    assert.equal((await r.hub.attach({ provider: 'codex-daemon', handle: h3, board: null }, ACTOR)).status, 'unavailable');
  } finally { await r.done(); }
});

test('busy-turn semantics: a turn Plexiform did not start is never steered; steer only adds to our own turn', async () => {
  const r = await rig();
  try {
    const S = (await r.attach()).state;
    const base = { session: S.session, generation: S.generation };
    const human = r.fake.foreignTurn(r.A);
    await until(() => r.hub.state({ session: S.session }, ACTOR).status === 'working');
    assert.equal(r.hub.state({ session: S.session }, ACTOR).activeTurn, null, 'a foreign turn is never offered for steer or interrupt');
    assert.equal((await r.hub.send({ ...base, text: 'new turn' }, ACTOR)).status, 'busy');
    for (const expectedTurn of ['00000000-0000-4000-8000-000000000000', '11111111-1111-4111-8111-111111111111']) {
      const refused = await r.hub.send({ ...base, text: 'x', expectedTurn }, ACTOR);
      assert.equal(refused.status, 'busy'); assert.equal(refused.error, ERRORS.foreignTurn);
    }
    // Even asked directly, the adapter refuses to steer or interrupt a turn it did not start.
    await assert.rejects(r.adapter.send({ target: r.A, text: 'x', clientId: 'c1', expectedTurnId: human }), /only steers turns it started/);
    await assert.rejects(r.adapter.interrupt({ target: r.A, turnId: human }), /only interrupts turns it started/);
    assert.equal(r.fake.calls.some((c) => c.method === 'turn/steer' || c.method === 'turn/interrupt'), false);
    r.fake.finish(r.A, human);
    await until(() => r.hub.state({ session: S.session }, ACTOR).status === 'ready');
    // Our own turn can be steered; its reply is shown.
    assert.equal((await r.hub.send({ ...base, text: 'HOLD' }, ACTOR)).status, 'acknowledged');
    const tag = r.hub.state({ session: S.session }, ACTOR).activeTurn, own = r.fake.threads.get(r.A).active;
    assert(tag && own);
    const steer = await r.hub.send({ ...base, text: 'also this', expectedTurn: tag }, ACTOR);
    assert.equal(steer.status, 'acknowledged'); assert.equal(steer.delivery.mode, 'steer');
    assert.equal(r.fake.calls.find((c) => c.method === 'turn/steer').params.expectedTurnId, own);
    const d = await until(() => r.hub.state({ session: S.session }, ACTOR).deliveries.find((x) => x.mode === 'steer' && x.state === 'completed'));
    assert.equal(d.response, 'steered:also this'); assert.equal(d.recorded, true);
    assert(!JSON.stringify(r.events).includes(SECRET), 'the human\'s own prompt and reply are never passed on');
  } finally { await r.done(); }
});

test('attaching to a thread already working (turn id unknown) refuses as busy until it is idle', async () => {
  const r = await rig();
  try {
    r.fake.threads.get(r.A).status = { type: 'active', activeFlags: [] };
    r.fake.threads.get(r.A).active = 'pre-existing';
    const S = (await r.attach()).state;
    assert.equal(S.status, 'working'); assert.equal(S.activeTurn, null);
    assert.equal((await r.hub.send({ session: S.session, generation: S.generation, text: 'x' }, ACTOR)).status, 'busy');
    r.fake.finish(r.A, 'pre-existing');
    await until(() => r.hub.state({ session: S.session }, ACTOR).status === 'ready');
    assert.equal((await r.hub.send({ session: S.session, generation: S.generation, text: 'now' }, ACTOR)).status, 'acknowledged');
  } finally { await r.done(); }
});

test('duplicate response ids and concurrent sends: the first answer wins, a second send is busy', async () => {
  const r = await rig();
  try {
    const S = (await r.attach()).state;
    r.fake.duplicateResponses = true;
    const [one, two] = await Promise.all([
      r.hub.send({ session: S.session, generation: S.generation, text: 'first' }, ACTOR),
      r.hub.send({ session: S.session, generation: S.generation, text: 'second' }, ACTOR),
    ]);
    assert.deepEqual([one.status, two.status].sort(), ['acknowledged', 'busy']);
    assert.equal(r.fake.calls.filter((c) => c.method === 'turn/start').length, 1);
    const d = await until(() => r.hub.state({ session: S.session }, ACTOR).deliveries.find((x) => x.state === 'completed'));
    assert.equal(d.response, 'echo:first');
    assert(!JSON.stringify(r.hub.state({ session: S.session }, ACTOR)).includes('forged-duplicate'));
  } finally { await r.done(); }
});

test('approvals belong to the human terminal: never answered, a notice is shown on our turn', async () => {
  const r = await rig();
  try {
    const S = (await r.attach()).state;
    await r.hub.send({ session: S.session, generation: S.generation, text: 'HOLD' }, ACTOR);
    const turnId = r.fake.threads.get(r.A).active;
    r.fake.approval(r.A, turnId);
    const d = await until(() => r.hub.state({ session: S.session }, ACTOR).deliveries.find((x) => x.notices.length));
    assert.equal(d.notices[0], NOTICES.approvalElsewhere);
    assert.doesNotMatch(d.notices[0], /Answer it in your Codex terminal/, 'never assumes a terminal is attached');
    assert.match(d.notices[0], /a Codex terminal attached to this session, or interrupt this turn if none is open/);
    await tick();
    assert.equal(r.fake.responses.length, 0, 'Plexiform sent no response to the server request');
  } finally { await r.done(); }
});

test('detach leaves the human\'s work running; a turn Plexiform did not start is never interrupted, its own turn only when asked', async () => {
  const r = await rig();
  try {
    const S = (await r.attach()).state;
    const human = r.fake.foreignTurn(r.A);
    await until(() => r.hub.state({ session: S.session }, ACTOR).status === 'working');
    const refused = await r.hub.interrupt({ session: S.session, generation: S.generation, turn: '00000000-0000-4000-8000-000000000000' }, ACTOR);
    assert.equal(refused.status, 'busy'); assert.equal(refused.error, ERRORS.foreignTurn);
    assert.equal((await r.hub.close({ session: S.session, generation: S.generation }, ACTOR)).status, 'closed');
    assert.equal(r.fake.calls.some((c) => c.method === 'turn/interrupt'), false);
    assert.equal(r.fake.calls.filter((c) => c.method === 'thread/unsubscribe').length, 1);
    // Re-attach, start our own turn and interrupt it explicitly.
    r.fake.finish(r.A, human);
    const S2 = (await r.attach()).state;
    assert.equal((await r.hub.send({ session: S2.session, generation: S2.generation, text: 'HOLD' }, ACTOR)).status, 'acknowledged');
    const own = r.fake.threads.get(r.A).active, tag = r.hub.state({ session: S2.session }, ACTOR).activeTurn;
    assert.equal((await r.hub.interrupt({ session: S2.session, generation: S2.generation, turn: tag }, ACTOR)).status, 'interrupt-requested');
    assert.deepEqual(r.fake.calls.filter((c) => c.method === 'turn/interrupt').map((c) => c.params.turnId), [own]);
  } finally { await r.done(); }
});

test('disclosure: the session\'s own approval policy and sandbox are shown on attach, with warnings for never / full access', async () => {
  const r = await rig({ withThread: false });
  try {
    r.fake.addThread({ approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } });
    const at = await r.attach([...r.fake.threads.keys()][0]);
    assert.equal(at.ok, true);
    const t = at.state.thread;
    assert.equal(t.approvalPolicy, 'never'); assert.equal(t.sandbox, 'dangerFullAccess');
    assert.match(t.permissions, /never asks for approval/); assert.match(t.permissions, /full access to your computer/);
    assert(t.warnings.some((w) => /never asks for approval/.test(w)) && t.warnings.some((w) => /full access to your computer/.test(w)), t.warnings.join('\n'));
    assert(!t.warnings.some((w) => /terminal/.test(w)), 'no approvals are asked under "never", so no terminal notice');
    assert.deepEqual(r.fake.calls.find((c) => c.method === 'thread/resume').params, { threadId: [...r.fake.threads.keys()][0], excludeTurns: true }, 'read from the resume response, never overridden');
  } finally { await r.done(); }
});

test('opting out or the daemon going away ends attached sessions in Plexiform', async () => {
  const r = await rig();
  try {
    const S = (await r.attach()).state;
    r.setEnabled(false);
    assert.equal((await r.hub.send({ session: S.session, generation: S.generation, text: 'x' }, ACTOR)).status, 'stale');
    r.setEnabled(true);
    r.fake.dropAll();
    await until(() => r.hub.state({ session: S.session }, ACTOR)?.status === 'ended');
  } finally { await r.done(); }
});

test('the adapter cannot send a transcript method even if asked', async () => {
  for (const m of TRANSCRIPT_METHODS) assert.equal(METHODS.has(m), false);
  assert.deepEqual([...METHODS].sort(), ['initialize', 'thread/list', 'thread/loaded/list', 'thread/resume', 'thread/unsubscribe', 'turn/interrupt', 'turn/start', 'turn/steer']);
});

test('privacy: nothing but our own echoed message and replies to our turns is stored, pushed or logged', async () => {
  const logged = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logged.push(a.join(' ')); };
  const r = await rig();
  try {
    const S = (await r.attach()).state;
    const human = r.fake.foreignTurn(r.A);
    r.fake.approval(r.A, human);
    r.fake.note('turn/completed', { threadId: r.A, turn: { id: human, status: 'failed', error: { message: `${SECRET} failure` }, items: [] } });
    r.fake.threads.get(r.A).active = null;
    r.fake.note('thread/status/changed', { threadId: r.A, status: { type: 'idle' } });
    await until(() => r.hub.state({ session: S.session }, ACTOR).status === 'ready');
    await r.hub.send({ session: S.session, generation: S.generation, text: 'HOLD' }, ACTOR);
    const tag = r.hub.state({ session: S.session }, ACTOR).activeTurn;
    await r.hub.send({ session: S.session, generation: S.generation, text: 'mine', expectedTurn: tag }, ACTOR);
    await until(() => r.hub.state({ session: S.session }, ACTOR).deliveries.find((x) => x.state === 'completed'));
    await r.hub.send({ session: S.session, generation: S.generation, text: 'mine too' }, ACTOR);
    await until(() => r.hub.state({ session: S.session }, ACTOR).deliveries.filter((x) => x.state === 'completed').length === 3);
    const everything = JSON.stringify([r.events, r.adapterEvents, r.hub.list(ACTOR), await r.hub.discover({ provider: 'codex-daemon' }, ACTOR), logged]);
    assert(!everything.includes(SECRET), 'no other transcript content anywhere');
    const texts = r.hub.state({ session: S.session }, ACTOR).deliveries.map((d) => [d.text, d.response]);
    assert.deepEqual(texts, [['HOLD', 'steered:mine'], ['mine', 'steered:mine'], ['mine too', 'echo:mine too']]);
    noTranscriptCalls(r.fake);
  } finally { Object.assign(console, orig); await r.done(); }
});

test('interaction-main exposes discover/attach; the board and actor come from main', async () => {
  assert.equal(CHANNELS.discover, 'interaction:discover'); assert.equal(CHANNELS.attach, 'interaction:attach');
  const r = await rig();
  const contents = { id: 1, isDestroyed: () => false, mainFrame: {}, send() {} };
  const context = () => ({ contents, foreground: true, generation: 1, document: 1 });
  const handlers = new Map();
  const main = createInteractionMain({ context, adapters: { 'codex-daemon': r.adapter }, owned: null, localModels: null, workspace: () => '/tmp', currentBoard: () => 'my-board' });
  main.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const e = { sender: contents, senderFrame: contents.mainFrame };
  try {
    const found = await handlers.get(CHANNELS.discover)(e, { provider: 'codex-daemon' });
    assert.equal(found.ok, true);
    assert.equal((await handlers.get(CHANNELS.attach)(e, { provider: 'codex-daemon', handle: found.threads[0].handle, board: 'forged' })).status, 'invalid');
    const at = await handlers.get(CHANNELS.attach)(e, { provider: 'codex-daemon', handle: found.threads[0].handle });
    assert.equal(at.ok, true); assert.equal(at.state.ownership, 'existing-unmanaged');
  } finally { main.close(); await r.done(); }
});

test('concurrent attaches of one thread give one session; detaching one window keeps the other subscribed', async () => {
  const r = await rig();
  try {
    const handle = await r.handleOf();
    const [one, two] = await Promise.all([1, 2].map(() => r.hub.attach({ provider: 'codex-daemon', handle, board: null }, ACTOR)));
    assert.equal(one.ok && two.ok, true);
    assert.equal(one.state.session, two.state.session, 'no duplicate session');
    assert.equal(r.hub.list(ACTOR).length, 1);
    assert.equal(r.fake.calls.filter((c) => c.method === 'thread/resume').length, 1);
    // Another window attaches the same thread over the same daemon connection.
    const other = (await r.attach(r.A, OTHER)).state;
    assert.equal((await r.hub.close({ session: one.state.session, generation: one.state.generation }, ACTOR)).status, 'closed');
    assert.equal(r.fake.calls.some((c) => c.method === 'thread/unsubscribe'), false, 'the connection is still in use by the other window');
    assert.equal((await r.hub.send({ session: other.session, generation: other.generation, text: 'still here' }, OTHER)).status, 'acknowledged');
    const d = await until(() => r.hub.state({ session: other.session }, OTHER).deliveries.find((x) => x.state === 'completed'));
    assert.equal(d.response, 'echo:still here');
    await r.hub.close({ session: other.session, generation: other.generation }, OTHER);
    assert.equal(r.fake.calls.filter((c) => c.method === 'thread/unsubscribe').length, 1, 'unsubscribed once the last one detached');
  } finally { await r.done(); }
});

test('reap prunes the discovery handles of a gone window', async () => {
  const r = await rig();
  try {
    const handle = await r.handleOf();
    await r.hub.reap((actor) => actor !== ACTOR);
    assert.equal((await r.hub.attach({ provider: 'codex-daemon', handle, board: null }, ACTOR)).status, 'stale');
    assert.equal(r.fake.calls.some((c) => c.method === 'thread/resume'), false);
  } finally { await r.done(); }
});

test('the request path refuses any method outside the allowlist, even from main', async () => {
  const r = await rig();
  try {
    assert.equal('_request' in r.adapter, false, 'no back door around the public adapter calls');
    await r.hub.discover({ provider: 'codex-daemon' }, ACTOR);
    const lists = () => r.fake.calls.filter((c) => c.method === 'thread/loaded/list').length;
    const before = lists();
    assert.ok(before >= 1);
    // Take a method off the allowlist: the public path that uses it must no longer reach the daemon.
    METHODS.delete('thread/loaded/list');
    try { await r.hub.discover({ provider: 'codex-daemon' }, ACTOR).catch(() => null); } finally { METHODS.add('thread/loaded/list'); }
    assert.equal(lists(), before, 'a method off the list is never sent');
    noTranscriptCalls(r.fake);
    assert.equal(r.fake.calls.some((c) => c.method === 'config/read' || c.method === 'thread/start'), false);
  } finally { await r.done(); }
});

test('our turn id on another thread is not ours: nothing from it is passed on', async () => {
  const r = await rig();
  try {
    const S = (await r.attach()).state;
    await r.hub.send({ session: S.session, generation: S.generation, text: 'HOLD' }, ACTOR);
    const own = r.fake.threads.get(r.A).active, elsewhere = r.fake.addThread({ name: 'Other' });
    r.fake.note('item/agentMessage/delta', { threadId: elsewhere, turnId: own, itemId: 'x', delta: SECRET });
    r.fake.note('item/completed', { threadId: elsewhere, turnId: own, item: { type: 'agentMessage', id: 'x', text: SECRET } });
    r.fake.note('turn/completed', { threadId: elsewhere, turn: { id: own, status: 'failed', error: { message: SECRET } } });
    r.fake.note('item/agentMessage/delta', { threadId: r.A, turnId: own, itemId: 'a', delta: 'real' });
    await until(() => r.adapterEvents.some((e) => e.kind === 'delta' && e.text === 'real'));
    assert(!JSON.stringify(r.adapterEvents).includes(SECRET), 'a forged thread id with our turn id is dropped by the adapter');
  } finally { await r.done(); }
});

test('error text of a turn someone else started is never passed on by the adapter', async () => {
  const r = await rig();
  try {
    await r.attach();
    const human = r.fake.foreignTurn(r.A);
    r.fake.note('turn/completed', { threadId: r.A, turn: { id: human, status: 'failed', error: { message: `${SECRET} failure` } } });
    const done = await until(() => r.adapterEvents.find((e) => e.kind === 'turn-completed' && e.turnId === human));
    assert.equal(done.error, null); assert.equal(done.status, 'failed');
    assert(!JSON.stringify(r.adapterEvents).includes(SECRET));
  } finally { await r.done(); }
});

test('socket check: owner uid and private directory are required (no root-owned or sticky directory)', () => {
  const sock = (o = {}) => ({ isSocket: () => true, uid: 501, mode: 0o140600, dev: 1, ino: 2, ...o });
  const dir = (o = {}) => ({ isSocket: () => false, uid: 501, mode: 0o40700, ...o });
  const fsImpl = (s, d) => ({ realpathSync: (p) => `/real/${path.basename(p)}`, statSync: (p) => (p === '/real' ? d : s) });
  const check = (s, d, uid = 501) => checkSocket('/x/app-server-control.sock', { fsImpl: fsImpl(s, d), uid });
  assert.deepEqual(check(sock(), dir()), { ok: true, real: '/real/app-server-control.sock', id: '1:2' });
  const bad = [
    [sock({ uid: 502 }), dir()], [sock(), dir({ uid: 502 })], [sock(), dir({ uid: 0 })], [sock(), dir(), 0], [sock(), dir(), null],
    [sock({ mode: 0o140660 }), dir()], [sock({ mode: 0o140604 }), dir()],
    [sock(), dir({ mode: 0o41777 })], [sock(), dir({ mode: 0o40750 })], [sock(), dir({ mode: 0o40701 })], [sock(), dir({ mode: 0o40770 })],
  ];
  for (const entry of bad) assert.equal(check(entry[0], entry[1], entry.length === 3 ? entry[2] : 501).reason, 'unsafe', JSON.stringify(entry));
});

test('the socket is checked again after connecting: a swapped socket is refused before initialize', async () => {
  const a = await startFakeDaemon(), b = await startFakeDaemon();
  try {
    const adapter = createCodexDaemon({ bin: '/usr/bin/true', enabled: () => true, socketPath: a.socketPath, connect: (real) => {
      fs.renameSync(b.realPath, real); // the inode behind the checked path changes before the connection lands
      return new WebSocket(`ws+unix://${real}:/`, { perMessageDeflate: false });
    } });
    await assert.rejects(adapter.discover(), (e) => e.message === REASONS.unsafe);
    assert.equal(b.calls.length, 0, 'nothing is sent to a socket that failed the re-check');
    assert.equal(a.calls.length, 0);
  } finally { await a.close(); await b.close(); }
});
