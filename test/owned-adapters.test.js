'use strict';
// Claude Code (stream-json) and Gemini (ACP) owned-session adapters, run as
// real child processes against FAKE provider fixtures. Not provider proof.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), os = require('node:os'), fs = require('node:fs');
const { createInteractionHub, NOTICES } = require('../src/session-interaction');
const { createClaudeCodeSession, buildClaudeArgs } = require('../src/claude-code-session');
const { createGeminiAcp, NOT_INSTALLED } = require('../src/gemini-acp');
const { ownedAdapters } = require('../src/interaction-main');

const ACTOR = 'overview:1:1';
const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-claude-stream.js');
const FAKE_GEMINI = path.join(__dirname, 'fixtures', 'fake-gemini-acp.js');
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-owned-test-'));
const ENV = { HOME: os.homedir(), PATH: process.env.PATH, TMPDIR: os.tmpdir(), ANTHROPIC_API_KEY: 'sk-must-not-pass', GEMINI_API_KEY: 'g-must-not-pass', SECRET_TOKEN: 'nope', CLAUDE_CODE_ENTRYPOINT: 'x' };

function rig(provider, adapter) {
  const hub = createInteractionHub({ adapters: { [provider]: adapter }, workspace: tmp, boardCurrent: (b) => b === null });
  const launch = async () => (await hub.launch({ provider }, ACTOR)).state;
  const send = (s, text, extra = {}) => hub.send({ session: s.session, generation: s.generation, text, ...extra }, ACTOR);
  const state = (s) => hub.state({ session: s.session }, ACTOR);
  return { hub, launch, send, state };
}
const claude = (over = {}) => rig('claude', createClaudeCodeSession({ bin: FAKE_CLAUDE, env: ENV, ackMs: 800, killGraceMs: 200, ...over }));
const gemini = (over = {}) => rig('gemini', createGeminiAcp({ bin: FAKE_GEMINI, env: ENV, requestMs: 800, ...over }));

// ── Claude Code ──
test('FAKE claude: message reaches the selected owned session only, with lifecycle ack, replayed echo and streamed reply', async () => {
  const x = claude();
  try {
    const A = await x.launch(), B = await x.launch();
    assert.equal(A.ownership, 'plexiform-owned'); assert.match(A.label, /Started by Plexiform · Claude Code/);
    assert.notEqual(x.hub.targetOf(A.session), x.hub.targetOf(B.session));
    const sent = await x.send(A, 'ping-A');
    assert.equal(sent.status, 'acknowledged'); assert.equal(sent.delivery.mode, 'new-turn');
    const done = await until(() => x.state(A).deliveries.find((d) => d.state === 'completed'));
    assert.equal(done.recorded, true); assert.equal(done.response, 'echo:ping-A', 'subagent deltas never join the reply');
    assert.equal(x.state(B).deliveries.length, 0);
    assert(!JSON.stringify(x.hub.list(ACTOR)).includes(x.hub.targetOf(A.session)), 'provider session id never leaves main');
    assert.equal((await x.send(A, 'again')).status, 'acknowledged', 'next turn after completion');
  } finally { x.hub.stopAll(); }
});
test('FAKE claude: isolation flags and minimal env reach the child; logins and secrets do not', async () => {
  const x = claude();
  try {
    const A = await x.launch();
    await x.send(A, 'ENV');
    const done = await until(() => x.state(A).deliveries.find((d) => d.state === 'completed'));
    const { argv, env } = JSON.parse(done.response);
    const flag = (f) => argv[argv.indexOf(f) + 1];
    for (const f of ['-p', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--replay-user-messages']) assert(argv.includes(f), f);
    assert.equal(flag('--setting-sources'), ''); assert.equal(flag('--tools'), '');
    assert.equal(flag('--permission-mode'), 'dontAsk'); assert.equal(flag('--permission-prompts'), 'none');
    assert(!argv.includes('--mcp-config') && !argv.includes('--plugin-dir') && !argv.includes('--settings') && !argv.some((a) => /bypass|dangerously/i.test(a)));
    assert.deepEqual(env.filter((k) => !['HOME', 'PATH', 'TMPDIR', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', '__CF_USER_TEXT_ENCODING'].includes(k)), []);
  } finally { x.hub.stopAll(); }
});
test('Claude edit tools exist only for a cwd inside an explicit safe root', async () => {
  assert.equal(buildClaudeArgs({ sessionId: 'x' }).includes('acceptEdits'), false);
  const root = tmp(), calls = [];
  const fakeSpawn = (bin, args) => { calls.push(args); const { EventEmitter } = require('node:events'); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}; c.stderr = new EventEmitter(); c.stdin = Object.assign(new EventEmitter(), { write() {} }); c.pid = 999999; c.kill = () => {}; return c; };
  const a = createClaudeCodeSession({ bin: '/x/claude', spawn: fakeSpawn, safeRoot: root });
  await a.open({ cwd: path.join(root, 'w') }); await a.open({ cwd: tmp() }); await a.open({ cwd: `${root}-evil` });
  assert.deepEqual(calls.map((c) => c[c.indexOf('--permission-mode') + 1]), ['acceptEdits', 'dontAsk', 'dontAsk']);
  await assert.rejects(a.open({ cwd: 'relative' }));
  a.stop();
});
test('FAKE claude: no steer; busy turn refused; interrupt ends the turn; a finished turn cannot be interrupted', async () => {
  const x = claude();
  try {
    const A = await x.launch();
    assert.equal(A.capabilities.steer, false); assert.equal(A.capabilities.existingSessions, false);
    assert.match(A.capabilities.existingSessionsReason, /no supported inbound/);
    await x.send(A, 'HOLD');
    const turn = await until(() => x.state(A).activeTurn);
    assert.equal((await x.send(A, 'second')).status, 'busy');
    assert.equal((await x.send(A, 'steer', { expectedTurn: turn })).status, 'stale');
    assert.equal((await x.hub.interrupt({ session: A.session, generation: A.generation, turn }, ACTOR)).status, 'interrupt-requested');
    await until(() => x.state(A).deliveries.some((d) => d.state === 'interrupted'));
    assert.equal((await x.hub.interrupt({ session: A.session, generation: A.generation, turn }, ACTOR)).status, 'stale');
  } finally { x.hub.stopAll(); }
});
test('Hostile FAKE claude: ack, echo and reply carrying our uuid in another session id are never delivery', async () => {
  const x = claude();
  try {
    const A = await x.launch();
    assert.equal((await x.send(A, 'FOREIGN')).status, 'unavailable');
    const d = x.state(A).deliveries[0];
    assert.equal(d.state, 'refused'); assert.equal(d.recorded, false); assert.equal(d.response, '');
  } finally { x.hub.stopAll(); }
});
test('Hostile FAKE claude: status, stream text and a result without our lifecycle ack are not delivery', async () => {
  const x = claude();
  try {
    const A = await x.launch();
    assert.equal((await x.send(A, 'STATUSONLY')).status, 'unavailable');
    const d = x.state(A).deliveries[0];
    assert.equal(d.state, 'refused'); assert.equal(d.response, ''); assert.equal(x.state(A).activeTurn, null);
  } finally { x.hub.stopAll(); }
});
test('Hostile FAKE claude: forged actor and wrong session never reach the child', async () => {
  const x = claude();
  try {
    const A = await x.launch();
    assert.equal((await x.hub.send({ session: A.session, generation: 1, text: 'hi' }, 'overview:2:1')).status, 'forbidden');
    assert.equal((await x.hub.send({ session: '00000000-0000-4000-8000-000000000000', generation: 1, text: 'hi' }, ACTOR)).status, 'stale');
    assert.equal((await x.hub.send({ session: A.session, generation: 2, text: 'hi' }, ACTOR)).status, 'stale');
    assert.equal(x.state(A).deliveries.length, 0);
  } finally { x.hub.stopAll(); }
});
test('Hostile FAKE claude: malformed and oversized output is dropped and the session survives', async () => {
  const x = claude();
  try {
    const A = await x.launch();
    await x.send(A, 'GARBAGE');
    const d = await until(() => x.state(A).deliveries.find((v) => v.state === 'completed'), 8000);
    assert.equal(d.response, 'echo:GARBAGE');
    assert.equal(x.state(A).status, 'ready');
  } finally { x.hub.stopAll(); }
});
test('Hostile FAKE claude: provider exit mid-turn ends only that session and fails its delivery', async () => {
  const x = claude();
  try {
    const A = await x.launch(), B = await x.launch();
    await x.send(A, 'DIE');
    await until(() => x.state(A).status === 'ended');
    assert.equal(x.state(A).deliveries[0].state, 'failed');
    assert.equal((await x.send(A, 'hi')).status, 'stale');
    assert.equal((await x.send(B, 'still here')).status, 'acknowledged');
  } finally { x.hub.stopAll(); }
});
test('Hostile FAKE claude: an init for a different session id kills that child', async () => {
  const x = claude();
  try {
    const A = await x.launch();
    assert.equal((await x.send(A, 'BADINIT')).status, 'unavailable');
    await until(() => x.state(A).status === 'ended');
  } finally { x.hub.stopAll(); }
});
test('FAKE claude: denied permissions surface as a refusal notice; close reaps the child', async () => {
  const adapter = createClaudeCodeSession({ bin: FAKE_CLAUDE, env: ENV, ackMs: 800, killGraceMs: 200 });
  const x = rig('claude', adapter);
  try {
    const A = await x.launch();
    await x.send(A, 'APPROVAL');
    const d = await until(() => x.state(A).deliveries.find((v) => v.state === 'completed'));
    assert.deepEqual(d.notices, [NOTICES.approval]);
    assert.equal(adapter.sessionCount(), 1);
    assert.equal((await x.hub.close({ session: A.session, generation: A.generation }, ACTOR)).status, 'closed');
    assert.equal(adapter.sessionCount(), 0);
  } finally { x.hub.stopAll(); }
});

// ── Gemini ACP ──
test('Gemini not installed: listed unavailable with the exact reason, launch refused', async () => {
  const adapters = ownedAdapters({ env: { HOME: '/nonexistent-home', PATH: '' } });
  const hub = createInteractionHub({ adapters, boardCurrent: (b) => b === null });
  const caps = hub.capabilities();
  const g = caps.find((c) => c.provider === 'gemini');
  assert.equal(g.available, false); assert.equal(g.reason, NOT_INSTALLED);
  assert.equal(g.capabilities.existingSessions, false);
  assert.equal((await hub.launch({ provider: 'gemini' }, ACTOR)).status, 'unavailable');
  assert.equal(caps.find((c) => c.provider === 'claude').capabilities.existingSessions, false);
  hub.stopAll();
});
test('FAKE ACP gemini: message reaches only the selected session; ack from its own session/update; reply streams', async () => {
  const x = gemini();
  try {
    const A = await x.launch(), B = await x.launch();
    const sent = await x.send(A, 'ping-G');
    assert.equal(sent.status, 'acknowledged');
    const d = await until(() => x.state(A).deliveries.find((v) => v.state === 'completed'));
    assert.equal(d.response, 'echo:ping-G'); assert.equal(d.recorded, false, 'ACP has no echo: never claimed');
    assert.equal(x.state(B).deliveries.length, 0);
    assert.equal(x.state(A).capabilities.echo, false);
  } finally { x.hub.stopAll(); }
});
test('FAKE ACP gemini: busy refused, no steer, session/cancel interrupts', async () => {
  const x = gemini();
  try {
    const A = await x.launch();
    await x.send(A, 'HOLD');
    const turn = await until(() => x.state(A).activeTurn);
    assert.equal((await x.send(A, 'more')).status, 'busy');
    assert.equal((await x.send(A, 'more', { expectedTurn: turn })).status, 'stale');
    assert.equal((await x.hub.interrupt({ session: A.session, generation: A.generation, turn }, ACTOR)).status, 'interrupt-requested');
    await until(() => x.state(A).deliveries.some((d) => d.state === 'interrupted'));
  } finally { x.hub.stopAll(); }
});
test('Hostile FAKE ACP gemini: updates for another session are not an ack; forged actor refused', async () => {
  const x = gemini();
  try {
    const A = await x.launch();
    assert.equal((await x.hub.send({ session: A.session, generation: 1, text: 'hi' }, 'overview:9:9')).status, 'forbidden');
    assert.equal((await x.send(A, 'FOREIGN')).status, 'unavailable');
    assert.equal(x.state(A).deliveries[0].response, '');
  } finally { x.hub.stopAll(); }
});
test('Hostile FAKE ACP gemini: permission request answered with reject, fs request refused, notice shown', async () => {
  const x = gemini();
  try {
    const A = await x.launch();
    await x.send(A, 'APPROVAL');
    const d = await until(() => x.state(A).deliveries.find((v) => v.state === 'completed'));
    assert.deepEqual(d.notices, [NOTICES.approval]);
    await x.send(A, 'PERM?');
    const p = await until(() => x.state(A).deliveries.find((v) => v.state === 'completed' && v.text === 'PERM?'));
    assert.equal(p.response, 'perm:{"outcome":{"outcome":"selected","optionId":"no"}}');
  } finally { x.hub.stopAll(); }
});
test('Hostile FAKE ACP gemini: malformed/oversized lines dropped with a notice; agent exit ends every session', async () => {
  const x = gemini();
  try {
    const A = await x.launch(), B = await x.launch();
    await x.send(A, 'GARBAGE');
    const d = await until(() => x.state(A).deliveries.find((v) => v.state === 'completed'), 8000);
    assert.equal(d.response, 'echo:GARBAGE'); assert(d.notices.includes(NOTICES.oversize));
    await x.send(B, 'DIE').catch(() => {});
    await until(() => x.state(A).status === 'ended' && x.state(B).status === 'ended');
  } finally { x.hub.stopAll(); }
});
