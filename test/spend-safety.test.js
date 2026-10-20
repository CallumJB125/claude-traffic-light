const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/spend-safety.js');
const Main = require('../src/spend-safety-main.js');

const H = 3600000;
const NOW = new Date(2026, 9, 19, 14, 0, 0).getTime();
// A Sonnet turn costing exactly `usd` ($10 per million output tokens).
const turn = (ts, usd, cwd = '/w/app', sessionId = 's1') => ({ ts, sessionId, cwd, modelKey: 'sonnet', input: 0, output: usd * 1e5, cacheRead: 0, cacheWrite: 0 });

test('normalize keeps valid plans and caps only', () => {
  const s = S.normalize({ plan: 'max20', showApiPrices: true, projectCaps: { app: 20, bad: -1, zero: 0, '': 5, nan: 'x' } });
  assert.deepEqual(s, { plan: 'max20', showApiPrices: true, projectCaps: { app: 20 }, notifyLoops: true });
  assert.equal(S.normalize({ plan: 'gold' }).plan, 'auto');
  assert.equal(S.normalize(null).showApiPrices, false);
});

test('detectPlan reads tier fields and the API key', () => {
  assert.equal(S.detectPlan({ env: { ANTHROPIC_API_KEY: 'k' }, claudeJson: { oauthAccount: { organizationType: 'claude_max' } } }), 'api');
  assert.equal(S.detectPlan({ claudeJson: { oauthAccount: { organizationRateLimitTier: 'default_claude_max_20x' } } }), 'max20');
  assert.equal(S.detectPlan({ claudeJson: { oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' } } }), 'max5');
  assert.equal(S.detectPlan({ claudeJson: { oauthAccount: { organizationType: 'claude_pro' } } }), 'pro');
  assert.equal(S.detectPlan({ claudeJson: {} }), null);
  assert.equal(S.detectPlan(), null);
});

test('effectivePlan: choice, then detection, then spend mode', () => {
  assert.equal(S.effectivePlan({ plan: 'pro' }, 'max20', 'api'), 'pro');
  assert.equal(S.effectivePlan({}, 'max20', 'api'), 'max20');
  assert.equal(S.effectivePlan({}, null, 'api'), 'api');
  assert.equal(S.effectivePlan({}, null, 'subscription'), 'pro');
});

test('projectCaps flags warning and over per project folder, today only', () => {
  const turns = [turn(NOW - 30 * H, 50), turn(NOW - H, 17), turn(NOW - H, 5, '/w/other'), turn(NOW - 2 * H, 4, '/w/other')];
  const r = S.projectCaps(turns, { projectCaps: { app: 20, other: 8, quiet: 5 } }, NOW);
  assert.deepEqual(r.map((p) => [p.project, p.spent, p.level]), [['other', 9, 'over'], ['app', 17, 'warning'], ['quiet', 0, null]]);
  assert.equal(r[0].text, 'other: $9.00 of its $8.00 daily cap');
});

test('projectedToday extrapolates the last two hours to midnight', () => {
  assert.equal(S.projectedToday([], NOW).ready, false);
  const p = S.projectedToday([turn(NOW - 3 * H, 10), turn(NOW - H, 4)], NOW);
  // $4 in the last 2 h → $2/h for the 10 h to midnight → 14 + 20.
  assert.equal(p.projected, 34);
  assert.match(p.text, /^Projected today: about \$34\.00 .* \(\$14\.00 so far\)$/);
  assert.equal(S.projectedToday([turn(NOW - 10 * 60000, 3)], NOW).ready, false);
});

test('limitEstimate: open 5-hour and weekly windows with countdowns', () => {
  assert.equal(S.limitEstimate([turn(NOW - H, 5)], 'api', NOW), null);
  const turns = [turn(NOW - 8 * H, 30), turn(NOW - 2 * H, 6), turn(NOW - H, 2)];
  const r = S.limitEstimate(turns, 'pro', NOW);
  assert.equal(r.estimate, true);
  assert.equal(r.fiveHour.percent, 80);
  assert.equal(r.fiveHour.band, 'amber');
  assert.equal(r.fiveHour.resetsAt, NOW + 3 * H);
  assert.equal(r.fiveHour.text, '5-hour window: about 80% used, resets in 3 h 0 min');
  assert.equal(r.week.percent, Math.round((38 / 80) * 100));
  assert.match(r.note, /Estimate only/);
  assert.match(r.note, /not charged per token/);
  assert.equal(S.limitEstimate([], 'max5', NOW).fiveHour.text, '5-hour window: nothing used yet');
});

const use = (id, name, input, ts = '2026-10-19T10:00:00Z') => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, err) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: err }] } });

test('retryLoop: the same failing call three times in a row', () => {
  const cmd = { command: 'npm test' };
  const lines = [use('a', 'Bash', cmd), res('a', true), use('b', 'Bash', cmd), res('b', true), use('c', 'Bash', cmd), res('c', true)];
  assert.deepEqual(S.retryLoop(lines), { tool: 'Bash', count: 3, since: Date.parse('2026-10-19T10:00:00Z') });
  assert.equal(S.loopText(S.retryLoop(lines), '/w/app'), 'Retry loop in app: the same Bash call failed 3 times in a row');
  assert.equal(S.retryLoop(lines.slice(0, 4)), null);
  assert.equal(S.retryLoop([...lines, use('d', 'Bash', cmd), res('d', false)]), null, 'a success ends it');
  const varied = [use('a', 'Bash', cmd), res('a', true), use('b', 'Bash', { command: 'npm run x' }), res('b', true), use('c', 'Bash', cmd), res('c', true)];
  assert.equal(S.retryLoop(varied), null, 'different inputs are not a loop');
  assert.equal(S.retryLoop(['not json', '']), null);
});

test('burnText says what the session burned', () => {
  assert.equal(S.burnText({ burn: '$47.20 in 18 min' }, false), 'This session burned $47.20 in 18 min');
  assert.equal(S.burnText({ burn: '$47.20 in 18 min' }, true), 'This session burned $47.20 in 18 min (API-price equivalent)');
});

test('main: IPC get/set, loop and cap notifications, widget alerts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  const home = path.join(tmp, 'home');
  const proj = path.join(home, '.claude', 'projects', '-w-app');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_20x', emailAddress: 'x@y' } }));
  const cmd = { command: 'npm test' };
  const lines = [JSON.stringify({ cwd: '/w/app' }), use('a', 'Bash', cmd), res('a', true), use('b', 'Bash', cmd), res('b', true), use('c', 'Bash', cmd), res('c', true)];
  fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), lines.join('\n') + '\n');
  const handlers = new Map();
  const shown = [];
  class N { constructor(o) { this.o = o; } static isSupported() { return true; } show() { shown.push(this.o); } }
  const m = Main.install({
    handle: (ch, allowed, fn) => handlers.set(ch, fn), allowed: () => true, Notification: N, rootDir: path.join(tmp, 'data'), home, env: {},
    config: () => ({ spend: { mode: 'subscription', warnAt: 0.8 } }), turns: async () => [turn(Date.now() - 60000, 30)],
    spend: () => ({ runaway: [{ sessionId: 's1', burn: '$30.00 in 4 min', firedAt: 1 }] }), tick: false, now: Date.now,
  });
  const v = await handlers.get('spend-safety:get')();
  assert.equal(v.detected, 'max20');
  assert.equal(v.plan, 'max20');
  assert.equal(v.subscriber, true);
  assert.equal(v.showDollars, false);
  assert.ok(v.limits.fiveHour.percent >= 15);
  assert.ok(!JSON.stringify(v).includes('x@y'), 'never returns the email');
  const saved = await handlers.get('spend-safety:set')(null, { projectCaps: { app: 10 }, showApiPrices: true });
  assert.equal(saved.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'data', Main.FILE), 'utf8')).projectCaps, { app: 10 });
  await m.tick();
  assert.deepEqual(shown.map((n) => n.title).sort(), ['Project over its daily cap', 'Retry loop?']);
  await m.tick();
  assert.equal(shown.length, 2, 'one notification each');
  const kinds = Main.alerts().map((a) => [a.kind, a.text]);
  assert.deepEqual(kinds, [
    ['needs-you', 'This session burned $30.00 in 4 min (API-price equivalent)'],
    ['needs-you', 'app is over its daily cap'],
    ['stuck', 'Retry loop in app: the same Bash call failed 3 times in a row'],
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('wiring: one-line require in main, preload channels, panels shipped, template present', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.equal(main.split('\n').filter((l) => l.includes("require('./src/spend-safety-main.js')")).length, 1);
  for (const f of ['lights-preload.js', 'settings-preload.js']) assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /spend-safety:get/);
  const files = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.files;
  assert.ok(files.includes('spend-safety-panel.js') && files.includes('settings-spend-safety.js'));
  const T = require('../src/rule-templates.js');
  assert.ok(T.list().some((t) => t.id === 'burn-alert'));
  assert.match(fs.readFileSync(path.join(root, 'onboarding.html'), 'utf8'), /aren't charged per token/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'onboarding.html'), 'utf8'), /We'll show API-price equivalents/);
});

test('a "pause nudges" runaway rule holds a burning session until its burn is acknowledged', async () => {
  const rule = { name: 'Session crossed my spend line', enabled: true, when: { signal: ['runaway'] }, then: { pauseNudges: true } };
  assert.deepEqual(S.nudgePauses([rule], [{ sessionId: 's9', firedAt: 5 }]), [{ sessionId: 's9', firedAt: 5, rule: 'Session crossed my spend line' }]);
  assert.deepEqual(S.nudgePauses([{ ...rule, then: {} }], [{ sessionId: 's9', firedAt: 5 }]), []);
  assert.deepEqual(S.nudgePauses([{ ...rule, enabled: false }], [{ sessionId: 's9', firedAt: 5 }]), []);
  assert.deepEqual(S.nudgePauses([rule], [{ sessionId: 's9', firedAt: 5 }], new Set(['s9|5'])), []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-'));
  let burns = [{ sessionId: 's9', firedAt: 5, burn: '$12 in 10 min' }];
  const api = Main.install({ handle: () => {}, allowed: () => true, rootDir: root, home: root, config: () => ({ rules: [rule] }), turns: async () => [], spend: () => ({ runaway: burns }), tick: false, silent: true, now: () => NOW });
  await api.tick();
  assert.equal(Main.nudgesPaused('s9'), true);
  assert.match(Main.alerts().find((a) => a.sessionId === 's9').text, /paused until you resume/);
  assert.deepEqual(Main.resumeNudges('s9'), { ok: true });
  assert.equal(Main.nudgesPaused('s9'), false);
  await api.tick();
  assert.equal(Main.nudgesPaused('s9'), false, 'the same burn stays acknowledged');
  burns = [{ sessionId: 's9', firedAt: 9, burn: '$30 in 10 min' }];
  await api.tick();
  assert.equal(Main.nudgesPaused('s9'), true, 'a new burn pauses again');
  Main.resumeNudges('s9');
  assert.deepEqual(Main.resumeNudges('nope'), { ok: false });
});
