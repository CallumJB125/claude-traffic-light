'use strict';
// Independent wire-to-state tests. These are synthetic provider frames, not
// real account/provider acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInteractionHub } = require('../src/session-interaction');
const { createCodexAppServer } = require('../src/codex-app-server');
const { createClaudeCodeSession } = require('../src/claude-code-session');
const { createSessionDirectory } = require('../src/session-directory');
const ACTOR = 'activity-test', T0 = 1_800_000_000_000;
function child(onWrite) {
  const c = new EventEmitter();
  c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} }); c.stderr = new EventEmitter();
  c.stdin = Object.assign(new EventEmitter(), { write(s) { onWrite?.(JSON.parse(s)); } });
  c.kill = () => { c.exitCode = 0; c.emit('exit', 0); };
  return c;
}
test('Claude reset evidence comes only from an active owned parent structured event', async () => {
  let c; const events=[];
  const a=createClaudeCodeSession({bin:'/synthetic/claude',spawn:()=>(c=child()),killGraceMs:10}); a.on(e=>events.push(e));
  try {
    const {target}=await a.open({cwd:'/tmp'}), id='10000000-0000-4000-8000-000000000001';
    const frame=m=>c.stdout.emit('data',`${JSON.stringify(m)}\n`);
    const rate={type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:2000000000}};
    frame(rate); assert.equal(events.filter(e=>e.kind==='usage-limit').length,0);
    const sent=a.send({target,text:'task',clientId:id}); frame({type:'command_lifecycle',session_id:target,command_uuid:id,state:'started'}); await sent;
    frame({...rate,session_id:'other'}); frame({...rate,parent_tool_use_id:'child'}); frame({...rate,rate_limit_info:{status:'made-up',resetsAt:2000000000}});
    assert.equal(events.filter(e=>e.kind==='usage-limit').length,0);
    frame(rate); const first=events.filter(e=>e.kind==='usage-limit').at(-1);
    assert.equal(first.target,target); assert.equal(first.resetAtMs,2000000000000); assert.match(first.eventId,/^[0-9a-f]{64}$/);
    frame(rate); assert.equal(events.filter(e=>e.kind==='usage-limit').at(-1).eventId,first.eventId);
    frame({...rate,rate_limit_info:{status:'allowed'}}); assert.equal(events.filter(e=>e.kind==='usage-limit').at(-1).resetAtMs,null);
  } finally {a.stop();}
});
function memoryRig() {
  const ee = new EventEmitter(); let seq = 0, at = T0;
  const adapter = { label: 'Synthetic', capabilities: { newTurn: true }, alive: () => true, open: async () => ({ target: 'private-target' }), send: async () => ({ turnId: `private-turn-${++seq}`, mode: 'new-turn' }), on: f => { ee.on('event', f); return () => ee.off('event', f); } };
  const hub = createInteractionHub({ adapters: { synthetic: adapter }, boardCurrent: () => true, now: () => at });
  return { hub, emit: e => ee.emit('event', { target: 'private-target', ...e }), advance: () => ++at, at: () => at, launch: () => hub.launch({ provider: 'synthetic' }, ACTOR) };
}
test('activity is exact-turn bound, uses closed labels, does not refresh on replay and cannot revive an old turn', async () => {
  const r = memoryRig(), s = (await r.launch()).state, base = { session: s.session, generation: s.generation };
  const state = () => r.hub.state({ session: s.session }, ACTOR);
  await r.hub.send({ ...base, text: 'first task' }, ACTOR);
  const initial = state().activity;
  assert.equal(initial.label, 'Thinking'); assert.equal(initial.turn, state().activeTurn);
  const e = { kind: 'activity', turnId: 'private-turn-1', activityId: 'private-tool-item', label: 'Reading files', phase: 'working' };
  r.advance(); r.emit({ ...e, target: 'other-target' }); r.emit({ ...e, turnId: 'old-turn' }); r.emit({ ...e, label: 'cat /private/file' });
  assert.deepEqual(state().activity, initial);
  r.emit(e); const reading = state().activity;
  assert.equal(reading.label, 'Reading files'); assert.equal(reading.observed_at, r.at());
  r.advance(); r.emit(e); assert.deepEqual(state().activity, reading, 'duplicate start is not fresh activity');
  r.emit({ ...e, activityId: 'second', label: 'Searching' });
  r.emit({ ...e, phase: 'completed' }); assert.equal(state().activity.label, 'Searching', 'older concurrent tool completion does not replace the active tool');
  r.emit({ ...e, activityId: 'second', label: 'Searching', phase: 'completed' });
  assert.equal(state().activity.phase, 'completed');
  r.advance(); r.emit({ kind: 'turn-completed', turnId: 'private-turn-1', status: 'completed' });
  const ended = state().activity;
  r.advance(); r.emit({ kind: 'turn-started', turnId: 'private-turn-1' }); r.emit({ ...e, activityId: 'late' });
  assert.equal(state().status, 'ready'); assert.deepEqual(state().activity, ended);
  await r.hub.send({ ...base, text: 'second task' }, ACTOR);
  assert.equal(state().activity.label, 'Thinking'); assert.notEqual(state().activity.turn, ended.turn);
  const second = state().activity; r.advance(); r.emit(e); assert.deepEqual(state().activity, second);
  assert.ok(!JSON.stringify(state()).includes('private-'), 'native target, turn and item IDs remain in main');
  r.hub.stopAll();
});
test('Codex wire item lifecycle exposes only fixed categories, never command, args, path or reasoning', async () => {
  let c; const events = [];
  const a = createCodexAppServer({ bin: '/synthetic/codex', spawn: () => (c = child(m => { if (m.id) c.stdout.emit('data', `${JSON.stringify({ id: m.id, result: m.method === 'thread/start' ? { thread: { id: 'thread' } } : {} })}\n`); })) });
  a.on(e => events.push(e));
  try {
    await a.open({ cwd: '/tmp' });
    for (const [id, type, expected] of [['a', 'commandExecution', 'Running a command'], ['b', 'fileChange', 'Editing files'], ['c', 'reasoning', 'Thinking'], ['d', 'collabAgentToolCall', 'Coordinating agents']]) {
      for (const method of ['item/started', 'item/completed']) c.stdout.emit('data', `${JSON.stringify({ method, params: { threadId: 'thread', turnId: 'turn', item: { id, type, command: 'PRIVATE_COMMAND', text: 'PRIVATE_REASONING', changes: [{ path: '/PRIVATE_PATH' }] } } })}\n`);
      assert.deepEqual(events.filter(e => e.activityId === id).map(e => [e.label, e.phase]), [[expected, 'working'], [expected, 'completed']]);
    }
    c.stdout.emit('data', `${JSON.stringify({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { id: 'bad', type: 'PRIVATE_TOOL' } } })}\n`);
    assert.equal(events.some(e => e.activityId === 'bad'), false);
    for (const raw of ['PRIVATE_COMMAND', 'PRIVATE_REASONING', 'PRIVATE_PATH', 'PRIVATE_TOOL']) assert.ok(!JSON.stringify(events).includes(raw));
  } finally { a.stop(); }
});
test('Claude partial tool/thinking frames use fixed categories and independent message blocks', async () => {
  let c; const events = [];
  const a = createClaudeCodeSession({ bin: '/synthetic/claude', spawn: () => (c = child()), killGraceMs: 10 }); a.on(e => events.push(e));
  try {
    const { target } = await a.open({ cwd: '/tmp' }), id = '10000000-0000-4000-8000-000000000001';
    const sent = a.send({ target, text: 'task', clientId: id });
    const frame = m => c.stdout.emit('data', `${JSON.stringify({ session_id: target, ...m })}\n`);
    frame({ type: 'command_lifecycle', command_uuid: id, state: 'started' }); await sent;
    for (const [message, name, label] of [['one', 'Read', 'Reading files'], ['two', 'Bash', 'Running a command'], ['three', 'PRIVATE_TOOL', 'Using a tool']]) {
      const stream = event => frame({ type: 'stream_event', event });
      stream({ type: 'message_start', message: { id: message } });
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tool:${message}`, name, input: { command: 'PRIVATE_COMMAND', path: '/PRIVATE_PATH' } } });
      stream({ type: 'content_block_stop', index: 0 });
      assert.equal(events.filter(e => e.kind === 'activity').at(-1).phase, 'working', 'argument streaming completion does not mean tool completion');
      frame({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tool:${message}`, content: 'PRIVATE_RESULT' }] } });
      assert.deepEqual(events.filter(e => e.kind === 'activity').slice(-2).map(e => [e.label, e.phase]), [[label, 'working'], [label, 'completed']]);
    }
    assert.equal(new Set(events.filter(e => e.kind === 'activity').map(e => e.activityId)).size, 3, 'reused block zero from a new message remains observable');
    frame({ type: 'stream_event', parent_tool_use_id: 'child-private', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Write' } } });
    assert.equal(events.filter(e => e.kind === 'activity').length, 6, 'sub-agent tool frames cannot impersonate parent activity');
    for (const raw of ['PRIVATE_TOOL', 'PRIVATE_COMMAND', 'PRIVATE_PATH', 'PRIVATE_RESULT']) assert.ok(!JSON.stringify(events).includes(raw));
  } finally { a.stop(); }
});
test('directory projects only safe activity categories and independent observation time', () => {
  const d = createSessionDirectory({ now: () => T0 });
  const make = activity => d.mine({ owned: [{ state: { session: '10000000-0000-4000-8000-000000000001', provider: { id: 'codex', label: 'Codex' }, status: 'working', ownership: 'plexiform-owned', activity } }] })[0];
  const e = make({ label: 'Reading files', phase: 'working', observed_at: T0 - 100_000, turn: 'private-turn', command: 'PRIVATE_COMMAND' });
  assert.equal(e.freshness, 'recent'); assert.equal(e.activity.freshness, 'stale'); assert.equal(e.activity.observedAt, T0 - 100_000);
  assert.deepEqual(Object.keys(e.activity), ['label', 'phase', 'observedAt', 'freshness', 'ageMs']);
  assert.ok(!JSON.stringify(e).includes('private-turn')); assert.ok(!JSON.stringify(e).includes('PRIVATE_COMMAND'));
  assert.equal(make({ label: 'PRIVATE_COMMAND', phase: 'working', observed_at: T0 }).activity, null);
  assert.equal(make({ label: 'Thinking', phase: 'working', observed_at: T0 + 1 }).activity, null);
});
