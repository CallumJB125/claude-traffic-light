const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const R = require('../rules.js');
const H = require('../hooks/install.js');
const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');

const rules = () => R.defaultRules();
const look = (sessions, rs = rules(), now) => R.resolve(rs, sessions, now).look;

test('idle: no sessions resolves the idle rule', () => {
  const l = look([]);
  assert.equal(l.lamp, 'amber');
  assert.equal(l.pose, 'none');
  assert.equal(l.eyes, 'default');
  assert.equal(l.ruleId, 'idle');
});

test('working owns lamp + pose; eyes stay default', () => {
  const l = look([{ signal: 'tool-use', tool: 'Bash' }]);
  assert.deepEqual([l.lamp, l.pose, l.eyes], ['green', 'think', 'default']);
});

test('a finished session never leaks its eyes onto a working one', () => {
  const l = look([{ signal: 'stop' }, { signal: 'tool-use', tool: 'Edit' }]);
  assert.equal(l.lamp, 'green');
  assert.equal(l.pose, 'think');
  assert.equal(l.eyes, 'default', 'green eyes from "done" must not bleed through');
  assert.equal(l.celebrate, false);
});

test('finished on its own shows thumbs, green eyes and confetti', () => {
  const l = look([{ signal: 'stop' }]);
  assert.deepEqual([l.lamp, l.pose, l.eyes, l.celebrate], ['green', 'thumbs', '#2fae3e', true]);
});

test('an accent rule above the lamp owner layers on: subagent eyes over working lamp', () => {
  const l = look([{ signal: 'tool-use', tool: 'Agent' }]);
  assert.deepEqual([l.lamp, l.pose, l.eyes], ['green', 'think', '#8b5cf6']);
});

test('permission beats working and beeps; an accent below it does not layer', () => {
  const l = look([{ signal: 'tool-use', tool: 'Agent' }, { signal: 'permission-ask' }]);
  assert.deepEqual([l.lamp, l.pose, l.eyes, l.sound], ['amber', 'wave', 'default', 'beep']);
});

test('an accent dragged above a locked rule still cannot outrank it, but does layer', () => {
  const rs = rules();
  const i = rs.findIndex((r) => r.id === 'subagent');
  const [sub] = rs.splice(i, 1);
  rs.unshift(sub);
  const l = look([{ signal: 'tool-use', tool: 'Agent' }, { signal: 'permission-ask' }], rs);
  assert.equal(l.lamp, 'amber', 'locked rule still owns the lamp');
  assert.equal(l.eyes, 'default', 'locked rules sort above everything, so the accent stays below');
});

test('limit beats everything and closes the eyes', () => {
  const l = look([{ signal: 'limit-hit' }, { signal: 'permission-ask' }, { signal: 'tool-use', tool: 'Agent' }]);
  assert.deepEqual([l.lamp, l.pose, l.eyes], ['red', 'sleep', 'closed']);
});

test('locked rules stay on top even when dragged below', () => {
  const rs = rules();
  const [limit] = rs.splice(0, 1);
  rs.push(limit);
  const l = look([{ signal: 'limit-hit' }, { signal: 'tool-use' }], rs);
  assert.equal(l.lamp, 'red');
});

test('disabled rules never fire', () => {
  const rs = rules().map((r) => (r.id === 'working' ? { ...r, enabled: false } : r));
  const l = look([{ signal: 'tool-use' }], rs);
  assert.equal(l.lamp, 'off');
  assert.equal(l.ruleId, null);
});

test('tool matching: exact is case-insensitive, prefix glob works, no tool never matches a scoped rule', () => {
  assert.equal(look([{ signal: 'tool-use', tool: 'agent' }]).eyes, '#8b5cf6');
  const rs = [{ id: 'm', name: 'mcp', when: { signal: ['tool-use'], tool: 'mcp__*' }, then: { lamp: 'green', eyes: '#ff00ff' } }];
  assert.equal(look([{ signal: 'tool-use', tool: 'mcp__playwright__click' }], rs).eyes, '#ff00ff');
  assert.equal(look([{ signal: 'tool-use', tool: 'Bash' }], rs).lamp, 'off');
  assert.equal(look([{ signal: 'tool-use' }], rs).lamp, 'off');
});

test('legacy colour-state session files still resolve', () => {
  assert.equal(look([{ state: 'green' }]).lamp, 'green');
  assert.equal(look([{ state: 'amber' }]).lamp, 'amber');
  assert.equal(look([{ state: 'red' }]).lamp, 'red');
  assert.equal(look([{ state: 'done' }]).pose, 'thumbs');
  assert.equal(look([{ state: 'bogus' }]).ruleId, 'idle', 'unreadable state counts as no session');
});

test('virtual signals: many-sessions and long-running', () => {
  const rs = [
    { id: 'busy', name: 'busy', when: { signal: ['many-sessions'] }, then: { eyes: '#ffffff' } },
    { id: 'long', name: 'long', when: { signal: ['long-running'] }, then: { pose: 'wave' } },
    ...rules(),
  ];
  const now = Date.parse('2026-09-09T12:00:00Z');
  const three = [1, 2, 3].map(() => ({ signal: 'tool-use', workingSince: new Date(now - 60e3).toISOString() }));
  let l = look(three, rs, now);
  assert.equal(l.eyes, '#ffffff');
  assert.equal(l.pose, 'think', 'not long-running yet');
  l = look([{ signal: 'tool-use', workingSince: new Date(now - R.LONG_RUNNING_MS - 1).toISOString() }], rs, now);
  assert.equal(l.pose, 'wave');
  assert.equal(l.eyes, 'default');
  l = look([{ signal: 'permission-ask', workingSince: new Date(now - 3 * R.LONG_RUNNING_MS).toISOString() }], rs, now);
  assert.equal(l.pose, 'wave', 'permission still waves');
  assert.equal(R.virtualSessions([{ signal: 'permission-ask', workingSince: new Date(0).toISOString() }], now).length, 0, 'waiting sessions are not long-running');
});

test('normalizeRule sanitises junk', () => {
  const r = R.normalizeRule({ name: '', when: { signal: 'stop', tool: '  ' }, then: { lamp: 'purple', lampColor: 'red', eyes: 'blue', pose: 'dab', sound: 'loud', celebrate: 'yes' } });
  assert.equal(r.name, 'Untitled rule');
  assert.deepEqual(r.when, { signal: ['stop'], tool: null, cwd: null, source: null });
  assert.deepEqual(r.then, { lamp: null, lampColor: null, lampFx: null, sign: null, lampShape: null, signFx: null, number: null, screenFx: null, eyes: null, pose: null, sound: null, celebrate: true, text: null, costume: null, body: null, bodyColor: null, effect: null, pet: null, clicks: {} });
  assert.equal(R.normalizeRule({ then: { sound: 'Glass' } }).then.sound, 'Glass');
  assert.equal(R.normalizeRule({ then: { sound: 'file:/x/y.wav' } }).then.sound, 'file:/x/y.wav');
  assert.equal(R.normalizeRule({ then: { sound: 'airhorn' } }).then.sound, null);
  assert.equal(R.normalizeRule({ then: { eyes: 'laser' } }).then.eyes, 'laser');
  assert.match(r.id, /^[a-z0-9]{6}$/);
});

test('banner text rides with the pose owner and is capped at 24 chars', () => {
  const rs = [{ id: 'b', name: 'b', when: { signal: ['permission-ask'] }, then: { lamp: 'amber', pose: 'banner', text: '  needs you now, seriously please  ' } }];
  const l = look([{ signal: 'permission-ask' }], rs);
  assert.equal(l.pose, 'banner');
  assert.equal(l.text, 'needs you now, seriously');
  assert.equal(look([{ signal: 'tool-use' }]).text, null);
});

test('previewLook shows only the rule\'s own channels', () => {
  const p = R.previewLook(rules().find((r) => r.id === 'subagent'));
  assert.deepEqual([p.lamp, p.eyes, p.pose], ['off', '#8b5cf6', 'none']);
});

test('costume is an accent channel: layers above the lamp owner, never leaks from below', () => {
  const rs = [
    { id: 'hat', name: 'hat', when: { signal: ['tool-use'], tool: 'Agent' }, then: { costume: 'wizard' } },
    ...rules(),
    { id: 'below', name: 'below', when: { signal: ['tool-use'] }, then: { costume: 'dog' } },
  ];
  assert.equal(look([{ signal: 'tool-use', tool: 'Agent' }], rs).costume, 'wizard');
  assert.equal(look([{ signal: 'tool-use', tool: 'Bash' }], rs).costume, 'none');
  assert.equal(R.normalizeRule({ then: { costume: 'dragon' } }).then.costume, null);
  assert.equal(R.previewLook({ then: { costume: 'halo' } }).costume, 'halo');
});

test('project scope: folder name or prefix glob', () => {
  const rs = [{ id: 'b', name: 'b', when: { signal: ['tool-use'], cwd: 'bondly*' }, then: { bodyColor: '#1155cc' } }, ...rules()];
  assert.equal(look([{ signal: 'tool-use', cwd: '/x/bondly-cf' }], rs).bodyColor, '#1155cc');
  assert.equal(look([{ signal: 'tool-use', cwd: '/x/other' }], rs).bodyColor, null);
  const exact = [{ id: 'b', name: 'b', when: { signal: ['tool-use'], cwd: 'redoubt' }, then: { pet: 'duck' } }, ...rules()];
  assert.equal(look([{ signal: 'tool-use', cwd: '/x/Redoubt' }], exact).pet, 'duck');
  assert.equal(look([{ signal: 'tool-use', cwd: '/x/redoubt-2' }], exact).pet, 'none');
});

test('rage meter: ignored-N signals from waiting age; waitMinutes reported', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  const ago = (m) => new Date(now - m * 60000).toISOString();
  const l10 = look([{ signal: 'idle-nudge', updatedAt: ago(12) }], rules(), now);
  assert.equal(l10.pose, 'none', 'default rules: 12 min → still the plain waiting look');
  assert.equal(l10.waitMinutes, 12);
  const l20 = look([{ signal: 'idle-nudge', updatedAt: ago(21) }], rules(), now);
  assert.equal(l20.pose, 'arms');
  assert.equal(l20.effect, 'beard');
  assert.equal(l20.lamp, 'green', 'lamp still from the waiting rule below');
  const busy = look([{ signal: 'tool-use', updatedAt: ago(40) }], rules(), now);
  assert.equal(busy.waitMinutes, 0, 'a working session is not waiting');
  assert.deepEqual(R.virtualSessions([{ signal: 'permission-ask', updatedAt: ago(35) }], now).map((v) => v.signal), ['ignored-10', 'ignored-20', 'ignored-30']);
});

test('ignored-N is measured from your last touch of any session, not the oldest one', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  const ago = (m) => new Date(now - m * 60000).toISOString();
  const stale = { signal: 'idle-nudge', updatedAt: ago(240), cwd: '/old' };
  const fresh = { signal: 'idle-nudge', updatedAt: ago(3), cwd: '/new' };
  const signals = R.virtualSessions([stale, fresh], now).map((v) => v.signal);
  assert.ok(!signals.some((s) => s.startsWith('ignored-')), `just answered elsewhere → nothing is ignored (${signals})`);
  const later = R.virtualSessions([stale, { ...fresh, updatedAt: ago(25) }], now).map((v) => v.signal);
  assert.deepEqual(later.filter((s) => s.startsWith('ignored-')).sort(), ['ignored-10', 'ignored-10', 'ignored-20', 'ignored-20'], '25 min since any touch → both waiting sessions count');
});

test('seasonal costumes by date', () => {
  assert.equal(R.seasonalCostume(Date.parse('2026-12-20T12:00:00')), 'santa');
  assert.equal(R.seasonalEffect(Date.parse('2026-12-20T12:00:00')), 'snow');
  assert.equal(R.seasonalCostume(Date.parse('2026-10-30T12:00:00')), 'pumpkin');
  assert.equal(R.seasonalCostume(Date.parse('2026-04-05T12:00:00')), 'bunny');
  assert.equal(R.seasonalCostume(Date.parse('2026-01-01T12:00:00')), 'partyhat');
  assert.equal(R.seasonalCostume(Date.parse('2026-09-09T12:00:00')), null);
});

test('body, effect and pet are accent channels', () => {
  const rs = [{ id: 'g', name: 'g', when: { signal: ['tool-use'], tool: 'Agent' }, then: { body: 'ghost', effect: 'fire', pet: 'blob' } }, ...rules()];
  const l = look([{ signal: 'tool-use', tool: 'Agent' }], rs);
  assert.deepEqual([l.body, l.effect, l.pet, l.lamp], ['ghost', 'fire', 'blob', 'green']);
  const p = R.previewLook({ then: { effect: 'beard' } });
  assert.equal(p.waitMinutes, 20, 'preview shows a grown beard');
});

test('lamp effect is an accent channel; green keeps its pulse only when none is set', () => {
  const rs = [{ id: 'f', name: 'f', when: { signal: ['tool-use'], tool: 'Agent' }, then: { lampFx: 'strobe' } }, ...rules()];
  assert.equal(look([{ signal: 'tool-use', tool: 'Agent' }], rs).lampFx, 'strobe');
  assert.equal(look([{ signal: 'tool-use', tool: 'Bash' }], rs).lampFx, 'none');
  assert.equal(R.normalizeRule({ then: { lampFx: 'disco' } }).then.lampFx, null);
});

test('sign, lamp shape, sign effect, number and screen effect are accent channels', () => {
  const rs = [{ id: 's', name: 's', when: { signal: ['tool-use'], tool: 'Agent' }, then: { sign: 'h5', lampShape: 'heart', signFx: 'neon', number: 'tasks', screenFx: 'vignette' } }, ...rules()];
  const l = look([{ signal: 'tool-use', tool: 'Agent' }], rs);
  assert.deepEqual([l.sign, l.lampShape, l.signFx, l.numberOf, l.screenFx], ['h5', 'heart', 'neon', 'tasks', 'vignette']);
  const d = look([{ signal: 'tool-use', tool: 'Bash' }], rs);
  assert.deepEqual([d.sign, d.lampShape, d.signFx, d.numberOf, d.screenFx], ['h3', 'square', 'none', null, 'none']);
  assert.equal(R.normalizeRule({ then: { number: 'none' } }).then.number, null);
  assert.equal(R.normalizeRule({ then: { lampShape: 'triangle' } }).then.lampShape, null);
});

test('clicks: per-gesture actions layer like accents and fall back to defaults', () => {
  const rs = [
    { id: 'a', name: 'a', when: { signal: ['tool-use'], tool: 'Agent' }, then: { clicks: { click: { type: 'url', arg: 'https://x.dev' } } } },
    ...rules(),
  ];
  const l = look([{ signal: 'tool-use', tool: 'Agent' }], rs);
  assert.deepEqual(l.clicks.click, { type: 'url', arg: 'https://x.dev' });
  assert.deepEqual(l.clicks.double, R.DEFAULT_CLICKS.double, 'unset gestures fall back');
  const plain = look([{ signal: 'tool-use', tool: 'Bash' }], rs);
  assert.equal(plain.clicks.click.type, 'jump');
  const junk = R.normalizeRule({ then: { clicks: { click: { type: 'explode' }, alt: { type: 'say', arg: '  hi  ' }, weird: { type: 'jump' } } } });
  assert.deepEqual(junk.then.clicks, { alt: { type: 'say', arg: 'hi' } });
});

// ── other agents: signals ───────────────────────────────────────────────────
const agent = (id, kind = 'subagent', status = 'working') => ({ id, name: id, kind, status });

test('subagents: one live subagent fires the signal; a finished one does not', () => {
  const v = (s) => R.virtualSessions([s]).map((x) => x.signal);
  assert.ok(v({ signal: 'tool-use', agents: [agent('a1')] }).includes('subagents'));
  assert.ok(!v({ signal: 'tool-use', agents: [agent('a1', 'subagent', 'done')] }).includes('subagents'));
  assert.ok(!v({ signal: 'tool-use' }).includes('subagents'), 'a session with no agents is silent');
});

test('team fires on team mode or on a teammate; ralph carries its iteration', () => {
  const v = (s) => R.virtualSessions([s]);
  assert.ok(v({ signal: 'tool-use', mode: 'team' }).some((x) => x.signal === 'team'));
  assert.ok(v({ signal: 'tool-use', agents: [agent('t1', 'teammate')] }).some((x) => x.signal === 'team'));
  const ralph = v({ signal: 'tool-use', mode: 'ralph', iteration: 7 }).find((x) => x.signal === 'ralph');
  assert.equal(ralph.iteration, 7);
  assert.ok(!v({ signal: 'tool-use', mode: 'nonsense' }).some((x) => x.signal === 'ralph'), 'an unknown mode is ignored');
});

test('agents-many counts live agents across every session, not sessions', () => {
  const many = R.virtualSessions([
    { signal: 'tool-use', agents: [agent('a1'), agent('a2')] },
    { signal: 'tool-use', agents: [agent('b1', 'teammate'), agent('b2', 'subagent', 'done')] },
  ]).find((x) => x.signal === 'agents-many');
  assert.equal(many.agents, 3, 'the finished one does not count');
  assert.ok(!R.virtualSessions([{ signal: 'tool-use', agents: [agent('a1'), agent('a2')] }]).some((x) => x.signal === 'agents-many'));
});

test('default rules: ralph runs and shows its iteration, swarm counts agents', () => {
  const l = look([{ signal: 'tool-use', mode: 'ralph', iteration: 7, agents: [agent('a1'), agent('a2'), agent('a3')] }]);
  assert.equal(l.pose, 'run', 'the ralph rule owns the pose');
  assert.equal(l.text, 'LOOP 7', '{iteration} is filled in from the session');
  assert.equal(l.numberOf, 'ralph', 'ralph owns the number before swarm does');
  assert.equal(l.eyes, '#f2a200', 'swarm still layers its eyes');
  assert.equal(l.lamp, 'green', 'and working still owns the lamp');
  const swarm = look([{ signal: 'tool-use', agents: [agent('a1'), agent('a2'), agent('a3')] }]);
  assert.equal(swarm.numberOf, 'agents');
  const team = look([{ signal: 'tool-use', mode: 'team' }]);
  assert.equal(team.pet, 'duck');
});

test('liveAgents and ralphIteration read the session set', () => {
  const sessions = [
    { cwd: '/x/one', mode: 'ralph', iteration: 3, agents: [agent('a1'), agent('a2', 'subagent', 'done')] },
    { cwd: '/x/two', mode: 'ralph', iteration: 9, agents: [{ id: 'b1' }] },
  ];
  assert.deepEqual(R.liveAgents(sessions).map((a) => [a.name, a.kind, a.status, a.cwd]), [
    ['a1', 'subagent', 'working', '/x/one'],
    ['b1', 'subagent', 'working', '/x/two'],
  ], 'defaults fill in for a bare entry');
  assert.equal(R.ralphIteration(sessions), 9, 'the furthest loop wins');
  assert.equal(R.ralphIteration([{ mode: 'team' }]), 0);
});

test('the new signals are offered in the editor and the number modes grow', () => {
  for (const id of ['subagents', 'team', 'ralph', 'agents-many']) {
    assert.ok(R.SIGNALS.some((s) => s.id === id && s.kind === 'virtual'), `${id} is listed`);
  }
  assert.ok(R.NUMBERS.includes('agents') && R.NUMBERS.includes('ralph'));
  for (const r of R.defaultRules()) assert.equal(typeof r.enabled, 'boolean');
  const added = R.defaultRules().filter((r) => ['ralph', 'swarm', 'team'].includes(r.id));
  assert.equal(added.length, 3);
  for (const r of added) { assert.equal(r.enabled, true); assert.equal(!!r.locked, false); }
});

// ── other agents: reading OMC and Claude Code state off disk ────────────────
const A = require('../agents.js');
const FIX = path.join(__dirname, 'fixtures', 'omc');
const scan = (session, extra = {}) => A.scanAgents(session, { stateDir: path.join(FIX, 'state'), teamsDir: path.join(FIX, 'teams'), now: 1788871500000, ...extra });

test('omc state: ralph iteration, team mode and every agent it can see', () => {
  const r = scan({ sessionId: 'sess-1', cwd: '/tmp/proj' });
  assert.equal(r.mode, 'team', 'team-state wins over the ralph and ultrawork loops');
  assert.equal(r.iteration, 7, 'the ralph iteration still comes through');
  const by = Object.fromEntries(r.agents.map((a) => [a.name, a]));
  assert.deepEqual([by.executor.kind, by.executor.status], ['ralph', 'working'], 'parent_mode names the kind');
  assert.equal(by.architect.status, 'done', '"completed" is done');
  assert.equal(by['verifier:bbf12aa'].status, 'waiting', '"blocked" is waiting');
  assert.equal(by['executor:aaf55ec'].kind, 'teammate');
  assert.ok(!r.agents.some((a) => a.name === 'writer:ccc'), 'a finished mission contributes nobody');
  assert.deepEqual(r.agents.filter((a) => a.id.includes('@session')).map((a) => a.name), ['reliability', 'stats'], 'tmux teammates, minus the lead');
  assert.equal(new Set(r.agents.map((a) => a.id)).size, r.agents.length, 'no duplicates');
});

test('omc state: a stale team config and a foreign session contribute nothing', () => {
  const old = scan({ sessionId: 'sess-1', cwd: '/tmp/proj' }, { now: 1788871500000 + A.TEAM_MEMBER_MAX_AGE_MS });
  assert.ok(!old.agents.some((a) => a.id.includes('@session')), 'members that joined long ago are gone');
  const other = scan({ sessionId: 'sess-9', cwd: '/tmp/proj' });
  assert.equal(other.mode, null, 'no per-session state for sess-9');
  assert.equal(other.iteration, 0);
  assert.ok(!other.agents.some((a) => a.id.includes('@session')), 'the team belongs to sess-1');
  const nothing = A.scanAgents({ sessionId: 'x', cwd: '/nope' }, { stateDir: '/nope/.omc/state', teamsDir: '/nope' });
  assert.deepEqual(nothing, { mode: null, iteration: 0, agents: [] });
});

test('mergeAgents keeps hook-owned subagents and never double-counts', () => {
  const found = [{ id: 'a1', name: 'executor', kind: 'ralph', status: 'working' }];
  const merged = A.mergeAgents([{ id: 'a1', kind: 'subagent' }, { id: 'z9', kind: 'subagent' }, { id: 'old', kind: 'teammate' }], found);
  assert.deepEqual(merged.map((a) => a.id), ['z9', 'a1'], 'a stale teammate is dropped; the scan wins on a1');
});

test('agentStatus folds every vocabulary into three states', () => {
  for (const s of ['running', 'in_progress', 'active', '', undefined]) assert.equal(A.agentStatus(s), 'working');
  for (const s of ['completed', 'done', 'failed', 'cancelled']) assert.equal(A.agentStatus(s), 'done');
  for (const s of ['blocked', 'pending', 'waiting']) assert.equal(A.agentStatus(s), 'waiting');
});

// ── stats.js ────────────────────────────────────────────────────────────────
const St = require('../stats.js');

test('stats: agents are counted once each and ralph iterations accrue by growth', () => {
  const st = { days: {} };
  const now = Date.parse('2026-09-09T10:00:00');
  const s = (agents, iteration) => [{ sessionId: 's1', cwd: '/x/p', signal: 'tool-use', mode: 'ralph', iteration, agents }];
  St.tick(st, s([agent('a1')], 1), now, 4000);
  St.tick(st, s([agent('a1'), agent('a2')], 3), now + 4000, 4000);
  St.tick(st, s([agent('a1', 'subagent', 'done'), agent('a2')], 3), now + 8000, 4000);
  const d = st.days[St.dayKey(now)];
  assert.equal(d.agents, 2, 'the same agent is never credited twice');
  assert.equal(d.ralphIters, 3, 'iteration 1 then 3');
  // A fresh loop restarts the counter; only the new growth counts.
  St.tick(st, s([agent('a1')], 1), now + 12000, 4000);
  assert.equal(d.ralphIters, 4);
  // A session that is not looping contributes no iterations.
  St.tick(st, [{ sessionId: 's2', cwd: '/x/p', signal: 'tool-use', agents: [agent('c1')] }], now + 16000, 4000);
  assert.equal(d.ralphIters, 4);
  assert.equal(d.agents, 3);
});

test('stats: ticks accrue to the right bucket and project; big gaps are dropped', () => {
  const st = { days: {} };
  const now = Date.parse('2026-09-09T10:00:00');
  St.tick(st, [{ signal: 'tool-use', cwd: '/x/bondly' }], now, 4000);
  St.tick(st, [{ signal: 'permission-ask', cwd: '/x/bondly' }, { signal: 'tool-use', cwd: '/x/other' }], now + 4000, 4000);
  St.tick(st, [], now + 8000, 4000);
  St.tick(st, [{ signal: 'stop', cwd: '/x/bondly' }], now + 12000, 4000);
  St.tick(st, [{ signal: 'tool-use', cwd: '/x/bondly' }], now + 3600000, 3600000, 60000);
  const d = st.days[St.dayKey(now)];
  assert.deepEqual([d.working, d.waiting, d.idle, d.done], [4000, 4000, 4000, 4000]);
  assert.deepEqual(d.projects, {
    bondly: { working: 4000, waiting: 4000, done: 4000, peak: 1 },
    other: { working: 4000, waiting: 0, done: 0, peak: 1 },
  }, 'project time splits by that session\'s own kind');
  assert.equal(d.sessionsPeak, 2);
});

test('stats: summary covers 7 days, ranks projects, formats durations', () => {
  const st = { days: {} };
  const now = Date.parse('2026-09-09T12:00:00');
  St.tick(st, [{ signal: 'tool-use', cwd: '/a/p1' }], now - 86400000 * 3, 5000);
  St.tick(st, [{ signal: 'tool-use', cwd: '/a/p2' }], now, 9000);
  const sum = St.summary(st, now, 7);
  assert.equal(sum.days.length, 7);
  assert.equal(sum.days[6].key, St.dayKey(now));
  assert.equal(sum.days[3].working, 5000);
  assert.deepEqual(sum.projects.map((p) => p.name), ['p2', 'p1']);
  assert.equal(sum.totals.working, 14000);
  assert.equal(St.fmt(20000), '0m');
  assert.equal(St.fmt(61 * 60000), '1h 01m');
  St.prune(st, now, 1);
  assert.equal(Object.keys(st.days).length, 1);
});

// ── hooks/set-status.js, for real, against a temp home ─────────────────────
function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-test-'));
}
function run(home, signal, payload) {
  const r = spawnSync(process.execPath, [SET_STATUS, signal], {
    env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home },
    input: payload === undefined ? '' : JSON.stringify(payload),
  });
  assert.equal(r.status, 0, r.stderr.toString());
}
function files(home) {
  const dir = path.join(home, 'sessions');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}
function read(home) {
  const [f] = files(home);
  return f ? JSON.parse(fs.readFileSync(path.join(home, 'sessions', f), 'utf8')) : null;
}

test('set-status writes the raw signal, tool and cwd from the hook payload', () => {
  const home = tmpHome();
  run(home, 'tool-use', { session_id: 'abc', cwd: '/x/y', tool_name: 'Bash' });
  const d = read(home);
  assert.equal(files(home)[0], `${os.hostname().split('.')[0]}-abc.json`);
  assert.equal(d.signal, 'tool-use');
  assert.equal(d.tool, 'Bash');
  assert.equal(d.cwd, '/x/y');
  assert.ok(d.workingSince);
});

test('set-status: notification text is classified into three signals', () => {
  const home = tmpHome();
  run(home, 'notification', { session_id: 's', message: 'Claude needs your permission to use Bash' });
  assert.equal(read(home).signal, 'permission-ask');
  run(home, 'notification', { session_id: 's', message: 'You have reached your 5-hour limit' });
  assert.equal(read(home).signal, 'limit-hit');
  run(home, 'notification', { session_id: 's', message: 'Claude is waiting for your input' });
  assert.equal(read(home).signal, 'idle-nudge');
  assert.equal(read(home).workingSince, null, 'turn ended');
});

test('set-status: workingSince starts at prompt, survives tool churn, clears at stop', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 's' });
  const since = read(home).workingSince;
  assert.ok(since);
  run(home, 'tool-done', { session_id: 's', tool_name: 'Read' });
  assert.equal(read(home).workingSince, since);
  run(home, 'stop', { session_id: 's' });
  assert.equal(read(home).workingSince, null);
});

test('set-status: identical signal within a second is not rewritten', () => {
  const home = tmpHome();
  run(home, 'tool-use', { session_id: 's', tool_name: 'Edit' });
  const first = read(home).updatedAt;
  run(home, 'tool-use', { session_id: 's', tool_name: 'Edit' });
  assert.equal(read(home).updatedAt, first);
  run(home, 'tool-use', { session_id: 's', tool_name: 'Write' });
  assert.equal(read(home).tool, 'Write', 'a different tool does write');
});

test('set-status: session-end removes the file; unknown signals write nothing', () => {
  const home = tmpHome();
  run(home, 'tool-use', { session_id: 's' });
  assert.equal(files(home).length, 1);
  run(home, 'session-end', { session_id: 's' });
  assert.equal(files(home).length, 0);
  run(home, 'dance', { session_id: 's' });
  assert.equal(files(home).length, 0);
});

test('set-status: legacy "<colour> <reason>" hook form still reports the signal', () => {
  const home = tmpHome();
  const r = spawnSync(process.execPath, [SET_STATUS, 'green', 'tool-use'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, input: JSON.stringify({ session_id: 'old', tool_name: 'Edit' }) });
  assert.equal(r.status, 0);
  assert.equal(read(home).signal, 'tool-use');
  assert.equal(read(home).tool, 'Edit');
  const r2 = spawnSync(process.execPath, [SET_STATUS, 'amber', 'nonsense'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: tmpHome() }, input: '' });
  assert.equal(r2.status, 0);
});

test('set-status: garbage stdin does not crash', () => {
  const home = tmpHome();
  const r = spawnSync(process.execPath, [SET_STATUS, 'stop'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, input: '{not json' });
  assert.equal(r.status, 0);
  assert.equal(read(home).signal, 'stop');
});

test('set-status: permission-request blocks until answered, then prints the decision', () => {
  const home = tmpHome();
  const env = { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ASK_MS: '4000' };
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [SET_STATUS, 'permission-request'], { env });
  child.stdin.end(JSON.stringify({ session_id: 'p1', cwd: '/x/proj', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const reqDir = path.join(home, 'requests');
  const deadline = Date.now() + 2000;
  let req = null;
  while (Date.now() < deadline && !req) {
    const f = fs.existsSync(reqDir) ? fs.readdirSync(reqDir).find((x) => x.endsWith('.json')) : null;
    if (f) req = JSON.parse(fs.readFileSync(path.join(reqDir, f), 'utf8'));
    else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  }
  assert.ok(req, 'request file appears while the hook waits');
  assert.equal(req.tool, 'Bash');
  assert.equal(req.summary, 'git push origin main');
  fs.writeFileSync(path.join(reqDir, `${req.id}.answer`), 'allow');
  return new Promise((resolve) => child.on('exit', (code) => {
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.hookSpecificOutput.decision, { behavior: 'allow' });
    assert.equal(fs.readdirSync(reqDir).length, 0, 'request and answer files are cleaned up');
    resolve();
  }));
});

test('set-status: permission-request with no answer passes through silently', () => {
  const home = tmpHome();
  const r = spawnSync(process.execPath, [SET_STATUS, 'permission-request'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ASK_MS: '300' }, input: JSON.stringify({ session_id: 'p2', tool_name: 'Edit', tool_input: { file_path: '/a.js' } }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString(), '', 'no decision printed → Claude Code shows its own dialog');
});

test('set-status: task events count without changing the state', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 't' });
  run(home, 'tool-use', { session_id: 't', tool_name: 'Bash' });
  run(home, 'task-created', { session_id: 't' });
  run(home, 'task-created', { session_id: 't' });
  run(home, 'task-done', { session_id: 't' });
  const d = read(home);
  assert.deepEqual(d.tasks, { created: 2, done: 1 });
  assert.equal(d.signal, 'tool-use', 'task bookkeeping keeps the last real signal');
  run(home, 'prompt-submit', { session_id: 't' });
  assert.deepEqual(read(home).tasks, { created: 0, done: 0 }, 'a new prompt resets the count');
});

test('agent scope: a rule can target one agent; sessions default to claude', () => {
  const rs = [{ id: 'c', name: 'c', when: { signal: ['tool-use'], source: 'cursor' }, then: { pet: 'cat' } }, ...rules()];
  assert.equal(look([{ signal: 'tool-use', source: 'cursor' }], rs).pet, 'cat');
  assert.equal(look([{ signal: 'tool-use' }], rs).pet, 'none');
  assert.equal(look([{ signal: 'tool-use', source: 'Codex' }], rs).pet, 'none');
});

test('set-status: SubagentStart/Stop build the agents list; a finished turn ends them all', () => {
  const home = tmpHome();
  const start = (id, type) => run(home, 'subagent-start', { session_id: 's1', cwd: '/tmp/p', agent_id: id, agent_type: type });
  start('ag-1', 'oh-my-claudecode:executor');
  start('ag-2', 'explore');
  run(home, 'subagent-done', { session_id: 's1', cwd: '/tmp/p', agent_id: 'ag-1' });
  let d = read(home);
  assert.deepEqual(d.agents.map((a) => [a.id, a.name, a.kind, a.status]), [
    ['ag-1', 'executor', 'subagent', 'done'],
    ['ag-2', 'explore', 'subagent', 'working'],
  ], 'the plugin prefix is trimmed off the name');
  assert.equal(d.agents[1].parent, 's1');
  assert.equal(d.mode, null, 'mode belongs to the watcher, not the hooks');
  assert.equal(d.iteration, 0);
  // The watcher's fields and its non-subagent entries survive a hook write.
  const file = path.join(home, 'sessions', files(home)[0]);
  const withMode = { ...read(home), mode: 'ralph', iteration: 4 };
  withMode.agents = withMode.agents.concat([{ id: 't1', name: 'mate', kind: 'teammate', status: 'working' }]);
  fs.writeFileSync(file, JSON.stringify(withMode));
  run(home, 'tool-use', { session_id: 's1', cwd: '/tmp/p', tool_name: 'Bash' });
  d = read(home);
  assert.deepEqual([d.mode, d.iteration], ['ralph', 4], 'a hook write never erases the mode');
  assert.ok(d.agents.some((a) => a.id === 't1'), 'nor the watcher-owned agents');
  run(home, 'stop', { session_id: 's1', cwd: '/tmp/p' });
  d = read(home);
  assert.deepEqual(d.agents.filter((a) => a.kind === 'subagent').map((a) => a.status), ['done', 'done'], 'a finished turn finishes its subagents');
  assert.equal(d.agents.find((a) => a.id === 't1').status, 'working', 'a teammate is not the turn\'s to finish');
});

// ── hooks/emit.js (other agents) ────────────────────────────────────────────
const EMIT = path.join(__dirname, '..', 'hooks', 'emit.js');
function emit(home, args, input) {
  const r = spawnSync(process.execPath, [EMIT, ...args], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, input: input === undefined ? '' : input });
  assert.equal(r.status, 0, r.stderr.toString());
  return r.stdout.toString();
}

test('emit: generic signal with source/session/cwd/tool', () => {
  const home = tmpHome();
  emit(home, ['tool-use', '--source', 'chatgpt', '--session', 'abc', '--cwd', '/p/q', '--tool', 'Bash']);
  const d = read(home);
  assert.equal(files(home)[0], `${os.hostname().split('.')[0]}-chatgpt-abc.json`);
  assert.deepEqual([d.source, d.signal, d.tool, d.cwd], ['chatgpt', 'tool-use', 'Bash', '/p/q']);
  emit(home, ['session-end', '--source', 'chatgpt', '--session', 'abc']);
  assert.equal(files(home).length, 0);
  emit(home, ['dance', '--source', 'x']);
  assert.equal(files(home).length, 0, 'unknown signals write nothing');
});

test('emit: Cursor hook payloads map to signals and reply allow', () => {
  const home = tmpHome();
  const out = emit(home, ['--cursor', 'beforeShellExecution'], JSON.stringify({ conversation_id: 'c1', workspace_roots: ['/w/proj'], command: 'ls' }));
  assert.deepEqual(JSON.parse(out), { permission: 'allow', continue: true });
  const d = read(home);
  assert.deepEqual([d.source, d.signal, d.tool, d.cwd, d.sessionId], ['cursor', 'tool-use', 'Bash', '/w/proj', 'c1']);
  emit(home, ['--cursor', 'stop'], JSON.stringify({ conversation_id: 'c1' }));
  assert.equal(read(home).signal, 'stop');
});

test('emit: Codex notify payload marks a finished turn', () => {
  const home = tmpHome();
  emit(home, ['--codex', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't9', cwd: '/c' })]);
  const d = read(home);
  assert.deepEqual([d.source, d.signal, d.sessionId], ['codex', 'stop', 't9']);
});

test('adapters: cursor/codex/gemini config writers are idempotent and keep foreign entries', () => {
  const cur = H.installCursor({ version: 1, hooks: { stop: [{ command: 'echo mine' }] } }, '/e/emit.js');
  const twice = H.installCursor(cur, '/e/emit.js');
  assert.deepEqual(cur, twice);
  assert.deepEqual(cur.hooks.stop.map((h) => h.command), ['echo mine', 'node "/e/emit.js" --cursor stop']);
  assert.ok(cur.hooks.beforeShellExecution.length === 1);
  const toml = H.installCodex('model = "o3"\nnotify = ["old"]\n', '/e/emit.js');
  assert.equal(toml, 'notify = ["node", "/e/emit.js", "--codex"]\nmodel = "o3"\n');
  assert.equal(H.installCodex(toml, '/e/emit.js'), toml);
  const gem = H.installGemini({ theme: 'x', hooks: { BeforeTool: [{ matcher: '', hooks: [{ type: 'command', command: 'echo keep' }] }] } }, '/e/emit.js');
  assert.equal(gem.theme, 'x');
  assert.equal(gem.hooks.BeforeTool.length, 2);
  assert.deepEqual(H.installGemini(gem, '/e/emit.js'), gem);
});

// ── hooks/install.js ────────────────────────────────────────────────────────
test('install is idempotent, strips old-style commands, keeps foreign hooks', () => {
  const foreign = { matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] };
  const settings = {
    hooks: {
      PreToolUse: [foreign, { matcher: '', hooks: [{ type: 'command', command: 'node "/old/set-status.js" green tool-use' }] }],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "/Applications/X.app/hooks/set-status.js" done stop' }] }],
    },
    permissions: { allow: ['Bash'] },
  };
  const once = H.install(JSON.parse(JSON.stringify(settings)), '/new/set-status.js');
  const twice = H.install(JSON.parse(JSON.stringify(once)), '/new/set-status.js');
  assert.deepEqual(once, twice);
  assert.deepEqual(once.permissions, settings.permissions);
  const cmds = (ev) => once.hooks[ev].flatMap((h) => h.hooks.map((x) => x.command));
  assert.deepEqual(cmds('PreToolUse'), ['echo hi', 'node "/new/set-status.js" tool-use']);
  assert.deepEqual(cmds('Stop'), ['node "/new/set-status.js" stop']);
  assert.ok(cmds('PostToolUseFailure').length);
  assert.equal(H.isInstalled(once, '/new/set-status.js'), true);
  assert.equal(H.isInstalled(once, '/other/set-status.js'), false);
  assert.equal(H.isInstalled(settings, '/old/set-status.js'), false, 'old-style commands do not count as installed');
});

test('install: PermissionRequest hook is opt-in and carries a timeout', () => {
  const off = H.install({}, '/x/set-status.js');
  assert.equal(off.hooks.PermissionRequest, undefined);
  assert.equal(H.isInstalled(off, '/x/set-status.js', { askFromWidget: true }), false, 'not installed for the opt-in when the hook is absent');
  const on = H.install({}, '/x/set-status.js', { askFromWidget: true });
  assert.equal(on.hooks.PermissionRequest[0].hooks[0].timeout, 60);
  assert.equal(H.isInstalled(on, '/x/set-status.js', { askFromWidget: true }), true);
  assert.equal(H.isInstalled(on, '/x/set-status.js', { askFromWidget: false }), false, 'turning it off means the hook must go');
  const backOff = H.install(on, '/x/set-status.js');
  assert.equal(backOff.hooks.PermissionRequest, undefined);
  assert.ok(backOff.hooks.TaskCompleted, 'task hooks are always on');
});
