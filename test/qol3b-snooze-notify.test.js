'use strict';
// QoL3b: snooze one session's alerts (src/session-snooze.js), and notifications that act (src/notify-actions.js):
// the store and its bounds, what a snooze holds (Q3-M2: never a remote session's sound), the card and its IPC,
// the click that is never silent, the buttons and their index (S3), and main's wiring (Q3-M1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const S = require('../src/session-snooze.js');
const N = require('../src/notify-actions.js');
const V = require('../src/session-card-view.js');
const Cards = require('../src/widget-cards-main.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NOW = Date.parse('2026-11-06T12:00:00Z');
const MIN = 60000;

// ── the store ──────────────────────────────────────────────────────────────
test('snoozedUntil honours only a finite end within the next 61 minutes', () => {
  const m = { a: NOW + 30 * MIN, old: NOW - 1, far: NOW + 62 * MIN, junk: 'soon', inf: Infinity, nan: NaN };
  assert.equal(S.snoozedUntil(m, 'a', NOW), NOW + 30 * MIN);
  for (const id of ['old', 'far', 'junk', 'inf', 'nan', 'missing']) assert.equal(S.snoozedUntil(m, id, NOW), 0, id);
  assert.equal(S.snoozedUntil(m, '../a', NOW), 0, 'a bad id never matches');
  assert.equal(S.snoozedUntil(null, 'a', NOW), 0);
  assert.equal(S.snoozedUntil([NOW + MIN], '0', NOW), 0, 'an array is not a map');
  assert.equal(S.snoozedUntil(Object.create({ a: NOW + MIN }), 'a', NOW), 0, 'inherited keys never count');
});

test('withSnooze drops expired and junk entries, removes on 0, refuses far-future, keeps the 32 latest ends', () => {
  assert.deepEqual(S.withSnooze({ a: NOW - 1, b: 'x', c: NOW + MIN }, 'd', NOW + 15 * MIN, NOW), { d: NOW + 15 * MIN, c: NOW + MIN });
  assert.deepEqual(S.withSnooze({ c: NOW + MIN }, 'c', 0, NOW), {});
  assert.deepEqual(S.withSnooze({}, 'c', NOW + 2 * 60 * MIN, NOW), {}, 'never more than 61 minutes ahead');
  const many = {};
  for (let i = 0; i < 40; i += 1) many[`s${i}`] = NOW + (i + 1) * 1000;
  const out = S.withSnooze(many, null, 0, NOW);
  assert.equal(Object.keys(out).length, S.CAP);
  assert.ok(!('s0' in out) && 's39' in out, 'the soonest ends go first');
});

test('the store: 15 minutes, an hour, off; a bad id or length does nothing; the file holds only ids and ends', () => {
  let t = NOW; let file = { v: 1, snoozes: { keep: NOW + 5 * MIN, stale: NOW - 1 } }; const writes = [];
  const st = S.createStore({ read: () => file, write: (o) => { writes.push(o); file = o; }, now: () => t });
  assert.equal(st.until('keep'), NOW + 5 * MIN, 'read lazily from the file');
  assert.equal(st.until('stale'), 0);
  assert.equal(st.set('s1', '15m'), NOW + 15 * MIN);
  assert.equal(st.set('s2', '1h'), NOW + 60 * MIN);
  assert.equal(st.set('s1', 'off'), 0);
  assert.equal(st.until('s1'), 0);
  assert.equal(st.set('s3', '2h'), 0, 'only the two lengths');
  assert.equal(st.set('../x', '1h'), 0);
  assert.equal(st.set({}, '1h'), 0);
  assert.deepEqual(writes.at(-1), { v: 1, snoozes: { s2: NOW + 60 * MIN, keep: NOW + 5 * MIN } });
  t += 61 * MIN;
  assert.equal(st.until('s2'), 0, 'it ends by itself');
});

test('the store: an unreadable file starts empty; a failed write still holds for this run', () => {
  const st = S.createStore({ read: () => { throw new Error('ENOENT'); }, write: () => { throw new Error('EROFS'); }, now: () => NOW });
  assert.equal(st.until('s1'), 0);
  assert.equal(st.set('s1', '1h'), NOW + 60 * MIN);
  assert.equal(st.until('s1'), NOW + 60 * MIN);
  const junk = S.createStore({ read: () => ({ snoozes: [1, 2] }), write() {}, now: () => NOW });
  assert.deepEqual(junk.map(), {});
});

// ── what a snooze holds ────────────────────────────────────────────────────
const RULE = { id: 'r1', when: { signal: ['permission-ask', 'stop'] } };
const snoozed = new Set(['a', 'b']);
const quiet = (s) => snoozed.has(s.sessionId);
test('Q3-M2: the sound is held only when every session feeding its rule is local and snoozed or muted', () => {
  const local = (id, signal = 'permission-ask') => ({ sessionId: id, signal, cwd: '/p' });
  assert.equal(S.soundHeld({ rule: RULE, sessions: [local('a'), local('b', 'stop'), local('c', 'tool-use')], quiet }), true, 'a working session does not feed the rule');
  assert.equal(S.soundHeld({ rule: RULE, sessions: [local('a'), local('c')], quiet }), false, 'one waiting session is not snoozed');
  assert.equal(S.soundHeld({ rule: RULE, sessions: [local('a'), { sessionId: 'r', signal: 'permission-ask', remote: true, deviceName: 'Studio' }], quiet: () => true }), false, 'local snoozed + remote waiting: plays');
  assert.equal(S.soundHeld({ rule: RULE, sessions: [local('a'), { sessionId: 'p', signal: 'stop', device: 'pair-1' }], quiet: () => true }), false, 'a paired device feeds it: plays');
  assert.equal(S.soundHeld({ rule: RULE, sessions: [local('a'), { sessionId: 't', signal: 'stop', teammate: { name: 'Alex' } }], quiet: () => true }), false, "a teammate's row: plays");
  assert.equal(S.soundHeld({ rule: RULE, sessions: [local('a'), local('x')], quiet: () => true, isRemote: (s) => s.sessionId === 'x' }), false, "main's host check counts too");
  assert.equal(S.soundHeld({ rule: RULE, sessions: [local('c', 'tool-use')], quiet }), false, 'nobody feeds it: nothing to hold');
  assert.equal(S.soundHeld({ rule: null, sessions: [local('a')], quiet }), false);
  assert.equal(S.soundHeld({ rule: { when: { signal: ['permission-ask', 'ci-failed'] } }, sessions: [local('a')], quiet, gitSignals: ['ci-failed'] }), false, "a GitHub rule's sound is never held");
});

test('a notification for a snoozed local session is held; a remote one or one without a session never is', () => {
  const until = (id) => (id === 'a' ? NOW + MIN : 0);
  assert.equal(S.notificationHeld({ sessionId: 'a', session: { sessionId: 'a' } }, until), true);
  assert.equal(S.notificationHeld({ sessionId: 'a', session: null }, until), true);
  assert.equal(S.notificationHeld({ sessionId: 'b', session: { sessionId: 'b' } }, until), false);
  assert.equal(S.notificationHeld({ sessionId: 'a', session: { sessionId: 'a', remote: true } }, until), false);
  assert.equal(S.notificationHeld({ sessionId: 'remote:a' }, () => NOW + MIN), false);
  assert.equal(S.notificationHeld({ kind: 'offline' }, () => NOW + MIN), false);
});

// ── the card and its IPC ───────────────────────────────────────────────────
test('card: your own sessions offer Snooze, a snoozed one says so and offers Unsnooze; never a teammate or another device', () => {
  const own = V.sessionCard({ sessionId: 's1', cwd: '/p', signal: 'permission-ask', signalSince: new Date(NOW - 4 * MIN).toISOString() }, { now: NOW });
  assert.ok(own.actions.includes('snooze') && !own.actions.includes('unsnooze'));
  const held = V.sessionCard({ sessionId: 's1', cwd: '/p', signal: 'permission-ask', signalSince: new Date(NOW - 4 * MIN).toISOString() }, { now: NOW, snoozedUntil: NOW + 42 * MIN });
  assert.ok(held.actions.includes('unsnooze') && !held.actions.includes('snooze'));
  assert.match(held.state, / · alerts snoozed, 42m left$/);
  const mate = V.sessionCard({ sessionId: 't1', signal: 'stop' }, { now: NOW, teammate: { name: 'Alex' }, snoozedUntil: NOW + MIN });
  assert.ok(!mate.actions.some((a) => /snooze/.test(a)) && !/snoozed/.test(mate.state));
  const away = V.sessionCard({ sessionId: 'r1', signal: 'stop', remote: true, deviceName: 'Studio' }, { now: NOW, snoozedUntil: NOW + MIN });
  assert.ok(!away.actions.some((a) => /snooze/.test(a)) && !/snoozed/.test(away.state));
  assert.ok(!V.sessionCard({ signal: 'stop' }, { now: NOW }).actions.includes('snooze'), 'no id, nothing to snooze');
});

function rig({ sessions, until = () => 0, clock } = {}) {
  const handlers = new Map(); const asked = [];
  let t = NOW;
  Cards.install({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, config: { load: () => ({}), save: () => {} }, now: clock || (() => (t += 1000)),
    getSessions: () => sessions, home: '/Users/me', platform: 'darwin', collapseAfter: 99,
    snoozedUntil: until, snooze: (id, kind) => { asked.push([id, kind]); return kind === 'off' ? 0 : NOW + (kind === '1h' ? 60 : 15) * MIN; } });
  const sender = (id = 1) => ({ sender: { id } });
  return { handlers, asked, call: (ch, req, e = sender()) => handlers.get(ch)(e, req) };
}
const ROWS = [{ sessionId: 's1', cwd: '/p', signal: 'stop' }, { sessionId: 'r1', cwd: '/p', signal: 'stop', remote: true, deviceName: 'Studio' }];

test('IPC: widget:session-snooze takes {id, for} only, re-finds your own session and says what it did', async () => {
  const r = rig({ sessions: ROWS });
  assert.deepEqual(await r.call('widget:session-snooze', { id: 's1', for: '1h' }), { ok: true, feedback: 'Alerts for this session are snoozed for 1 hour.' });
  assert.deepEqual(await r.call('widget:session-snooze', { id: 's1', for: '15m' }, { sender: { id: 2 } }), { ok: true, feedback: 'Alerts for this session are snoozed for 15 minutes.' });
  assert.deepEqual(await r.call('widget:session-snooze', { id: 's1', for: 'off' }, { sender: { id: 3 } }), { ok: true, feedback: 'Alerts for this session are back on.' });
  assert.deepEqual(r.asked, [['s1', '1h'], ['s1', '15m'], ['s1', 'off']]);
  for (const [req, sid] of [[{ id: 's1', for: '2h' }, 4], [{ id: 's1' }, 5], [{ id: 's1', for: '1h', until: NOW + 1e9 }, 6], [{ id: '../x', for: '1h' }, 7], [null, 8]]) {
    assert.deepEqual(await r.call('widget:session-snooze', req, { sender: { id: sid } }), { ok: false, feedback: '' }, JSON.stringify(req));
  }
  assert.deepEqual(await r.call('widget:session-snooze', { id: 'r1', for: '1h' }, { sender: { id: 9 } }), { ok: false, feedback: "That session isn't listed any more." }, 'another device is never snoozed here');
  assert.deepEqual(await r.call('widget:session-snooze', { id: 'gone', for: '1h' }, { sender: { id: 10 } }), { ok: false, feedback: "That session isn't listed any more." });
  assert.equal(r.asked.length, 3, 'nothing else reached the store');
});

test('IPC: one snooze per sender every half second; the end comes from main, never the request', async () => {
  const r = rig({ sessions: ROWS, clock: () => NOW });
  assert.equal((await r.call('widget:session-snooze', { id: 's1', for: '1h' })).ok, true);
  assert.deepEqual(await r.call('widget:session-snooze', { id: 's1', for: '1h' }), { ok: false, feedback: '' });
  const src = read('src/widget-cards-main.js');
  const body = src.slice(src.indexOf('async function snoozeOne('), src.indexOf("ipcMain.handle('widget:session-cards'"));
  assert.match(body, /snooze\(row\.sessionId, req\.for\)/, 'the id is the re-found row\'s');
  assert.doesNotMatch(body, /req\.until|Date\.now/);
});

test('the cards carry the snooze end only for your own sessions', async () => {
  const r = rig({ sessions: ROWS, until: (id) => (id === 's1' || id === 'r1' ? NOW + 10 * MIN : 0), clock: () => NOW });
  const m = await r.handlers.get('widget:session-cards')({});
  const byId = Object.fromEntries(m.rows.map((x) => [x.id, x.card]));
  assert.match(byId.s1.state, /alerts snoozed, 10m left/);
  assert.doesNotMatch(byId.r1.state, /snoozed/);
});

function widget(model) {
  const src = read('widget.js');
  const slice = src.slice(src.indexOf('const CARD_DELAY_MS = 350;'));
  const dom = new JSDOM('<body><div id="strip"></div><div id="session-card"></div></body>', { runScripts: 'outside-only' });
  const w = dom.window; const calls = []; const feedback = [];
  w.trafficLight = { getSessionCards: async () => model, sessionSnooze: async (id, how) => { calls.push([id, how]); return { ok: true, feedback: `snooze ${how}` }; }, pinSession: async () => ({}) };
  w.showFeedback = (t) => feedback.push(t);
  w.stop = (e) => e.stopPropagation();
  w.eval(slice);
  return { w, calls, feedback, doc: w.document };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
test('widget: Snooze swaps in the two lengths and Cancel; a length snoozes that session; Unsnooze ends it', async () => {
  const card = (o) => ({ id: 's1', title: 'shop', state: 'Finished', waiting: false, idle: true, actions: ['snooze'], folder: null, folderApp: 'Finder', waitFor: '', help: [], ...o });
  const f = widget({ rows: [{ kind: 'session', id: 's1', card: card() }, { kind: 'session', id: 's2', card: card({ id: 's2', actions: ['unsnooze'] }) }], team: [] });
  f.w.loadCards(true); await tick();
  const chips = [...f.doc.querySelectorAll('#strip .chip')];
  const buttons = () => [...f.doc.querySelectorAll('#session-card .card-acts button')].map((b) => b.textContent);
  chips[0].dispatchEvent(new f.w.FocusEvent('focus'));
  assert.deepEqual(buttons(), ['Snooze']);
  f.doc.querySelector('#session-card .card-acts button').click();
  assert.deepEqual(buttons(), ['15 minutes', '1 hour', 'Cancel']);
  [...f.doc.querySelectorAll('#session-card .card-acts button')][2].click();
  assert.deepEqual(buttons(), ['Snooze'], 'Cancel puts the buttons back');
  assert.deepEqual(f.calls, []);
  f.doc.querySelector('#session-card .card-acts button').click();
  [...f.doc.querySelectorAll('#session-card .card-acts button')][1].click();
  await tick();
  chips[1].dispatchEvent(new f.w.FocusEvent('focus'));
  assert.deepEqual(buttons(), ['Unsnooze']);
  f.doc.querySelector('#session-card .card-acts button').click();
  await tick();
  assert.deepEqual(f.calls, [['s1', '1h'], ['s2', 'off']]);
  assert.deepEqual(f.feedback, ['snooze 1h', 'snooze off']);
});

test('the preload passes only an id and one of the three lengths', () => {
  assert.match(read('preload.js'), /sessionSnooze: \(id, how\) => \(typeof id === 'string' && \['15m', '1h', 'off'\]\.includes\(how\) \? ipcRenderer\.invoke\('widget:session-snooze', \{ id, for: how \}\)/);
});

// ── notifications ──────────────────────────────────────────────────────────
test('the click is never silent: another device or a gone session says so; a local one jumps', () => {
  assert.deepEqual(N.clickPlan({ sessionId: 'remote:x' }, null), { kind: 'note', body: 'That session runs on another device. Answer it there.' });
  assert.deepEqual(N.clickPlan({ sessionId: 'x' }, { sessionId: 'x', remote: true, deviceName: 'Stu‮dio\u0007' }), { kind: 'note', body: 'That session runs on Studio. Answer it there.' }, 'S2: the name is cleaned');
  assert.deepEqual(N.clickPlan({ sessionId: 'x' }, { sessionId: 'x', remote: true, deviceName: 'y'.repeat(99) }).body, `That session runs on ${'y'.repeat(60)}. Answer it there.`);
  assert.equal(N.clickPlan({ sessionId: 'x' }, { sessionId: 'x' }, (s) => s.sessionId === 'x').kind, 'note', "main's host check");
  assert.deepEqual(N.clickPlan({ sessionId: 'x' }, null), { kind: 'note', body: "That session isn't running any more." });
  assert.deepEqual(N.clickPlan({ sessionId: 'x', hostApp: null }, { sessionId: 'x' }), { kind: 'jump' }, 'no host app still jumps; the jumper says why if it misses');
  assert.deepEqual(N.clickPlan({ kind: 'runaway', hostApp: null }, null), { kind: 'jump' });
  assert.deepEqual(N.clickPlan({ kind: 'offline' }, null), { kind: 'none' });
});

test('the buttons: [Show in Overview, Snooze 1 hour] for a local session; a runaway keeps Stop first; none for another device', () => {
  const row = { sessionId: 'x' };
  assert.deepEqual(N.actionsFor({ sessionId: 'x', kind: 'permission-ask' }, { row }).map((b) => b.run), ['overview', 'snooze']);
  assert.deepEqual(N.actionsFor({ sessionId: 'x', kind: 'runaway' }, { row, stop: true }).map((b) => b.text), ['Stop session', 'Show in Overview']);
  assert.deepEqual(N.actionsFor({ sessionId: 'x', kind: 'runaway' }, { row: null, stop: true }).map((b) => b.run), ['stop']);
  assert.deepEqual(N.actionsFor({ sessionId: 'x', kind: 'permission-ask' }, { row: { ...row, remote: true } }), []);
  assert.deepEqual(N.actionsFor({ sessionId: 'x', kind: 'permission-ask' }, { row, isRemote: () => true }), []);
  assert.deepEqual(N.actionsFor({ sessionId: 'remote:x', kind: 'stop' }, { row }), []);
  assert.deepEqual(N.actionsFor({ kind: 'offline' }, {}), []);
});

test('S3: an action index picks from the same array; a bad or out-of-range index runs nothing and does not throw', () => {
  const list = N.actionsFor({ sessionId: 'x', kind: 'runaway' }, { row: { sessionId: 'x' }, stop: true });
  assert.equal(N.pick(list, { actionIndex: 0 }).run, 'stop');
  assert.equal(N.pick(list, { actionIndex: 1 }).run, 'overview');
  assert.equal(N.pick(list, {}, 1).run, 'overview', 'the deprecated second argument when details has no index');
  assert.equal(N.pick(list, { actionIndex: 1 }, 0).run, 'overview', 'details wins');
  for (const bad of [2, -1, 0.5, NaN, '0', null, undefined]) assert.equal(N.pick(list, { actionIndex: bad }), null, String(bad));
  assert.equal(N.pick(list, null, 7), null);
  assert.equal(N.pick(null, { actionIndex: 0 }), null);
});

// ── main ───────────────────────────────────────────────────────────────────
test('main: Q3-M1, snoozes never pass through config; a renderer save carrying the key changes nothing', () => {
  const main = read('main.js');
  const commit = main.slice(main.indexOf('function commitConfig('), main.indexOf('const next = saveConfig(partial);', main.indexOf('function commitConfig(')));
  assert.match(commit, /delete partial\.sessionSnoozes;/, 'commitConfig drops it before saving');
  assert.equal(main.match(/sessionSnoozes\b(?!\.)/g).filter((m) => m).length >= 1, true);
  assert.doesNotMatch(main, /config\.sessionSnoozes|\(\)\.sessionSnoozes|saveConfig\(\{ sessionSnoozes/, 'no config read or write of it');
  assert.match(main, /const SNOOZE_FILE = path\.join\(ROOT_DIR, 'session-snoozes\.json'\);/);
  assert.match(read('PRIVACY.md'), /`session-snoozes\.json`: the sessions whose alerts you snoozed/);
});

test('main: notifications, the sound and the knock consult the snoozes; the buttons map through pick', () => {
  const main = read('main.js');
  assert.match(main, /if \(SessionSnooze\.notificationHeld\(n, \(id\) => sessionSnoozes\.until\(id\)\)\) \{ console\.log\(`\[notify\] held \(session snoozed\)/);
  assert.match(main, /pingAllowed\(owned\.sound, \{ lamp: look\.lamp \}\) && !alertsSnoozed\(owned\.sound\)\) playSound/);
  assert.match(main, /force \|\| \(pingAllowed\(st\.owned\?\.sound, \{ lamp: base\.lamp \}\) && !alertsSnoozed\(st\.owned\?\.sound\)\)/);
  assert.match(main, /rule, sessions: aggregateState\(\{ ignoreTravel: true \}\)\.sessions, isRemote, gitSignals: GitSignals\.SIGNALS/);
  const notify = main.slice(main.indexOf('function maybeNotify('), main.indexOf('// ── Bullet overlay'));
  assert.match(notify, /const buttons = NotifyActions\.actionsFor\(n, \{ row: rowNow\(\), stop: !!stop, isRemote \}\);/);
  assert.match(notify, /actions: buttons\.map\(\(b\) => \(\{ type: 'button', text: b\.text \}\)\)/);
  assert.match(notify, /const b = NotifyActions\.pick\(buttons, details, legacyIndex\);\n\s+if \(!b\) return;/);
  assert.match(notify, /else if \(b\.run === 'overview'\) \{\n(?:[^\n]*\n){2,3}\s+openBuddy\('overview'\);\n\s+\}\n\s+else if \(b\.run === 'snooze'\) snoozeSession\(n\.sessionId, '1h'\);/);
  assert.match(notify, /const plan = NotifyActions\.clickPlan\(n, s, isRemote\);\n\s+if \(plan\.kind === 'note'\) \{ showJumpNote\(\{ title: 'Plexiform', body: plan\.body \}\); return; \}/);
  const snooze = main.slice(main.indexOf('function snoozeSession('), main.indexOf('const liveNotifications'));
  assert.match(snooze, /if \(!row \|\| row\.remote \|\| row\.device \|\| isRemote\(row\)\) return 0;/, 'only a local session, re-found by id');
  assert.match(main, /snoozedUntil: \(id\) => sessionSnoozes\.until\(id\), snooze: \(id, kind\) => snoozeSession\(id, kind\),/);
});

// ── the new store on disk: inventory, delete, export, backups ──────────────
test('session-snoozes.json is a named store: Delete removes it with Session state, Export includes it, Backups leave it out', async (t) => {
  const Inventory = require('../src/data-inventory.js');
  const Delete = require('../src/data-delete.js');
  const { exportData } = require('../src/data-export.js');
  const Backups = require('../src/backups.js');
  const { fakeMac, put } = require('./helpers/data-rights-fixture.js');
  const mac = fakeMac();
  t.after(mac.cleanup);
  const file = path.join(mac.roots.dataDir, 'session-snoozes.json');
  put(file, JSON.stringify({ v: 1, snoozes: { s1: NOW + MIN } }));
  const row = Inventory.inventory(mac.roots).find((r) => r.paths.includes(file));
  assert.equal(row && row.id, 'sessions', 'it lands in Session state, not the catch-all');
  const out = fs.mkdtempSync(path.join(mac.outside, 'export-'));
  const ex = await exportData({ outDir: out, now: NOW, ...mac.roots });
  if (row.exportable) assert.ok(fs.existsSync(path.join(ex.dir, 'sessions', 'session-snoozes.json')), 'exported with its store');
  else assert.ok(ex.excluded.some((x) => x.label === row.label));
  Delete.deleteStores({ ...mac.roots, ids: ['sessions'] });
  assert.equal(fs.existsSync(file), false, 'deleted with Session state');
  assert.ok(Backups.EXCLUDED.some((x) => x.name === 'session-snoozes.json'), 'named as left out of backups, with why');
});
