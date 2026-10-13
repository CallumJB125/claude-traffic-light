const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanTitle, FALLBACK } = require('../src/title-clean.js');
const WorkCost = require('../src/work-cost.js');

const RAW = '<realtime_delegation> <source>transcript_tail_flush</source> <input>The user just ended the call';

test('strips tag blocks and stray tags from a realtime_delegation title', () => {
  const t = cleanTitle(RAW);
  assert.equal(t, 'The user just ended the call');
  assert.ok(!t.includes('<') && !t.includes('transcript_tail_flush'));
});

test('plain titles pass through, whitespace collapses, long ones truncate', () => {
  assert.equal(cleanTitle('  Fix\n the   login  '), 'Fix the login');
  assert.equal(cleanTitle('a'.repeat(300), 50).length, 50);
  assert.equal(cleanTitle('x < y and y > z'), 'x < y and y > z');
});

test('falls back when nothing is left', () => {
  assert.equal(cleanTitle('<a>only</a>'), FALLBACK);
  assert.equal(cleanTitle(null), FALLBACK);
  assert.equal(cleanTitle('   '), 'Untitled session');
  assert.equal(cleanTitle('', 10, 'Untitled card'), 'Untitled card');
});

test('work-cost shows cleaned card titles', () => {
  const ts = Date.now() - 3600000;
  const turn = { id: 't1', ts, sessionId: 's1', cwd: '/w/app', project: 'app', branch: 'main', model: 'claude-sonnet-4-5', modelKey: 'sonnet', subagent: false, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  const task = (title) => ({ provider: 'claude', session_id: 's1', task_id: 'session', card_id: 'c1', title, last_seen: ts });
  const card = (title, rec) => WorkCost.attribute({ turns: [turn], tasks: [task(title)], records: rec ? [{ adapter: 'claude', session_id: 's1', title: rec }] : [], now: Date.now() }).week.items.find((x) => x.kind === 'card');
  assert.equal(card(RAW).title, 'The user just ended the call');
  assert.equal(card('x', RAW).title, 'The user just ended the call');
  assert.equal(card('<a>only</a>').title, 'Untitled card');
});
