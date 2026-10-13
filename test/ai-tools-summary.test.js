'use strict';
// Home's banner, the AI tools page and Help's first-run prompt word "found /
// connected" from one summary (src/ai-tools.js), so they cannot disagree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { summary } = require('../src/ai-tools.js');
const Home = require('../src/home-main.js');
const Checklist = require('../src/setup-checklist.js');

const row = (id, label, o = {}) => ({ id, label, kind: 'tool', installed: true, connected: false, state: 'ready', ...o });
// The QA case: Claude Code and Codex found but not connected, Hermes Agent connected.
const QA = [row('claude', 'Claude Code'), row('codex', 'Codex'), row('gemini', 'Gemini CLI', { installed: false, state: 'missing' }), row('hermes', 'Hermes Agent', { connected: true, state: 'connected' })];
const LINE = 'Found Claude Code, Codex and Hermes Agent on this Mac. Hermes Agent connected; Claude Code and Codex not connected yet.';

test('summary names everything found, what is connected and what is not', () => {
  const s = summary(QA);
  assert.equal(s.text, LINE);
  assert.deepEqual(s.found, ['claude', 'codex', 'hermes']);
  assert.deepEqual(s.connected, ['hermes']);
  assert.deepEqual(s.waiting, ['claude', 'codex']);
  assert.equal(summary([row('codex', 'Codex', { connected: true })]).text, 'Found Codex on this Mac. Connected.');
  assert.equal(summary([row('codex', 'Codex')]).text, 'Found Codex on this Mac. Not connected yet.');
  assert.equal(summary([row('a', 'A', { connected: true }), row('b', 'B', { connected: true })]).text, 'Found A and B on this Mac. All connected.');
  assert.equal(summary([]).text, null);
  assert.equal(summary(null).text, null);
  // A broken config is still "not connected"; only the connectable ones are offered for Connect all.
  assert.deepEqual(summary([row('a', 'A'), row('b', 'B', { state: 'fix' })]).ready, ['a']);
  assert.deepEqual(summary([row('x', 'Mine', { kind: 'custom' })]).found, [], 'custom commands are not detected tools');
});

test('Home, Help and the AI tools page say the same thing for the same tools', async () => {
  const banner = Home.banner(QA);
  assert.ok(banner.text.startsWith(LINE), banner.text);
  assert.deepEqual(banner.action, { label: 'Connect 2 tools', destination: 'aitools:all' });

  const help = Checklist.build({ tools: QA });
  assert.equal(help.prompt.text, LINE);
  assert.deepEqual(help.prompt.ids, ['claude', 'codex']);
  assert.deepEqual(help.rows.filter((r) => r.id.startsWith('tool:')).map((r) => [r.id, r.state]), [['tool:claude', 'todo'], ['tool:codex', 'todo'], ['tool:hermes', 'done']]);

  const ROOT = path.join(__dirname, '..');
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'aitools.html'), 'utf8').replace(/<script src[^>]*><\/script>/, ''), { runScripts: 'outside-only', pretendToBeVisual: true });
  const full = QA.map((r) => ({ version: null, primary: { action: 'connect', label: 'Connect' }, detail: '', error: null, lastEvent: { at: null, text: 'no events yet' }, chips: [], note: null, canUndo: false, files: [], ...r }));
  const snap = { rows: full, pending: ['claude', 'codex'], summary: summary(QA) };
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.aiToolsApi = { scan: async () => snap, focus: async () => null, onChanged() {}, mcpStatus: async () => null };
  try {
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'aitools.js'), 'utf8'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dom.window.document.getElementById('status').textContent, LINE);
  } finally { dom.window.close(); }
});
