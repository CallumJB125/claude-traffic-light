'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTeamHubClient } = require('../src/team-hub-client');

const AT = 1_800_000_000_000;
const SHARE = '11111111-2222-4333-8444-555555555555';
const SESSION = '10000000-0000-4000-8000-000000000001';
const OTHER_SESSION = '10000000-0000-4000-8000-000000000002';
const TURN = '20000000-0000-4000-8000-000000000001';
const OTHER_TURN = '20000000-0000-4000-8000-000000000002';
const REQUEST = '30000000-0000-4000-8000-000000000001';
const VIEWER = Object.freeze({ id: 'alice', name: 'Alice' });
const share = (over = {}) => ({ id: SHARE, session: SESSION, scope: 'interact', expires_at: null, team: { id: 'team', name: 'Team' }, owner: { id: 'bob', name: 'Bob' }, online: true, ...over });
const state = (over = {}) => ({ session: SESSION, generation: 4, activeTurn: null, status: 'ready', observed_at: AT - 10,
  provider: { id: 'codex', label: 'Codex' }, capabilities: { newTurn: true, steer: true, interrupt: true, ack: true, echo: true, stream: true },
  deliveries: [], ...over });
const delivery = (over = {}) => ({ id: '40000000-0000-4000-8000-000000000001', text: 'hello', by: 'Alice', mode: 'new-turn',
  state: 'acknowledged', recorded: false, turn: TURN, response: '', error: null, notices: [], sentAt: AT - 1, finishedAt: null, ...over });
const reply = (body, status = 200) => ({ status, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });

function rig({ shares = [share()], current = state(), actionResult, onRequest, viewer = VIEWER } = {}) {
  const cfg = { shares, current, actionResult }, calls = [];
  const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 'opaque-test-token', viewer,
    fetch: async (url, init) => {
      const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      const out = await onRequest?.(call, cfg);
      if (out !== undefined) return out;
      if (url.endsWith('/shared')) return reply({ shared: cfg.shares });
      if (call.body.op === 'state') return reply({ result: { ok: true, state: cfg.current } });
      return reply({ result: cfg.actionResult ?? { ok: true, status: 'acknowledged', delivery: delivery(), state: cfg.current } });
    },
  }, { now: () => AT });
  return { hub, cfg, calls, mutations: () => calls.filter(c => c.body && c.body.op !== 'state') };
}

test('inspect reads the exact share and returns bounded live state without routing or native identifiers', async () => {
  const r = rig({ current: state({ activeTurn: TURN, status: 'working', thread: { id: 'native-thread', cwd: '/private' }, board: 'private-board',
    provider: { id: 'codex', label: 'Codex', target: 'native-target' },
    activity: { label: 'Running a command', phase: 'working', observed_at: AT - 20, turn: TURN, command: 'private command' },
    reporting: { task: { title: 'Implement the task', source: 'provider', observed_at: AT - 30, received_at: AT - 20 }, input: null, children: [] },
    deliveries: [delivery({ response: 'x'.repeat(20_000), notices: ['A notice', ''].concat(Array(10).fill('bounded')), nativeTurn: 'native-turn' })],
  }) });
  const out = await r.hub.inspect(VIEWER, 'team', SHARE);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'ok');
  assert.deepEqual([out.state.generation, out.state.activeTurn, out.state.status], [4, TURN, 'working']);
  assert.equal(out.state.deliveries[0].response.length, 16_000);
  assert.equal(out.state.deliveries[0].notices.length, 4);
  assert.deepEqual(out.state.activity, { label: 'Running a command', phase: 'working', observed_at: AT - 20, turn: TURN });
  assert.equal(out.state.task_title, 'Implement the task');
  for (const forbidden of ['native-thread', '/private', 'private-board', 'native-target', 'native-turn', 'private command', '"session"']) assert.equal(JSON.stringify(out).includes(forbidden), false, forbidden);
  assert.deepEqual(r.calls.map(c => c.body?.op ?? 'shared'), ['shared', 'state']);
  assert.deepEqual(r.calls[1].body.args, { session: SESSION });
});

test('inspect preserves watch visibility while disabling mutation capabilities; invalid activities are omitted', async () => {
  for (const activity of [{ label: 'Run private shell command', phase: 'working', observed_at: AT, turn: TURN }, { label: 'Thinking', phase: 'working', observed_at: AT + 1, turn: TURN }, { label: 'Thinking', phase: 'working', observed_at: AT, turn: 'native-turn' }]) {
    const r = rig({ shares: [share({ scope: 'watch' })], current: state({ activity }) });
    const out = await r.hub.inspect(VIEWER, 'team', SHARE);
    assert.equal(out.ok, true);
    assert.deepEqual([out.state.capabilities.newTurn, out.state.capabilities.steer, out.state.capabilities.interrupt], [false, false, false]);
    assert.equal(out.state.activity, null);
  }
});

test('inspect rejects a foreign viewer, wrong team, expired/revoked share and a wrong-session state', async () => {
  const foreign = rig();
  assert.equal((await foreign.hub.inspect({ id: 'mallory' }, 'team', SHARE)).status, 'forbidden');
  assert.equal(foreign.calls.length, 0);
  const wrongTeam = rig();
  assert.equal((await wrongTeam.hub.inspect(VIEWER, 'other-team', SHARE)).status, 'forbidden');
  assert.equal(wrongTeam.calls.some(c => c.body?.op), false);
  for (const shares of [[], [share({ expires_at: new Date(AT).toISOString() })], [share({ expires_at: 'not a date' })]]) {
    const r = rig({ shares });
    assert.equal((await r.hub.inspect(VIEWER, 'team', SHARE)).status, 'stale');
    assert.equal(r.calls.some(c => c.body?.op), false);
  }
  const wrong = rig({ current: state({ session: OTHER_SESSION, deliveries: [delivery({ response: 'private content' })] }) });
  const out = await wrong.hub.inspect(VIEWER, 'team', SHARE);
  assert.equal(out.status, 'stale');
  assert.equal(JSON.stringify(out).includes('private content'), false);
});

test('act sends and steers with the supplied generation, exact turn and request ID; provider acknowledgement survives', async () => {
  for (const operation of ['send', 'steer']) {
    const current = state(operation === 'steer' ? { activeTurn: TURN, status: 'working' } : {});
    const receipt = delivery({ mode: operation === 'steer' ? 'steer' : 'new-turn' });
    const r = rig({ current, actionResult: { ok: true, status: 'acknowledged', delivery: receipt, state: { ...current, deliveries: [receipt] } } });
    const out = await r.hub.act(VIEWER, 'team', SHARE, { operation, generation: 4, turn: operation === 'steer' ? TURN : null, text: '  hello  ' }, REQUEST);
    assert.equal(out.ok, true);
    assert.equal(out.status, 'acknowledged', 'provider receipt must never collapse into queued');
    assert.equal(out.delivery.state, 'acknowledged');
    assert.equal(out.state.generation, 4);
    assert.equal(r.mutations().length, 1);
    assert.deepEqual(r.mutations()[0].body, { request_id: REQUEST, op: 'send', args: { session: SESSION, generation: 4, text: 'hello', ...(operation === 'steer' ? { expectedTurn: TURN } : {}) } });
  }
});

test('act interrupts only the exact active opaque turn and preserves interrupt-requested without claiming stop', async () => {
  const current = state({ activeTurn: TURN, status: 'working' });
  const r = rig({ current, actionResult: { ok: true, status: 'interrupt-requested', state: current } });
  const out = await r.hub.act(VIEWER, 'team', SHARE, { operation: 'interrupt', generation: 4, turn: TURN }, REQUEST);
  assert.equal(out.status, 'interrupt-requested');
  assert.equal(out.state.status, 'working');
  assert.deepEqual(r.mutations()[0].body, { request_id: REQUEST, op: 'interrupt', args: { session: SESSION, generation: 4, turn: TURN } });
});

test('act refuses stale generation, wrong/completed turn, foreign busy turn, unsupported action and invalid schemas before dispatch', async () => {
  const cases = [
    [state(), { operation: 'send', generation: 3, turn: null, text: 'hello' }, 'stale'],
    [state({ activeTurn: TURN, status: 'working' }), { operation: 'steer', generation: 4, turn: OTHER_TURN, text: 'hello' }, 'stale'],
    [state(), { operation: 'interrupt', generation: 4, turn: TURN }, 'stale'],
    [state({ status: 'working' }), { operation: 'send', generation: 4, turn: null, text: 'hello' }, 'busy'],
    [state({ activeTurn: TURN, status: 'working', capabilities: { steer: false } }), { operation: 'steer', generation: 4, turn: TURN, text: 'hello' }, 'unsupported'],
    [state(), { operation: 'send', generation: 4, turn: TURN, text: 'hello' }, 'invalid'],
    [state(), { operation: 'interrupt', generation: 4, turn: TURN, text: 'hello' }, 'invalid'],
    [state(), { operation: 'send', generation: 4, turn: null, text: 'hello', nativeTarget: 'secret' }, 'invalid'],
  ];
  for (const [current, action, status] of cases) {
    const r = rig({ current });
    assert.equal((await r.hub.act(VIEWER, 'team', SHARE, action, REQUEST)).status, status);
    assert.equal(r.mutations().length, 0);
  }
});

test('act refreshes authorization: revoked, watch/viewer downgrade, wrong team and retargeted shares never dispatch', async () => {
  for (const shares of [[], [share({ scope: 'watch' })], [share({ team: { id: 'other-team', name: 'Other' } })], [share({ session: OTHER_SESSION })], [share({ owner: { id: 'different-owner', name: 'Other' } })]]) {
    const r = rig();
    await r.hub.teams(VIEWER);
    r.cfg.shares = shares;
    const out = await r.hub.act(VIEWER, 'team', SHARE, { operation: 'send', generation: 4, turn: null, text: 'hello' }, REQUEST);
    assert.equal(out.ok, false);
    assert.equal(r.mutations().length, 0);
  }
});

test('act preserves bounded provider result/delivery states and fixed refusal reasons', async () => {
  for (const status of ['recorded', 'responding', 'completed', 'interrupted', 'failed']) {
    const receipt = delivery({ state: status });
    const r = rig({ actionResult: { ok: true, status, delivery: receipt, state: state({ deliveries: [receipt] }) } });
    const out = await r.hub.act(VIEWER, 'team', SHARE, { operation: 'send', generation: 4, turn: null, text: 'hello' }, REQUEST);
    assert.equal(out.status, status);
    assert.equal(out.delivery.state, status);
  }
  const r = rig({ actionResult: { ok: false, status: 'busy', error: 'HUB-SECRET-TEXT' } });
  const out = await r.hub.act(VIEWER, 'team', SHARE, { operation: 'send', generation: 4, turn: null, text: 'hello' }, REQUEST);
  assert.equal(out.status, 'busy');
  assert.equal(JSON.stringify(out).includes('HUB-SECRET-TEXT'), false);
});

test('act treats lost, malformed and ambiguous write receipts as unconfirmed and never retries', async () => {
  const writes = [
    () => { throw new Error('write connection lost'); },
    () => reply({ error: 'server failed after forwarding' }, 500),
    () => reply({}),
    () => reply({ result: { ok: true } }),
    () => reply({ result: { ok: false, status: 'unconfirmed', error: 'private failure' } }),
  ];
  for (const write of writes) {
    const r = rig({ onRequest: c => c.body && c.body.op !== 'state' ? write() : undefined });
    const out = await r.hub.act(VIEWER, 'team', SHARE, { operation: 'send', generation: 4, turn: null, text: 'hello' }, REQUEST);
    assert.equal(out.status, 'unconfirmed');
    assert.match(out.reason, /Do not resend automatically/);
    assert.equal(r.mutations().length, 1);
  }
});

test('act authority guard cancels before write when selection/account changes during awaited read', async () => {
  let alive = true;
  const r = rig({ onRequest: c => { if (c.body?.op === 'state') alive = false; } });
  const out = await r.hub.act(VIEWER, 'team', SHARE, { operation: 'send', generation: 4, turn: null, text: 'hello' }, REQUEST, () => alive);
  assert.equal(out.status, 'forbidden');
  assert.equal(r.mutations().length, 0);
});

test('act returns unconfirmed without state after authority is lost during the dispatched write', async () => {
  let alive = true;
  const r = rig({ onRequest: c => { if (c.body?.op === 'send') alive = false; } });
  const out = await r.hub.act(VIEWER, 'team', SHARE, { operation: 'send', generation: 4, turn: null, text: 'hello' }, REQUEST, () => alive);
  assert.equal(out.status, 'unconfirmed');
  assert.equal(Object.hasOwn(out, 'state'), false);
  assert.equal(Object.hasOwn(out, 'delivery'), false);
  assert.equal(r.mutations().length, 1);
});

test('inspect withholds an awaited state when its configured account changes', async () => {
  const identity = { ...VIEWER };
  const r = rig({ viewer: identity, onRequest: c => { if (c.body?.op === 'state') identity.id = 'other-account'; } });
  const out = await r.hub.inspect(VIEWER, 'team', SHARE);
  assert.equal(out.status, 'forbidden');
  assert.equal(Object.hasOwn(out, 'state'), false);
});

test('legacy send preserves the provider acknowledgement rather than relabelling it queued', async () => {
  const receipt = delivery();
  const r = rig({ actionResult: { ok: true, status: 'acknowledged', delivery: receipt, state: state({ deliveries: [receipt] }) } });
  const out = await r.hub.send(VIEWER, 'team', SHARE, 'hello', REQUEST);
  assert.equal(out.status, 'acknowledged');
  assert.equal(out.delivery.state, 'acknowledged');
});

test('legacy send authority guard stops dispatch after list/state await and withholds post-write receipts', async () => {
  for (const boundary of ['shared', 'state', 'send']) {
    let alive = true;
    const r = rig({ onRequest: c => { if (boundary === 'shared' ? c.url.endsWith('/shared') : c.body?.op === boundary) alive = false; } });
    const out = await r.hub.send(VIEWER, 'team', SHARE, 'hello', REQUEST, () => alive);
    assert.equal(out.status, boundary === 'send' ? 'unconfirmed' : 'forbidden');
    assert.equal(r.mutations().length, boundary === 'send' ? 1 : 0);
    assert.equal(Object.hasOwn(out, 'delivery'), false);
  }
});

test('legacy send rejects wrong principal before any request and lost writes stay unconfirmed', async () => {
  const wrong = rig();
  assert.equal((await wrong.hub.send({ id: 'other-account' }, 'team', SHARE, 'hello', REQUEST)).status, 'forbidden');
  assert.equal(wrong.calls.length, 0);
  const lost = rig({ onRequest: c => { if (c.body?.op === 'send') throw new Error('connection lost after forwarding'); } });
  const out = await lost.hub.send(VIEWER, 'team', SHARE, 'hello', REQUEST);
  assert.equal(out.status, 'unconfirmed');
  assert.equal(lost.mutations().length, 1);
});

test('old host/hub top-level steer response cannot bypass filtered state history for act or legacy send', async () => {
  for (const legacy of [false, true]) {
    const safe = delivery({ mode: 'steer', response: '' });
    const current = state(legacy ? {} : { activeTurn: TURN, status: 'working' });
    const r = rig({ current, actionResult: { ok: true, status: 'acknowledged', delivery: { ...safe, response: 'PRIVATE pre-share output' }, state: { ...current, deliveries: [safe] } } });
    const out = legacy ? await r.hub.send(VIEWER, 'team', SHARE, 'hello', REQUEST)
      : await r.hub.act(VIEWER, 'team', SHARE, { operation: 'steer', generation: 4, turn: TURN, text: 'hello' }, REQUEST);
    assert.equal(out.status, 'acknowledged');
    assert.equal(out.delivery.response, '');
    assert.equal(JSON.stringify(out).includes('PRIVATE'), false);
  }
});

test('a top-level receipt without matching projected state is omitted for act and legacy send', async () => {
  for (const legacy of [false, true]) for (const returnedState of [undefined, state({ deliveries: [] })]) {
    const r = rig({ actionResult: { ok: true, status: 'acknowledged', delivery: delivery({ response: 'PRIVATE pre-share output' }), ...(returnedState ? { state: returnedState } : {}) } });
    const out = legacy ? await r.hub.send(VIEWER, 'team', SHARE, 'hello', REQUEST)
      : await r.hub.act(VIEWER, 'team', SHARE, { operation: 'send', generation: 4, turn: null, text: 'hello' }, REQUEST);
    assert.equal(out.status, 'acknowledged');
    assert.equal(Object.hasOwn(out, 'delivery'), false);
    assert.equal(JSON.stringify(out).includes('PRIVATE'), false);
  }
});
