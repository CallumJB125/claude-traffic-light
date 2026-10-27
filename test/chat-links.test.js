'use strict';
// Redesign R2a: chat-first deep links (plan-r2.md §5; labfix-review S4a).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Pages = require('../buddy-window/pages.js');
const ChatLinks = require('../src/chat-links.js');

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(root, 'buddy-window/index.js'), 'utf8');
const between = (text, a, b) => { const i = text.indexOf(a); const j = text.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} … ${b}`); return text.slice(i, j); };
const ROW = 'a'.repeat(64);

test('page links: every PAGES id, on either scheme; nothing else', () => {
  for (const p of Pages.flat()) {
    assert.deepEqual(ChatLinks.parse(`plexiform://open/${p.id}`), { kind: 'page', id: p.id }, p.id);
    assert.deepEqual(ChatLinks.parse(`claudebuddy://open/${p.id}/`), { kind: 'page', id: p.id });
  }
  // R2b-2: newchat is the one FUTURE_IDS entry with a link of its own (below); it is still not a page.
  for (const id of [...Pages.FUTURE_IDS.filter((x) => x !== 'newchat'), 'nope', 'section:sessions', '..', '__proto__', 'constructor']) assert.equal(ChatLinks.parse(`plexiform://open/${id}`), null, id);
});

test('R2b-2 (outline Rev 1 S2): open/newchat is its own kind, never a page; it carries nothing else', () => {
  for (const url of ['plexiform://open/newchat', 'plexiform://open/newchat/', 'claudebuddy://open/newchat']) assert.deepEqual(ChatLinks.parse(url), { kind: 'newchat', id: 'newchat' }, url);
  assert.equal(Pages.pageById('newchat'), null, 'not in PAGES');
  assert.ok(Pages.FUTURE_IDS.includes('newchat'));
  for (const url of ['plexiform://open/newchat?text=rm', 'plexiform://open/newchat/folder', 'plexiform://thread/newchat', 'plexiform://open/NEWCHAT', 'plexiform://open/newchat%20x']) assert.equal(ChatLinks.parse(url), null, url);
});

test('S4a: no link reaches an account flow (sign-in, join, create-team)', () => {
  assert.deepEqual([...Pages.FLOW_IDS].sort(), ['create-team', 'join', 'signin']);
  for (const id of Pages.FLOW_IDS) {
    for (const url of [`plexiform://open/${id}`, `plexiform://open/${id}/`, `PLEXIFORM://OPEN/${id}`, `claudebuddy://open/${id}`, `plexiform://thread/${id}`]) assert.equal(ChatLinks.parse(url), null, url);
  }
});

test('thread links: a 64-hex row id only', () => {
  assert.deepEqual(ChatLinks.parse(`plexiform://thread/${ROW}`), { kind: 'thread', id: ROW });
  for (const bad of [ROW.toUpperCase(), ROW.slice(1), `${ROW}0`, `${ROW}?x=1`, `${ROW}#x`, `${ROW}/more`, '../../etc']) assert.equal(ChatLinks.parse(`plexiform://thread/${bad}`), null, bad);
});

test('malformed or foreign links are refused', () => {
  for (const url of [null, 1, '', 'https://open/board', 'plexiform:open/board', 'plexiform://open/', 'plexiform://open/board?next=signin', 'plexiform://other/board', 'plexiform://join?code=x', `plexiform://open/${'b'.repeat(81)}`, `plexiform://open/board${' '.repeat(3000)}`]) assert.equal(ChatLinks.parse(url), null, String(url).slice(0, 40));
});

test('the same target within a second is one navigation', () => {
  let t = 0;
  const fresh = ChatLinks.coalescer(() => t);
  const a = { kind: 'page', id: 'usage' }, b = { kind: 'thread', id: ROW };
  assert.equal(fresh(a), true);
  assert.equal(fresh(a), false);
  t += ChatLinks.COALESCE_MS - 1;
  assert.equal(fresh(a), false);
  assert.equal(fresh(b), true, 'another target is not coalesced');
  assert.equal(fresh(a), false, 'A, B, A within a second: A is still coalesced');
  t += 1;
  assert.equal(fresh(a), true, 'a second after A');
  assert.equal(fresh(b), false, 'B is still inside its second');
});

// The real handleDeepLink from main.js, with its collaborators faked.
function deepLink(chatPreview, { invite = false } = {}) {
  const calls = [];
  const ctx = {
    CHAT_PREVIEW: chatPreview, linksReady: true, pendingLinks: [], console: { error: () => {} }, BRAND: { NAME: 'Plexiform' },
    DEEP_LINK_RE: /^(plexiform|claudebuddy):/i, require: (m) => (m === './src/chat-links.js' ? ChatLinks : require(m)),
    getBuddy: () => ({ openInvite: (u) => { calls.push(['invite', u]); return invite; } }),
    buddyWin: { openLink: (t) => calls.push(['link', t.kind, t.id]) },
    openBuddy: () => calls.push(['openBuddy']),
  };
  vm.runInNewContext(between(mainSrc, "const ChatLinks = require('./src/chat-links.js');", "app.on('open-url'") + '\nglobalThis.handleDeepLink = handleDeepLink;', ctx);
  return { calls, go: (u) => ctx.handleDeepLink(u) };
}

test('gate off: deep links are invites only, exactly as before', () => {
  const d = deepLink(false);
  d.go(`plexiform://open/usage`);
  d.go(`plexiform://thread/${ROW}`);
  assert.deepEqual(d.calls, [['invite', 'plexiform://open/usage'], ['openBuddy'], ['invite', `plexiform://thread/${ROW}`], ['openBuddy']]);
});

test('gate on: invites are handled first; a page or thread link navigates; a flow link only opens the window', () => {
  const inv = deepLink(true, { invite: true });
  inv.go('plexiform://join?invite=x');
  assert.deepEqual(inv.calls, [['invite', 'plexiform://join?invite=x'], ['openBuddy']], 'an invite is unchanged');
  const d = deepLink(true);
  d.go('plexiform://open/usage');
  d.go(`plexiform://thread/${ROW}`);
  d.go('plexiform://open/usage'); // repeated within a second
  for (const id of Pages.FLOW_IDS) d.go(`plexiform://open/${id}`);
  assert.deepEqual(d.calls.filter(([k]) => k === 'link'), [['link', 'page', 'usage'], ['link', 'thread', ROW]]);
  assert.equal(d.calls.filter(([k]) => k === 'openBuddy').length, Pages.FLOW_IDS.length, 'a flow link starts nothing: the window opens on its current page (Board by default)');
});

// The real openLink from index.js.
function linker({ thread = true } = {}) {
  const calls = [];
  const ctx = {
    chatFirst: true, calls, pageById: Pages.pageById,
    open: () => calls.push(['open']), route: (id) => calls.push(['route', id]), select: (id) => calls.push(['select', id]),
    focusSidebar: (f) => calls.push(['sidebar', f]), openThread: (id) => { calls.push(['thread', id]); return thread; },
  };
  vm.runInNewContext(`const api = {\n${between(indexSrc, '    openLink(target) {', '    overviewReadContext(){')}};\nglobalThis.openLink = (t) => api.openLink(t);`, ctx);
  return ctx;
}

test('openLink: pages through route() (never goTo), threads through openThread, else Board with the sidebar on All', () => {
  const a = linker();
  a.openLink({ kind: 'page', id: 'usage' });
  assert.deepEqual(a.calls, [['open'], ['route', 'usage']]);
  const b = linker();
  b.openLink({ kind: 'thread', id: ROW });
  assert.deepEqual(b.calls, [['open'], ['thread', ROW]]);
  const c = linker({ thread: false });
  c.openLink({ kind: 'thread', id: ROW });
  assert.deepEqual(c.calls, [['open'], ['thread', ROW], ['select', 'board'], ['sidebar', 'all']]);
  const d = linker();
  d.openLink({ kind: 'page', id: 'signin' }); // not a page: never routed
  assert.deepEqual(d.calls, [['open'], ['select', 'board'], ['sidebar', 'all']], 'a non-page is never routed: Board');
  assert.doesNotMatch(between(indexSrc, '    openLink(target) {', '    overviewReadContext(){'), /goTo|startFlow/);
});
