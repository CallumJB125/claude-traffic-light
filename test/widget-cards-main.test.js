// Main-side wiring of the widget's session cards (src/widget-cards-main.js) over a fake ipcMain.
const test = require('node:test');
const assert = require('node:assert/strict');
const Cards = require('../src/widget-cards-main.js');

const NOW = Date.parse('2026-10-19T12:00:00Z');
function rig({ sessions = [], cfg = {}, spend = () => null, allowed = () => true, teammates } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const saved = [];
  const config = { load: () => cfg, save: (p) => { saved.push(p); Object.assign(cfg, p); } };
  const api = Cards.install({ ipcMain, getSessions: () => (teammates ? { sessions, teammates } : sessions), getSpend: spend, config, allowed, now: () => NOW, home: '/Users/me' });
  return { handlers, saved, cfg, api, call: (ch, e, ...a) => handlers.get(ch)(e || {}, ...a) };
}

test('registers exactly the seven widget channels (QoL3b: session-snooze)', () => {
  const { handlers } = rig();
  assert.deepEqual([...handlers.keys()].sort(), ['widget:card-help', 'widget:pin-session', 'widget:resume-nudges', 'widget:session-cards', 'widget:session-copy-resume', 'widget:session-open', 'widget:session-snooze']);
});

test('cards carry the view, the spend for local rows, and never the raw row; the path only as the ~ folder line', async () => {
  const r = rig({ sessions: [{ sessionId: 's1', cwd: '/Users/me/secret/plex', signal: 'tool-use', tool: 'Bash', prompt: 'do not leak' }], spend: async (id) => (id === 's1' ? { cost_usd: 2, unpriced: 0 } : null) });
  const m = await r.call('widget:session-cards');
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].card.title, 'plex');
  assert.equal(m.rows[0].card.spend, '$2.00 this session');
  assert.equal(m.rows[0].card.folder, '~/secret/plex');
  const text = JSON.stringify(m);
  assert.ok(!text.includes('/Users/me') && !text.includes('do not leak'));
});

test('pinning persists widgetPinnedSession and puts that row first; null unpins', async () => {
  const r = rig({ sessions: [{ sessionId: 'a', signal: 'tool-use' }, { sessionId: 'b', signal: 'idle' }] });
  assert.deepEqual(await r.call('widget:pin-session', null, 'b'), { ok: true, pinned: 'b' });
  assert.deepEqual(r.saved, [{ widgetPinnedSession: 'b' }]);
  const m = await r.call('widget:session-cards');
  assert.equal(m.pinnedId, 'b');
  assert.equal(m.rows[0].id, 'b');
  assert.deepEqual(m.rows[0].card.actions, ['open', 'snooze', 'unpin']);
  assert.deepEqual(await r.call('widget:pin-session', null, null), { ok: true, pinned: null });
  assert.equal(r.cfg.widgetPinnedSession, null);
});

test('a malformed pin id is refused and nothing is saved', async () => {
  const r = rig();
  assert.equal((await r.call('widget:pin-session', null, '../../etc')).ok, false);
  assert.equal((await r.call('widget:pin-session', null, { x: 1 })).ok, false);
  assert.deepEqual(r.saved, []);
});

test('other senders get nothing', async () => {
  const r = rig({ sessions: [{ sessionId: 'a', signal: 'tool-use' }], allowed: () => false });
  assert.equal(await r.call('widget:session-cards'), null);
  assert.deepEqual(await r.call('widget:pin-session', null, 'a'), { ok: false, pinned: null });
  assert.deepEqual(r.saved, []);
});

test('teammates come back as a team row with initials; spend failures do not break cards', async () => {
  const r = rig({ sessions: [{ sessionId: 'a', signal: 'tool-use' }], spend: () => { throw new Error('no usage'); }, teammates: [{ member_id: 'm', name: 'Bo Chen', sessions: [{ agent: 'codex', repo_short: 'site', state: 'running' }] }] });
  const m = await r.call('widget:session-cards');
  assert.equal(m.rows[0].card.spend, '');
  assert.equal(m.team.length, 1);
  assert.deepEqual(m.team[0].card.teammate, { name: 'Bo Chen', initials: 'BC' });
  assert.equal(m.team[0].team, true);
});

test('install refuses without a config store', () => {
  assert.throws(() => Cards.install({ ipcMain: { handle() {} } }), /config/);
});

test('cards take explain, deploy and paused-nudge slices; help and resume go through their own channels', async () => {
  const handlers = new Map();
  const calls = [];
  Cards.install({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, config: { load: () => ({}), save: () => {} }, now: () => NOW,
    getSessions: () => [{ sessionId: 's1', cwd: '/w/shop', signal: 'stop', updatedAt: new Date(NOW).toISOString() }],
    getExplain: (s) => ({ recap: { headline: `recap ${s.sessionId}`, line: 'l' }, help: [], why: null }),
    getDeploy: (cwd) => (cwd === '/w/shop' ? { label: 'Vercel', name: 'shop', state: 'live' } : null),
    nudgesPaused: (id) => id === 's1', copyHelp: (h) => { calls.push(['help', h]); return { ok: true }; }, resumeNudges: (id) => { calls.push(['resume', id]); return { ok: true }; } });
  const m = await handlers.get('widget:session-cards')({});
  const card = m.rows[0].card;
  assert.equal(card.recap.headline, 'recap s1');
  assert.equal(card.deploy, 'Vercel · shop: live');
  assert.equal(card.nudgesPaused, true);
  // QoL2: the folder line is the only place the path shows (outside the home folder it can't be shortened).
  assert.equal(card.folder, '/w/shop');
  assert.ok(!JSON.stringify({ ...m, rows: m.rows.map((r) => ({ ...r, card: { ...r.card, folder: null } })) }).includes('/w/shop'));
  assert.deepEqual(await handlers.get('widget:card-help')({}, 'h1'), { ok: true });
  assert.deepEqual(await handlers.get('widget:card-help')({}, 7), { ok: false });
  assert.deepEqual(await handlers.get('widget:resume-nudges')({}, 's1'), { ok: true });
  assert.deepEqual(await handlers.get('widget:resume-nudges')({}, '../x'), { ok: false });
  assert.deepEqual(calls, [['help', 'h1'], ['resume', 's1']]);
});
