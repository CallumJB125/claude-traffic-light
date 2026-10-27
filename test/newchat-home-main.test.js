'use strict';
// Redesign R7-1 (plan-r7 §2, review S1–S4): the new chat's own content, main's side (src/newchat-home-main.js).
// The sender matrix for its three channels, Open's checks (given ids only, a fresh read, focus, the gap), the
// starters (handle → folder in main, the hardened git argv, the cache, CI red only from a live event), the row shape
// and the page's preload. No window, no git: every dependency is a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const NCH = require('../src/newchat-home-main.js');

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64), E = 'e'.repeat(64);
const HOUR = 3600e3;
const row = (id, bucket, age = 1000, extra = {}) => ({ id, bucket, title: `T ${id[0]}`, project: `p${id[0]}`, origin: null, age_ms: age, team: false, terminal: false, chat: true, thread: true, ...extra });

function harness(over = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => { assert.ok(!handlers.has(ch), ch); handlers.set(ch, fn); } };
  const frame = { url: 'file:///newchat.html?embedded=1' };
  const wc = { id: 70, mainFrame: frame, isDestroyed: () => false };
  const win = { isDestroyed: () => false };
  const st = { generation: 1, document: 1, foreground: true, sessions: [row(A, 'needs', 5 * HOUR), row(B, 'needs', HOUR), row(C, 'check', 1000), row(D, 'working')], rowsCalls: 0, rowsGate: null, opened: [], openOk: true, now: Date.UTC(2026, 9, 28, 15), git: [], tree: '', remotes: '', red: [], folders: { h1: '/r/one', h2: '/r/two' }, ...over };
  const buddy = {
    newChatContext: () => (st.noContext ? null : { window: win, contents: wc, generation: st.generation, document: st.document, foreground: st.foreground }),
    openThread: (id) => { st.opened.push(id); return st.openOk; },
  };
  const svc = NCH.createNewChatHome({
    ipcMain, buddy: () => buddy, chatsOn: () => st.chats !== false,
    rows: async (alive) => { st.rowsCalls++; if (st.rowsGate) await st.rowsGate; return alive() ? { schema: 1, status: 'complete', sessions: st.sessions.map((r) => ({ ...r })) } : null; },
    folderOf: (h) => st.folders[h] ?? null,
    git: async (cwd, args, opts) => { st.git.push({ cwd, args, opts }); if (st.gitFail) throw new Error('boom'); return args[0] === 'remote' ? st.remotes : st.tree; },
    ciFailedRepos: () => st.red,
    repoOf: (url) => (/github\.com[:/](.+?)(?:\.git)?$/.exec(url) || [])[1] ?? null,
    now: () => st.now,
  });
  svc.register();
  const ev = (o = {}) => ({ sender: o.sender ?? wc, senderFrame: o.frame ?? frame });
  const call = (ch, e, ...args) => handlers.get(ch)(e, ...args);
  return { st, handlers, call, ev, wc, frame };
}

test('exactly three channels, all registered here and nowhere else; the newchat-main set stays its six', () => {
  const h = harness();
  assert.deepEqual([...h.handlers.keys()].sort(), ['newchat:home', 'newchat:open-row', 'newchat:starters']);
  assert.deepEqual(Object.values(NCH.CHANNELS).sort(), ['newchat:home', 'newchat:open-row', 'newchat:starters']);
  const nc = require('../src/newchat-main.js');
  for (const ch of Object.values(NCH.CHANNELS)) assert.ok(!Object.values(nc.CHANNELS).includes(ch), ch);
});

test('sender matrix: only the new-chat document (its webContents and main frame) reads or acts', async () => {
  const others = [
    ['another webContents', { sender: { id: 1, mainFrame: {} } }],
    ['a subframe of the new chat', { frame: { url: 'file:///x' } }],
  ];
  for (const [label, o] of others) {
    const h = harness();
    assert.equal(await h.call('newchat:home', h.ev(o)), null, label);
    assert.deepEqual(await h.call('newchat:starters', h.ev(o), { handle: 'h1' }), { starters: [] }, label);
    await h.call('newchat:home', h.ev());
    assert.deepEqual(await h.call('newchat:open-row', h.ev(o), { id: A }), { ok: false }, label);
    assert.deepEqual(h.st.opened, [], label);
    assert.deepEqual(h.st.git, [], label);
  }
  const gone = harness({ noContext: true }); // not showing, hidden, another page selected, or the gate off in buddy-window
  assert.equal(await gone.call('newchat:home', gone.ev()), null);
  assert.deepEqual(await gone.call('newchat:open-row', gone.ev(), { id: A }), { ok: false });
  const h = harness();
  assert.equal(await h.call('newchat:home', h.ev(), 'extra'), null, 'home takes no arguments');
});

test('home: the summary counts, up to 3 Needs-you rows oldest first, `more`, and the exact row keys (no paths, no refs)', async () => {
  const h = harness({ sessions: [row(A, 'needs', HOUR), row(B, 'needs', 3 * HOUR), row(C, 'needs', 2 * HOUR), row(D, 'needs', 10), row(E, 'check', 1000), row('f'.repeat(64), 'check', 20 * HOUR), row('9'.repeat(64), 'needs', 5, { thread: false })] });
  const r = await h.call('newchat:home', h.ev());
  assert.deepEqual(r.summary, { needs: 4, check: 1 }, 'a check row older than local midnight is not today; a row with no thread is not a Needs-you row');
  assert.deepEqual(r.rows.map((x) => x.id), [B, C, A]);
  assert.equal(r.more, 1);
  assert.equal(r.firstEver, false);
  assert.deepEqual(Object.keys(r).sort(), ['firstEver', 'more', 'rows', 'summary']);
  for (const x of r.rows) assert.deepEqual(Object.keys(x), [...NCH.ROW_KEYS]);
  const empty = harness({ sessions: [] });
  assert.equal((await empty.call('newchat:home', empty.ev())).firstEver, true);
  // Review: the service down or still starting ({status:'unavailable'|'partial', sessions:[]}) is not a first run.
  for (const status of ['unavailable', 'partial']) assert.equal(NCH.homeOf({ schema: 1, status, sessions: [] }, 0, 0).firstEver, false, status);
  assert.equal(NCH.homeOf(null, 0, 0).firstEver, false);
});

test('home: one shared read per document generation at the sidebar cadence; a new generation reads again; a move mid-read answers null', async () => {
  const h = harness();
  await h.call('newchat:home', h.ev());
  await h.call('newchat:home', h.ev());
  assert.equal(h.st.rowsCalls, 1);
  h.st.now += 5001;
  await h.call('newchat:home', h.ev());
  assert.equal(h.st.rowsCalls, 2);
  h.st.generation = 2;
  await h.call('newchat:home', h.ev());
  assert.equal(h.st.rowsCalls, 3);
  let release; h.st.rowsGate = new Promise((r) => { release = r; }); h.st.generation = 3;
  const p = h.call('newchat:home', h.ev());
  h.st.generation = 4; release();
  assert.equal(await p, null);
});

test('open-row (S4): only an id given to this generation, still Needs you in a fresh read, focused, 500 ms apart; never a fallback', async () => {
  const h = harness();
  assert.deepEqual(await h.call('newchat:open-row', h.ev(), { id: A }), { ok: false }, 'nothing given yet');
  await h.call('newchat:home', h.ev());
  const reads = h.st.rowsCalls;
  assert.deepEqual(await h.call('newchat:open-row', h.ev(), { id: D }), { ok: false }, 'working, never given');
  assert.deepEqual(await h.call('newchat:open-row', h.ev(), { id: A }), { ok: true });
  assert.deepEqual(h.st.opened, [A]);
  assert.equal(h.st.rowsCalls, reads + 1, 'a fresh read, not the cached one');
  assert.deepEqual(await h.call('newchat:open-row', h.ev(), { id: B }), { ok: false }, 'within 500 ms');
  h.st.now += 501;
  h.st.sessions = h.st.sessions.map((r) => (r.id === B ? { ...r, bucket: 'working' } : r));
  assert.deepEqual(await h.call('newchat:open-row', h.ev(), { id: B }), { ok: false }, 'no longer needs you');
  h.st.now += 501; h.st.foreground = false;
  assert.deepEqual(await h.call('newchat:open-row', h.ev(), { id: A }), { ok: false }, 'unfocused');
  h.st.now += 501; h.st.foreground = true; h.st.generation = 9;
  assert.deepEqual(await h.call('newchat:open-row', h.ev(), { id: A }), { ok: false }, 'given to an earlier generation');
  assert.deepEqual(h.st.opened, [A]);
  for (const bad of [[], [{ id: A, x: 1 }], [{ id: 'A' }], [A], [{ id: A }, 1], [null]]) {
    h.st.now += 501;
    assert.deepEqual(await h.call('newchat:open-row', h.ev(), ...bad), { ok: false }, JSON.stringify(bad));
  }
  const f = harness({ openOk: false });
  await f.call('newchat:home', f.ev());
  assert.deepEqual(await f.call('newchat:open-row', f.ev(), { id: A }), { ok: false }, 'openThread false → ok false, nothing else');
  const m = harness();
  await m.call('newchat:home', m.ev());
  let release; m.st.rowsGate = new Promise((r) => { release = r; });
  const p = m.call('newchat:open-row', m.ev(), { id: A });
  m.st.foreground = false; release();
  assert.deepEqual(await p, { ok: false }, 'focus lost during the fresh read');
  assert.deepEqual(m.st.opened, []);
});

const TREE = [
  '100644 blob 1111111111111111111111111111111111111111    9000\tsrc/big.js',
  '100644 blob 1111111111111111111111111111111111111111   12000\tsrc/tested.js',
  '100644 blob 1111111111111111111111111111111111111111     300\ttest/tested.test.js',
  '100644 blob 1111111111111111111111111111111111111111   99999\tnode_modules/x/index.js',
  '100644 blob 1111111111111111111111111111111111111111   50000\tdist/app.min.js',
  '100644 blob 1111111111111111111111111111111111111111   70000\tREADME.md',
].join('\n');

test('starters (S1): named by handle and resolved in main; an unknown handle reads nothing and runs no git', async () => {
  const h = harness({ tree: TREE });
  for (const bad of [[], [{}], [{ handle: 'nope' }], [{ handle: '/r/one' }], [{ handle: 'h1', x: 1 }], ['h1'], [{ handle: 'x'.repeat(201) }]]) {
    assert.deepEqual(await h.call('newchat:starters', h.ev(), ...bad), { starters: [] }, JSON.stringify(bad));
  }
  assert.deepEqual(h.st.git, [], 'no git for anything but a known handle');
  const r = await h.call('newchat:starters', h.ev(), { handle: 'h1' });
  assert.deepEqual(r.starters.map((s) => s.id), ['explain', 'tests']);
  assert.equal(r.starters[1].label, 'Add tests for big.js');
  assert.match(r.starters[1].text, /^Add tests for src\/big\.js\./);
  assert.ok(h.st.git.every((g) => g.cwd === '/r/one'));
});

test('starters (S2): the git argv is pinned, bounded and hardened by src/checkpoint-git.js; one read a minute per handle', async () => {
  const h = harness({ tree: TREE, remotes: 'origin\tgit@github.com:me/one.git (fetch)\norigin\tgit@github.com:me/one.git (push)', red: ['me/one'] });
  const r = await h.call('newchat:starters', h.ev(), { handle: 'h1' });
  assert.deepEqual(r.starters.map((s) => s.id), ['explain', 'tests', 'build']);
  assert.deepEqual(h.st.git.map((g) => g.args), [['ls-tree', '-r', '-l', '--full-tree', 'HEAD'], ['remote', '-v']]);
  for (const g of h.st.git) { assert.equal(g.opts.timeoutMs, 1000); assert.ok(g.opts.maxBuffer > 0 && g.opts.maxBuffer <= 4 << 20); }
  await h.call('newchat:starters', h.ev(), { handle: 'h1' });
  assert.equal(h.st.git.length, 2, 'cached');
  h.st.now += 60001;
  await h.call('newchat:starters', h.ev(), { handle: 'h1' });
  assert.equal(h.st.git.length, 4);
  // main.js wires git to checkpoint-git's run, whose SAFE_GIT turns off hooks, fsmonitor and attributes, with no system config.
  const CG = require('../src/checkpoint-git.js');
  for (const flag of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.attributesFile=/dev/null']) assert.ok(CG.SAFE_GIT.includes(flag), flag);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /const ncGit = require\('\.\/src\/checkpoint-git\.js'\)\.createGit\(\);/);
  assert.match(main, /git: \(cwd, args, opts\) => ncGit\.run\(cwd, args, opts\)/);
});

test('starters: CI red only while a ci-failed event names this repo; not git, or a failed read → Explain only', async () => {
  const other = harness({ tree: TREE, remotes: 'origin\tgit@github.com:me/one.git (fetch)', red: ['me/two'] });
  assert.deepEqual((await other.call('newchat:starters', other.ev(), { handle: 'h1' })).starters.map((s) => s.id), ['explain', 'tests']);
  const none = harness({ tree: TREE, red: [] });
  assert.deepEqual((await none.call('newchat:starters', none.ev(), { handle: 'h1' })).starters.map((s) => s.id), ['explain', 'tests']);
  const fail = harness({ gitFail: true, red: ['me/one'] });
  assert.deepEqual((await fail.call('newchat:starters', fail.ev(), { handle: 'h1' })).starters.map((s) => s.id), ['explain']);
});

test('largestUntested and cleanName: tests, vendored, generated and non-source files are skipped; names are capped and stripped', () => {
  assert.equal(NCH.largestUntested(TREE), 'src/big.js');
  assert.equal(NCH.largestUntested(''), null);
  assert.equal(NCH.largestUntested('100644 blob 11    5\ttest/only.test.js'), null);
  assert.equal(NCH.cleanName('a‮b\u0007c​d'), 'abcd');
  const long = NCH.cleanName(`${'x/'.repeat(60)}file.js`);
  assert.ok(long.length <= 80 && long.startsWith('…') && long.endsWith('file.js'));
  const evil = ['100644 blob 11   10\tsrc/‮evil.js'].join('\n');
  const s = NCH.startersFor({ tree: evil });
  assert.ok(!/[‪-‮]/.test(JSON.stringify(s)));
});

test('the page bridge: three calls with fixed shapes, no paths', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', 'newchat-preload.js'), 'utf8');
  assert.match(pre, /home: \(\) => ipcRenderer\.invoke\('newchat:home'\)/);
  assert.match(pre, /starters: \(handle\) => ipcRenderer\.invoke\('newchat:starters', \{ handle: typeof handle === 'string' \? handle : '' \}\)/);
  assert.match(pre, /openRow: \(id\) => ipcRenderer\.invoke\('newchat:open-row', \{ id: typeof id === 'string' \? id : '' \}\)/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'newchat.js'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(page), 'textContent and .value only');
  assert.match(page, /t\.value = st\.text;/);
});

test('gate off: main registers the module only inside the CHAT_PREVIEW block', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const at = main.indexOf("require('./src/newchat-home-main.js')");
  assert.ok(at > 0);
  assert.equal(main.indexOf("require('./src/newchat-home-main.js')", at + 1), -1, 'once');
  const block = main.lastIndexOf('if (CHAT_PREVIEW) {', at);
  const between = main.slice(block, at);
  assert.ok(block > 0 && between.includes("NewChat = require('./src/newchat-main.js')"), 'beside the new chat, in its gated block');
  assert.ok(!/\n}\n/.test(between), 'the block has not closed before it');
  const ov = fs.readFileSync(path.join(__dirname, '..', 'src/overview-main.js'), 'utf8');
  assert.match(ov, /passiveSidebarRows:alive=>stopped\|\|chatPreview!==true\?Promise\.resolve\(null\)/);
});

test('C4: with "Show chats" off the three reads answer nothing and read nothing, even from the new-chat document', async () => {
  const h = harness();
  await h.call('newchat:home', h.ev());
  h.st.chats = false;
  const reads = h.st.rowsCalls;
  assert.equal(await h.call('newchat:home', h.ev()), null);
  assert.deepEqual(await h.call('newchat:starters', h.ev(), { handle: 'h1' }), { starters: [] });
  assert.deepEqual(await h.call('newchat:open-row', h.ev(), { id: A }), { ok: false });
  assert.equal(h.st.rowsCalls, reads, 'no sidebar read');
  assert.deepEqual(h.st.opened, []);
  h.st.chats = true;
  assert.notEqual(await h.call('newchat:home', h.ev()), null, 'on again');
});
