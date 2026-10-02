'use strict';
// Overview "My sessions" / "Team sessions" through the real preload bridge,
// the real Overview IPC (overview-main → overview-service → session
// directory), the real owned-session interaction IPC and hub (with an
// in-memory provider standing in for Codex) and the FAKE team hub.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { createInteractionMain } = require('../src/interaction-main');
const { createOverviewMain } = require('../src/overview-main');
const { createFakeTeamHub } = require('../src/team-hub-fake');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('overview.html'), script = read('overview.js'), dirScript = read('overview-directory.js'), bridge = read('overview-preload.js');
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HOSTILE = '<img src=x onerror="globalThis.pwned=1">';

function memAdapter() {
  const ee = new EventEmitter(); const calls = [];
  return {
    label: 'Codex', calls,
    capabilities: { newTurn: true, steer: true, interrupt: true, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: false },
    open: async () => ({ target: 'target-1' }),
    async send(a) { calls.push(a); return { turnId: `turn-${calls.length}`, mode: 'new-turn' }; },
    interrupt: async () => true, release: async () => true, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
}
const FIXTURE = {
  viewer: 'u-me', users: { 'u-me': 'Me', 'u-bob': `Bob ${HOSTILE}`, 'u-cara': 'Cara', 'u-eve': 'Eve' },
  teams: [{ id: 't-dev', name: 'Dev team', members: ['u-me', 'u-bob', 'u-cara'] }, { id: 't-ops', name: 'Ops (not mine)', members: ['u-eve', 'u-bob'] }],
  sessions: [
    { ref: 'bob-1', owner: 'u-bob', provider: { id: 'claude', label: 'Claude Code' }, device: { label: 'Bob’s Windows PC' }, card: { key: 'DEV-7', title: `Fix login ${HOSTILE}`, edited_by: 'human' }, task_title: 'agent title', state: 'working', observed_ago_ms: 2000, capabilities: { interrupt: true }, children: [{ ref: 'k1', name: 'Reviewer', state: 'input', task_title: 'Review diff', observed_ago_ms: 1000 }], handoffs: [{ direction: 'in', with: 'Cara', state: 'offered', summary: 'Take over tests' }], shares: [{ team: 't-dev', scope: 'interact' }] },
    { ref: 'cara-1', owner: 'u-cara', provider: { id: 'codex', label: 'Codex' }, device: { label: 'Cara’s Mac' }, task_title: 'Write docs', state: 'idle', observed_ago_ms: 3000, shares: [{ team: 't-dev', scope: 'watch' }] },
    { ref: 'bob-private', owner: 'u-bob', provider: { id: 'cursor', label: 'Cursor' }, device: { label: 'Bob’s Windows PC' }, task_title: 'PRIVATE personal side project', state: 'working', observed_ago_ms: 1000, shares: [] },
    { ref: 'eve-ops', owner: 'u-eve', provider: { id: 'gemini', label: 'Gemini' }, device: { label: 'Eve’s laptop' }, task_title: 'OPS-ONLY incident work', state: 'working', observed_ago_ms: 1000, shares: [{ team: 't-ops', scope: 'interact' }] },
  ],
};

function stack({ teamHub = createFakeTeamHub(structuredClone(FIXTURE)), observed = true, shares = [] } = {}) {
  const handlers = new Map(), listeners = new Map(), results = [];
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => ctx.foreground };
  const contents = { id: 9, isDestroyed: () => false, mainFrame: {}, send: (ch, ...a) => { for (const fn of listeners.get(ch) ?? []) fn({}, ...structuredClone(a)); } };
  const ctx = { window: win, contents, generation: 1, document: 1, foreground: true };
  const buddy = { overviewContext: () => (ctx.foreground ? ctx : null), overviewReadContext: () => ctx };
  const adapter = memAdapter();
  const interaction = createInteractionMain({ context: () => (ctx.foreground ? ctx : null), readContext: () => ctx, adapters: { codex: adapter }, owned: null, localModels: null, workspace: (id) => `/private/tmp/plexiform-owned-${id.slice(-6)}`, currentBoard: () => 'local' });
  interaction.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const now = () => Date.now();
  const raw = [];
  if (observed) raw.push({ sessionId: 'thread-SECRET-1', source: 'codex', signal: 'tool-use', updatedAt: new Date().toISOString(), cwd: '/Users/me/private-repo/checkout' });
  const overview = createOverviewMain({
    buddy: () => buddy, sessions: () => raw, work: async () => ({ sources: [], capture: [] }), now,
    owned: () => interaction.listOwned(), shares: () => ({ origin: 'https://hub.example', list: shares }),
    hubTeams: async () => ({ origin: 'https://hub.example', teams: [] }), teamHub: () => teamHub,
  });
  overview.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  teamHub?.onChange(() => overview.directoryChanged());
  let api;
  vm.runInNewContext(bridge, { Buffer, Promise, require: () => ({ contextBridge: { exposeInMainWorld(_n, v) { api = v; } }, ipcRenderer: {
    invoke: async (ch, ...args) => { const fn = handlers.get(ch); assert.ok(fn, `no handler ${ch}`); const r = await fn({ sender: contents, senderFrame: contents.mainFrame }, ...structuredClone(args)); results.push([ch, r]); return structuredClone(r); },
    on: (ch, fn) => { if (!listeners.has(ch)) listeners.set(ch, new Set()); listeners.get(ch).add(fn); },
    removeListener: (ch, fn) => listeners.get(ch)?.delete(fn),
  } }) });
  let ready;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const intervals = [];
  dom.window.setInterval = (fn) => intervals.push(fn);
  dom.window.overviewApi = { ...api, onReady: (fn) => { ready = fn; return () => {}; } };
  dom.window.eval(dirScript);
  dom.window.eval(script);
  const doc = dom.window.document;
  const $ = (id) => doc.getElementById(id);
  const rows = (list) => [...$(list).querySelectorAll('.dir-entry')];
  const row = (list, re) => rows(list).find((r) => re.test(r.textContent));
  const change = (id, value) => { $(id).value = value; $(id).dispatchEvent(new dom.window.Event('change')); };
  return {
    dom, doc, $, rows, row, change, adapter, interaction, overview, teamHub, ctx, api, results, raw,
    ready: async () => { ready(); await tick(); },
    poll: async () => { for (const fn of intervals) fn(); await tick(); },
    team: async () => { $('tab-team').click(); await tick(); },
    close: () => { overview.close(); interaction.close(); dom.window.close(); },
  };
}

test('My sessions: an owned session and an observed Codex session, each with honest capabilities', async () => {
  const s = stack();
  try {
    await s.ready();
    assert.equal(s.$('views').hidden, false); assert.equal(s.$('mine-section').hidden, false); assert.equal(s.$('team-section').hidden, true);
    s.$('start-session').click(); await tick(); await s.poll();
    const owned = s.row('mine-list', /Started by Plexiform/), observed = s.row('mine-list', /Observed from activity hooks/);
    assert.ok(owned && observed, 'both rows');
    assert.equal(s.rows('mine-list').length, 2);
    assert.match(owned.querySelector('.tag').textContent, /Ready/);
    assert.match(observed.textContent, /Codex, which has no supported way for another app to send to it/);
    assert.equal([...observed.querySelectorAll('button')].filter((b) => !b.hidden && /Message/.test(b.textContent)).length, 0, 'no message control without a channel');
    assert.match(observed.querySelector('.caps').textContent, /Activity reports: available/);
    assert.match(observed.querySelector('.caps').textContent, /Interrupt: unavailable/);
    // Selected-session interaction is the existing owned card.
    const open = [...owned.querySelectorAll('button')].find((b) => b.textContent === 'Open conversation');
    open.click(); await tick();
    assert.equal(s.doc.activeElement, s.doc.querySelector('.owned-session textarea'));
    assert.match(s.$('mine-summary').textContent, /2My sessions/);
    // Claude Code's own hook writes no source field: still Claude Code, never "Local AI".
    s.raw.push({ sessionId: 'claude-1', signal: 'tool-use', updatedAt: new Date().toISOString(), cwd: '/Users/me/other' });
    await s.poll();
    assert.match(s.row('mine-list', /Claude Code/).textContent, /Claude Code activity hooks report activity only/);
    // No private identifiers in anything the page received.
    const wire = JSON.stringify(s.results.filter(([ch]) => ch === 'overview:directory'));
    for (const leak of ['thread-SECRET-1', '/Users/me', 'private-repo', 'target-1', '/private/tmp']) assert.equal(wire.includes(leak), false, leak);
  } finally { s.close(); }
});

test('My sessions: a session shared with a team is one row with a team badge; its hook twin is folded in', async () => {
  const shares = [];
  const s = stack({ shares });
  try {
    await s.ready();
    s.$('start-session').click(); await tick();
    const [{ state }] = s.interaction.listOwned();
    shares.push({ session: state.session, team: { id: 't-dev', name: 'Dev team' }, scope: 'interact' });
    s.raw.push({ sessionId: 'thread-twin', source: 'codex', signal: 'tool-use', updatedAt: new Date().toISOString(), cwd: `/private/tmp/plexiform-owned-${state.session.slice(-6)}` });
    await s.poll();
    const owned = s.row('mine-list', /Started by Plexiform/);
    assert.equal(s.rows('mine-list').length, 2, 'owned (with twin folded) + the unrelated observed session');
    assert.match(owned.querySelector('.badges').textContent, /Team: Dev team/);
    assert.match(owned.querySelector('.badges').textContent, /Observed from activity hooks/);
    assert.match(owned.querySelector('.caps').textContent, /Use from other devices or teammates: available/);
  } finally { s.close(); }
});

test('Team sessions: explicit shares only, grouped by person, filters, reasons, hostile text, no private leakage', async () => {
  const s = stack();
  try {
    await s.ready(); await s.team();
    const picks = [...s.$('team-pick').options].map((o) => o.textContent);
    assert.deepEqual(picks, ['Dev team · Fake team hub (test data)'], 'only teams the viewer belongs to');
    assert.match(s.$('team-notice').textContent, /test data, not a real team/);
    assert.equal(s.rows('team-list').length, 2);
    const groups = [...s.$('team-list').querySelectorAll('.dir-group > h3')].map((h) => h.textContent);
    assert.deepEqual(groups, [`Bob ${HOSTILE}`, 'Cara']);
    const bob = s.row('team-list', /Fix login/);
    assert.equal(s.doc.querySelector('img'), null, 'hostile names and titles are text');
    assert.equal(bob.querySelector('.avatar').textContent, 'B<');
    assert.match(bob.textContent, /task title edited by a person/);
    assert.match(bob.textContent, /Reviewer: Review diff/); assert.match(bob.textContent, /Needs input/);
    assert.match(bob.textContent, /Handoff from Cara · offered · Take over tests/);
    assert.match(bob.textContent, /Shared with this team by its owner/);
    const cara = s.row('team-list', /Write docs/);
    assert.match(cara.textContent, /Cara shared this session with your team to watch only/);
    for (const text of [s.doc.body.textContent, JSON.stringify(s.results)]) {
      assert.equal(text.includes('PRIVATE personal side project'), false, 'unshared personal session never leaves main');
      assert.equal(text.includes('OPS-ONLY'), false, 'another team\'s share never leaves main');
    }
    s.change('team-platform-filter', 'Codex'); await tick();
    assert.equal([...s.$('team-list').querySelectorAll('.dir-entry')].length, 1);
    assert.match(s.$('team-count').textContent, /1 of 2/);
    s.change('team-platform-filter', ''); s.change('team-group', 'status'); await tick();
    assert.deepEqual([...s.$('team-list').querySelectorAll('.dir-group > h3')].map((h) => h.textContent), ['Idle', 'Working']);
    // The reported-work sections belong to My sessions only.
    assert.equal(s.doc.querySelector('.work').classList.contains('view-hidden'), true);
  } finally { s.close(); }
});

test('Team sessions: message → acknowledged → reply arrives live; watch-only and forged requests refuse', async () => {
  const s = stack();
  try {
    await s.ready(); await s.team();
    const bob = s.row('team-list', /Fix login/);
    [...bob.querySelectorAll('button')].find((b) => b.textContent === 'Message').click(); await tick();
    const box = bob.querySelector('textarea'); assert.equal(s.doc.activeElement, box);
    box.value = `hello ${HOSTILE}`;
    [...bob.querySelectorAll('button')].find((b) => b.textContent === 'Send').click(); await tick();
    assert.match(bob.textContent, /Queued by the team hub/);
    await wait(400); await tick();
    assert.match(bob.querySelector('.deliveries').textContent, /Sent by Me/);
    assert.match(bob.querySelector('.deliveries').textContent, /replied/);
    assert.match(bob.querySelector('.delivery-response').textContent, /received: hello <img/);
    assert.equal(s.doc.querySelector('img'), null);
    // Watch-only: no control, and a forged request for its id refuses in main.
    const cara = s.results.flatMap(([ch, r]) => (ch === 'overview:directory' && r?.view === 'team' ? r.entries : [])).find((e) => e.owner.name === 'Cara');
    assert.equal((await s.api.teamMessage({ id: cara.id, text: 'x' })).ok, false);
    assert.equal((await s.api.teamMessage({ id: 'f'.repeat(40), text: 'x' })).status, 'stale');
    assert.equal(await s.api.directory({ view: 'team', team: '../etc' }), null, 'preload refuses malformed team keys');
    assert.equal(await s.api.directory({ view: 'everyone' }), null);
    // Background: a focused-only effect refuses.
    s.ctx.foreground = false;
    const bobId = s.results.flatMap(([ch, r]) => (ch === 'overview:directory' && r?.view === 'team' ? r.entries : [])).find((e) => e.kind === 'shared' && e.owner.name.startsWith('Bob')).id;
    assert.equal((await s.api.teamMessage({ id: bobId, text: 'x' })).ok, false);
  } finally { s.close(); }
});

test('Team sessions: live state change, member removal and revocation take effect without manual refresh; rows do not vanish', async () => {
  const s = stack();
  try {
    await s.ready(); await s.team();
    const before = s.results.length;
    s.teamHub.update('cara-1', { state: 'input' });
    await wait(400); await tick();
    assert.ok(s.results.length > before, 'push → re-read, no Refresh click or interval');
    assert.match(s.row('team-list', /Write docs/).querySelector('.tag').textContent, /Needs input/);
    s.teamHub.revoke('bob-1', 't-dev');
    await wait(400); await tick();
    const gone = s.$('team-list').querySelector('.dir-entry.gone');
    assert.ok(gone, 'revoked row stays visible as no longer listed');
    assert.match(gone.textContent, /No longer shared with you, or it ended/);
    assert.equal(gone.textContent.includes('Fix login'), false, 'no task details survive revocation');
    assert.equal(gone.textContent.includes('Reviewer'), false);
    assert.equal([...gone.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent).join(), 'Dismiss');
    // Removed from the team: nothing of teammates remains listed.
    s.teamHub.removeMember('t-dev', 'u-me');
    await wait(400); await tick();
    assert.equal(s.$('team-list').querySelectorAll('.dir-entry:not(.gone)').length, 0);
    assert.equal(s.doc.body.textContent.includes('Write docs'), false);
  } finally { s.close(); }
});

test('Team sessions without a team hub directory: own team work only, with an honest notice', async () => {
  const shares = [];
  const s = stack({ teamHub: null, shares });
  try {
    await s.ready();
    s.$('start-session').click(); await tick();
    const [{ state }] = s.interaction.listOwned();
    shares.push({ session: state.session, team: { id: 't-real', name: 'Real team' }, scope: 'watch' });
    await s.team();
    assert.deepEqual([...s.$('team-pick').options].map((o) => o.textContent), ['Real team']);
    assert.match(s.$('team-notice').textContent, /Teammates' shared sessions appear once your team hub's shared-session directory is connected/);
    assert.equal(s.rows('team-list').length, 1);
    assert.match(s.rows('team-list')[0].textContent, /Started by Plexiform/);
  } finally { s.close(); }
});
