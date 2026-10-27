'use strict';
// Redesign R7-2: Usage › Today, main's side. src/usage-today-main.js (its sender matrix, the pinned reply, the closed
// open table), src/home-main.js's shared gatherer (review S2: one My day read per TTL across Home and Today), and
// src/digest-main.js's bindings (S1, S4): Today's own channels for get/copy/save/email only, its own guard only, and
// the same digest and delivery instances. Fakes only; no window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Today = require('../src/usage-today-main.js');
const Home = require('../src/home-main.js');
const DigestMain = require('../src/digest-main.js');

const TODAY = { id: 'today' }, HOME = { id: 'home' }, OTHER = { id: 'other' };
const ev = (sender) => ({ sender });
const ipc = () => { const handlers = new Map(); return { handlers, handle: (ch, fn) => { assert.ok(!handlers.has(ch), ch); handlers.set(ch, fn); } }; };

const SNAP = {
  today: { spend: { spent: 3.5, budget: 10, level: 'ok', unpriced: 0, equivalent: false }, longestWaitMs: 120000 },
  running: { quiet: 0, items: [{ provider: 'claude', project: 'api' }, { provider: 'codex', project: 'web' }] },
  costs: { receipt: { month: 'October', headline: 'You saved $12' }, enforce: { on: true, status: 'Your limit is enforced.' }, waste: { days: 7, count: 2, top: 'Re-read the same file', files: 1 } },
  team: { unavailable: false, cards: [{ handle: 'c1', title: 'Secret card title' }], decisions: [{ handle: 'd1', title: 'Secret decision' }, { handle: 'd2', title: 'x' }] },
};

function today(over = {}) {
  const i = ipc();
  const st = { snaps: 0, opened: [], snap: SNAP, ...over };
  Today.register({ ipcMain: i, allowed: (e) => e?.sender === TODAY, snapshot: async () => { st.snaps++; return st.snap; }, openPage: (id) => st.opened.push(id) });
  return { st, call: (ch, e, ...a) => i.handlers.get(ch)(e, ...a), i };
}

test('channels: exactly state and open', () => {
  assert.deepEqual([...today().i.handlers.keys()].sort(), ['usage-today:open', 'usage-today:state']);
});

test('sender matrix: only the Today document reads or opens; refused senders cause no read and no navigation', async () => {
  for (const s of [HOME, OTHER, null]) {
    const t = today();
    assert.equal(await t.call('usage-today:state', ev(s)), null);
    assert.equal(await t.call('usage-today:open', ev(s), 'team'), false);
    assert.equal(t.st.snaps, 0);
    assert.deepEqual(t.st.opened, []);
  }
  const t = today();
  assert.equal(await t.call('usage-today:state', ev(TODAY), 'extra'), null, 'state takes no arguments');
});

test('state: the pinned reply is numbers and the cost card texts; My day is counts only (no card or decision titles)', async () => {
  const t = today();
  const r = await t.call('usage-today:state', ev(TODAY));
  assert.deepEqual(Object.keys(r), [...Today.KEYS]);
  assert.deepEqual(r.today, { spend: { spent: 3.5, budget: 10, level: 'ok', unpriced: 0, equivalent: false }, longestWaitMs: 120000, running: 2 });
  assert.deepEqual(r.myDay, { decisions: 2, cards: 1, unavailable: false });
  assert.deepEqual(r.costs, { receipt: { month: 'October', headline: 'You saved $12' }, enforce: { on: true, status: 'Your limit is enforced.' }, waste: { count: 2, top: 'Re-read the same file' } });
  assert.equal(r.empty, false);
  assert.ok(!JSON.stringify(r).includes('Secret'), 'no titles');
  assert.ok(!JSON.stringify(r).includes('api'), 'no projects');
  const empty = today({ snap: { today: { spend: null, longestWaitMs: null }, running: { items: [] }, costs: null, team: null } });
  const e = await empty.call('usage-today:state', ev(TODAY));
  assert.equal(e.empty, true);
  assert.equal(e.myDay, null);
  const broken = today({ snap: null });
  assert.equal((await broken.call('usage-today:state', ev(TODAY))).empty, true, 'no snapshot → the empty state, never a throw');
});

test('state: the document must still be Today after the read', async () => {
  const i = ipc();
  let me = TODAY, release;
  const gate = new Promise((r) => { release = r; });
  Today.register({ ipcMain: i, allowed: (e) => e?.sender === me, snapshot: async () => { await gate; return SNAP; }, openPage() {} });
  const p = i.handlers.get('usage-today:state')(ev(TODAY));
  me = OTHER; release();
  assert.equal(await p, null);
});

test('open: Team or Board only', async () => {
  const t = today();
  for (const bad of ['settings', 'usage', 'home', '', undefined]) assert.equal(await t.call('usage-today:open', ev(TODAY), bad), false, String(bad));
  assert.equal(await t.call('usage-today:open', ev(TODAY), 'team', 'x'), false);
  assert.equal(await t.call('usage-today:open', ev(TODAY), 'team'), true);
  assert.equal(await t.call('usage-today:open', ev(TODAY), 'board'), true);
  assert.deepEqual(t.st.opened, ['team', 'board']);
});

test('S2: Home and Today share one gatherer: My day is read once per TTL across both, and home:state is unchanged', async () => {
  const i = ipc();
  let reads = 0;
  const myDay = { snapshot: async () => { reads++; return { sources: [{ name: 'Team board', cards: [{ handle: 'c', title: 't' }], decisions: [] }] }; }, open: async () => true };
  const shared = Home.register({ ipcMain: i, allowed: (e) => e?.sender === HOME, state: () => null, localSessions: () => [], tools: () => [], myDay, openPage() {}, openAiTools() {}, morning: () => null, now: () => 1000 });
  assert.equal(typeof shared?.snapshot, 'function');
  const t = ipc();
  Today.register({ ipcMain: t, allowed: (e) => e?.sender === TODAY, snapshot: () => shared.snapshot(), openPage() {} });
  const h = await i.handlers.get('home:state')(ev(HOME));
  const r = await t.handlers.get('usage-today:state')(ev(TODAY));
  assert.equal(reads, 1, 'one My day read for both pages');
  assert.deepEqual(r.myDay, { decisions: 0, cards: 1, unavailable: false });
  assert.deepEqual(Object.keys(h).sort(), ['banner', 'canDemo', 'costs', 'firstRunTour', 'morning', 'needs', 'observed_at', 'running', 'simple', 'team', 'teamless', 'today'], 'home:state keeps its shape');
});

function digest(bindings) {
  const i = ipc();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r72-digest-'));
  const clip = [];
  const out = DigestMain.register({
    ipcMain: i, allowed: (e) => e?.sender === HOME, rootDir: dir, userData: dir,
    safeStorage: { isEncryptionAvailable: () => false }, clipboard: { writeText: (s) => clip.push(s) }, dialog: {}, shell: {}, Notification: { isSupported: () => false },
    fetch: async () => { throw new Error('no network'); }, usageTurns: () => [], costGuard: () => null, bindings,
  });
  return { i, out, clip, dir };
}
const TODAY_BINDING = { prefix: 'usage-today:digest-', allowed: (e) => e?.sender === TODAY, only: ['get', 'copy', 'save', 'email'] };

test('digest: with no bindings, exactly the nine digest:* channels (gate off is unchanged)', () => {
  const d = digest(undefined);
  assert.deepEqual([...d.i.handlers.keys()].sort(), ['digest:copy', 'digest:email', 'digest:get', 'digest:preview', 'digest:save', 'digest:set', 'digest:test', 'digest:webhook-remove', 'digest:webhook-save']);
  assert.deepEqual([...digest([]).i.handlers.keys()].length, 9);
});

test('S1: Today binds get, copy, save and email only; preview, test, set and the webhook are never bound, even if asked', () => {
  const d = digest([{ ...TODAY_BINDING, only: ['get', 'copy', 'save', 'email', 'preview', 'test', 'set', 'webhook-save', 'webhook-remove'] }]);
  const mine = [...d.i.handlers.keys()].filter((c) => c.startsWith('usage-today:')).sort();
  assert.deepEqual(mine, ['usage-today:digest-copy', 'usage-today:digest-email', 'usage-today:digest-get', 'usage-today:digest-save']);
  assert.deepEqual([...DigestMain.SHAREABLE], ['get', 'copy', 'save', 'email']);
  // A binding can't take Home's names or an odd prefix.
  for (const prefix of ['digest:', 'digest:x-', 'Usage:', '../', 'usage today:']) assert.equal([...digest([{ ...TODAY_BINDING, prefix }]).i.handlers.keys()].length, 9, prefix);
});

test('S4: own guards both ways, never OR\'d: Home can\'t use Today\'s channels and Today can\'t use Home\'s', async () => {
  const d = digest([TODAY_BINDING]);
  const call = (ch, s, ...a) => d.i.handlers.get(ch)(ev(s), ...a);
  for (const ch of ['get', 'copy', 'save', 'email']) {
    assert.equal(await call(`usage-today:digest-${ch}`, HOME, 'day'), null, `Home → Today's ${ch}`);
    assert.equal(await call(`usage-today:digest-${ch}`, OTHER, 'day'), null, `other → Today's ${ch}`);
  }
  for (const ch of ['get', 'copy', 'save', 'email', 'preview', 'test', 'set', 'webhook-save', 'webhook-remove']) assert.equal(await call(`digest:${ch}`, TODAY, 'day'), null, `Today → Home's ${ch}`);
  assert.deepEqual(d.clip, [], 'nothing reached the clipboard');
  // The same handler: Today's copy writes the same text Home's would, from the one digest instance.
  await call('usage-today:digest-copy', TODAY, 'day', 'text');
  await call('digest:copy', HOME, 'day', 'text');
  assert.equal(d.clip.length, 2);
  assert.equal(d.clip[0], d.clip[1]);
  const g = await call('usage-today:digest-get', TODAY, 'day');
  assert.ok(g && g.digest && typeof g.digest.title === 'string');
});

test('main.js: Today\'s module and digest binding are set only inside the CHAT_PREVIEW block; Home\'s guard is unchanged', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const at = main.indexOf("require('./src/usage-today-main.js').register(");
  const block = main.lastIndexOf('if (CHAT_PREVIEW) {', at);
  assert.ok(at > 0 && block > 0 && !/\n}\n/.test(main.slice(block, at)), 'inside the gated block');
  assert.match(main.slice(block, at + 600), /todayDigest = \{ prefix: 'usage-today:digest-', allowed: todayAllowed, only: \['get', 'copy', 'save', 'email'\] \};/);
  assert.match(main, /let HomeState = null, todayDigest = null;/);
  assert.match(main, /require\('\.\/src\/digest-main\.js'\)\.register\(\{ ipcMain, allowed: \(e\) => fromUtilityPage\(e, 'home'\),/);
  assert.match(main, /bindings: todayDigest \? \[todayDigest\] : \[\] \}\);/);
  assert.match(main, /const todayAllowed = \(e\) => fromUtilityPage\(e, 'usage:today'\);/);
});

test('the page bridge and page: fixed shapes, textContent only', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', 'usage-today-preload.js'), 'utf8');
  const channels = [...pre.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(channels, ['usage-today:digest-copy', 'usage-today:digest-email', 'usage-today:digest-get', 'usage-today:digest-save', 'usage-today:open', 'usage-today:state']);
  assert.doesNotMatch(pre, /\.send\(|\.on\(/, 'no pushes, no fire-and-forget');
  const page = fs.readFileSync(path.join(__dirname, '..', 'usage-today.js'), 'utf8');
  assert.doesNotMatch(page, /innerHTML|insertAdjacentHTML/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'usage-today.html'), 'utf8'), /No usage yet\. It appears after your first chat or session\./);
});
