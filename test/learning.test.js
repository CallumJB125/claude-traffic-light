const test = require('node:test');
const assert = require('node:assert/strict');

const Router = require('../router.js');
const U = require('../usage.js');

const NOW = new Date(2026, 8, 10, 12, 0, 0).getTime();
const DAY = 86400000;
const MIN = 60000;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, `${msg || ''} ${a} ≉ ${b}`);

// Synthetic learn stats: `sessions` sessions, escalations at these turns.
const learn = (sessions, turns = [], minutes = 5) => ({ days: 14, sessions, escalations: turns.map((turn) => ({ turn, minutes })) });
const tier = (...a) => Router.learnProjectTier(learn(...a));

// ── learnProjectTier ────────────────────────────────────────────────────────
test('learnProjectTier: no history is neutral, with nothing to say', () => {
  for (const h of [null, undefined, {}, learn(0)]) {
    const t = Router.learnProjectTier(h);
    assert.equal(t.tier, 'neutral');
    assert.equal(t.label, null);
  }
});

test('learnProjectTier: all-clean history earns cheaper picks, but only after LEARN_CLEAN_SESSIONS', () => {
  const t = tier(Router.LEARN_CLEAN_SESSIONS);
  assert.equal(t.tier, 'cheap');
  assert.equal(t.label, `learned: cheap (no switch-ups in ${Router.LEARN_CLEAN_SESSIONS} cheap-start sessions)`);
  assert.equal(tier(Router.LEARN_CLEAN_SESSIONS - 1).tier, 'neutral', 'a few clean sessions prove nothing yet');
  assert.equal(tier(40, [30]).tier, 'neutral', 'one switch-up and it is no longer clean');
});

test('learnProjectTier: frequent early switch-ups force quality, at a lower rate than mid or late ones', () => {
  const t = Router.learnProjectTier({ sessions: 12, escalations: [1, 2, 2, 3, 1].map((turn) => ({ turn, minutes: 2 })) });
  assert.equal(t.tier, 'quality');
  assert.equal(t.timing, 'early');
  assert.equal(t.label, 'learned: quality (42% escalation rate, 12 cheap-start sessions; usually by turn 2, ~2 min in)');
  // Early: 15% is enough; the same rate mid-session is not.
  assert.equal(tier(20, [2, 2, 2]).tier, 'quality', '3/20 = 15%, early');
  assert.equal(tier(20, [2, 2]).tier, 'neutral', '2/20 = 10%, early');
  assert.equal(tier(20, [10, 10, 10]).tier, 'neutral', '15%, mid-session');
  assert.equal(tier(10, [10, 10, 10]).tier, 'quality', '30%, mid-session');
});

test('learnProjectTier: occasional late switch-ups stay cheap — the model mostly handled it', () => {
  const t = tier(10, [25, 40], 35);
  assert.equal(t.tier, 'neutral');
  assert.equal(t.timing, 'late');
  assert.match(t.label, /^learned: cheap is fine \(2 of 10 cheap-start sessions switched up, late — the cheap model did most of the work; usually by turn 33, ~35 min in\)$/);
  assert.equal(tier(10, [25, 30, 40, 22]).tier, 'neutral', '40% late is still under LEARN_RATE_LATE');
  assert.equal(tier(10, [25, 30, 40, 22, 21]).tier, 'quality', 'half of all sessions switching up, even late, is quality');
});

test('learnProjectTier: thresholds are the named constants; bad entries are ignored', () => {
  assert.deepEqual([Router.LEARN_DAYS, Router.LEARN_EARLY_TURN, Router.LEARN_LATE_TURN], [14, 5, 20]);
  assert.deepEqual([Router.LEARN_RATE_EARLY, Router.LEARN_RATE, Router.LEARN_RATE_LATE, Router.LEARN_CLEAN_SESSIONS], [0.15, 0.3, 0.5, 20]);
  const t = Router.learnProjectTier({ sessions: 3, escalations: [null, { turn: 0 }, { turn: 'x' }, { turn: 4 }] });
  assert.equal(t.escalations, 1);
  assert.equal(t.medianMinutes, null);
  assert.match(t.label, /usually by turn 4\)$/);
  assert.equal(Router.learnProjectTier({ sessions: 1, escalations: [{ turn: 1 }, { turn: 2 }] }).rate, 1, 'never more escalations than sessions');
});

// ── decide blends the learned tier with your policy ─────────────────────────
const hist = (l, over = {}) => ({ projects: { bondly: { sessions: 12, medianTurns: 12, escalations: 0, lastEscalationAt: null, learn: l, ...over } } });
const d = (over = {}) => Router.decide({ cwd: '/w/bondly', args: [], env: {}, history: hist(learn(12)), config: {}, now: NOW, ...over });
const QUALITY = learn(12, [1, 2, 2, 3, 1], 2);
const CLEAN = learn(24);
const LATE = learn(10, [25, 40], 35);

test('decide: learned quality is quality-first for that project, whatever the policy', () => {
  for (const routerPolicy of ['frugal', 'balanced']) {
    const r = d({ config: { routerPolicy }, history: hist(QUALITY) });
    assert.equal(r.model, 'opus', routerPolicy);
    assert.equal(r.reason, 'learned: quality (42% escalation rate, 12 cheap-start sessions; usually by turn 2, ~2 min in)');
    assert.equal(r.policy, routerPolicy, 'your setting is untouched');
  }
  const p = d({ config: { routerPolicy: 'frugal' }, history: hist(QUALITY), args: ['-p', 'hi'] });
  assert.equal(p.model, 'sonnet', 'short -p goes where quality-first sends it');
  assert.match(p.reason, /^short one-shot prompt \(-p\); learned: quality/);
  assert.equal(d({ config: { routerProjects: { bondly: 'haiku' } }, history: hist(QUALITY) }).model, 'haiku', 'your per-project pick still wins');
});

test('decide: a clean project gets Haiku for short -p even under balanced; quality-first stays Sonnet', () => {
  const r = d({ history: hist(CLEAN), args: ['-p', 'what is 2+2'] });
  assert.equal(r.model, 'haiku');
  assert.equal(r.reason, 'short one-shot prompt (-p); learned: cheap (no switch-ups in 24 cheap-start sessions)');
  assert.equal(d({ history: hist(learn(19)), args: ['-p', 'hi'] }).model, 'sonnet', 'not clean for long enough');
  assert.equal(d({ history: hist(CLEAN), args: ['-p', 'hi'], config: { routerPolicy: 'quality' } }).model, 'sonnet');
  const s = d({ history: hist(CLEAN) });
  assert.equal(s.model, 'sonnet');
  assert.equal(s.reason, 'light project (median 12 turns over 12 sessions); learned: cheap (no switch-ups in 24 cheap-start sessions)');
});

test('decide: occasional late switch-ups no longer force Opus for a week', () => {
  const recent = hist(LATE, { escalations: 1, lastEscalationAt: NOW - DAY });
  const r = d({ history: recent });
  assert.equal(r.model, 'sonnet', 'the old flat 7-day rule would have said Opus');
  assert.match(r.reason, /^light project \(median 12 turns over 12 sessions\); learned: cheap is fine \(2 of 10 cheap-start sessions switched up, late/);
  assert.equal(d({ history: recent, config: { routerPolicy: 'frugal' } }).model, 'sonnet');
  assert.equal(d({ history: hist(LATE, { medianTurns: 90 }) }).model, 'opus', 'a heavy project is still heavy under balanced');
  assert.equal(d({ history: hist(learn(5)) }).reason, 'light project (median 12 turns over 12 sessions), no escalations in 14d');
});

test('decide: a history.json without `learn` keeps the old 7-day rule', () => {
  const old = { projects: { bondly: { sessions: 5, medianTurns: 12, escalations: 1, lastEscalationAt: NOW - 2 * DAY } } };
  assert.equal(d({ history: old }).model, 'opus');
  assert.match(d({ history: old }).reason, /switched up/);
});

test('advise: follows the learned tier', () => {
  const a = (history) => Router.advise({ current: 'claude-opus-4-6', cwd: '/w/bondly', history, config: {}, now: NOW });
  assert.equal(a(hist(QUALITY)), null);
  assert.equal(a(hist(LATE)).model, 'sonnet');
});

// ── learnStats / projectHistory: what history.json carries ──────────────────
const turn = (over) => ({ ts: NOW - DAY, sessionId: 's1', project: 'bondly', modelKey: 'sonnet', subagent: false, input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...over });
// A session starting `ago` ms back, one turn a minute, switching to Opus at turn `at` (1-based).
const session = (id, n, { at = null, ago = DAY, project = 'bondly', model = 'sonnet' } = {}) =>
  Array.from({ length: n }, (_, i) => turn({ sessionId: id, project, ts: NOW - ago + i * MIN, modelKey: at && i + 1 >= at ? 'opus' : model }));

test('learnStats: per project over 14 days, the turn and minute each session switched up', () => {
  const turns = [...session('a', 5, { at: 2 }), ...session('b', 30, { at: 25 }), ...session('c', 3), ...session('old', 3, { ago: 10 * DAY, at: 3 }), ...session('gone', 3, { ago: 20 * DAY, at: 2 }),
    turn({ sessionId: 'a', subagent: true, modelKey: 'haiku', ts: NOW - DAY + 30 * MIN })];
  const l = U.learnStats(turns, { now: NOW });
  assert.equal(l.bondly.sessions, 4, 'the 20-day-old session is outside the window');
  assert.deepEqual(l.bondly.escalations.map((e) => e.turn).sort((x, y) => x - y), [2, 3, 25]);
  assert.deepEqual(l.bondly.escalations.find((e) => e.turn === 25), { turn: 25, minutes: 24 });
  const h = U.projectHistory(turns, { now: NOW });
  assert.equal(h.projects.bondly.sessions, 3, 'the 7-day figures are unchanged');
  assert.equal(h.projects.bondly.learn.sessions, 4);
});

test('learnStats: sessions that started on Opus never tried a cheap model, so they teach nothing', () => {
  // 40 Opus sessions (one moving up to Fable) and 4 Sonnet ones that all switched up at turn 2.
  const turns = [];
  for (let i = 0; i < 40; i += 1) turns.push(...session(`o${i}`, 3, { model: 'opus' }));
  turns.push(turn({ sessionId: 'o0', ts: NOW - DAY + 5 * MIN, modelKey: 'fable' }));
  for (let i = 0; i < 4; i += 1) turns.push(...session(`s${i}`, 3, { at: 2 }));
  const l = U.learnStats(turns, { now: NOW }).bondly;
  assert.equal(l.sessions, 4);
  assert.equal(l.escalations.length, 4);
  assert.equal(Router.learnProjectTier(l).tier, 'quality', '4/4, not a diluted 4/44');
  assert.equal(U.learnStats(session('o', 30, { model: 'opus' }), { now: NOW }).bondly, undefined, 'a clean Opus history earns no Haiku');
});

test('projectHistory: a project quiet this week keeps its lesson; the router reads it', () => {
  const turns = [];
  for (let i = 0; i < 4; i += 1) turns.push(...session(`q${i}`, 10, { ago: 10 * DAY + i * 3600e3, at: i < 2 ? 2 : null, project: 'quiet' }));
  const h = U.projectHistory(turns, { now: NOW });
  assert.equal(h.projects.quiet.sessions, 0);
  assert.equal(h.projects.quiet.learn.sessions, 4);
  // 2/4 sessions escalated at turn 2: early and 50%.
  const r = Router.decide({ cwd: '/w/quiet', history: h, config: { routerPolicy: 'frugal' }, now: NOW });
  assert.equal(r.model, 'opus');
  assert.match(r.reason, /^learned: quality \(50% escalation rate, 4 cheap-start sessions; usually by turn 2/);
});

// ── review: routing, context diet and the cost of escalations ──────────────
const ALL_OPUS = { mix: { opus: { share: 1 } } };
const SINCE = NOW - 3 * DAY;

test('review: routing savings, the context diet and escalations, each on its own line', () => {
  // Five clean sessions of two Sonnet turns: each turn $2 vs $5 at the all-Opus mix.
  const turns = [];
  for (let i = 0; i < 5; i += 1) turns.push(...session(`s${i}`, 2));
  // One that switched up: a Sonnet turn, then Opus rewriting 1M of cache
  // ($6.25; at the old mix that would have been a $0.50 read), then a turn
  // that cost what the old mix would have.
  turns.push(turn({ sessionId: 'e', ts: NOW - DAY }), turn({ sessionId: 'e', ts: NOW - DAY + MIN, modelKey: 'opus', input: 0, cacheWrite: 1e6 }), turn({ sessionId: 'e', ts: NOW - DAY + 2 * MIN, modelKey: 'opus' }));
  turns.push(turn({ sessionId: 'before', ts: SINCE - DAY }));
  const events = [{ at: new Date(NOW - 1000).toISOString(), sessionId: 's0', tokensAvoided: 1e6 }];
  const rv = U.review(turns, { since: SINCE, frozen: ALL_OPUS, events, now: NOW });
  assert.equal(rv.sessions, 6);
  assert.equal(rv.turns, 13, 'the turn before switch-on is out');
  assert.equal(rv.routing.high, 33, '11 Sonnet turns × $3');
  near(rv.routing.low, 11 * (5 / U.SLACK - 2), 'low end allows SLACK');
  assert.deepEqual(rv.diet, { low: 2.5, high: 2.5, events: 1 });
  assert.deepEqual(rv.escalations, { sessions: 1, cost: 5.75, projects: [{ name: 'bondly', cost: 5.75, sessions: 1 }] });
  near(rv.net.high, 33 + 2.5 - 5.75);
  assert.equal(rv.verdict.kind, 'saving');
  assert.equal(rv.verdict.text, 'Routing is saving you money');
});

test('review: escalations eating the saving name the project; a switch-up that still undercut the old mix costs nothing', () => {
  const turns = [];
  for (let i = 0; i < 5; i += 1) turns.push(...session(`x${i}`, 1), turn({ sessionId: `x${i}`, ts: NOW - DAY + MIN, modelKey: 'opus', input: 0, cacheWrite: 4e6 }));
  const rv = U.review(turns, { since: SINCE, frozen: ALL_OPUS, now: NOW });
  assert.equal(rv.escalations.sessions, 5);
  assert.equal(rv.escalations.cost, 5 * (25 - 2));
  assert.equal(rv.verdict.kind, 'escalations');
  assert.equal(rv.verdict.text, 'Escalations are eating most of the savings — consider Quality-first for bondly');

  // Haiku → Sonnet against an all-Opus mix is still cheaper than Opus: no escalation cost.
  const cheap = session('h', 3, { at: 2, model: 'haiku' }).map((t) => (t.modelKey === 'opus' ? { ...t, modelKey: 'sonnet' } : t));
  const c = U.review(cheap, { since: SINCE, frozen: ALL_OPUS, now: NOW });
  assert.equal(c.escalations.cost, 0);
  assert.equal(c.routing.high, (5 - 1) + 2 * (5 - 2));
});

test('review: not enough data, and a mix that costs more than before', () => {
  const few = U.review(session('a', 2), { since: SINCE, frozen: ALL_OPUS, now: NOW });
  assert.deepEqual(few.verdict, { kind: 'early', text: 'Not enough data yet (1 session)' });
  assert.equal(U.review([], { since: SINCE, frozen: ALL_OPUS, now: NOW }).verdict.text, 'Not enough data yet (0 sessions)');
  const turns = [];
  for (let i = 0; i < 5; i += 1) turns.push(...session(`o${i}`, 1, { model: 'opus' }));
  const rv = U.review(turns, { since: SINCE, frozen: { mix: { sonnet: { share: 1 } } }, now: NOW });
  assert.deepEqual(rv.routing, { low: -15, high: -15 });
  assert.equal(rv.verdict.kind, 'losing');
});
