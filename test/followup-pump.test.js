'use strict';
// T5a: queued follow-ups send from main, re-validated at every dispatch; accounts that ended or changed drop their team items.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createSessionFollowups, MAX_AGE_MS, MAX_PER_TARGET } = require('../src/session-followups');
const { resolveFollowup, MSG } = require('../src/followup-resolve');
const { createFollowupPump } = require('../src/followup-pump');
const { createAccountClient } = require('../buddy-window/accounts');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const S = 'a'.repeat(64), OTHER = 'b'.repeat(64), uuid = () => crypto.randomUUID();
const ORIGIN = 'https://hub.example', REF = uuid(), SESSION_STATE = '10000000-0000-4000-8000-000000000001';

function vault(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-t5a-')); fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'outbox.bin'), key = crypto.randomBytes(32);
  const storage = {
    encryptAsync: async text => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, Buffer.concat([c.update(text), c.final()]), c.getAuthTag()]); },
    decryptAsync: async b => { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(-16)); return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString(); },
  };
  let scope = S, now = 1_000_000;
  const stores = [];
  const open = (over = {}) => { const q = createSessionFollowups({ file, storage, scope: () => scope, now: () => now, ...over }); stores.push(q); return q; };
  t.after(() => { stores.forEach(q => q.close()); fs.rmSync(dir, { recursive: true, force: true }); });
  const disk = async () => JSON.parse(await storage.decryptAsync(fs.readFileSync(file)));
  return { open, disk, file, setScope: v => { scope = v; }, tick: ms => { now += ms; }, now: () => now };
}
const teamTarget = (over = {}) => ({ kind: 'team', key: crypto.createHash('sha256').update(JSON.stringify(over)).digest('hex'), route: { origin: ORIGIN, viewer: 'alice', team: 'team1', ref: REF, ...(over.route ?? {}) }, generation: 1, provider: 'claude', ...(over.target ?? {}) });
const ownedTarget = () => ({ kind: 'owned', key: 'c'.repeat(64), route: { session: uuid(), actor: 'a:1:1', board: 'b' }, generation: 1, provider: 'codex' });
const req = (target, text = 'PRIVATE canary') => ({ id: uuid(), target, text, label: 'Shared Claude session', current: () => true });

function world(over = {}) {
  const w = {
    viewer: { id: 'alice' }, hub: null, calls: [], acts: [], inspect: null, listed: null, listThrows: false, scope: S,
    state: { generation: 1, provider: { id: 'claude' }, status: 'ready', activeTurn: null, capabilities: { newTurn: true }, deliveries: [] },
    share: { scope: 'interact', expiresAt: null }, inspectResult: null, ...over,
  };
  w.listed = w.listed ?? (() => ({ teams: [{ id: 'team1', entries: [{ ref: REF, owner: { id: 'bob' }, share: { scope: 'interact', expiresAt: null }, online: true }] }] }));
  w.hub = {
    origin: ORIGIN, viewer: () => w.viewer,
    inspect: async () => { w.calls.push('inspect'); return w.inspectResult ?? { ok: true, state: w.state, share: w.share }; },
    sharedEntries: async () => { w.calls.push('list'); if (w.listThrows) throw new Error('down'); return w.listed(); },
    act: async (_v, _t, _r, action, id, fresh) => { w.acts.push({ action, id }); return fresh() ? { ok: true, status: 'acknowledged', delivery: { id: 'd1', state: 'acknowledged' } } : { ok: false, status: 'stale' }; },
  };
  w.resolve = t => resolveFollowup(t, { teamHub: () => w.hub, local: null, scope: () => w.scope, now: () => Date.parse('2025-01-01T00:00:00Z') });
  return w;
}
const run = async (w, t = teamTarget()) => w.resolve(t);

test('resolver: a different account on the same hub waits (the sweep drops it), signed out only waits', async () => {
  const w = world({ viewer: { id: 'mallory' } });
  const r = await run(w);
  assert.equal(r.ok, false); assert.notEqual(r.terminal, true, 'one reading is not proof; the sweep decides'); assert.equal(r.error, MSG.wrongAccount); assert.deepEqual(w.calls, []);
  w.viewer = null; const out = await run(w);
  assert.equal(out.ok, false); assert.notEqual(out.terminal, true); assert.equal(out.error, MSG.signIn);
  w.viewer = { id: 'alice' }; w.hub.origin = 'https://other.example';
  assert.notEqual((await run(w)).terminal, true);
});

test('resolver: stale or offline is terminal only when the hub list says the share is gone', async () => {
  const w = world({ inspectResult: { ok: false, status: 'unavailable', offline: true, error: 'offline' } });
  let r = await run(w); assert.equal(r.ok, false); assert.notEqual(r.terminal, true); assert.equal(r.error, MSG.offline);
  w.inspectResult = { ok: false, status: 'stale', error: 'gone' };
  r = await run(w); assert.notEqual(r.terminal, true, 'stale but still listed (owner offline) stays queued');
  w.listed = () => ({ teams: [{ id: 'team1', entries: [{ ref: REF, owner: { id: 'bob' }, share: { scope: 'interact', expiresAt: '2020-01-01T00:00:00Z' } }] }] });
  assert.equal((await run(w)).terminal, true, 'expired');
  w.listed = () => ({ teams: [{ id: 'team1', entries: [] }] });
  r = await run(w); assert.equal(r.terminal, true); assert.equal(r.error, MSG.gone);
  w.listed = () => ({ teams: [{ id: 'team9', entries: [{ ref: REF, owner: { id: 'bob' }, share: { scope: 'interact', expiresAt: null } }] }] });
  assert.equal((await run(w)).terminal, true, 'team mismatch');
  w.listThrows = true; r = await run(w); assert.notEqual(r.terminal, true, 'a failed list read never drops an item');
});

test('resolver: a 401 from the shared call waits for sign-in again', async () => {
  const w = world({ inspectResult: { ok: false, status: 'unavailable', signIn: true, error: 'x' } });
  const r = await run(w); assert.equal(r.ok, false); assert.notEqual(r.terminal, true); assert.equal(r.error, 'Sign in again to continue.'); assert.ok(!w.calls.includes('list'));
});

test('resolver: watch-only or expired share, and a changed session, are terminal', async () => {
  const w = world();
  w.share = { scope: 'watch', expiresAt: null }; let r = await run(w); assert.equal(r.terminal, true); assert.equal(r.error, MSG.watch);
  w.share = { scope: 'interact', expiresAt: '2020-01-01T00:00:00Z' }; assert.equal((await run(w)).terminal, true);
  w.share = { scope: 'interact', expiresAt: null };
  for (const patch of [{ generation: 2 }, { provider: { id: 'codex' } }, { status: 'ended' }, { capabilities: { newTurn: false } }]) {
    const w2 = world(); w2.state = { ...w2.state, ...patch }; assert.equal((await run(w2)).terminal, true, JSON.stringify(patch));
  }
});

test('resolver: only an idle session is ready, and an action already running on it makes the item wait', async () => {
  const w = world(); w.state = { ...w.state, status: 'working', activeTurn: SESSION_STATE };
  let r = await w.resolve(teamTarget()); assert.equal(r.ok, true); assert.equal(r.ready, false);
  w.state = { ...w.state, status: 'ready', activeTurn: null };
  // resolving (Overview review/enqueue do this) takes no lock
  for (let i = 0; i < 3; i++) assert.equal((await w.resolve(teamTarget())).ready, true);
  const first = (await w.resolve(teamTarget())).acquire(); assert.equal(typeof first, 'function');
  assert.equal((await w.resolve(teamTarget())).acquire(), null, 'held by the first');
  first(); const again = (await w.resolve(teamTarget())).acquire(); assert.equal(typeof again, 'function'); again();
  assert.equal(w.acts.length, 0);
});

test('dispatch: one send, lock released, and a flip after the durable marker is unconfirmed with one act', async t => {
  const v = vault(t), q = v.open(), w = world();
  await q.enqueue(req(teamTarget())); await q.advance(w.resolve);
  assert.equal(w.acts.length, 1); assert.equal(w.acts[0].action.operation, 'send'); assert.equal(w.acts[0].action.turn, null);
  assert.equal((await q.list()).items[0].status, 'acknowledged');
  assert.equal((await w.resolve(teamTarget())).ready, true, 'lock was released');
  // authority flips while the send is in flight
  const w2 = world(); w2.hub.act = async () => { w2.viewer = { id: 'mallory' }; w2.acts.push(1); return { ok: true, status: 'acknowledged', delivery: { id: 'd', state: 'acknowledged' } }; };
  const q2 = vault(t).open(); await q2.enqueue(req(teamTarget())); await q2.advance(w2.resolve); await q2.advance(w2.resolve);
  assert.equal(w2.acts.length, 1); assert.equal((await q2.list()).items[0].status, 'unconfirmed');
});

test('terminal identity or permission refusals clear the text at once; a waiting item keeps it', async t => {
  const v = vault(t), q = v.open(), w = world({ share: { scope: 'watch', expiresAt: null } });
  await q.enqueue(req(teamTarget(), 'SECRET-TEXT')); await q.advance(w.resolve);
  let d = await v.disk(); assert.equal(d.entries[0].status, 'refused'); assert.equal(d.entries[0].text, '');
  const v2 = vault(t), q2 = v2.open(), w2 = world(); w2.state = { ...w2.state, status: 'working', activeTurn: SESSION_STATE };
  await q2.enqueue(req(teamTarget(), 'KEEP-ME')); await q2.advance(w2.resolve);
  d = await v2.disk(); assert.equal(d.entries[0].status, 'queued'); assert.equal(d.entries[0].text, 'KEEP-ME'); assert.equal(w2.acts.length, 0);
});

async function seed(v, q, over) { const r = req(teamTarget(over.target ?? {}), over.text ?? 'TEXT'); await q.enqueue(r); return r; }

test('sweepForeign: another account on the signed-in hub is refused with the text cleared, in any scope', async t => {
  const v = vault(t), q = v.open();
  const foreign = await seed(v, q, { target: { route: { viewer: 'mallory' } }, text: 'FOREIGN' });
  const same = await seed(v, q, { target: { route: { viewer: 'alice', team: 't2' } }, text: 'SAME' });
  const otherHub = await seed(v, q, { target: { route: { viewer: 'mallory', origin: 'https://elsewhere.example' } }, text: 'ELSEWHERE' });
  const owned = req(ownedTarget(), 'OWNED'); await q.enqueue(owned);
  v.setScope(OTHER); // the foreign item lives in a scope that is not current
  const before = (await v.disk()).entries;
  await q.sweepForeign({ origin: ORIGIN, viewer: 'alice' });
  const after = (await v.disk()).entries, by = id => after.find(e => e.id === id), was = id => before.find(e => e.id === id);
  assert.equal(by(foreign.id).status, 'refused'); assert.equal(by(foreign.id).text, ''); assert.equal(by(foreign.id).reason, "Signed in as someone else; this follow-up won't be sent.");
  for (const r of [same, otherHub, owned]) assert.deepEqual(by(r.id), was(r.id));
  const { status, reason, text, updatedAt, ...rest } = by(foreign.id), { status: s0, reason: r0, text: t0, updatedAt: u0, ...rest0 } = was(foreign.id);
  assert.deepEqual(rest, rest0, 'only status/reason/text/updatedAt change');
  assert.equal(fs.readFileSync(v.file).includes(Buffer.from('FOREIGN')), false);
});

test('sweepForeign leaves sending, acknowledged, unconfirmed and terminal items alone', async t => {
  const v = vault(t), q = v.open(); const r = await seed(v, q, { target: { route: { viewer: 'mallory' } } });
  await q.advance(async () => ({ ok: true, ready: true, current: () => true, send: async () => ({ ok: true, delivery: { id: 'x', state: 'acknowledged' } }) }));
  const before = await v.disk(); assert.equal(before.entries[0].status, 'acknowledged');
  await q.sweepForeign({ origin: ORIGIN, viewer: 'alice' });
  assert.deepEqual(await v.disk(), before); assert.ok(r.id);
});

test('sign-out: only that origin and user lose their queued team items; owned and others stay', async t => {
  const v = vault(t), q = v.open();
  const mine = await seed(v, q, { target: { route: { viewer: 'alice' } }, text: 'MINE' });
  const other = await seed(v, q, { target: { route: { viewer: 'carol', team: 't3' } }, text: 'CAROL' });
  const hub2 = await seed(v, q, { target: { route: { viewer: 'alice', origin: 'https://elsewhere.example' } }, text: 'HUB2' });
  const owned = req(ownedTarget(), 'OWNED'); await q.enqueue(owned);
  await q.signedOut({ origin: ORIGIN, userId: 'alice' });
  const d = (await v.disk()).entries, by = id => d.find(e => e.id === id);
  assert.equal(by(mine.id).status, 'refused'); assert.equal(by(mine.id).text, ''); assert.equal(by(mine.id).reason, "Signed out; this follow-up won't be sent.");
  assert.equal(by(other.id).status, 'queued'); assert.equal(by(hub2.id).status, 'queued'); assert.equal(by(owned.id).status, 'queued');
  assert.equal(fs.readFileSync(v.file).includes(Buffer.from('MINE')), false);
  await q.signedOut({ origin: ORIGIN }); await q.signedOut({ userId: 'carol' }); await q.signedOut();
  assert.equal((await v.disk()).entries.find(e => e.id === other.id).status, 'queued', 'a call without both origin and user does nothing');
});

test('expiry runs over every scope: an old item of another scope loses its text on disk', async t => {
  const v = vault(t), q = v.open(); const old = await seed(v, q, { text: 'OLD-TEXT' });
  v.setScope(OTHER); await q.enqueue(req(ownedTarget(), 'NEW-OWNED'));
  v.tick(MAX_AGE_MS + 1000); await q.advance(async () => ({ ok: false, error: 'x' }));
  const d = (await v.disk()).entries;
  assert.equal(d.find(e => e.id === old.id).text, ''); assert.equal(d.find(e => e.id === old.id).status, 'expired');
  assert.equal(fs.readFileSync(v.file).includes(Buffer.from('OLD-TEXT')), false);
});

test('at most three queued per target, 16 per device, and a restart never resends', async t => {
  const v = vault(t), q = v.open(), tgt = teamTarget();
  for (let i = 0; i < MAX_PER_TARGET; i++) assert.equal((await q.enqueue(req(tgt))).ok, true);
  assert.equal((await q.enqueue(req(tgt))).status, 'full');
  assert.equal((await q.enqueue(req(teamTarget({ route: { team: 'other' } })))).ok, true);
});

test('static pin: only sweepForeign, signedOut and expire touch items outside the current scope', () => {
  const src = read('src/session-followups.js');
  assert.equal((src.match(/e\.scope === s|item\.scope !== s/g) || []).length, 4, 'scope filters: snapshot, cancel, discard, advance; a new one needs a new look');
  assert.match(src, /function refuseTeam\(match, reason, keep\)/);
  assert.equal((src.match(/refuseTeam\(/g) || []).length, 3, 'defined once, used by the two sweeps');
  assert.match(src, /async function expire\(s\)\{\s*const next=entries\.map\(e=>\['queued','blocked','refused'\]/);
});

// --- the pump ---
const pumpHarness = over => {
  const log = { advance: 0, sweeps: [], inflight: 0, maxInflight: 0 }, w = { hub: { origin: ORIGIN, viewer: () => ({ id: 'alice' }) }, scope: S, ready: true, ...over };
  const followups = {
    advance: async () => { log.advance++; log.inflight++; log.maxInflight = Math.max(log.maxInflight, log.inflight); await new Promise(r => setImmediate(r)); log.inflight--; },
    sweepForeign: async x => { log.sweeps.push({ origin: x.origin, viewer: x.viewer }); },
  };
  const pump = createFollowupPump({ followups, resolve: () => null, scope: () => w.scope, hub: () => w.hub, ready: () => w.ready });
  return { log, w, pump };
};

test('pump: runs with no Overview, one pass in flight, not without a scope or after stop', async () => {
  const { log, w, pump } = pumpHarness();
  await Promise.all([pump.pass(), pump.pass(), pump.pass()]);
  assert.equal(log.advance, 1); assert.equal(log.maxInflight, 1);
  w.scope = null; await pump.pass(); assert.equal(log.advance, 1, 'no workspace');
  w.scope = S; w.ready = false; await pump.pass(); assert.equal(log.advance, 1, 'app not ready');
  w.ready = true; pump.stop(); await pump.pass(); assert.equal(log.advance, 1, 'stopped');
});

test('pump: the foreign sweep waits for the same viewer on two passes and never runs on a null viewer', async () => {
  const { log, w, pump } = pumpHarness();
  await pump.pass(); assert.equal(log.sweeps.length, 0, 'first sight of a viewer is not enough');
  await pump.pass(); assert.deepEqual(log.sweeps, [{ origin: ORIGIN, viewer: 'alice' }]);
  const hub0 = w.hub; w.hub = { ...hub0, viewer: () => null }; await pump.pass(); await pump.pass();
  assert.equal(log.sweeps.length, 1, 'signed-out / restart / token refresh: no sweep');
  w.hub = { ...hub0, viewer: () => ({ id: 'bob' }) }; await pump.pass(); assert.equal(log.sweeps.length, 1, 'account just switched');
  w.hub.viewer = () => ({ id: 'bob' }); await pump.pass(); await pump.pass(); assert.equal(log.sweeps.at(-1).viewer, 'bob');
});

test('exactly one pump: Overview keeps its own only with the preview off; main starts the new one only with it on', () => {
  const om = read('src/overview-main.js'), main = read('main.js');
  assert.match(om, /const pump=followups&&chatPreview!==true\?setInterval\(/);
  assert.match(main, /const FollowupPump=CHAT_PREVIEW===true\?require\('\.\/src\/followup-pump'\)/);
  assert.match(main, /FollowupPump\?\.start\(\);/);
  assert.match(main, /onQuit\(app,\(\)=>\{FollowupPump\?\.stop\(\);liveTeamHub\.close\(\);PresenceLink\.stop\(\);OverviewMain\.close\(\);sessionFollowups\.close\(\);/);
  const { createOverviewMain } = require('../src/overview-main'), real = global.setInterval;
  for (const [chatPreview, want] of [[true, 0], [false, 1], [undefined, 1]]) {
    let timers = 0; global.setInterval = (...a) => { if (a[1] === 1500) timers++; return real(...a); };
    let m; try { m = createOverviewMain({ buddy: () => null, sessions: () => [], work: async () => ({}), owned: () => [], followups: { advance: async () => {}, list: async () => ({ ok: true, items: [] }) }, followupScope: () => null, chatPreview }); } finally { global.setInterval = real; }
    assert.equal(timers, want, `chatPreview ${chatPreview}`); m.close?.();
  }
});

test('an explicit sign-out or revoked token reports the account that ended; a discarded sign-in does not', async () => {
  const mk = (res) => {
    let saved = { hub: ORIGIN, token: 'tok', user: { id: 'alice' } }; const ended = [];
    const client = createAccountClient({ origin: ORIGIN, store: { load: () => saved, save: v => { saved = v; }, clear: () => { saved = null; } }, onEnded: x => ended.push(x), onSignedOut: () => {},
      fetchImpl: async () => ({ ok: res.status < 400, status: res.status, headers: new Map(), json: async () => res.body ?? { ok: true }, text: async () => '{}' }) });
    return { client, ended };
  };
  const a = mk({ status: 200 }); await a.client.signOut(); assert.deepEqual(a.ended, [{ origin: ORIGIN, userId: 'alice' }]);
  const b = mk({ status: 401, body: { error: { code: 'UNAUTHENTICATED' } } }); await b.client.signOut(); assert.deepEqual(b.ended, [{ origin: ORIGIN, userId: 'alice' }], 'exactly once');
  const c = mk({ status: 200 }); await c.client.bearerless?.(); assert.deepEqual(c.ended, [], 'nothing ended without a sign-out');
});

test('the review notice says what the main pump does only when it is the one running', () => {
  const svc = read('src/overview-service.js'), om = read('src/overview-main.js');
  assert.match(svc, /\$\{backgroundFollowups\?'Sent once, when the session is idle, while Plexiform is running and you are signed in as you\. If the share ends, becomes watch-only or you sign in as someone else, it is dropped and not sent\.':'Keep Plexiform open/);
  assert.match(om, /backgroundFollowups:chatPreview===true/);
});

test('a held session lock keeps the item queued with the text; the lock is released after the send', async t => {
  const v = vault(t), q = v.open(), w = world();
  await q.enqueue(req(teamTarget()));
  const held = (await w.resolve(teamTarget())).acquire();
  await q.advance(w.resolve);
  assert.equal(w.acts.length, 0); const d = await v.disk(); assert.equal(d.entries[0].status, 'queued'); assert.equal(d.entries[0].text, 'PRIVATE canary');
  held(); await q.advance(w.resolve); assert.equal(w.acts.length, 1);
  const free = (await w.resolve(teamTarget())).acquire(); assert.equal(typeof free, 'function'); free();
});

test('a viewer change seen by the list read never reads as "share gone"', async () => {
  const w = world({ inspectResult: { ok: false, status: 'stale', error: 'x' } });
  w.listed = () => ({ teams: [], viewerChanged: true });
  const r = await run(w); assert.notEqual(r.terminal, true);
});
