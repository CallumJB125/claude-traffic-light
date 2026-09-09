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
  assert.deepEqual(r.when, { signal: ['stop'], tool: null });
  assert.deepEqual(r.then, { lamp: null, lampColor: null, eyes: null, pose: null, sound: null, celebrate: true, text: null, costume: null });
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

// ── stats.js ────────────────────────────────────────────────────────────────
const St = require('../stats.js');

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
  assert.deepEqual(d.projects, { bondly: 8000, other: 4000 }, 'done sessions do not accrue project time');
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
