'use strict';
// T4b (plan-t4b Rev 1 + B-S1): who sent each message (and a steer), and who stopped a turn.
// The host stamp (session-interaction interrupt `by`, from remote-interaction's own share record), the projections
// (shared-thread-view deliveriesOf, team-hub-client's grantee rebuild) and both thread renderers.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { createInteractionHub } = require('../src/session-interaction');
const { createRemoteInteractionHost } = require('../src/remote-interaction');
const { createTeamHubClient } = require('../src/team-hub-client');
const SharedView = require('../src/shared-thread-view');
const OwnedView = require('../src/owned-thread-view');

const ACTOR = 'overview:1:1';
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// A provider whose turns the test drives; interrupt can be held open.
function memAdapter() {
  const ee = new EventEmitter(); let n = 0, sends = 0;
  const a = {
    label: 'Mem', hold: null, fail: false, interrupts: [],
    capabilities: { newTurn: true, steer: true, interrupt: true, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: false },
    emit: (e) => ee.emit('e', e),
    open: async () => ({ target: `target-${++n}` }),
    async send(x) { return x.expectedTurnId ? { turnId: x.expectedTurnId, mode: 'steer' } : { turnId: `turn-${++sends}`, mode: 'new-turn' }; },
    async interrupt(x) { a.interrupts.push(x); if (a.hold) await a.hold; if (a.fail) throw new Error('provider said no'); return true; },
    alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
  return a;
}
async function hubRig() {
  const adapter = memAdapter();
  const hub = createInteractionHub({ adapters: { mem: adapter }, boardCurrent: (b) => b === null });
  const s = (await hub.launch({ provider: 'mem' }, ACTOR)).state;
  const base = { session: s.session, generation: s.generation };
  const state = () => hub.state({ session: s.session }, ACTOR);
  // Start a turn with a message (and optionally a teammate's `by`); returns its public turn tag.
  async function start(text = 'go', by = null) {
    await hub.send({ ...base, text }, ACTOR, by ? { by } : undefined);
    const id = `turn-${state().deliveries.filter((d) => d.mode === 'new-turn').length}`;
    adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: id });
    await flush();
    return { id, tag: state().activeTurn };
  }
  const end = (id, status = 'interrupted') => adapter.emit({ kind: 'turn-completed', target: 'target-1', turnId: id, status });
  return { hub, adapter, base, state, start, end, stop: (tag, by) => hub.interrupt({ ...base, turn: tag }, ACTOR, by === undefined ? undefined : { by }) };
}

// ── host: session-interaction ───────────────────────────────────────────
test('host: a stop names who asked once the turn is interrupted, on its new-turn delivery only; the owner\'s own stop names no one', async () => {
  const x = await hubRig();
  try {
    const t = await x.start('first');
    await x.hub.send({ ...x.base, text: 'more', expectedTurn: t.tag }, ACTOR, { by: 'Alex' });
    assert.equal((await x.stop(t.tag, 'Alex')).status, 'interrupt-requested');
    assert.deepEqual(x.state().deliveries.map((d) => d.stoppedBy), [null, null], 'not before the provider says interrupted');
    x.end(t.id); await flush();
    const [first, steer] = x.state().deliveries;
    assert.equal(first.stoppedBy, 'Alex');
    assert.equal(steer.mode, 'steer'); assert.equal(steer.by, 'Alex');
    assert.equal(steer.stoppedBy, null, 'one line per turn');
    // The owner's stop (Overview IPC: no by).
    const u = await x.start('second');
    await x.stop(u.tag); x.end(u.id); await flush();
    assert.equal(x.state().deliveries.at(-1).stoppedBy, null);
    // A teammate then the owner, both while it runs: the last one wins.
    const v = await x.start('third');
    await x.stop(v.tag, 'Alex'); await x.stop(v.tag); x.end(v.id); await flush();
    assert.equal(x.state().deliveries.at(-1).stoppedBy, null);
  } finally { x.hub.stopAll(); }
});

test('host: no claim for a stop that failed, a turn that completed anyway, a name over 80, or `by` in the request', async () => {
  const x = await hubRig();
  try {
    const t = await x.start();
    x.adapter.fail = true;
    assert.equal((await x.stop(t.tag, 'Alex')).status, 'unavailable');
    x.adapter.fail = false;
    x.end(t.id); await flush();
    assert.equal(x.state().deliveries[0].stoppedBy, null, 'the failed request put back what was there');
    const u = await x.start();
    await x.stop(u.tag, 'Alex'); x.end(u.id, 'completed'); await flush();
    assert.equal(x.state().deliveries.at(-1).stoppedBy, null, 'it finished on its own: no one stopped it');
    const v = await x.start();
    await x.stop(v.tag, 'A'.repeat(81)); x.end(v.id); await flush();
    assert.equal(x.state().deliveries.at(-1).stoppedBy, null);
    const w = await x.start();
    assert.equal((await x.hub.interrupt({ ...x.base, turn: w.tag, by: 'Mallory' }, ACTOR)).status, 'invalid', 'a request never names the stopper');
  } finally { x.hub.stopAll(); }
});

test('host (B-S1): the stamp lands on the turn the call captured, even if it ended and another started before the provider answered', async () => {
  const x = await hubRig();
  try {
    const t = await x.start('old');
    let release; x.adapter.hold = new Promise((r) => { release = r; });
    const asked = x.stop(t.tag, 'Alex');
    await flush();
    x.end(t.id); await flush();
    const u = await x.start('new');
    release(); assert.equal((await asked).status, 'interrupt-requested');
    x.adapter.hold = null;
    x.end(u.id); await flush();
    const [oldD, newD] = x.state().deliveries;
    assert.equal(oldD.stoppedBy, 'Alex', 'its interrupted can arrive before the answer');
    assert.equal(newD.stoppedBy, null, 'the new turn is never stamped');
  } finally { x.hub.stopAll(); }
});

// ── host: a teammate's stop through the relay, stamped from the share record ──
const USER = 'u-owner';
async function ownerHost() {
  const adapter = memAdapter();
  const shares = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    let body = {};
    if (u.pathname === '/api/interaction/v1/shares' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      const s = { id: crypto.randomUUID(), session: b.session, team: { id: b.team, name: 'Design' }, scope: b.scope, owner: { name: 'Owner' }, members: [{ id: 'u-alex', name: 'Alex', role: 'member' }] };
      shares.push(s); body = { share: s };
    } else if (u.pathname === '/api/interaction/v1/shares') body = { teams: [{ id: 'team-1', name: 'Design' }], shares };
    else body = { ok: true };
    return { status: 200, ok: true, json: async () => body };
  };
  class WS extends EventEmitter { constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'relay.welcome', user: USER, device: 'd-1', resume: 'r-1' })), false)); } send() {} close() {} }
  const host = createRemoteInteractionHost({ userId: USER, adapters: { mem: adapter }, boardCurrent: (b) => b === null });
  await host.enable({ baseUrl: 'https://hub.example', token: 'tok', WebSocket: WS, fetch });
  const own = (op, args) => host.handle({ type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: USER, from: 'phone', op, args });
  const s = (await own('launch', { provider: 'mem' })).state;
  const made = await host.shareSession({ session: s.session, team: 'team-1', scope: 'interact' });
  assert.equal(made.ok, true, JSON.stringify(made));
  const teammate = (op, args, name = 'Someone else entirely') => host.handle({ type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: USER, from: 'hub', op, args,
    share: { id: made.share.id, team: 'team-1', user: 'u-alex', name, scope: 'interact' } });
  return { host, adapter, s, own, teammate };
}
test('relay: a teammate\'s stop is stamped with their name from this host\'s share record (never the frame\'s), and they see it', async () => {
  const x = await ownerHost();
  try {
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await x.teammate('send', { session: x.s.session, generation: x.s.generation, text: 'please stop soon' })).ok, true);
    x.adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: 'turn-1' }); await flush();
    const tag = (await x.own('state', { session: x.s.session })).state.activeTurn;
    const out = await x.teammate('interrupt', { session: x.s.session, generation: x.s.generation, turn: tag }, 'Mallory');
    assert.equal(out.status, 'interrupt-requested', JSON.stringify(out));
    x.adapter.emit({ kind: 'turn-completed', target: 'target-1', turnId: 'turn-1', status: 'interrupted' }); await flush();
    const mine = (await x.own('state', { session: x.s.session })).state.deliveries[0];
    assert.deepEqual([mine.by, mine.stoppedBy], ['Alex', 'Alex']);
    const theirs = (await x.teammate('state', { session: x.s.session })).state.deliveries[0];
    assert.equal(theirs.stoppedBy, 'Alex');
    assert.ok(!JSON.stringify(theirs).includes('Mallory'));
  } finally { x.host.close(); }
});

// ── projections ─────────────────────────────────────────────────────────
test('views: deliveriesOf carries mode (send|steer) and a cleaned, bounded stoppedBy; the grantee client keeps it; an older host sends none', async () => {
  assert.deepEqual([...SharedView.DELIVERY_KEYS ?? []].sort(), ['at', 'by', 'id', 'mode', 'response', 'state', 'stoppedBy', 'text'].sort());
  const [a, b, c] = SharedView.deliveriesOf({ deliveries: [
    { id: 'a', text: 't', by: 'Alex', mode: 'new-turn', state: 'interrupted', stoppedBy: 'Al‮ex\u0007', sentAt: 1 },
    { id: 'b', text: 't', by: 'Alex', mode: 'steer', state: 'completed', stoppedBy: 7, sentAt: 2 },
    { id: 'c', text: 't', mode: 'bogus', state: 'interrupted', stoppedBy: 'Z'.repeat(200), sentAt: 3 }] });
  assert.deepEqual([a.mode, a.stoppedBy], ['send', 'Alex']);
  assert.deepEqual([b.mode, b.stoppedBy], ['steer', null]);
  assert.deepEqual([c.mode, c.stoppedBy.length], ['send', 80]);
  assert.deepEqual(Object.keys(OwnedView.project({ state: { deliveries: [{ id: 'a', stoppedBy: 'Alex', mode: 'steer' }] }, now: 0 }).deliveries[0]).sort(), ['at', 'by', 'id', 'mode', 'response', 'state', 'stoppedBy', 'text'].sort());
  // The grantee's own app rebuilds each delivery from fixed keys.
  const SHARE = '11111111-2222-4333-8444-555555555555', SESSION = '10000000-0000-4000-8000-000000000001', TURN = '20000000-0000-4000-8000-000000000001', AT = 1_800_000_000_000;
  const d = (over) => ({ id: '40000000-0000-4000-8000-000000000001', text: 'hello', by: 'Alex', mode: 'new-turn', state: 'interrupted', turn: TURN, response: '', notices: [], sentAt: AT - 1, ...over });
  const read = async (dl) => {
    const st = { session: SESSION, generation: 4, activeTurn: null, status: 'ready', provider: { id: 'codex', label: 'Codex' }, capabilities: {}, deliveries: [dl] };
    const hub = createTeamHubClient({ baseUrl: 'https://hub.test', token: () => 't', viewer: { id: 'alice', name: 'Alice' }, fetch: async (url, init) => {
      const body = url.endsWith('/shared') ? { shared: [{ id: SHARE, session: SESSION, scope: 'interact', expires_at: null, team: { id: 'team', name: 'Team' }, owner: { id: 'bob', name: 'Bob' }, online: true }] } : { result: { ok: true, state: st } };
      void init; return { status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) };
    } }, { now: () => AT });
    return (await hub.inspect({ id: 'alice', name: 'Alice' }, 'team', SHARE)).state.deliveries[0];
  };
  assert.equal((await read(d({ stoppedBy: 'Alex' }))).stoppedBy, 'Alex');
  assert.equal((await read(d({}))).stoppedBy, null, 'an older host: none');
  assert.equal((await read(d({ stoppedBy: 'Q'.repeat(300) }))).stoppedBy.length, 80);
});

// ── renderers ───────────────────────────────────────────────────────────
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
function render(file, start, v) {
  const dom = new JSDOM(read('thread.html').replace(/<script[^]*?<\/script>/g, ''), { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.eval(read(file));
  start(w, v);
  return w;
}
const deliveries = [
  { id: 'a', by: 'Alex', mode: 'send', text: 'Try the <b>retry</b> path', state: 'interrupted', response: '', stoppedBy: 'Alex', at: 1 },
  { id: 'b', by: null, mode: 'steer', text: 'Also log it', state: 'completed', response: '', stoppedBy: null, at: 2 },
  { id: 'c', by: 'Sam', mode: 'steer', text: 'and <img src=x onerror=1>', state: 'interrupted', response: '', stoppedBy: '<i>Sam</i>', at: 3 },
];
test('renderers: the owner thread says "(teammate)", " · steer" and "‹name› stopped this turn."; the grantee thread the same without "(teammate)"; text only', async () => {
  const owned = { header: { title: 'T', provider: 'Codex', channel: false }, activity: { category: null, ageMs: null, stale: false }, deliveries, status: 'ready' };
  const w = render('thread-owned.js', () => {}, null);
  const s = render('thread-shared.js', () => {}, null);
  try {
  const api = { ownedState: async () => owned, openOverview: async () => true };
  w.ThreadOwned.start(api, 'a'.repeat(64)); await new Promise((r) => setTimeout(r, 20));
  const by = [...w.document.querySelectorAll('.th-msg-by')].map((n) => n.textContent);
  assert.deepEqual(by, ['Sent by Alex (teammate)', 'Sent from Overview · steer', 'Sent by Sam (teammate) · steer']);
  const notes = [...w.document.querySelectorAll('.th-msg-note')].map((n) => n.textContent);
  assert.deepEqual(notes, ['Alex stopped this turn.', '<i>Sam</i> stopped this turn.']);
  assert.equal(w.document.querySelector('.th-msgs i, .th-msgs img, .th-msgs b'), null);
  const shared = SharedView.project({ state: { status: 'ready', generation: 1, provider: { label: 'Codex' }, deliveries: deliveries.map((d) => ({ ...d, mode: d.mode === 'steer' ? 'steer' : 'new-turn', sentAt: d.at })) }, share: { scope: 'watch', expiresAt: null }, route: { ownerName: 'Bob' }, now: 0 });
  s.ThreadShared.start({ sharedState: async () => shared, sharedPainted: async () => true, sharedProposals: async () => null, openTeam: async () => true }, 'a'.repeat(64)); await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([...s.document.querySelectorAll('.th-msgs .th-msg-by')].map((n) => n.textContent), ['Sent by Alex', 'Sent through this share · steer', 'Sent by Sam · steer']);
  assert.deepEqual([...s.document.querySelectorAll('.th-msgs .th-msg-note')].map((n) => n.textContent), ['Alex stopped this turn.', '<i>Sam</i> stopped this turn.']);
  assert.equal(s.document.querySelector('.th-msgs i, .th-msgs img, .th-msgs b'), null);
  } finally { w.close(); s.close(); }
});
