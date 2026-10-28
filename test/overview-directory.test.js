'use strict';
const ORGANISE = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'work-organise.js'), 'utf8'); // views read their state words from it
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
const html = read('overview.html'), script = read('overview.js'), dirScript = read('overview-directory.js'), availScript = read('src/availability.js'), bridge = read('overview-preload.js');
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
    { ref: 'bob-1', owner: 'u-bob', provider: { id: 'claude', label: 'Claude Code' }, device: { label: 'Bob’s Windows PC' }, card: { key: 'DEV-7', title: `Fix login ${HOSTILE}`, edited_by: 'human' }, task_title: 'agent title', state: 'working', observed_ago_ms: 2000, capabilities: { interrupt: true }, children: [{ ref: 'k1', name: 'Reviewer', state: 'input', task_title: 'Review diff', observed_ago_ms: 1000 }], handoffs: [{ direction: 'in', with: 'Cara', state: 'offered', summary: 'Take over tests' }, { direction: 'out', with: 'Dan', state: 'offered', summary: '' }], shares: [{ team: 't-dev', scope: 'interact' }] },
    { ref: 'cara-1', owner: 'u-cara', provider: { id: 'codex', label: 'Codex' }, device: { label: 'Cara’s Mac' }, task_title: 'Write docs', state: 'idle', observed_ago_ms: 3000, shares: [{ team: 't-dev', scope: 'watch' }] },
    { ref: 'bob-private', owner: 'u-bob', provider: { id: 'cursor', label: 'Cursor' }, device: { label: 'Bob’s Windows PC' }, task_title: 'PRIVATE personal side project', state: 'working', observed_ago_ms: 1000, shares: [] },
    { ref: 'eve-ops', owner: 'u-eve', provider: { id: 'gemini', label: 'Gemini' }, device: { label: 'Eve’s laptop' }, task_title: 'OPS-ONLY incident work', state: 'working', observed_ago_ms: 1000, shares: [{ team: 't-ops', scope: 'interact' }] },
  ],
};

function stack({ teamHub = createFakeTeamHub(structuredClone(FIXTURE)), observed = true, shares = [], channelAdapter = null, prepareChannel = null, scripts = [], presence = null, presenceView = null, looseEnds = null, chatPreview = false } = {}) {
  const handlers = new Map(), listeners = new Map(), results = [];
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => ctx.foreground };
  const contents = { id: 9, isDestroyed: () => false, mainFrame: {}, send: (ch, ...a) => { for (const fn of listeners.get(ch) ?? []) fn({}, ...structuredClone(a)); } };
  const ctx = { window: win, contents, generation: 1, document: 1, foreground: true };
  // T1: a sidebar document (its own contents) for sidebar:team-rows, with the chat-first preview on.
  const sidebar = { id: 10, isDestroyed: () => false, mainFrame: {} };
  const buddy = { overviewContext: () => (ctx.foreground ? ctx : null), overviewReadContext: () => ctx, sidebarReadContext: () => ({ window: win, contents: sidebar, generation: 1, document: 1 }) };
  const adapter = memAdapter();
  const interaction = createInteractionMain({ context: () => (ctx.foreground ? ctx : null), readContext: () => ctx, adapters: { codex: adapter,...(channelAdapter?{'claude-channel':channelAdapter}:{}) },prepareChannel, owned: null, localModels: null, workspace: (id) => `/private/tmp/plexiform-owned-${id.slice(-6)}`, currentBoard: () => 'local' });
  interaction.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const now = () => Date.now();
  const raw = [];
  if (observed) raw.push({ sessionId: 'thread-SECRET-1', source: 'codex', signal: 'tool-use', updatedAt: new Date().toISOString(), cwd: '/Users/me/private-repo/checkout' });
  const overview = createOverviewMain({
    buddy: () => buddy, sessions: () => raw, work: async () => ({ sources: [], capture: [] }), now,
    owned: () => interaction.listOwned(), shares: () => ({ origin: 'https://hub.example', list: shares }),
    hubTeams: async () => ({ origin: 'https://hub.example', teams: [] }), teamHub: () => teamHub,
    ...(presence ? { presence } : {}), ...(presenceView ? { presenceView } : {}), ...(looseEnds ? { looseEnds } : {}), chatPreview,
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
  // Optional page helpers (src/session-pins.js etc.) load only when a test asks; a URL gives the page a localStorage origin.
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, ...(scripts.length ? { url: 'http://localhost/' } : {}) });
  const intervals = [];
  dom.window.setInterval = (fn) => intervals.push(fn);
  dom.window.overviewApi = { ...api, onReady: (fn) => { ready = fn; return () => {}; } };
  dom.window.eval(ORGANISE);dom.window.eval(availScript);
  for (const f of scripts) dom.window.eval(read(f));
  dom.window.eval(dirScript);
  dom.window.eval(script);
  const doc = dom.window.document;
  const $ = (id) => doc.getElementById(id);
  const rows = (list) => [...$(list).querySelectorAll('.dir-entry')];
  const row = (list, re) => rows(list).find((r) => re.test(r.textContent));
  const change = (id, value) => { $(id).value = value; $(id).dispatchEvent(new dom.window.Event('change')); };
  return {
    dom, doc, $, rows, row, change, adapter, interaction, overview, teamHub, ctx, api, results, raw,
    sidebarRows: () => handlers.get('sidebar:team-rows')({ sender: sidebar, senderFrame: sidebar.mainFrame }),
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
    assert.match(owned.querySelector('.tag').textContent, /^Idle$/);
    assert.match(observed.textContent, /Activity hooks cannot send to this Codex session/);
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
    await s.interaction.hub.send({session:state.session,generation:state.generation,board:state.board,text:'safe task'},'overview:9:1');
    s.raw.push({ sessionId: 'target-1',codexTurnId:'turn-1', source: 'codex', signal: 'tool-use', updatedAt: new Date().toISOString(), cwd: `/private/tmp/plexiform-owned-${state.session.slice(-6)}` });
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
    const groups = [...s.$('team-list').querySelectorAll('.dir-group > h3')].map((h) => h.firstChild.textContent);
    assert.deepEqual(groups, [`Bob ${HOSTILE}`, 'Cara']);
    const heads = [...s.$('team-list').querySelectorAll('.dir-group > h3')];
    const bobBadge = heads[0].querySelector('.availability'), caraBadge = heads[1].querySelector('.availability');
    assert.equal(bobBadge.dataset.level, 'active', 'Bob is working and reported seconds ago'); assert.equal(bobBadge.textContent, 'Active');
    assert.match(bobBadge.title, /Working in 1 session · last report \d+s ago/);
    assert.equal(caraBadge.dataset.level, 'idle'); assert.equal(caraBadge.textContent, 'Idle');
    const bob = s.row('team-list', /Fix login/);
    assert.equal(s.doc.querySelector('img'), null, 'hostile names and titles are text');
    assert.equal(bob.querySelector('.avatar').textContent, 'B<');
    assert.match(bob.textContent, /task title edited by a person/);
    assert.match(bob.textContent, /Reviewer: Review diff/); assert.match(bob.textContent, /Needs Bob/);
    assert.match(bob.textContent, /Handoff from Cara · offered · Take over tests/);
    assert.match(bob.textContent, /Handed to Dan, waiting/, 'a card handed to a person reads as the board shows it');
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
    assert.deepEqual([...s.$('team-list').querySelectorAll('.dir-group > h3')].map((h) => h.textContent), ['Idle', 'Working on it']);
    // The reported-work sections belong to My sessions only.
    assert.equal(s.doc.querySelector('.work').classList.contains('view-hidden'), true);
  } finally { s.close(); }
});

// Ledger 37 (L-M1): the history list shows who stopped a turn, through the hub's rows and the real session-directory projection.
test('Team sessions (ledger 37): an interrupted message says "‹name› stopped this turn." as text, bounded; nothing otherwise', async () => {
  const s = stack();
  try {
    await s.ready(); await s.team();
    s.teamHub.update('bob-1', { deliveries: [
      { id: 'd-1', text: 'try it', by: 'Me', state: 'interrupted', response: '', stoppedBy: `Cara ${HOSTILE}` },
      { id: 'd-2', text: 'and this', by: 'Me', state: 'replied', response: 'ok', stoppedBy: 'Nobody' },
      { id: 'd-3', text: 'long', by: 'Me', state: 'interrupted', response: '', stoppedBy: 'Z'.repeat(300) },
      { id: 'd-4', text: 'old host', by: 'Me', state: 'interrupted', response: '' }] });
    await wait(400); await tick();
    const items = [...s.row('team-list', /Fix login/).querySelectorAll('.deliveries > li')];
    assert.equal(items.length, 4);
    assert.equal(items[0].querySelector('.reason').textContent, `Cara ${HOSTILE} stopped this turn.`);
    assert.equal(s.doc.querySelector('img'), null, 'text only');
    assert.equal(items[1].querySelector('.reason'), null, 'not interrupted: no line');
    assert.equal(items[2].querySelector('.reason').textContent, `${'Z'.repeat(80)} stopped this turn.`, 'bounded at 80 by the projection');
    assert.equal(items[3].querySelector('.reason'), null, 'an older host sends none');
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
    assert.match(s.row('team-list', /Write docs/).querySelector('.tag').textContent, /Needs Cara/);
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


test('Overview can prepare an explicit Claude channel and select it without replacing another connection',async()=>{
 const ee=new EventEmitter();let prepared=0;
 const channel={label:'Claude Code terminal channel',capabilities:{existingSessions:true,newTurn:true,steer:false,interrupt:false,ack:'channel-accept-tool',echo:'channel-accept-exact-text'},alive:()=>true,discover:async()=>[{id:'private-terminal-target',title:'Synthetic terminal',project:'/tmp/synthetic',status:'idle'}],attach:async({target})=>({target,status:'idle',permissions:{approvalPolicy:'unknown',sandbox:'unknown'}}),release:async()=>true,stop(){},on:f=>{ee.on('e',f);return()=>ee.off('e',f);}};
 const s=stack({channelAdapter:channel,prepareChannel:async({fresh})=>{prepared++;return {ok:fresh(),status:'prepared',command:"claude --mcp-config '/synthetic/private.json'",note:'Approve Claude channel confirmation yourself.'};}});
 try{
  await s.ready();s.$('claude-channel-setup').click();await tick();assert.equal(prepared,1);assert.match(s.$('claude-channel-command').textContent,/private.json/);assert.match(s.$('claude-channel-note').textContent,/yourself/);
  s.$('existing-provider').value='claude-channel';s.$('existing-provider').dispatchEvent(new (s.$('existing-provider').ownerDocument.defaultView.Event)('change'));s.$('existing-find').click();await tick();
  assert.match(s.$('existing-list').textContent,/Synthetic terminal/);assert.equal(s.$('existing-list').textContent.includes('private-terminal-target'),false);
  const use=s.$('existing-list').querySelector('button');assert.ok(use);use.click();await tick();assert.equal(s.interaction.listOwned()[0].state.provider.id,'claude-channel');
 }finally{s.close();}
});

test('board-run team composer distinguishes task-inbox queuing from agent acknowledgement', async () => {
  const base = createFakeTeamHub(structuredClone(FIXTURE));
  const teamHub = { ...base, sessions: async (...args) => Object.assign((await base.sessions(...args)).map((row) => ({ ...row, kind: 'board-run', messageContract: 'task-inbox' })), { partial: true }) };
  const s = stack({ teamHub, observed: false });
  try {
    await s.ready(); await s.team();
    const row = s.row('team-list', /Fix login/);
    assert.ok(row); assert.match(row.textContent, /Queued does not mean received or acknowledged/);
    assert.match(s.$('team-status').textContent, /Some activity is unavailable/);
    [...row.querySelectorAll('.actions button')].find(b => b.textContent === 'Message').click(); await tick();
    assert.match(row.querySelector('.composer').textContent, /Sending does not resume a paused run/);
    row.querySelector('textarea').value = 'Read this task message';
    row.querySelector('.composer button').click(); await tick();
    assert.match(row.querySelector('.composer').textContent, /agent has not acknowledged it yet/);
    s.teamHub.send = async () => ({ ok: false, status: 'unconfirmed', error: 'The task inbox may have queued this message. Do not resend automatically.' });
    const current = (await s.api.directory({ view: 'team', team: null })).entries.find((e) => /Fix login/.test(e.task.title));
    assert.equal((await s.api.teamMessage({ id: current.id, text: 'uncertain delivery' })).status, 'unconfirmed');
    row.querySelector('textarea').value = 'unknown receipt';
    row.querySelector('.composer button').click(); await tick();
    assert.match(row.querySelector('.composer').textContent, /Receipt unconfirmed/);
    assert.doesNotMatch(row.querySelector('.composer').textContent, /Not sent/);
    assert.match(row.querySelector('.composer').textContent, /Do not resend automatically/);
  } finally { s.close(); }
});

test('Team sessions: per-viewer collections group rows locally, filter the list when active, and never leave this device', async () => {
  const s = stack({ scripts: ['src/session-pins.js'] });
  try {
    await s.ready(); await s.team();
    const bob = s.row('team-list', /Fix login/);
    const collect = bob.querySelector('.session-collect'); assert.ok(collect, 'Collect button on a team row');
    collect.click(); await tick();
    const picker = bob.querySelector('.collect-picker'); assert.equal(picker.hidden, false);
    const select = picker.querySelector('select'), input = picker.querySelector('input');
    assert.deepEqual([...select.options].map((o) => o.textContent), ['New collection…'], 'no collections yet');
    assert.equal(input.hidden, false); input.value = 'Release';
    [...picker.querySelectorAll('button')].find((b) => b.textContent === 'Add').click(); await tick();
    const bob2 = s.row('team-list', /Fix login/);
    assert.deepEqual([...bob2.querySelectorAll('.collection-chip')].map((c) => c.firstChild.textContent), ['Release'], 'membership chip under the title');
    const stored = JSON.parse(s.dom.window.localStorage.getItem('plexiform.pins'));
    assert.equal(stored.collections.length, 1); assert.equal(stored.collections[0].name, 'Release'); assert.equal(stored.collections[0].keys.length, 1);
    assert.equal(JSON.stringify(s.results).includes('Release'), false, 'collections never go to main');
    const chips = s.$('saved-filters').querySelector('.collections');
    assert.equal(chips.getAttribute('aria-label'), 'Collections');
    const chip = chips.querySelector('.chip-apply'); assert.equal(chip.textContent, 'Release'); assert.equal(chip.getAttribute('aria-pressed'), 'false');
    chip.click(); await tick();
    assert.equal(chips.querySelector('.chip-apply').getAttribute('aria-pressed'), 'true');
    assert.match(s.$('saved-filters').querySelector('.collection-active').textContent, /Showing collection: Release/);
    assert.ok(s.row('team-list', /Fix login/), 'Bob stays'); assert.equal(s.row('team-list', /Write docs/), undefined, 'Cara is filtered out');
    assert.match(s.$('team-count').textContent, /1 of 2/);
    // Remove the collection: filter clears, both rows return, chip and storage are gone.
    chips.querySelector('.chip-x').click(); await tick();
    assert.equal(s.rows('team-list').length, 2);
    assert.equal(s.$('saved-filters').querySelector('.collection-active').hidden, true);
    assert.equal(s.$('saved-filters').querySelectorAll('.collections .chip').length, 0);
    assert.equal(s.row('team-list', /Fix login/).querySelectorAll('.collection-chip').length, 0);
    assert.deepEqual(JSON.parse(s.dom.window.localStorage.getItem('plexiform.pins')).collections, []);
    assert.equal(s.doc.querySelector('img'), null);
  } finally { s.close(); }
});

// Team depth lane C (C3): the person group header shows what that teammate is looking at or running,
// from the latest board.presence the main-side link holds; opening a shared session's details tells
// the hub its card id (presence.view) and collapsing clears it.
test('Team sessions: "viewing <card title>" / "running <repo>" next to the availability badge, and presence.view on open/close', async () => {
  const hub = createFakeTeamHub(structuredClone({ ...FIXTURE, sessions: FIXTURE.sessions.map((s) => (s.ref === 'bob-1' ? { ...s, card: { ...s.card, id: 'card-7' } } : s)) }));
  let live = {
    members: [
      { member_id: 'm-bob', name: `Bob ${HOSTILE}`, sessions: [{ agent: 'claude', repo_short: `bondly ${HOSTILE}`, branch: 'main', state: 'working' }], viewing: { card_id: 'card-7', since: '2026-10-19T10:00:00Z' } },
      { member_id: 'm-cara', name: 'Cara', sessions: [{ agent: 'codex', repo_short: 'docs', branch: null, state: 'idle' }, { agent: 'codex', repo_short: 'docs', branch: null, state: 'working' }], viewing: null },
      { member_id: 'm-me', name: 'Me', sessions: [{ agent: 'claude', repo_short: 'mine', branch: null, state: 'working' }], viewing: null },
    ],
    viewers: [{ member_id: 'm-bob', name: `Bob ${HOSTILE}`, card_id: 'card-7', key: 'DEV-7', title: `Fix login ${HOSTILE}`, at: '2026-10-19T10:00:00Z' }],
  };
  const asked = [], views = [];
  const s = stack({ teamHub: hub, presence: (team) => { asked.push(team); return live; }, presenceView: (r) => { views.push(r); return 1; } });
  try {
    await s.ready(); await s.team();
    assert.deepEqual([...new Set(asked)], ['t-dev'], 'presence is read for the selected team only');
    const heads = [...s.$('team-list').querySelectorAll('.dir-group > h3')];
    assert.deepEqual(heads.map((h) => h.firstChild.textContent), [`Bob ${HOSTILE}`, 'Cara']);
    const bobNow = heads[0].querySelector('.presence-now'), caraNow = heads[1].querySelector('.presence-now');
    assert.ok(heads[0].querySelector('.availability'), 'the availability badge stays');
    assert.equal(bobNow.textContent, `viewing Fix login ${HOSTILE}`, 'viewing wins over running');
    assert.equal(bobNow.dataset.kind, 'viewing');
    assert.match(bobNow.title, /^DEV-7 · Fix login .* · running bondly /);
    assert.equal(caraNow.textContent, 'running docs', 'each repo once');
    assert.equal(caraNow.dataset.kind, 'running');
    assert.equal(s.doc.querySelector('img'), null, 'hostile names, titles and repos are text');
    // The page never learns member ids or the card id from presence; only what the header shows.
    const wire = JSON.stringify(s.results.filter(([ch]) => ch === 'overview:directory'));
    for (const leak of ['m-bob', 'card-7', 'since']) assert.equal(wire.includes(leak), false, leak);

    // Opening Bob's details → presence.view for his session's card; closing → cleared; a session without a card id sends null.
    const bob = s.row('team-list', /Fix login/), cara = s.row('team-list', /Write docs/);
    const toggle = (row, open) => { const d = row.querySelector('details.caps'); d.open = open; d.dispatchEvent(new s.dom.window.Event('toggle')); };
    toggle(bob, true); await tick();
    assert.deepEqual(views, [{ team: 't-dev', card_id: 'card-7' }]);
    toggle(bob, true); await tick();
    assert.equal(views.length, 1, 'a repeat changes nothing');
    toggle(bob, false); await tick();
    assert.deepEqual(views.at(-1), { team: 't-dev', card_id: null });
    toggle(cara, true); await tick();
    assert.equal(views.length, 2, 'no card id on Cara\'s session: nothing new to send (already cleared)');
    toggle(cara, false); await tick();
    assert.equal(views.length, 2);

    // Presence gone (link closed): the header line disappears, the badge stays.
    live = null;
    s.overview.directoryChanged(); await tick(); await s.poll();
    const heads2 = [...s.$('team-list').querySelectorAll('.dir-group > h3')];
    assert.equal(heads2[0].querySelector('.presence-now'), null);
    assert.ok(heads2[0].querySelector('.availability'));
    // Grouping by something other than person never shows it.
    live = { members: [], viewers: [{ member_id: 'm-cara', name: 'Cara', card_id: 'c-9', key: 'DEV-9', title: 'Docs', at: '2026-10-19T10:00:00Z' }] };
    s.change('team-group', 'status'); await tick();
    assert.equal(s.$('team-list').querySelector('.presence-now'), null);
  } finally { s.close(); }
});

// B3: Burst's loose ends per repository, matched in main to the session's working directory; the page gets counts only.
test('My sessions: a loose-ends badge "n uncommitted · n unpushed · n stashes" per repo row; hidden without Burst\'s report', async () => {
  const LE = require('../src/burst-loose-ends-view.js');
  const AT = 1_792_401_162;
  let report = { report: { at: AT, scanned: 2, repos: [
    { root: '/Users/me/private-repo', branch: 'main', uncommitted: [{ path: '/Users/me/private-repo/a.js', status: ' M', mtime: AT - 100 }, { path: '/Users/me/private-repo/b.js', status: '??', mtime: AT - 100 }], unpushed: [{ hash: 'abc', when: AT - 50, subject: 'SECRET subject' }], ahead: 1, stashes: [{ ref: 'stash@{0}', when: AT - 60 * 3600, subject: 'wip' }] },
    { root: '/Users/me/other', branch: 'dev', uncommitted: [{ path: 'x', status: ' M', mtime: AT }] },
  ] }, stale_hours: 24 };
  const s = stack({ looseEnds: () => (report ? LE.looseEndsView(report) : null) });
  try {
    await s.ready(); await s.poll();
    const observed = s.row('mine-list', /Observed from activity hooks/);
    const badge = observed.querySelector('.loose-ends');
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, 'Loose ends: 2 uncommitted · 1 unpushed · 1 stash · left for a day or more', 'the checkout under /Users/me/private-repo matches that repo; the 60 h stash makes it stale');
    assert.equal(badge.classList.contains('stale'), true);
    // A session in a repository with nothing loose, and one outside any reported repository: no badge.
    s.raw.push({ sessionId: 'claude-1', signal: 'tool-use', updatedAt: new Date().toISOString(), cwd: '/Users/me/other/sub' });
    s.raw.push({ sessionId: 'claude-2', signal: 'tool-use', updatedAt: new Date().toISOString(), cwd: '/Users/me/elsewhere' });
    await s.poll();
    const rowsNow = s.rows('mine-list');
    const texts = rowsNow.map((r) => r.querySelector('.loose-ends')).map((b) => (b.hidden ? '' : b.textContent));
    assert.deepEqual(texts.filter(Boolean).sort(), ['Loose ends: 1 uncommitted', 'Loose ends: 2 uncommitted · 1 unpushed · 1 stash · left for a day or more']);
    // Counts only ever reach the page: no path, branch, file name or commit subject.
    const wire = JSON.stringify(s.results.filter(([ch]) => ch === 'overview:directory'));
    for (const leak of ['/Users/me', 'private-repo', 'a.js', 'SECRET subject', 'stash@', 'branch']) assert.equal(wire.includes(leak), false, leak);
    assert.match(wire, /"looseEnds":\{"uncommitted":2,"unpushed":1,"stashes":1,"stale":true,"text":"2 uncommitted · 1 unpushed · 1 stash"\}/);
    // Capability gone (0.19 Burst, or Burst not answering): the view model is null and every badge hides.
    report = null;
    await s.poll();
    for (const r of s.rows('mine-list')) assert.equal(r.querySelector('.loose-ends').hidden, true);
    assert.equal(JSON.stringify(s.results.at(-1)[1]).includes('"looseEnds":{'), false, 'null, never a zero badge');
  } finally { s.close(); }
});

test('Team sessions: a teammate with an 80-unit name who needs input still renders, with the name cut', async () => {
  const long = 'Maria Fernanda de los Angeles Gonzalez Rodriguez van der Berg Smith-Jones IIII';
  const names = [long + 'x'.repeat(80 - long.length), '😀'.repeat(40), `Ana ${'😀'.repeat(38)}`, '𝓜𝓪𝓻𝓲𝓪 '.repeat(8)];
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const name of names) {
    assert.ok(name.length >= 75, `${name.length}`);
    const fixture = structuredClone(FIXTURE); fixture.users['u-cara'] = name;
    const s = stack({ teamHub: createFakeTeamHub(fixture) });
    try {
      await s.ready(); await s.team();
      s.teamHub.update('cara-1', { state: 'input', self_reported: { state: 'input', at: new Date().toISOString() }, children: [{ ref: 'kid', name: 'Kid', state: 'input', source: 'self-reported', observed_ago_ms: 500 }] });
      await wait(400); await tick();
      const entries = s.results.flatMap(([ch, r]) => (ch === 'overview:directory' && r?.view === 'team' ? r.entries : []));
      const cara = entries.filter((e) => e.task?.title === 'Write docs').at(-1);
      assert.equal(cara.bucket, 'needs');
      const states = [cara.state, cara.selfReported?.state, cara.children[0]?.state, cara.children[0]?.selfReported?.state];
      for (const st of states) {
        assert.ok(typeof st === 'string' && st.length <= 80, `${name}: ${st}`);
        assert.match(st, /^Needs \S/); assert.doesNotMatch(st, lone, 'no half of a surrogate pair');
      }
      assert.match(s.row('team-list', /Write docs/).querySelector('.tag').textContent, /^Needs /, name);
    } finally { s.close(); }
  }
});

// Organised views PR 3: My sessions grouped by project, then status. Entries carry the project as a name, so a
// group's key is keyOf('name', name) — the same name on two folders or devices is one group (until N7).
test('My sessions PR 3: grouped by project name with bucket counts; one name in two folders is one group', async () => {
  const W = require('../src/work-organise.js');
  const s = stack({ scripts: ['src/session-pins.js'] });
  try {
    const at = new Date().toISOString();
    s.raw.push({ sessionId: 'c-2', source: 'codex', signal: 'permission-ask', updatedAt: at, cwd: '/Users/me/elsewhere/checkout' });
    s.raw.push({ sessionId: 'c-3', source: 'codex', signal: 'idle', updatedAt: at, cwd: '/Users/me/app' });
    await s.ready(); await s.poll();
    const groups = [...s.$('mine-list').querySelectorAll('.mine-group')];
    assert.deepEqual(groups.map((g) => g.querySelector('.group-name').textContent), ['app', 'checkout']);
    const checkout = groups[1];
    assert.equal(checkout.dataset.groupKey, W.keyOf('name', 'checkout'));
    assert.match(checkout.dataset.groupKey, /^name-[0-9a-z]{1,7}$/);
    assert.equal(checkout.querySelectorAll('.dir-entry').length, 2, 'two folders named checkout share one group');
    assert.equal(checkout.querySelector('.group-counts').textContent, 'Needs you 1, · Working on it 1');
    assert.deepEqual([...checkout.querySelectorAll('details.bucket')].map((d) => [d.dataset.bucket, d.querySelector('summary').textContent]), [['needs', 'Needs you (1)'], ['working', 'Working on it (1)']]);
    const app = groups[0];
    assert.equal(app.querySelector('details.bucket[data-bucket="idle"]').open, false, 'Idle starts folded');
    assert.ok(app.querySelector('h3 > button.group-toggle'));
    assert.equal(app.querySelector('h3').querySelectorAll('[aria-label]').length + Number(app.querySelector('h3').hasAttribute('aria-label')), 0, 'no aria-label on the heading, its button or a span');
    for (const g of groups) assert.equal(/[\\/]/.test(g.dataset.groupKey), false);
  } finally { s.close(); }
});

test('My sessions PR 3: a fold is saved only in Project mode; Status and AI tool write nothing; the choice and folds come back', async () => {
  const STORE = 'plexiform.overview.mine.groups.v1';
  const s = stack({ scripts: ['src/session-pins.js'] });
  let saved;
  try {
    await s.ready(); await s.poll();
    const ls = s.dom.window.localStorage;
    assert.equal(ls.getItem(STORE), null);
    s.$('mine-list').querySelector('.mine-group .group-toggle').click();
    saved = ls.getItem(STORE);
    assert.deepEqual(Object.values(JSON.parse(saved).closed), [true]);
    for (const by of ['bucket', 'provider']) {
      s.change('mine-group', by); await tick();
      for (const b of s.$('mine-list').querySelectorAll('.group-toggle')) b.click();
      for (const x of s.$('mine-list').querySelectorAll('summary')) x.click();
      assert.equal(ls.getItem(STORE), saved, `${by}: nothing written`);
    }
    assert.deepEqual([...s.$('mine-list').querySelectorAll('.group-name')].map((n) => n.textContent), ['Codex']);
    s.change('mine-group', 'bucket'); await tick();
    assert.equal(s.$('mine-list').querySelector('.group-name').textContent, 'Working on it');
    assert.equal(ls.getItem('plexiform.overview.mine.groupBy.v1'), 'bucket');
    s.change('mine-group', 'project'); await tick();
    assert.equal(s.$('mine-list').querySelector('.group-body').hidden, true, 'the saved fold');
  } finally { s.close(); }
});

// T1: a teammate row clicked in the chat-first sidebar opens here, on Team sessions, with its activity.
test('T1 open hint: the page consumes it on ready, switches to that team and opens the row; a gone row says so', async () => {
  const s = stack({ chatPreview: true });
  try {
    await s.ready();
    const side = await s.sidebarRows();
    const cara = side.rows.find((r) => r.person === 'Cara');
    assert.ok(cara, 'the sidebar lists Cara');
    assert.equal(s.overview.armTeamHint(cara.id), true);
    await s.ready(); await tick(); await tick();
    assert.equal(s.$('tab-team').getAttribute('aria-selected'), 'true', 'Team sessions');
    const box = s.doc.querySelector('.team-activity');
    assert.ok(box, 'the activity is open');
    assert.match(box.getAttribute('aria-label'), /Write docs/);
    assert.ok(s.results.some(([ch]) => ch === 'overview:team-inspect'), 'through the page\'s own inspect');
    assert.equal(s.results.filter(([ch]) => ch === 'overview:open-hint').length, 2);
    // Consumed: another ready opens nothing new.
    assert.equal(await s.api.openHint(), null);
    // A row that is no longer shared: the page says so, nothing is opened.
    assert.equal(s.overview.armTeamHint(side.rows.find((r) => r.person !== 'Cara').id), true);
    s.teamHub.revoke('bob-1', 't-dev');
    await s.ready(); await tick(); await tick();
    assert.equal(s.$('team-status').textContent, 'That session is no longer shared with you.');
    assert.ok(!/Fix login/.test(s.doc.querySelector('.team-activity')?.getAttribute('aria-label') ?? ''), 'Bob\'s activity was not opened');
  } finally { s.close(); }
});
