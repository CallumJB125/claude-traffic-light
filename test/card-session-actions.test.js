'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../buddy-window/card-session-actions');
function rig(over = {}) {
  const token = {}, effects = [], options = [];
  let live = true, doc = { markdown: '# Recorded work\nNext: review it.' };
  const bridge = { localHandover: async (id, opts) => { options.push({ id, opts }); return doc; }, sessionForCard: async () => ({ adapter: 'codex', sessionId: 'exact-session' }) };
  const act = create({ bridge, capture: e => e === token ? token : null, current: t => live && t === token,
    copy: text => effects.push(['copy', text]), save: (file, text) => effects.push(['save', file, text]), choose: async () => '/chosen/handover.md', open: key => { effects.push(['open', key]); return true; }, ...over });
  return { token, effects, options, bridge, act, revoke: () => { live = false; }, unshare: () => { doc = null; } };
}
test('card actions reject other documents, forged card paths and unsupported operations before reading', async () => {
  const r = rig();
  for (const [e, action, id] of [[{}, 'copy', 'card-1'], [r.token, 'copy', '../secret'], [r.token, 'execute', 'card-1']]) assert.equal((await r.act(e, action, id)).ok, false);
  assert.deepEqual(r.options, []); assert.deepEqual(r.effects, []);
});
test('copy uses the resolved recorded handover as a resume prompt, and refresh explicitly regenerates it', async () => {
  const r = rig(); assert.equal((await r.act(r.token, 'copy', 'card-1')).ok, true);
  assert.match(r.effects[0][1], /check the repository state/); assert.match(r.effects[0][1], /Recorded work/);
  assert.equal((await r.act(r.token, 'refresh', 'card-1')).markdown, '# Recorded work\nNext: review it.');
  assert.equal(r.options.at(-1).opts.refresh, true);
});
test('open selects the exact provider session resolved from the card', async () => {
  const r = rig(); assert.equal((await r.act(r.token, 'open', 'card-1')).ok, true); assert.deepEqual(r.effects, [['open', 'codex-exact-session']]);
});
test('a board/document change during resolution withholds copy and navigation', async () => {
  const r = rig(); r.bridge.localHandover = async () => { r.revoke(); return { markdown: 'old document' }; };
  assert.equal((await r.act(r.token, 'copy', 'card-1')).ok, false); assert.deepEqual(r.effects, []);
  const s = rig(); s.bridge.sessionForCard = async () => { s.revoke(); return { adapter: 'codex', sessionId: 'old' }; };
  assert.equal((await s.act(s.token, 'open', 'card-1')).ok, false); assert.deepEqual(s.effects, []);
});
test('save re-resolves sharing after the dialog and writes nothing after revocation', async () => {
  let r; r = rig({ choose: async () => { r.unshare(); return '/chosen/handover.md'; } });
  assert.equal((await r.act(r.token, 'save', 'card-1')).ok, false); assert.deepEqual(r.effects, []); assert.equal(r.options.length, 2);
  const yes = rig(); assert.equal((await yes.act(yes.token, 'save', 'card-1')).ok, true); assert.equal(yes.effects[0][0], 'save');
});
test('save chooses a destination using the captured originating-window token', async () => {
  let chosen;
  const r = rig({ choose: async token => { chosen = token; return '/chosen/handover.md'; } });
  assert.equal((await r.act(r.token, 'save', 'card-1')).ok, true);
  assert.equal(chosen, r.token);
});
test('cancelled save leaves all files untouched', async () => {
  const r = rig({ choose: async () => null }); assert.equal((await r.act(r.token, 'save', 'card-1')).cancelled, true); assert.deepEqual(r.effects, []);
});

function bridgeRig(over = {}) {
  const { createSessionBridge } = require('../buddy-window/session-bridge');
  const root = require('./helpers/tmp').testTempDir('card-session-');
  let team = 't1', refresh = async () => ({ ok: true });
  const bridge = createSessionBridge({ userData: root, hubs: () => [], clientFor: () => ({}), userOf: () => null, signedIn: () => false, supervisor: {},
    workCapture: { overviewSnapshot: () => [], routes: async () => ({ routes: [] }) },
    handoverWriter: () => ({ text: () => '# Allowed local session', refresh: (...args) => refresh(...args) }),
    currentHub: () => 'https://hub.test', currentTeam: () => team, rootOf: async () => '/safe/repo', ...over });
  bridge.links.attach({ provider: 'codex', session_id: 's1', card_id: 'card-1', destination: { kind: 'team', hub: 'https://hub.test', team_id: 't1', board_id: 'b1' } });
  const share = require('../src/burst-handover').repoKey('/safe/repo');
  bridge.links.setShare(share, true); bridge.sessionsChanged([{ source: 'codex', sessionId: 's1', cwd: '/safe/repo' }]);
  return { bridge, revoke: () => bridge.links.setShare(share, false), team: t => { team = t; }, refreshing: fn => { refresh = fn; } };
}
test('local handover and session resolution honor the exact current team on a shared hub', async () => {
  const r = bridgeRig(); assert.ok(await r.bridge.localHandover('card-1'));
  r.team('t2'); assert.equal(await r.bridge.localHandover('card-1'), null); assert.equal(await r.bridge.sessionForCard('card-1'), null);
});
test('revoking sharing during writer refresh withholds the handover', async () => {
  const r = bridgeRig(); r.refreshing(async () => { r.revoke(); return { ok: true }; });
  assert.equal(await r.bridge.localHandover('card-1', { refresh: true }), null);
});
test('changing the card session binding during writer refresh withholds the old handover', async () => {
  const r = bridgeRig(); r.refreshing(async () => {
    r.bridge.links.attach({ provider: 'codex', session_id: 's1', card_id: 'other-card', destination: { kind: 'team', hub: 'https://hub.test', team_id: 't1', board_id: 'b1' } });
    return { ok: true };
  });
  assert.equal(await r.bridge.localHandover('card-1', { refresh: true }), null);
});
test('revoking sharing while repository resolution awaits releases no handover text', async () => {
  let r, change = false; r = bridgeRig({ rootOf: async () => { if (change) r.revoke(); return '/safe/repo'; } }); change = true;
  assert.equal(await r.bridge.localHandover('card-1'), null);
});
test('a newly attached earlier row cannot replace the exact session refreshed for this card', async () => {
  const other = { provider: 'codex', session_id: 's0', card_id: 'other-card', destination: { kind: 'team', hub: 'https://hub.test', team_id: 't1', board_id: 'b1' } };
  const r = bridgeRig({ workCapture: { overviewSnapshot: () => [other], routes: async () => ({ routes: [] }) },
    handoverWriter: () => ({ text: key => `# Exact ${key}`, refresh: async () => { other.card_id = 'card-1'; return { ok: true }; } }) });
  r.bridge.sessionsChanged([{ source: 'codex', sessionId: 's1', cwd: '/safe/repo' }, { source: 'codex', sessionId: 's0', cwd: '/safe/repo' }]);
  assert.equal((await r.bridge.localHandover('card-1', { refresh: true })).markdown, '# Exact codex-s1');
});
