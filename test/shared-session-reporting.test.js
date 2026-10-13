'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInteractionHub, cleanReportText } = require('../src/session-interaction');
const { createTeamHubClient } = require('../src/team-hub-client');
const actor = 'overview:report';
async function fixture() {
  const ee = new EventEmitter(); let time = 1000, n = 0;
  const adapter = { label: 'Fixture', capabilities: { newTurn: true, steer: true }, alive: () => true, on: (f) => { ee.on('event', f); return () => ee.off('event', f); }, open: async () => ({ target: `private-target-${++n}` }), send: async (r) => ({ turnId: r.expectedTurnId ?? 'private-turn', mode: r.expectedTurnId ? 'steer' : 'new-turn' }), interrupt: async () => {}, stop() {} };
  const hub = createInteractionHub({ adapters: { fixture: adapter }, boardCurrent: () => true, now: () => time });
  const session = (await hub.launch({ provider: 'fixture' }, actor)).state;
  return { hub, adapter, ee, session, now: () => time, tick: () => ++time, advance: (ms) => time += ms, report: (r, who = actor) => hub.report({ session: session.session, generation: session.generation, source: 'self-reported', ...r }, who), state: () => hub.state({ session: session.session }, actor) };
}
test('owned report seam binds actor and generation, bounds schema, preserves independent clocks and opaque children', async () => {
  const f = await fixture();
  try {
    assert.equal(f.report({ taskTitle: 'No' }, 'other').status, 'forbidden');
    assert.equal(f.report({ generation: 0, taskTitle: 'No' }).status, 'stale');
    assert.equal(f.report({ taskTitle: 'No', rawPath: '/tmp/x' }).status, 'invalid');
    assert.equal(f.report({ source: 'invented', taskTitle: 'No' }).status, 'invalid');
    assert.equal(f.report({ children: [{ id: 'child', name: 'One', state: 'imagined' }] }).status, 'invalid');
    assert.equal(f.report({ observedAt: f.now() + 1, inputNeeded: true }).status, 'invalid');
    assert.equal(f.report({ children: [{ id: 'child', name: 'One', state: 'working', createdAt: 1001 }] }).status, 'invalid');
    assert.equal(f.report({ taskTitle: 'Parent', inputNeeded: true, children: [{ id: 'raw-child', name: 'Worker', taskTitle: 'Child task', state: 'input', observedAt: 900, createdAt: 800 }] }).ok, true);
    const original = f.state().reporting.children[0];
    assert.equal(original.observed_at, 900); assert.equal(original.received_at, 1000); assert.equal(original.created_at, 800);
    assert.match(original.ref, /^[0-9a-f-]{36}$/); assert.ok(!JSON.stringify(f.state()).includes('raw-child'));
    f.tick();
    f.report({ taskTitle: 'Parent updated', children: [{ id: 'raw-child', name: 'Replay', state: 'ended', observedAt: 900 }] });
    assert.deepEqual(f.state().reporting.children[0], original, 'replayed child is not freshened by the parent');
    f.tick(); f.report({ children: [{ id: 'raw-child', name: 'Worker', state: 'ended', observedAt: 1002, createdAt: 1002 }] });
    const changed = f.state().reporting.children[0];
    assert.equal(changed.ref, original.ref); assert.equal(changed.created_at, 800, 'later update cannot reset pre-share creation');
    assert.equal(changed.received_at, 1002); assert.equal(f.state().reporting.task.observed_at, 1001);
    await f.hub.replaceTarget(f.session.session);
    assert.deepEqual(f.state().reporting, { task: null, input: null, children: [] });
  } finally { f.hub.stopAll(); }
});
test('real target/turn events report supported metadata; model output and refused approvals do not invent telemetry', async () => {
  const f = await fixture();
  try {
    const sent = await f.hub.send({ session: f.session.session, generation: 1, text: 'Build the overview' }, actor);
    assert.equal(sent.state.task_title, 'Build the overview'); assert.equal(sent.state.reporting.task.source, 'human');
    assert.equal(f.hub.reportTurnOf(f.session.session), 'private-turn'); assert.ok(!JSON.stringify(sent.state.reporting).includes('private-turn'));
    const target = f.hub.targetOf(f.session.session);
    f.tick();
    f.ee.emit('event', { kind: 'task-report', target: 'other', turnId: 'private-turn', taskTitle: 'wrong target' });
    f.ee.emit('event', { kind: 'input-needed', target: 'other', turnId: 'private-turn', needed: true });
    f.ee.emit('event', { kind: 'child-report', target: 'other', turnId: 'private-turn', child: { id: 'foreign-child', name: 'Foreign', state: 'working' } });
    f.ee.emit('event', { kind: 'task-report', target, turnId: 'other', taskTitle: 'wrong turn' });
    f.ee.emit('event', { kind: 'message', target, turnId: 'private-turn', text: 'I started an agent and need input' });
    f.ee.emit('event', { kind: 'refused-request', target, turnId: 'private-turn' });
    assert.equal(f.state().task_title, 'Build the overview'); assert.equal(f.state().input_needed, false); assert.equal(f.state().reporting.children.length, 0);
    f.ee.emit('event', { kind: 'task-report', target, turnId: 'private-turn', taskTitle: 'Provider plan' });
    f.ee.emit('event', { kind: 'input-needed', target, turnId: 'private-turn', needed: true });
    f.ee.emit('event', { kind: 'child-report', target, turnId: 'private-turn', child: { id: 'child-provider-id', name: 'Test worker', taskTitle: 'Test overview', state: 'working' } });
    assert.equal(f.state().task_title, 'Build the overview', 'provider plan cannot replace human intent'); assert.equal(f.state().input_needed, true);
    assert.equal(f.state().reporting.children[0].source, 'provider');
    f.tick(); f.ee.emit('event', { kind: 'input-needed', target, turnId: 'private-turn', needed: false });
    assert.equal(f.state().input_needed, false);
    f.tick(); f.ee.emit('event', { kind: 'input-needed', target, turnId: 'private-turn', needed: true }); assert.equal(f.state().input_needed, true);
    f.ee.emit('event', { kind: 'turn-completed', target, turnId: 'private-turn', status: 'completed' });
    assert.equal(f.state().input_needed, false); assert.equal(f.state().reporting.input.source, 'provider');
    f.tick(); f.ee.emit('event', { kind: 'child-report', target, turnId: 'private-turn', child: { id: 'late', name: 'Late', state: 'working' } });
    assert.equal(f.state().reporting.children.length, 1, 'late inactive turn cannot add an agent');
    await f.hub.replaceTarget(f.session.session); assert.equal(f.hub.reportTurnOf(f.session.session), null);
  } finally { f.hub.stopAll(); }
});
test('human task intent outranks later declared/provider labels; newer human intent may replace it', async () => {
  const f = await fixture();
  f.adapter.send = async ({ target }) => {
    f.ee.emit('event', { kind: 'turn-started', target, turnId: 'private-turn' }); f.tick();
    f.ee.emit('event', { kind: 'task-report', target, turnId: 'private-turn', taskTitle: 'Early provider guess' });
    return { turnId: 'private-turn', mode: 'new-turn' };
  };
  try {
    await f.hub.send({ session: f.session.session, generation: 1, text: 'Human selected task' }, actor);
    for (const source of ['provider', 'self-reported', 'observed']) { f.tick(); f.report({ source, taskTitle: 'Reported replacement', inputNeeded: false }); assert.equal(f.state().task_title, 'Human selected task'); assert.equal(f.state().reporting.task.source, 'human'); }
    f.tick(); f.report({ source: 'human', taskTitle: 'Human revised task' }); assert.equal(f.state().task_title, 'Human revised task');
  } finally { f.hub.stopAll(); }
});
test('report labels redact secrets, known private IDs, paths, URLs, emails and invisible controls before truncating', async () => {
  const f = await fixture();
  try {
    const token = `bdt_${'A'.repeat(43)}`, gh = `ghp_${'b'.repeat(30)}`;
    const text = `Fix /Users/private/project C:\\secret\\file ~/secret \\\\server\\secret https://user:password@host/path?token=x bob@example.org ${token} ${gh} private-target-1 \u202e\u200b`;
    f.report({ taskTitle: text, children: [{ id: 'child-secret', name: 'child-secret', taskTitle: text, state: 'working' }] });
    const wire = JSON.stringify(f.state().reporting);
    for (const raw of ['/Users/private', 'C:\\secret', '~/secret', 'server', 'https://', 'bob@example', token, gh, 'private-target-1', 'child-secret', '\u202e', '\u200b']) assert.ok(!wire.includes(raw), raw);
    assert.ok(cleanReportText(`${'a '.repeat(95)}${token}`).length <= 200);
    assert.ok(!cleanReportText(`${'a '.repeat(95)}${token}`).includes('bdt_'));
    f.tick(); f.report({ taskTitle: 'Parent mentions sibling-a', children: [{ id: 'sibling-a', name: 'First mentions sibling-b', taskTitle: 'sibling-b', state: 'working' }, { id: 'sibling-b', name: 'Second mentions sibling-a', taskTitle: 'sibling-a', state: 'working' }] });
    let labels = JSON.stringify(f.state().reporting); assert.ok(!labels.includes('sibling-a')); assert.ok(!labels.includes('sibling-b'));
    f.tick(); f.report({ taskTitle: 'Known previous sibling-b', children: [{ id: 'new-one', name: 'Mentions sibling-a', taskTitle: 'sibling-b', state: 'working' }] });
    labels = JSON.stringify(f.state().reporting); assert.ok(!labels.includes('sibling-a')); assert.ok(!labels.includes('sibling-b'));
    for (let i = 0; i < 25; i++) { f.tick(); f.report({ children: [{ id: `child-${i}`, name: 'Agent', taskTitle: 'x'.repeat(300), state: 'working' }] }); }
    assert.equal(f.state().reporting.children.length, 20); assert.ok(f.state().reporting.children.every((c) => c.task_title.length <= 200));
  } finally { f.hub.stopAll(); }
});
test('untrusted hub client whitelists metadata and keeps child/report times independent of fresh host receipt', async () => {
  const share = '11111111-1111-4111-8111-111111111111', session = '22222222-2222-4222-8222-222222222222', child = '33333333-3333-4333-8333-333333333333';
  const task = { title: 'Task /tmp/private', source: 'self-reported', observed_at: 600, received_at: 700, secret: 'hidden' };
  const reportChild = { ref: child, name: 'Worker', task_title: 'Test', state: 'input', source: 'observed', observed_at: 500, received_at: 650, created_at: 400, rawID: 'hidden' };
  let advertisedInput = true, clientTime = 1000;
  const fetch = async (url) => ({ status: 200, text: async () => JSON.stringify(url.endsWith('/shared') ? { shared: [{ id: share, session, scope: 'interact', team: { id: 'team', name: 'Team' }, owner: { id: 'owner', name: 'Owner' }, online: true }] } : { result: { ok: true, state: { provider: { id: 'codex', label: 'Codex' }, status: 'working', input_needed: advertisedInput, observed_at: 1000, reporting: { task, input: { needed: true, source: 'provider', observed_at: 800, received_at: 850 }, children: [reportChild, reportChild, { ...reportChild, ref: 'raw-provider-id' }, { ...reportChild, ref: session, source: 'invented' }] } } } }) });
  const client = createTeamHubClient({ baseUrl: 'http://127.0.0.1', token: () => 'fixture', fetch }, { now: () => clientTime });
  const [row] = await client.sessions(null, 'team');
  assert.equal(row.task_title, 'Task <path>'); assert.equal(row.task_source, 'self-reported'); assert.equal(row.input_needed, true); assert.equal(row.state, 'input');
  assert.equal(row.observed_at, 1000); assert.equal(row.task_observed_at, 600); assert.equal(row.task_received_at, 700);
  assert.equal(row.children.length, 1); assert.equal(row.children[0].observed_at, 500); assert.equal(row.children[0].received_at, 650);
  assert.ok(!JSON.stringify(row).includes('hidden'));
  advertisedInput = false; const [noLongerCurrent] = await client.sessions(null, 'team'); assert.equal(noLongerCurrent.input_needed, false); assert.equal(noLongerCurrent.input_reported_needed, true);
  advertisedInput = true; clientTime = 90_801; const [oldReport] = await client.sessions(null, 'team'); assert.equal(oldReport.input_needed, false); assert.equal(oldReport.input_reported_needed, true); assert.equal(oldReport.input_observed_at, 800);
});
test('an uncertain provider send records unconfirmed once and cannot claim refusal or acknowledgement', async () => {
  const f = await fixture(); let sends = 0;
  f.adapter.send = async () => { sends++; const e = new Error('private channel detail'); e.code = 'DELIVERY_UNCONFIRMED'; throw e; };
  try {
    const sent = await f.hub.send({ session: f.session.session, generation: 1, text: 'One instruction' }, actor);
    assert.equal(sent.ok, false); assert.equal(sent.status, 'unconfirmed'); assert.match(sent.error, /Do not resend automatically/);
    assert.equal(sends, 1); assert.equal(f.state().deliveries[0].state, 'unconfirmed'); assert.equal(f.state().deliveries[0].recorded, false); assert.equal(f.state().deliveries[0].turn, null);
    assert.ok(!JSON.stringify(sent).includes('private channel detail')); assert.equal(f.state().task_title, null);
  } finally { f.hub.stopAll(); }
});
test('shared client preserves uncertain send warning and never retries the operation', async () => {
  const share = '11111111-1111-4111-8111-111111111111', session = '22222222-2222-4222-8222-222222222222'; let sends = 0;
  const fetch = async (url, opts) => {
    let body;
    if (url.endsWith('/shared')) body = { shared: [{ id: share, session, scope: 'interact', team: { id: 'team', name: 'Team' }, owner: { id: 'owner', name: 'Owner' }, online: true }] };
    else if (JSON.parse(opts.body).op === 'state') body = { result: { ok: true, state: { generation: 1 } } };
    else { sends++; body = { result: { ok: false, status: 'unconfirmed', error: 'private unsafe detail' } }; }
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  const client = createTeamHubClient({ baseUrl: 'http://127.0.0.1', token: () => 'fixture', fetch });
  const result = await client.send(null, 'team', share, 'Single message');
  assert.equal(result.status, 'unconfirmed'); assert.match(result.error, /Do not resend automatically/); assert.equal(sends, 1); assert.ok(!JSON.stringify(result).includes('private unsafe detail'));
});
test('input-needed expires independently of state reads while its original last report remains immutable', async () => {
  const f = await fixture();
  try {
    f.report({ inputNeeded: true }); const original = { ...f.state().reporting.input };
    f.advance(-1); assert.equal(f.state().input_needed, false, 'future report is not a current question'); f.advance(1);
    f.advance(90_000); assert.equal(f.state().input_needed, true);
    f.advance(1); assert.equal(f.state().input_needed, false); assert.deepEqual(f.state().reporting.input, original);
    f.report({ observedAt: original.observed_at, inputNeeded: true }); assert.equal(f.state().input_needed, false); assert.deepEqual(f.state().reporting.input, original);
    f.tick(); f.report({ inputNeeded: true }); const last = { ...f.state().reporting.input }; assert.equal(f.state().input_needed, true);
    f.ee.emit('event', { kind: 'closed', target: f.hub.targetOf(f.session.session) }); assert.equal(f.state().input_needed, false); assert.deepEqual(f.state().reporting.input, last);
  } finally { f.hub.stopAll(); }
});
