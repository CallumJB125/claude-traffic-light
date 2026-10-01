// Team view: ordering, empty states, the Needs-you strip, untrusted text,
// stale mode and the work-scope explainer (render-team.js is pure).
import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, byClass, byAttr } from '../js/h.js';
import { displayFace } from '../js/view.js';
import { teamRows, teamScreen, overviewPanel, SCOPE_RULE } from '../js/render-team.js';
import { view, model, ALICE, BOB } from './fixtures.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const entry = (v) => ({ view: v, elapsed_ms: 0, face: displayFace(v) });
const CAROL = { member_id: 'm-carol', name: 'Carol', login: 'carol', avatar_url: null };
const DAVE = { member_id: 'm-dave', name: 'Dave', login: 'dave', avatar_url: null };
const sess = (state, extra = {}) => ({ agent: 'claude', repo_short: 'bondly', branch: 'main', state, since: ago(90_000), ...extra });

function teamModel(presenceMembers, extra = {}) {
  const members = new Map([ALICE, BOB, CAROL, DAVE].map((m) => [m.member_id, m]));
  return model(extra.entries ?? [], { members, nowMs: NOW, view: 'team', presence: { members: presenceMembers, loaded: true, stale: false }, ...extra });
}

test('order: you first, then working, waiting, idle, then the rest A to Z', () => {
  const rows = teamRows(teamModel([
    { member_id: 'm-dave', name: 'Dave', sessions: [sess('idle')] },
    { member_id: 'm-carol', name: 'Carol', sessions: [sess('waiting')] },
    { member_id: 'm-bob', name: 'Bob', sessions: [sess('working')] },
  ]));
  assert.deepEqual(rows.map((r) => r.name), ['Alice', 'Bob', 'Carol', 'Dave']);
  assert.equal(rows[0].is_me, true);
  const flat = teamRows(teamModel([{ member_id: 'm-dave', name: 'Dave', sessions: [sess('idle')] }]));
  assert.deepEqual(flat.map((r) => r.name), ['Alice', 'Dave', 'Bob', 'Carol'], 'live before not-sharing; me first even when not live');
});

test('a member the snapshot does not list still shows from presence', () => {
  const rows = teamRows(teamModel([{ member_id: 'm-zed', name: 'Zed', sessions: [sess('working')] }]));
  assert.ok(rows.some((r) => r.name === 'Zed' && r.sessions.length === 1));
});

test('sessions inside a member run working, waiting, idle', () => {
  const [me] = teamRows(teamModel([{ member_id: 'm-alice', name: 'Alice', sessions: [sess('idle', { repo_short: 'a' }), sess('working', { repo_short: 'b' }), sess('waiting', { repo_short: 'c' })] }]));
  assert.deepEqual(me.sessions.map((s) => s.state), ['working', 'waiting', 'idle']);
});

test('header: count, the one-line scope, and the work-scope rule', () => {
  const v = teamScreen(teamModel([{ member_id: 'm-bob', name: 'Bob', sessions: [sess('working')] }]));
  const text = textOf(v);
  assert.match(text, /Team/);
  assert.match(text, /1 online/);
  assert.match(text, /Live sessions in repos linked to this board\. Only members who turned on sharing appear\. Read-only sessions never show\./);
  assert.match(text, /only shows once it writes into a repo linked to this board/);
  assert.match(SCOPE_RULE, /Personal — don’t track/);
});

test('each session row names the agent, repo@branch, state, age and the board it counts for', () => {
  const v = teamScreen(teamModel([{ member_id: 'm-bob', name: 'Bob', sessions: [sess('working', { agent: 'codex', repo_short: 'bondly', branch: 'feat/x', since: ago(125_000) })] }]));
  const [row] = byClass(v, 'team-session');
  const t = textOf(row);
  assert.match(t, /Codex/);
  assert.match(t, /bondly@feat\/x/);
  assert.match(t, /Working/);
  assert.match(t, /since 2m ago/);
  assert.match(t, /counting for Bondly/);
});

test('ages follow nowMs (they tick with the page clock)', () => {
  const at = (nowMs) => textOf(teamScreen(teamModel([{ member_id: 'm-bob', name: 'Bob', sessions: [sess('idle', { since: ago(10_000) })] }], { nowMs })));
  assert.match(at(NOW), /since 10s ago/);
  assert.match(at(NOW + 5_000), /since 15s ago/);
});

test('empty member: not sharing, not offline', () => {
  const v = teamScreen(teamModel([]));
  assert.equal(byClass(v, 'team-empty').length, 4);
  assert.match(textOf(byClass(v, 'team-empty')[0]), /^Not sharing live sessions right now$/);
  assert.doesNotMatch(textOf(v), /offline/i);
  assert.match(textOf(v), /0 online/);
});

test('before presence arrives: checking, not a claim that nobody is sharing', () => {
  const v = teamScreen(teamModel([], { presence: { members: [], loaded: false, stale: false } }));
  assert.match(textOf(v), /Checking…/);
  assert.doesNotMatch(textOf(v), /Not sharing live sessions right now/);
  assert.equal(byClass(v, 'team-needs').length, 0);
});

test('Needs you lists waiting sessions only, longest first; absent when none', () => {
  const none = teamScreen(teamModel([{ member_id: 'm-bob', name: 'Bob', sessions: [sess('working')] }]));
  assert.equal(byClass(none, 'team-needs').length, 0);
  const v = teamScreen(teamModel([
    { member_id: 'm-bob', name: 'Bob', sessions: [sess('waiting', { since: ago(60_000) })] },
    { member_id: 'm-carol', name: 'Carol', sessions: [sess('waiting', { since: ago(600_000), summary: 'pick a bank' }), sess('working')] },
  ]));
  const items = byClass(v, 'team-needs-item');
  assert.equal(items.length, 2);
  assert.match(textOf(items[0]), /^Carol is waiting in Claude .*10m.*pick a bank/);
  assert.match(textOf(items[1]), /^Bob is waiting/);
  assert.match(textOf(byClass(v, 'team-needs')[0]), /Needs you/);
});

test('untrusted summary is a text child, never markup (D25)', () => {
  const evil = '<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1))';
  const v = teamScreen(teamModel([{ member_id: 'm-bob', name: 'Bob', sessions: [sess('waiting', { summary: evil })] }]));
  const [p] = byClass(v, 'team-summary');
  assert.equal(p.children.length, 1);
  assert.equal(p.children[0].tag, '#text');
  assert.equal(p.children[0].text, evil);
  const seen = [];
  (function walk(n) { if (!n || n.tag === '#text') return; seen.push(n.tag); n.children.forEach(walk); })(v);
  assert.ok(!seen.includes('img') && !seen.includes('a'));
});

test('summary is clipped at 120 and an unknown agent or state degrades to plain text', () => {
  const v = teamScreen(teamModel([{ member_id: 'm-bob', name: 'Bob', sessions: [sess('mystery', { agent: 'robo', summary: 'x'.repeat(300) })] }]));
  assert.equal(textOf(byClass(v, 'team-summary')[0]).length, 120);
  assert.match(textOf(byClass(v, 'team-session')[0]), /robo.*Idle/);
});

test('stale: the page says presence may be out of date and marks the view', () => {
  const v = teamScreen(teamModel([{ member_id: 'm-bob', name: 'Bob', sessions: [sess('working')] }], { presence: { members: [{ member_id: 'm-bob', name: 'Bob', sessions: [sess('working')] }], loaded: true, stale: true } }));
  assert.equal(v.props['data-stale'], 'true');
  assert.match(textOf(v), /Presence may be out of date/);
  const fresh = teamScreen(teamModel([]));
  assert.equal(fresh.props['data-stale'], null);
  assert.doesNotMatch(textOf(fresh), /out of date/);
});

test('board work: running and assigned cards open the drawer; done cards and other people are left out', () => {
  const mine = view({ id: 'c-1', key: 'BDL-1', title: 'Running one' });
  const assigned = view({ id: 'c-2', key: 'BDL-2', title: 'Assigned todo', run_state: 'todo', column: 'todo', run: null, live: null, assignee_ids: ['m-alice'] });
  const done = view({ id: 'c-3', key: 'BDL-3', title: 'Finished', run_state: 'done', column: 'done' });
  const bobs = view({ id: 'c-4', key: 'BDL-4', title: 'Bob’s', assignee_ids: ['m-bob'], run: { id: 'r', owner: { member_id: 'm-bob', name: 'Bob' } } });
  const v = teamScreen(teamModel([], { entries: [mine, assigned, done, bobs].map(entry) }));
  const alice = byClass(v, 'team-member')[0];
  const buttons = byAttr(alice, 'data-action', 'open');
  assert.deepEqual(buttons.map((b) => b.props['data-card']), ['c-1', 'c-2']);
  assert.match(textOf(buttons[0]), /BDL-1Running one/);
  assert.equal(byClass(buttons[0], 'pill').length, 1);
  assert.deepEqual(byAttr(v, 'data-card', 'c-3'), []);
});

test('role shows for you when known; your card carries the you tag', () => {
  const v = teamScreen(teamModel([]));
  assert.match(textOf(byClass(v, 'team-member')[0]), /Alice.*you.*member/);
});

test('team overview keeps verification, reported tests and unavailable costs distinct, with safe cross-board links', () => {
  const task = { id: 'elsewhere', key: 'WEB-2', title: '<img src=x onerror=alert(1)>', board: { id: 'other', name: 'Client delivery' }, owner: { name: 'Bob' }, ai_label: 'Codex', activity: 'idle', evidence: { verification: 'hub_verified', tests: 'pass' }, cost: { cost_usd: null }, attention: {}, overlap_count: 1 };
  const data = { team: { name: 'Our team' }, board_count: 2, totals: { open: 3, attention: 1, review: 1, done: 2 }, boards: [], attention: { items: [] }, work: { items: [task] }, review: { items: [] }, recent: { items: [] } };
  const panel = overviewPanel({ teamOverview: { status: 'ok', data } });
  assert.match(textOf(panel), /Bob’s Codex.*Idle · task still open/);
  assert.match(textOf(panel), /Change verified · Tests reported: pass · Cost unavailable/);
  const button = byAttr(panel, 'data-action', 'team-open-card')[0];
  assert.equal(button.props['data-card'], 'elsewhere'); assert.equal(button.props['data-board'], 'other');
  assert.equal(byClass(panel, 'team-overview-task-title')[0].children[1].tag, '#text');
  assert.match(textOf(overviewPanel({ teamOverview: { status: 'ok', data, stale: true } })), /Last snapshot: Idle/);
  const pending = overviewPanel({ teamOverview: { status: 'loading', data: null } });
  assert.equal(byClass(pending, 'team-overview-stat').length, 0);
});
