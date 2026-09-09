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
  assert.deepEqual(r.when, { signal: ['stop'], tool: null, cwd: null });
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
