'use strict';
// BACKBONE G1 / owner decision D3: hooks/awareness.js midTurn, the PostToolUse notes notice. One line, a new note set
// only, at most every 2 minutes, never the roster block or a body, off with midTurnNotices false, never a subagent's
// tool call, and cheap enough for every tool call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Hook = require('../hooks/awareness.js');
const Receipt = require('../hooks/team-brief-receipt.js');
const { testTempDir } = require('./helpers/tmp');

const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
const note = (i, from = 'codex-site-ab12') => ({ note_id: `note_${String(i).padStart(20, '0')}`, from_handle: from, from_provider: 'codex', from_folder: 'site' });

function world(t, { config = {}, notices = [note(1)] } = {}) {
  const dir = fs.realpathSync(testTempDir('pf-aw-mid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root');
  const repo = path.join(dir, 'code', 'app');
  fs.mkdirSync(path.join(root, 'awareness'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(root, 'port'), '1');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const self = { 'claude|s1': { handle: 'claude-app-a1e0', allowed: true, interactive: true, verified: true, bound: true, caps: { mcp: true, notes: true }, notices, repo_key: 'aaaaaaaaaaaaaaaa' } };
  const roster = { v: 1, generated_at: '', excluded_roots: [], peers: [{ handle: 'codex-site-ab12', provider: 'codex', folder: 'site', repo_key: null, branch: null, status: 'working', waiting_on: null }], groups: [], self };
  const write = (at = Date.now()) => { roster.generated_at = new Date(at).toISOString(); fs.writeFileSync(path.join(root, 'awareness', 'roster.json'), JSON.stringify(roster)); };
  write();
  const payload = { session_id: 's1', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
  const mid = (now = Date.now(), extra = {}, adapter = 'claude') => Hook.midTurn({ adapter, payload: { ...payload, ...extra }, root, now });
  return { root, repo, roster, write, mid, self };
}

test('one notice line on PostToolUse, no roster block; delivered once, then silent for that set', (t) => {
  const w = world(t);
  const t0 = Date.now();
  const out = w.mid(t0);
  assert.ok(out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  const text = out.hookSpecificOutput.additionalContext;
  assert.equal(text.split('\n').length, 1);
  assert.match(text, /^\[Plexiform: 1 note waiting from codex-site-ab12 \(Codex, folder site\)\. Read it with bus_notes\./);
  assert.ok(!text.includes(Hook.HEADER));
  assert.equal(Receipt.recordDelivered(out), true);
  // Same set: never again mid-turn, whatever the time.
  assert.equal(w.mid(t0 + 1000), null);
  assert.equal(w.mid(t0 + 10 * 60_000), null);
});

test('a new note set inside 2 minutes waits; after 2 minutes it shows', (t) => {
  const w = world(t);
  const t0 = Date.now();
  assert.equal(Receipt.recordDelivered(w.mid(t0)), true);
  w.self['claude|s1'].notices = [note(2), note(1)];
  w.write();
  // The receipt's written_at is the real clock: measure from it.
  const written = Receipt.read(Hook.noticeFile(w.root, 'claude', 's1'), Date.now()).written_at;
  assert.equal(w.mid(written + Hook.MID_TURN_MS - 1000), null);
  w.write(written + Hook.MID_TURN_MS + 1000);
  const later = w.mid(written + Hook.MID_TURN_MS + 1000);
  assert.ok(later);
  assert.match(later.hookSpecificOutput.additionalContext, /^\[Plexiform: 2 notes waiting/);
});

test('off with midTurnNotices false; never for a subagent, a non-interactive session, gemini, or without notes', (t) => {
  assert.equal(world(t, { config: { agentAwareness: { midTurnNotices: false, v: Hook.AWARENESS_V } } }).mid(), null);
  assert.equal(world(t, { config: { agentAwareness: { enabled: false } } }).mid(), null);
  assert.equal(world(t).mid(Date.now(), { agent_id: 'sub-1' }), null);
  assert.equal(world(t).mid(Date.now(), {}, 'gemini'), null);
  assert.equal(world(t, { notices: [] }).mid(), null);
  const w = world(t);
  w.self['claude|s1'].interactive = false;
  w.write();
  assert.equal(w.mid(), null);
  const n = world(t);
  n.self['claude|s1'].caps.notes = false;
  n.write();
  assert.equal(n.mid(), null, 'notes held (halted): no notice');
  // Default (no key) is on.
  assert.ok(world(t, { config: { agentAwareness: {} } }).mid());
});

test('latency: with nothing new, a PostToolUse check costs at most 5 ms (p95)', (t) => {
  const w = world(t);
  assert.equal(Receipt.recordDelivered(w.mid()), true);
  const times = [];
  for (let i = 0; i < 200; i += 1) {
    const t0 = process.hrtime.bigint();
    assert.equal(w.mid(), null);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  assert.ok(p95(times) <= 5, `p95 ${p95(times).toFixed(2)} ms`);
  // With no notes at all (the common case), cheaper still.
  const quiet = world(t, { notices: [] });
  const q = [];
  for (let i = 0; i < 200; i += 1) { const t0 = process.hrtime.bigint(); quiet.mid(); q.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  assert.ok(p95(q) <= 5, `quiet p95 ${p95(q).toFixed(2)} ms`);
});

test('migration: an unversioned stored false (the old default, no control could write it) reads as on; a versioned false sticks', (t) => {
  // A config.json saved before the backbone: {enabled, notes, midTurnNotices:false} and no v.
  assert.ok(world(t, { config: { agentAwareness: { enabled: true, notes: true, midTurnNotices: false } } }).mid());
  assert.equal(Hook.midTurnOn({ agentAwareness: { midTurnNotices: false } }), true);
  assert.equal(Hook.midTurnOn({ agentAwareness: { midTurnNotices: false, v: 1 } }), true);
  assert.equal(Hook.midTurnOn({ agentAwareness: { midTurnNotices: false, v: Hook.AWARENESS_V } }), false);
  assert.equal(Hook.midTurnOn({}), true);
  // Main's normalize does the same and stamps v, so the next save makes a later explicit off stick.
  const A = require('../src/agent-awareness.js');
  const migrated = A.normalize({ enabled: true, notes: true, midTurnNotices: false });
  assert.deepEqual(migrated, { enabled: true, notes: true, midTurnNotices: true, v: Hook.AWARENESS_V });
  const off = A.normalize({ ...migrated, midTurnNotices: false });
  assert.equal(off.midTurnNotices, false);
  assert.equal(A.normalize(off).midTurnNotices, false, 'stays off across later loads and saves');
  assert.equal(Hook.midTurnOn({ agentAwareness: off }), false);
});
