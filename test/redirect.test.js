'use strict';
// Redesign R1: the redirect table (plan-redesign §R2.5) and section targets.
// The table is pinned here row by row, so a new page id can't ship without a
// decision about where it goes once the chat-first preview is on.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../buddy-window/pages.js');

const ALL_IDS = [...P.flat().map((p) => p.id), ...P.FLOW_IDS];
// Destinations that are built: they redirect with the preview on.
const BUILT = ['home', 'myday', 'stats', 'optimiser', 'clients'];

// §R2.5, in the plan's words → the encoded row.
const TABLE = {
  home: 'new chat', overview: 'sidebar, All', waiting: 'sidebar, Needs you', myday: 'new chat',
  sessions: 'sidebar, In terminals', timeline: 'thread by session, else sidebar In terminals (R2)',
  checkpoints: 'thread › Changes by session, else ⌘K "changes in…" (R2)', memory: '⌘K',
  tasks: 'thread by session, else new chat (R2)', discover: 'Library (R14)', 'agents-find': 'Library (R14)',
  board: 'kept', 'board:table': 'kept', 'board:history': 'kept', 'board:dashboard': 'kept', 'board:calendar': 'kept', 'board:timeline': 'kept',
  integrations: 'Settings › Account & team › Integrations', team: 'kept', usage: 'kept',
  stats: 'Usage › Stats', optimiser: 'Usage › Burst', clients: 'Usage › Client billing',
  setups: 'Settings › Advanced › Setups', thismac: 'Settings › General', phone: 'Settings › Phone',
  account: 'Settings › Account & team', upgrade: 'Settings › Account & team › Plan & billing',
  sync: 'Settings › Account & team › Sync', widget: 'Settings › Widget', lights: 'Settings › Widget › When to light up',
  aitools: 'Settings › AI tools', settings: 'Settings › General', hatch: 'Settings › Widget › Character',
  help: 'kept', feedback: 'kept', updates: 'kept', signin: 'kept', join: 'kept', 'create-team': 'kept',
};
const describe = (r) => {
  if (r.keep) return 'kept';
  if (r.sidebar) return { all: 'sidebar, All', needs: 'sidebar, Needs you', terminals: 'sidebar, In terminals' }[r.sidebar];
  if (r.to === 'settings') return `Settings › ${{
    'account-team/integrations': 'Account & team › Integrations', 'advanced/setups': 'Advanced › Setups', general: 'General', phone: 'Phone',
    'account-team': 'Account & team', 'account-team/plan': 'Account & team › Plan & billing', 'account-team/sync': 'Account & team › Sync',
    widget: 'Widget', 'widget/when-to-light-up': 'Widget › When to light up', 'ai-tools': 'AI tools', 'widget/character': 'Widget › Character',
  }[r.pane]}`;
  if (r.to === 'usage') return `Usage › ${{ stats: 'Stats', burst: 'Burst', clients: 'Client billing' }[r.tab]}`;
  if (r.to === 'library') return 'Library (R14)';
  if (r.to === 'palette') return '⌘K';
  if (r.to === 'newchat') return r.until ? `new chat (${r.until})` : 'new chat';
  if (r.to === 'thread' && r.pane === 'changes') return 'thread › Changes by session, else ⌘K "changes in…" (R2)';
  if (r.to === 'thread') return `thread by session, else ${r.otherwise.sidebar ? 'sidebar In terminals' : 'new chat'} (R2)`;
  return JSON.stringify(r);
};

test('every PAGES id and every FLOW_IDS id has a redirect row, and no row is for an unknown id', () => {
  for (const id of ALL_IDS) assert.ok(P.REDIRECTS[id], `no redirect row for ${id}`);
  for (const id of Object.keys(P.REDIRECTS)) assert.ok(ALL_IDS.includes(id), `redirect row for unknown id ${id}`);
});

test('each redirect row says what §R2.5 says', () => {
  assert.deepEqual(Object.keys(TABLE).sort(), Object.keys(P.REDIRECTS).sort());
  for (const [id, want] of Object.entries(TABLE)) assert.equal(describe(P.REDIRECTS[id]), want, id);
});

test('every destination is a page, a future document, a named destination or a sidebar filter', () => {
  const ok = (r) => r.keep || (r.sidebar && P.SIDEBAR_FILTERS.includes(r.sidebar))
    || (r.to && (P.pageById(r.to) || P.FUTURE_IDS.includes(r.to) || P.DESTINATIONS.includes(r.to)));
  for (const [id, r] of Object.entries(P.REDIRECTS)) {
    assert.ok(ok(r), `${id} → ${JSON.stringify(r)}`);
    if (r.otherwise) assert.ok(ok(r.otherwise), `${id} otherwise → ${JSON.stringify(r.otherwise)}`);
    // A destination still to be built names the PR that builds it; R7-1 built the new chat (home, myday).
    if (r.to && !r.keep && !BUILT.includes(id)) assert.match(String(r.until), /^(R\d+|palette)$/, `${id} has no until`);
    if (BUILT.includes(id)) assert.equal(r.until, undefined, `${id} is built`);
  }
});

test('the preview off: resolve is the identity for every id', () => {
  for (const id of ALL_IDS) assert.deepEqual(P.resolve(id), { page: id });
  for (const id of ALL_IDS) assert.deepEqual(P.resolve(id, { chatFirst: false }), { page: id });
});

test('the preview on: the sidebar filters (R1) and Home and My day → the new chat (R7-1) move; unbuilt destinations stay on their page', () => {
  const moved = Object.fromEntries(ALL_IDS.map((id) => [id, P.resolve(id, { chatFirst: true })]).filter(([id, r]) => r.page !== id));
  assert.deepEqual(moved, { overview: { sidebar: 'all' }, waiting: { sidebar: 'needs' }, sessions: { sidebar: 'terminals' }, home: { newchat: true }, myday: { newchat: true } });
  // Review S3: tasks' fallback is the new chat too, but tasks itself is unbuilt (R2) and stays put.
  assert.deepEqual(P.resolve('tasks', { chatFirst: true }), { page: 'tasks' });
  // R7-2 (review nit): Usage's tabs are built, and each tab is the page itself, so they resolve to themselves.
  for (const id of ['stats', 'optimiser', 'clients', 'usage']) assert.deepEqual(P.resolve(id, { chatFirst: true }), { page: id }, id);
  for (const id of ['stats', 'optimiser', 'clients']) assert.equal(P.REDIRECTS[id].until, undefined, `${id} is built`);
});

test('a select from the sidebar itself is never redirected (a row click on overview stays on overview)', () => {
  for (const id of ALL_IDS) assert.deepEqual(P.resolve(id, { chatFirst: true, from: 'sidebar' }), { page: id });
});

test('one hop at most: a result is the id itself, a sidebar filter or the new chat, never another page to redirect', () => {
  for (const id of ALL_IDS) {
    const r = P.resolve(id, { chatFirst: true });
    assert.equal(Object.keys(r).length, 1, id);
    if ('page' in r) assert.equal(r.page, id, `${id} resolved to another page`);
    else if ('newchat' in r) assert.equal(r.newchat, true, id);
    else assert.ok(P.SIDEBAR_FILTERS.includes(r.sidebar), id);
  }
});

test('future ids are not pages: pageById is null and none is in PAGES (so the sidebar never sees them)', () => {
  for (const id of P.FUTURE_IDS) {
    assert.equal(P.pageById(id), null, id);
    assert.ok(!JSON.stringify(P.PAGES).includes(`"${id}"`), `${id} appears in PAGES`);
    assert.equal(P.sectionOf(id), null, id);
  }
  assert.deepEqual([...P.FUTURE_IDS].sort(), ['newchat', 'sidebar', 'thread']);
});

test('every section id resolves to its default page; page ids win the bare name', () => {
  for (const s of P.SECTIONS) {
    const addr = P.sectionAddress(s);
    if (addr === s.id && P.pageById(s.id)) assert.equal(s.default, s.id, `${s.id}: a page owns the name, so its default must be itself`);
    else assert.equal(P.sectionTarget(addr), s.default, addr);
  }
  assert.equal(P.sectionAddress(P.SECTIONS.find((s) => s.id === 'sessions')), 'section:sessions');
  assert.equal(P.sectionTarget('section:sessions'), 'overview');
  assert.equal(P.sectionTarget('sessions'), null, 'the bare name is the Sessions page');
  assert.equal(P.sectionTarget('inbox'), 'waiting');
  assert.equal(P.sectionTarget('nope'), null);
  assert.equal(P.sectionTarget('section:nope'), null);
});

test('FLOW_IDS are exported and are not pages', () => {
  assert.deepEqual([...P.FLOW_IDS], ['signin', 'join', 'create-team']);
  for (const id of P.FLOW_IDS) assert.equal(P.pageById(id), null);
});
