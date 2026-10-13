'use strict';
// Hand-off requests from a running AI (src/handoff-requests.js): the request
// waits for the person, Confirm goes through continue-in's preview (native
// confirm) and launch, the outcome comes back on the card, and the AI reads
// only states. Nothing starts, copies or sends on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const Requests = require('../src/handoff-requests.js');
const Packet = require('../src/handoff-packet.js');

const tools = () => [{ id: 'claude', label: 'Claude Code', mode: 'launch' }, { id: 'codex', label: 'Codex', mode: 'launch' }, { id: 'gemini', label: 'Gemini CLI', mode: 'copy' }, { id: 'copy', label: 'Copy as prompt', mode: 'copy' }];

test('parseMarker: the first "plexiform: handoff to <tool>: <why>" line, case and spelling tolerant, aliases resolved', () => {
  assert.deepEqual(Requests.parseMarker('Done with the parser.\nplexiform: handoff to codex: needs a second opinion on the grammar\nmore'), { to: 'codex', reason: 'needs a second opinion on the grammar' });
  assert.deepEqual(Requests.parseMarker('PLEXIFORM: Hand-off to Claude-Code'), { to: 'claude', reason: '' });
  assert.deepEqual(Requests.parseMarker('  plexiform: hand off to gemini-cli : try the long context'), { to: 'gemini', reason: 'try the long context' });
  assert.equal(Requests.parseMarker('plexiform handoff to codex'), null);
  assert.equal(Requests.parseMarker('I would plexiform: handoff to codex'), null, 'only at the start of a line');
  assert.equal(Requests.parseMarker(''), null);
  assert.equal(Requests.parseMarker(null), null);
  assert.equal(Requests.parseMarker(`plexiform: handoff to codex: ${'x'.repeat(400)}`).reason.length, Requests.LIMITS.reason);
});

test('request: a found tool, a title, repo-relative files only; the AI gets a waiting status and never a launch', () => {
  const changes = [], notes = [];
  const q = Requests.create({ tools, onChange: () => changes.push(1), notify: (r) => notes.push(r), home: '/Users/alice' });
  assert.equal(q.request({ from: 'claude', to: 'cursor', title: 'x' }).reason, 'not_found');
  assert.match(q.request({ from: 'claude', to: 'cursor', title: 'x' }).message, /claude, codex, gemini/);
  assert.equal(q.request({ from: 'claude', to: 'copy', title: 'x' }).reason, 'not_found');
  assert.equal(q.request({ from: 'claude', to: 'codex', title: '  ' }).reason, 'invalid');
  assert.equal(q.request({ from: 'claude', to: 'claude', title: 'same tool' }).reason, 'invalid', 'a hand-off is to a different tool');
  const r = q.request({ from: 'claude', to: 'Codex', reason: 'parser grammar', title: 'Finish the parser', brief: 'Token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH in /Users/alice/.env', files: ['src/parser.js', '/etc/passwd', '../../x', 'docs/a.md'], branch: 'feat/parser', cwd: '/Users/alice/shop' });
  assert.equal(r.available, true);
  assert.equal(r.status, 'waiting_for_your_person');
  assert.equal(r.to, 'Codex');
  assert.match(r.note, /Nothing happens until your person presses Confirm/);
  assert.equal(changes.length, 1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].to, 'codex');
  const [row] = q.list();
  assert.equal(row.state, 'pending');
  assert.deepEqual(row.files, ['src/parser.js', 'docs/a.md']);
  assert.equal(row.goal, 'Finish the parser');
  assert.equal(row.reason, 'parser grammar');
  assert.equal(q.pending(), 1);
  // The AI's read-back carries states and outcomes only.
  const st = q.status({});
  assert.deepEqual(Object.keys(st.requests[0]), ['request_id', 'to', 'status', 'outcome']);
  assert.equal(st.requests[0].status, 'waiting_for_your_person');
  assert.equal(q.status({ request_id: 'nope' }).requests.length, 0);
});

test('at most 8 pending; a pending request expires after an hour; finished ones are kept ten minutes', () => {
  let t = 1_000_000;
  const q = Requests.create({ tools, now: () => t });
  for (let i = 0; i < 8; i++) assert.equal(q.request({ to: 'codex', title: `t${i}` }).available, true);
  assert.equal(q.request({ to: 'codex', title: 'one more' }).reason, 'busy');
  t += Requests.LIMITS.ttlMs + 1;
  assert.ok(q.list().every((r) => r.state === 'expired'));
  assert.equal(q.pending(), 0);
  t += Requests.LIMITS.keepDoneMs + 1;
  assert.equal(q.list().length, 0);
});

test('fromText: one marker makes one request per session and target, however often the handover is re-rendered', () => {
  const q = Requests.create({ tools });
  const facts = { from: 'claude', title: 'Ship the importer', brief: 'Half done', files: ['src/import.js'], cwd: '/w', sessionId: 'claude-code:abc' };
  const text = 'All tests pass.\nplexiform: handoff to codex: review the SQL\n';
  const first = q.fromText(text, facts);
  assert.equal(first.status, 'waiting_for_your_person');
  assert.equal(q.fromText(text, facts), null);
  assert.equal(q.fromText(text, facts), null);
  assert.equal(q.list().length, 1);
  assert.equal(q.list()[0].goal, 'Ship the importer');
  assert.equal(q.list()[0].reason, 'review the SQL');
  // A different reason, or a different session, is a new request; no marker is nothing.
  assert.ok(q.fromText('plexiform: handoff to codex: a second thing', facts));
  assert.ok(q.fromText(text, { ...facts, sessionId: 'claude-code:other' }));
  assert.equal(q.fromText('no marker here', facts), null);
  assert.equal(q.list().length, 3);
  // A dismissed request does not come back when the same handover renders again.
  q.dismiss(first.request_id);
  assert.equal(q.fromText(text, facts), null);
});

test('confirm goes through continue-in (preview, then launch); the outcome is written back; dismiss and double-confirm are refused', async () => {
  const changes = [];
  const q = Requests.create({ tools, onChange: () => changes.push(1) });
  const r = q.request({ from: 'claude', to: 'codex', title: 'Finish it', brief: 'Where it was left' });
  const shown = [];
  let emit = null;
  const continueIn = {
    handoffPacket: async (packet, to, onEvent) => {
      assert.equal(Packet.validate(packet).ok, true);
      assert.equal(to, 'codex');
      shown.push(Packet.toPrompt(packet));
      emit = onEvent;
      return { ok: true, mode: 'launched', id: 'launch-1', to: 'codex', label: 'Codex' };
    },
  };
  const events = [];
  const res = await q.confirm(r.request_id, { continueIn, onEvent: (ev) => events.push(ev) });
  assert.equal(res.ok, true);
  assert.equal(res.request, r.request_id);
  assert.match(shown[0], /^# Handoff from claude to codex\n/);
  assert.match(shown[0], /## Goal\nFinish it/);
  assert.equal(q.list()[0].state, 'started');
  assert.equal((await q.confirm(r.request_id, { continueIn })).ok, false, 'not twice');
  assert.equal(q.dismiss(r.request_id).ok, false);
  emit({ kind: 'message', text: 'Reviewed the SQL; two indexes added.' });
  emit({ kind: 'done', status: 'completed' });
  assert.equal(q.list()[0].state, 'done');
  assert.equal(q.list()[0].note, 'Reviewed the SQL; two indexes added.');
  assert.equal(events.filter((e) => e.kind === 'done')[0].request, r.request_id);
  assert.equal(q.status({ request_id: r.request_id }).requests[0].outcome, 'Reviewed the SQL; two indexes added.');
  // The outcome is written once; a later close does not reopen or overwrite it.
  emit({ kind: 'closed' });
  assert.equal(q.list()[0].state, 'done');

  // A cancelled preview leaves the request pending; a failed launch keeps it pending with the error shown.
  const r2 = q.request({ from: 'claude', to: 'codex', title: 'Again' });
  assert.deepEqual(await q.confirm(r2.request_id, { continueIn: { handoffPacket: async () => ({ ok: false, cancelled: true }) } }), { ok: false, cancelled: true });
  assert.equal(q.list().find((x) => x.id === r2.request_id).state, 'pending');
  await q.confirm(r2.request_id, { continueIn: { handoffPacket: async () => ({ ok: false, error: 'Codex did not start.' }) } });
  const row = q.list().find((x) => x.id === r2.request_id);
  assert.equal(row.state, 'pending');
  assert.equal(row.note, 'Codex did not start.');
  // A copy (free plan or copy-only tool) ends the request at once.
  const copied = await q.confirm(r2.request_id, { continueIn: { handoffPacket: async () => ({ ok: true, mode: 'copied', note: 'Copied.' }) } });
  assert.equal(copied.ok, true);
  assert.equal(q.list().find((x) => x.id === r2.request_id).state, 'copied');
  // A failed turn is a failed outcome with the error.
  const r3 = q.request({ from: 'claude', to: 'codex', title: 'Third' });
  await q.confirm(r3.request_id, { continueIn: { handoffPacket: async (_p, _t, onEvent) => { setImmediate(() => onEvent({ kind: 'done', status: 'failed', error: 'rate limited' })); return { ok: true, mode: 'launched', id: 'l3' }; } } });
  await new Promise((res2) => setImmediate(res2));
  const third = q.list().find((x) => x.id === r3.request_id);
  assert.equal(third.state, 'failed');
  assert.equal(third.note, 'rate limited');
  assert.equal(q.dismiss('missing').ok, false);
  assert.ok(changes.length >= 8);
});

test('confirm refuses a tool that disappeared since the request', async () => {
  let rows = tools();
  const q = Requests.create({ tools: () => rows });
  const r = q.request({ to: 'codex', title: 'x' });
  rows = rows.filter((c) => c.id !== 'codex');
  const res = await q.confirm(r.request_id, { continueIn: { handoffPacket: async () => { throw new Error('must not be called'); } } });
  assert.equal(res.ok, false);
  assert.match(res.error, /no longer found/);
});
