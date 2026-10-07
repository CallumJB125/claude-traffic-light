'use strict';

// WP3: standalone "What's in context" from a Claude Code transcript (no Burst).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { breakdownText, breakdownFile, GROUPS } = require('../src/context-breakdown.js');

const SECRET = 'PRIVATE-PROMPT-TEXT';
const j = (o) => JSON.stringify(o);
const user = (content, extra = {}) => j({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content, usage) => j({ type: 'assistant', message: { role: 'assistant', content, ...(usage ? { usage } : {}) } });
// A transcript shaped like Claude Code's: a reminder, a prompt, a tool round trip, a reply,
// and the API's reported input size on the last assistant line.
function fixture({ reported = { input_tokens: 4, cache_creation_input_tokens: 1200, cache_read_input_tokens: 18000 } } = {}) {
  return [
    j({ type: 'summary', summary: 'old' }),
    user(`<system-reminder>${'r'.repeat(2000)}</system-reminder>`, { isMeta: true }),
    user(`${SECRET} ${'p'.repeat(800)}`),
    assistant([{ type: 'thinking', thinking: 't'.repeat(400), signature: 'sig' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x/a.js' } }]),
    user([{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'c'.repeat(12000) }, { type: 'image', source: {} }] }]),
    j({ type: 'attachment', attachment: { type: 'file', content: 'a'.repeat(1000) } }),
    j({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(50000) }] } }),
    assistant([{ type: 'text', text: 'd'.repeat(3000) }], reported),
    'not json',
    '',
  ].join('\n');
}

test('breakdown of a fixture transcript sums to within 5% of its reported input tokens; only sizes leave', () => {
  const b = breakdownText(fixture());
  const reported = 4 + 1200 + 18000;
  assert.equal(b.reportedInputTokens, reported);
  assert.ok(Math.abs(b.total.tokens - reported) / reported <= 0.05, `${b.total.tokens} vs ${reported}`);
  assert.equal(b.estimate, false);
  const by = Object.fromEntries(b.groups.map((g) => [g.group, g]));
  assert.ok(by[GROUPS.results].bytes >= 12000 && by[GROUPS.results].tokens >= 3000 + 1600, 'tool result text plus an image');
  assert.ok(by[GROUPS.reminders].bytes > 2000, 'meta reminder and attachment');
  assert.ok(by[GROUPS.prompts].bytes > 800 && by[GROUPS.prompts].bytes < 1000);
  assert.equal(by[GROUPS.replies].bytes, 3400, 'thinking and text; the sidechain is not counted');
  assert.ok(by[GROUPS.calls].bytes > 0);
  assert.ok(by[GROUPS.base].tokens > 0, 'what the transcript does not hold (system prompt, tools) is the remainder');
  assert.ok(!JSON.stringify(b).includes(SECRET));
  assert.deepEqual(Object.keys(b.groups[0]).sort(), ['bytes', 'group', 'tokens']);
});

test('an over-estimate is scaled to the reported size; without one it is a plain bytes/4 estimate', () => {
  const small = breakdownText(fixture({ reported: { input_tokens: 2000 } }));
  assert.ok(Math.abs(small.total.tokens - 2000) <= 2 * small.groups.length, `${small.total.tokens}`);
  assert.equal(small.groups.some((g) => g.group === GROUPS.base && g.tokens > 0), false);
  const none = breakdownText(fixture({ reported: null }));
  assert.equal(none.reportedInputTokens, 0);
  assert.equal(none.estimate, true);
  assert.ok(none.total.tokens > 4000);
});

test('only what follows the last compaction boundary counts', () => {
  const text = `${fixture()}\n${j({ type: 'system', subtype: 'compact_boundary' })}\n${user('s'.repeat(400), { isCompactSummary: true })}\n${user('next')}`;
  const b = breakdownText(text);
  assert.equal(b.reportedInputTokens, 0);
  assert.deepEqual(b.groups.map((g) => g.group), [GROUPS.reminders, GROUPS.prompts]);
  assert.deepEqual(breakdownText(''), { total: { bytes: 0, tokens: 0 }, groups: [], reportedInputTokens: 0, estimate: true });
});

test('breakdownFile reads only the tail and drops the partial first line; a missing file is null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-bd-'));
  try {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, `${user('z'.repeat(100000))}\n${fixture()}`);
    const whole = await breakdownFile(file);
    const tail = await breakdownFile(file, { maxBytes: Buffer.byteLength(fixture()) + 50 });
    assert.equal(tail.reportedInputTokens, 19204);
    assert.ok(tail.groups.find((g) => g.group === GROUPS.prompts).bytes < 1000, 'the 100 kB first line was cut off');
    assert.ok(whole.groups.find((g) => g.group === GROUPS.prompts).bytes > 100000);
    assert.equal(await breakdownFile(path.join(dir, 'missing.jsonl')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
