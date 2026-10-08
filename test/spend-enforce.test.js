const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const Enforce = require('../src/spend-enforce');
const Gate = require('../hooks/spend-gate');
const { registerAll } = require('../src/paid-wiring');

const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const ent = (plan) => ({
  plan: () => plan,
  has: (k) => (plan === 'free' ? k === 'costguard.receipt' : k.startsWith('costguard.')),
  limits: () => ({ receipt: plan === 'free' ? 'teaser' : 'full' }),
});
const exceeded = (over = {}) => ({
  budget: { level: 'exceeded', which: 'day', dayKey: 'Wed Oct 07 2026', weekKey: 'Mon Oct 05 2026', day: { spent: 12 }, week: { spent: 30 } },
  budgetText: '$12.00 of $10.00 today', runaway: [], ...over,
});
const runaway = (id = 'run-1') => ({ budget: { level: null }, runaway: [{ sessionId: id, cost: 44, burn: '$44.00 in 20 min', firedAt: 1 }] });

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// The real hook, as Claude Code runs it, against a throwaway data folder.
function hook(root, payload) {
  return execFileSync(process.execPath, [SET_STATUS, 'tool-use'], {
    env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: root, PLEXIFORM_NO_FAST: '1', TMUX: '', TMUX_PANE: '' },
    input: JSON.stringify({ session_id: 's-1', cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'ls' }, ...payload }),
    encoding: 'utf8',
  });
}

test('gateFor: an exceeded budget is a cap only with enforcement on; runaways only with stopping on', () => {
  const off = { enforceCaps: false, stopRunaways: false };
  assert.equal(Enforce.gateFor({ snapshot: exceeded(), settings: off }), null);
  const g = Enforce.gateFor({ snapshot: exceeded(), settings: { ...off, enforceCaps: true }, now: 5 });
  assert.match(g.cap, /budget cap reached \(\$12\.00 of \$10\.00 today\)/);
  assert.equal(g.at, 5);
  assert.equal(Enforce.gateFor({ snapshot: { budget: { level: 'warning' }, runaway: [] }, settings: { enforceCaps: true, stopRunaways: true } }), null);
  const r = Enforce.gateFor({ snapshot: runaway(), settings: { ...off, stopRunaways: true } });
  assert.equal(r.cap, null);
  assert.match(r.sessions['run-1'], /runaway session \(\$44\.00 in 20 min\)/);
  assert.equal(Enforce.gateFor({ snapshot: null, settings: { enforceCaps: true, stopRunaways: true } }), null);
});

test('enforce on and over budget: the real PreToolUse hook answers deny with the reason', (t) => {
  const root = home(t);
  Enforce.saveSettings(root, { enforceCaps: true });
  const e = Enforce.createEnforcer({ rootDir: root, entitlements: ent('plus'), spend: () => exceeded() });
  assert.ok(e.tick().cap);
  const out = JSON.parse(hook(root));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Plexiform budget cap reached/);
  // a question to the person is never refused
  assert.equal(hook(root, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }).trim(), '');
  // the cap episode is logged once for the receipt
  e.tick();
  assert.deepEqual(Enforce.readLog(root).map((x) => x.kind), ['cap']);
  assert.equal(fs.statSync(path.join(root, Gate.GATE_FILE)).mode & 0o777, 0o600);
});

test('free plan: no gate, whatever the saved settings say', (t) => {
  const root = home(t);
  Enforce.saveSettings(root, { enforceCaps: true, stopRunaways: true });
  const e = Enforce.createEnforcer({ rootDir: root, entitlements: ent('free'), spend: () => exceeded() });
  assert.equal(e.tick(), null);
  assert.equal(fs.existsSync(path.join(root, Gate.GATE_FILE)), false);
  assert.equal(hook(root).trim(), '');
});

test('fail-open: the spend read crashing removes the gate, and the hook allows', (t) => {
  const root = home(t);
  Enforce.saveSettings(root, { enforceCaps: true });
  let crash = false;
  const logs = [];
  const e = Enforce.createEnforcer({ rootDir: root, entitlements: ent('plus'), spend: () => { if (crash) throw new Error('spend worker died'); return exceeded(); }, log: (m) => logs.push(m) });
  e.tick();
  assert.ok(fs.existsSync(path.join(root, Gate.GATE_FILE)));
  crash = true;
  assert.equal(e.tick(), null);
  assert.equal(fs.existsSync(path.join(root, Gate.GATE_FILE)), false);
  assert.match(logs.join('\n'), /spend worker died/);
  assert.equal(hook(root).trim(), '');
});

test('fail-open: a stale, future-dated, corrupt or wrong-version gate allows', (t) => {
  const root = home(t);
  const file = path.join(root, Gate.GATE_FILE);
  const now = Date.now();
  const write = (g) => fs.writeFileSync(file, typeof g === 'string' ? g : JSON.stringify(g));
  const decide = () => Gate.decide({ rootDir: root, sessionId: 's-1', tool: 'Bash', now });
  write({ v: 1, at: now, ttlMs: 60000, cap: 'over', sessions: {} });
  assert.ok(decide());
  write({ v: 1, at: now - 61000, ttlMs: 60000, cap: 'over' });
  assert.equal(decide(), null, 'stale: the app stopped vouching for it');
  write({ v: 1, at: now - 10 * 60000, ttlMs: 1e9, cap: 'over' });
  assert.equal(decide(), null, 'a huge ttl is clamped');
  write({ v: 1, at: now + 10 * 60000, ttlMs: 60000, cap: 'over' });
  assert.equal(decide(), null, 'future-dated');
  write('{nope');
  assert.equal(decide(), null);
  write({ v: 2, at: now, ttlMs: 60000, cap: 'over' });
  assert.equal(decide(), null);
  write({ v: 1, at: now, ttlMs: 60000, cap: null, sessions: { 'other': 'x' } });
  assert.equal(decide(), null, 'another session is held, not this one');
  assert.equal(Gate.decide({ rootDir: root, sessionId: 'other', tool: 'Bash', now }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(Gate.decide({ rootDir: root, sessionId: '__proto__', tool: 'Bash', now }), null);
  assert.equal(Gate.decide({ rootDir: null }), null);
  assert.equal(Gate.decide({ rootDir: root, readFileSync: () => { throw new Error('EIO'); } }), null);
});

test('runaway stopping: the session is held and a registered stopper is called once per episode', async (t) => {
  const root = home(t);
  Enforce.saveSettings(root, { stopRunaways: true });
  let stops = 0;
  const stoppers = new Map([['run-1', async () => { stops += 1; }]]);
  const e = Enforce.createEnforcer({ rootDir: root, entitlements: ent('plus'), spend: () => runaway(), stoppers: () => stoppers });
  e.tick(); e.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(stops, 1);
  assert.deepEqual(Enforce.readLog(root).map((x) => [x.kind, x.sessionId, x.cost, x.stopped]), [['runaway', 'run-1', 44, true]]);
  assert.equal(Gate.decide({ rootDir: root, sessionId: 'run-1', tool: 'Bash' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(Gate.decide({ rootDir: root, sessionId: 'calm', tool: 'Bash' }), null);
});

test('an owned Claude session registers a stopper that interrupts its running turn, and only while it runs', async () => {
  const stoppers = new Map([['someone-else', () => 'theirs']]);
  const mine = new Set();
  const calls = [];
  const state = { session: '11111111-1111-4111-8111-111111111111', generation: 3, ownership: 'plexiform-owned', provider: { id: 'claude' }, status: 'working', activeTurn: '22222222-2222-4222-8222-222222222222' };
  let rows = [{ state, nativeSessionId: 'native-1' }, { state: { ...state, provider: { id: 'codex' } }, nativeSessionId: 'native-codex' }, { state: { ...state, ownership: 'existing-unmanaged' }, nativeSessionId: 'native-x' }, { state, nativeSessionId: 'someone-else' }];
  const owned = { list: () => rows, target: (s) => ({ actor: 'overview:1:1', hub: { interrupt: async (req, actor) => { calls.push([req, actor, s]); return { ok: true }; } } }) };
  Enforce.syncOwnedStoppers(stoppers, owned, mine);
  assert.deepEqual([...stoppers.keys()].sort(), ['native-1', 'someone-else']);
  assert.equal(stoppers.get('someone-else')(), 'theirs');
  await stoppers.get('native-1')();
  assert.deepEqual(calls, [[{ session: state.session, generation: 3, turn: state.activeTurn }, 'overview:1:1', state.session]]);
  rows = [{ state: { ...state, status: 'ready', activeTurn: null }, nativeSessionId: 'native-1' }];
  Enforce.syncOwnedStoppers(stoppers, owned, mine);
  assert.deepEqual([...stoppers.keys()], ['someone-else']);
  // a refused interrupt is an error the notification logs
  rows = [{ state, nativeSessionId: 'native-1' }];
  Enforce.syncOwnedStoppers(stoppers, { ...owned, target: () => ({ actor: 'a', hub: { interrupt: async () => ({ ok: false, error: 'stale' }) } }) }, mine);
  await assert.rejects(stoppers.get('native-1')(), /stale/);
});

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn) };
}

test('register: Usage page only; free gets the receipt teaser and no waste or enforcement', async (t) => {
  const root = home(t);
  const ipcMain = fakeIpc();
  const quits = [];
  const ctx = { rootDir: root, ipcMain, entitlements: ent('free'), fromPage: (e, id) => e.page === id, onQuit: (fn) => quits.push(fn), log: () => {}, usageTurns: async () => [] };
  const { report } = Enforce.register(ctx);
  t.after(() => quits.forEach((fn) => fn()));
  assert.ok(report);
  const get = ipcMain.handlers.get('cost-guard:report');
  const set = ipcMain.handlers.get('cost-guard:set');
  assert.equal(await get({ page: 'settings' }), null);
  const r = await get({ page: 'usage' });
  assert.equal(r.plan, 'free');
  assert.equal(r.enforce.available, false);
  assert.equal(r.waste, null);
  assert.equal(r.receipt.teaser, true);
  assert.match((await set({ page: 'usage' }, { enforceCaps: true })).error, /Plus/);
  assert.equal(Enforce.readSettings(root).enforceCaps, false);
  assert.equal(await set({ page: 'widget' }, { enforceCaps: true }), null);
});

test('register: Plus gets waste, the full receipt and the switches', async (t) => {
  const root = home(t);
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects);
  // A throwaway HOME too: the receipt's Burst check must not find a real Burst.
  const prev = { CLAUDE_TRAFFIC_LIGHT_PROJECTS: process.env.CLAUDE_TRAFFIC_LIGHT_PROJECTS, HOME: process.env.HOME };
  process.env.CLAUDE_TRAFFIC_LIGHT_PROJECTS = projects;
  process.env.HOME = root;
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const ipcMain = fakeIpc();
  const quits = [];
  Enforce.register({ rootDir: root, ipcMain, entitlements: ent('plus'), fromPage: (e, id) => e.page === id, onQuit: (fn) => quits.push(fn), log: () => {}, spend: () => exceeded() });
  t.after(() => quits.forEach((fn) => fn()));
  const set = await ipcMain.handlers.get('cost-guard:set')({ page: 'usage' }, { enforceCaps: true, stopRunaways: 'yes' });
  assert.deepEqual(set.settings, { enforceCaps: true, stopRunaways: false });
  assert.ok(fs.existsSync(path.join(root, Gate.GATE_FILE)), 'turning it on applies at once');
  const r = await ipcMain.handlers.get('cost-guard:report')({ page: 'usage' });
  assert.equal(r.enforce.available, true);
  assert.equal(r.enforce.capActive, true);
  assert.equal(r.waste.days, 7);
  assert.deepEqual(r.waste.findings, []);
  assert.equal(r.receipt.teaser, false);
  quits.forEach((fn) => fn());
  assert.equal(fs.existsSync(path.join(root, Gate.GATE_FILE)), false, 'quitting removes the gate');
});

test('paid-wiring finds the cost guard and registers it', (t) => {
  const root = home(t);
  const quits = [];
  const out = registerAll({ rootDir: root, ipcMain: fakeIpc(), entitlements: ent('free'), fromPage: () => false, onQuit: (fn) => quits.push(fn), log: () => {} });
  t.after(() => quits.forEach((fn) => fn()));
  assert.deepEqual(out.find((x) => x.name === 'cost-guard'), { name: 'cost-guard', status: 'ok' });
});
