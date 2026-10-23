'use strict';
// bus_card_add through main's relay (plan-agent-onboarding "PR B", review points 7, 11, 13): who calls, which folder,
// which scope, provider and handle come from the verified session and the book, never the request; the soft
// real-work check; the limits that are the real bound (per attempt, persisted, one at a time per session).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../src/agent-awareness.js');
const { world } = require('./helpers/bind-world.js');

const edited = () => ({ files: { 'src/parser.js': 'edit' }, startedAt: null });
let seq = 0;
const rid = () => `req-card-${String(++seq).padStart(6, '0')}`;

function rig(t, { add, facts = edited, make = {}, w = world(t) } = {}) {
  const adds = [];
  const clock = { t: Date.parse(w.iso) };
  const aw = w.make({
    now: () => clock.t,
    sessionFacts: (s) => facts(s),
    addAgentCard: add || (async (s, a) => { adds.push({ s, a }); return { card_id: `card-${adds.length}`, title: `${a.title} · added by Claude Code`, board: { kind: 'team', name: ']] Team board' } }; }),
    ...make,
  });
  t.after(() => aw.stop());
  const forward = async () => { throw new Error('card_add is never forwarded to the Tasks helper'); };
  const call = (args, pid = 101) => aw.relay('card_add', args, { provider: 'claude', cwd: args.cwd ?? null }, w.call(pid), { forward });
  return { w, aw, adds, clock, call };
}

test('PR B card_add: a verified session adds a card; the session, folder, scope, provider and handle main passes are the binding\'s and the book\'s, never the request\'s', async (t) => {
  const r = rig(t);
  const roster = await r.aw.build();
  const me = roster.self['claude|X'];
  const res = await r.call({ title: 'Fix the parser', details: 'grammar.js', request_id: rid(), cwd: r.w.repoB, provider: 'codex', handle: 'codex-evil-0000', folder: 'elsewhere', personal: true, session_id: 'T', after_note: true });
  assert.equal(res.card_id, 'card-1', JSON.stringify(res));
  assert.deepEqual(res.board, { kind: 'team', name: 'Team board' }, 'the board name is cut to a label on the way out');
  assert.match(res.note, /added by an AI\. Only your person moves or closes it\./);
  assert.equal(r.adds.length, 1);
  const { s, a } = r.adds[0];
  assert.equal(s.sessionId, 'X');
  assert.equal(s.cwd, r.w.repoA, 'the bound session\'s own folder, not the one the request named');
  assert.equal(s.source, 'claude');
  assert.equal(s.scope, undefined, 'its scope is the session\'s own (none here), never the request\'s personal flag');
  assert.deepEqual(Object.keys(a).sort(), ['after_note', 'details', 'folder', 'handle', 'request_id', 'title']);
  assert.equal(a.handle, me.handle);
  assert.notEqual(a.folder, 'elsewhere');
  assert.equal(a.after_note, false, 'after_note is main\'s record of a bus_notes read, never the request\'s');
  assert.ok(!JSON.stringify(a).includes(r.w.repoB));
});

test('PR B card_add refusals reach no board: awareness off, unbound, excluded, unverified, bad arguments, not real work yet', async (t) => {
  const r = rig(t);
  const ok = { title: 'Fix the parser', request_id: rid() };
  r.w.state.config = { agentAwareness: { enabled: false } };
  assert.equal((await r.call(ok)).reason, 'AWARENESS_OFF');
  r.w.state.config = {};
  r.w.proc(300, { ppid: 1, exe: '/opt/homebrew/bin/node', cwd: r.w.repoA, args: 'node /x/mcp-server.js --profile bus', env: '' });
  assert.equal((await r.call(ok, 300)).reason, 'NOT_BOUND');
  r.w.state.config = { agentBus: { exclude: [r.w.repoA] } };
  assert.equal((await r.call(ok)).reason, 'EXCLUDED');
  r.w.state.config = {};
  for (const bad of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(121) }, { details: 'x'.repeat(801) }, { request_id: 'short' }, { request_id: '../../../etc' }, { title: 7 }]) {
    assert.equal((await r.call({ ...ok, ...bad })).reason, 'VALIDATION', JSON.stringify(bad));
  }
  assert.equal(r.adds.length, 0);
  // The soft guard: no edited file and under a minute → refused with the agreed words; read-only files do not count.
  const quiet = rig(t, { facts: () => ({ files: { 'README.md': 'read' }, startedAt: new Date(Date.parse(r.w.iso) - 30_000).toISOString() }) });
  const refused = await quiet.call(ok);
  assert.deepEqual([refused.reason, refused.message], ['NOT_REAL_WORK', 'not real work yet: no files edited, under a minute']);
  assert.equal((await rig(t, { facts: () => null }).call(ok)).reason, 'NOT_REAL_WORK', 'no facts at all');
  assert.equal(quiet.adds.length, 0);
  // Over a minute is real work even with no edit.
  const long = rig(t, { facts: () => ({ files: {}, startedAt: new Date(Date.parse(r.w.iso) - 61_000).toISOString() }) });
  assert.equal((await long.call({ ...ok, request_id: rid() })).card_id, 'card-1');
  // An unverified session (npm Claude Code, unsigned): NOT_BOUND, nothing added.
  const w = world(t);
  w.proc(900, { exe: '/opt/homebrew/bin/node', cwd: w.repoC, args: 'node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js' });
  const kid = w.proc(901, { ppid: 900, exe: w.procs.get(101).exe, cwd: w.repoC, args: w.procs.get(101).args, env: w.procs.get(101).env.replace('CLAUDE_CODE_SESSION_ID=X', 'CLAUDE_CODE_SESSION_ID=NPM').replace('CLAUDE_PID=100', 'CLAUDE_PID=900') });
  w.stdio(kid, w.procs.get(900), 'unix');
  w.state.sessions.push(w.claudeSession('NPM', { claudePid: 900, cwd: w.repoC }));
  const npm = rig(t, { w });
  assert.equal((await npm.call(ok, 901)).reason, 'NOT_BOUND');
  assert.equal(npm.adds.length, 0);
});

test('PR B card_add limits: 3 in 10 minutes and 10 a day per session, 30 a day per Mac; refused attempts count; persisted 0600 across a restart', async (t) => {
  const w = world(t);
  let fail = true;
  const r = rig(t, { w, add: async () => (fail ? { reason: 'UNAVAILABLE', message: 'hub away' } : { card_id: 'c', title: 't', board: { kind: 'personal' } }) });
  for (let i = 0; i < 3; i += 1) assert.equal((await r.call({ title: 'Fix', request_id: rid() })).reason, 'UNAVAILABLE');
  const rate = await r.call({ title: 'Fix', request_id: rid() });
  assert.equal(rate.reason, 'RATE', 'three refused attempts already used the 10-minute allowance');
  assert.match(rate.message, /3 cards in 10 minutes/);
  const file = path.join(w.root, 'awareness', 'card-limits.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.mac, 3);
  assert.equal(saved.sessions['claude|X'].n, 3);
  // A restart reads the counts back: still limited.
  const again = rig(t, { w, add: async () => ({ card_id: 'c', title: 't', board: { kind: 'personal' } }) });
  assert.equal((await again.call({ title: 'Fix', request_id: rid() })).reason, 'RATE');
  // Ten minutes on: allowed again, up to 10 a day for the session.
  fail = false;
  let sent = 3;
  for (let round = 0; sent < 10; round += 1) {
    r.clock.t += A.CARD_LIMITS.burstMs + 1;
    for (let i = 0; i < 3 && sent < 10; i += 1, sent += 1) assert.equal((await r.call({ title: 'Fix', request_id: rid() })).card_id, 'c', `card ${sent + 1}`);
  }
  r.clock.t += A.CARD_LIMITS.burstMs + 1;
  assert.match((await r.call({ title: 'Fix', request_id: rid() })).message, /10 cards a day from one session/);
  // The Mac's day: a file already at 30 refuses every session.
  const w2 = world(t);
  fs.mkdirSync(path.join(w2.root, 'awareness'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(w2.root, 'awareness', 'card-limits.json'), JSON.stringify({ v: 1, day: w2.iso.slice(0, 10), mac: 30, sessions: {} }), { mode: 0o600 });
  const full = rig(t, { w: w2 });
  assert.match((await full.call({ title: 'Fix', request_id: rid() })).message, /30 cards a day from the AI sessions on this Mac/);
  assert.equal(full.adds.length, 0);
  // A new day resets the Mac and the session counts, never the 10-minute window.
  full.clock.t += 24 * 3600_000;
  assert.equal((await full.call({ title: 'Fix', request_id: rid() })).card_id, 'card-1');
});

test('PR B card_add: one call at a time per session, so a burst cannot race past the 10-minute check', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = rig(t, { add: async () => { await gate; return { card_id: 'c1', title: 't', board: { kind: 'personal' } }; } });
  const first = r.call({ title: 'Fix', request_id: rid() });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await r.call({ title: 'Fix again', request_id: rid() });
  assert.equal(second.reason, 'RATE');
  assert.match(second.message, /One card at a time/);
  release();
  assert.equal((await first).card_id, 'c1');
  assert.equal((await r.call({ title: 'Next', request_id: rid() })).card_id, 'c1', 'free again once the first finished');
});

test('PR B card_add: a refusal from the board side passes through as a closed reason; a throw is UNAVAILABLE', async (t) => {
  const r = rig(t, { add: async () => ({ reason: 'CHOOSE_BOARD', message: 'x'.repeat(500), fix: 'Pick one.', extra: 'dropped' }) });
  const res = await r.call({ title: 'Fix', request_id: rid() });
  assert.deepEqual(Object.keys(res).sort(), ['fix', 'message', 'reason']);
  assert.equal(res.message.length, 200);
  const boom = rig(t, { add: async () => { throw new Error('SQLITE /Users/x'); } });
  const e = await boom.call({ title: 'Fix', request_id: rid() });
  assert.equal(e.reason, 'UNAVAILABLE');
  assert.ok(!JSON.stringify(e).includes('SQLITE'));
});

// The world's process table answers for one caller at a time, so the two sessions call one after the other here.
test('PR B card_add: each session has its own count and the Mac\'s day counts both', async (t) => {
  const r = rig(t);
  const a = await r.aw.relay('card_add', { title: 'Codex work', request_id: rid() }, {}, { ...r.w.call(201), threadId: r.w.T }, { forward: async () => ({}) });
  const b = await r.call({ title: 'Claude work', request_id: rid() });
  assert.ok(a.card_id && b.card_id, JSON.stringify([a, b]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const saved = JSON.parse(fs.readFileSync(path.join(r.w.root, 'awareness', 'card-limits.json'), 'utf8'));
  assert.equal(saved.mac, 2);
  assert.deepEqual(Object.keys(saved.sessions).sort(), ['claude|X', `codex|${r.w.T}`]);
  assert.deepEqual(r.adds.map((x) => x.s.sessionId).sort(), ['X', r.w.T].sort());
});

test('PR B card_add: a hung board send times out as UNAVAILABLE and frees the session\'s one card slot (#55 review L3)', async (t) => {
  let calls = 0;
  const r = rig(t, { add: async () => { calls += 1; if (calls === 1) return new Promise(() => {}); return { card_id: 'c2', title: 'Next', board: { kind: 'personal' } }; }, make: { cardTimeoutMs: 40 } });
  const hung = await r.call({ title: 'Fix', request_id: rid() });
  assert.equal(hung.reason, 'UNAVAILABLE');
  assert.match(hung.message, /same request_id/);
  assert.equal((await r.call({ title: 'Next', request_id: rid() })).card_id, 'c2', 'the slot is free after the timeout');
});
