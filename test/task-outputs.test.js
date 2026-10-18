'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const Outputs = require('../src/task-outputs');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test('saved output is bounded checkpoint data and only links the task-approved pull request', () => {
  const url = 'https://github.com/acme/app/pull/12';
  const task = { id: 'task-a', pr: { url }, checkpoint: { version: 3, at: 10, author: { kind: 'agent' }, provenance: 'participant', progress: '<script>unsafe()</script>', artifacts: [
    { kind: 'pr', url }, { kind: 'pr', url: 'javascript:unsafe()' }, { kind: 'pr', url: 'https://github.com/other/app/pull/1' }, { kind: 'commit', sha: 'a'.repeat(40) }, { kind: 'path', path: 'report.md' }, { kind: 'script', code: 'unsafe()' },
  ] } };
  const output = Outputs.fromTask(task);
  assert.equal(output.version, 3); assert.equal(output.author, 'Task agent');
  assert.deepEqual(output.artifacts.filter(a => a.href).map(a => a.href), [url]);
  assert.equal(output.artifacts.length, 5); assert.equal(output.text, '<script>unsafe()</script>');
  task.checkpoint.progress = 'x'.repeat(5000); assert.equal(Outputs.fromTask(task).text.length, 4000);
  assert.equal(Outputs.fromTask({}), null);
});

test('a response can be reviewed into the existing checkpoint and its report restores after renderer reopen', async t => {
  const row = { id: 'task-a', title: 'Report task', state: 'in_review', label: 'Needs review', tone: 'purple', green: false, actions: ['message'], confirm: [], ai: { id: 'codex' }, cost: { usd: 0, budgetUsd: null }, where: 'project', workInPlace: false, text: 'Write the report', messages: [], openApprovals: [], openAsk: null,
    checkpoint: { schemaVersion: 1, version: 2, at: 10, brief: 'Write the report', decisions: ['Preserve the approved decision'], progress: 'Earlier note', nextAction: 'Review the report', artifacts: [{ kind: 'path', path: 'report.md' }], reportedChecks: [], observed: { tests: null }, author: { kind: 'human' }, provenance: 'participant' } };
  let request = null;
  async function open() {
    const dom = new JSDOM(read('tasks.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://plexiform.invalid/tasks.html?embedded=1' });
    t.after(() => dom.window.close()); const w = dom.window, d = w.document;
    w.CSS ??= {}; w.CSS.escape ??= value => value; w.HTMLElement.prototype.scrollIntoView = () => {};
    w.tasksApi = { state: async () => ({ conn: { status: 'connected' }, tasks: [row] }), open: async () => ({ ok: true, detail: structuredClone(row), replay: [{ type: 'transcript', role: 'assistant', text: '<img src=x onerror=bad()> Final report', turn: 1, seq: 1, partial: false }] }), close: async () => {}, onChanged: () => {}, onEvent: () => {},
      saveCheckpoint: async r => { request = r; row.checkpoint = { ...row.checkpoint, ...r.data, version: 3, at: 20 }; return { ok: true, checkpoint: structuredClone(row.checkpoint) }; } };
    for (const file of ['src/tasks-view.js', 'src/task-outputs.js', 'tasks.js']) w.eval(read(file));
    await tick(); d.querySelector('[data-id="task-a"]').click(); await tick();
    return { w, d, button: label => [...d.querySelectorAll('button')].find(b => b.textContent === label) };
  }
  const first = await open();
  assert.match(first.d.getElementById('saved-output').textContent, /version 2.*You/);
  first.button('Keep this response').click();
  assert.equal(first.d.getElementById('checkpoint-progress').value, '<img src=x onerror=bad()> Final report');
  assert.equal(request, null, 'reviewing a response does not save it automatically');
  first.button('Save checkpoint').click(); await tick();
  assert.equal(request.expectedVersion, 2); assert.equal(request.data.decisions[0], 'Preserve the approved decision');
  assert.deepEqual(Array.from(request.data.artifacts, a => a.path), ['report.md']);
  const reopened = await open(), card = reopened.d.getElementById('saved-output');
  assert.match(card.textContent, /version 3/); assert.match(card.textContent, /Final report/); assert.match(card.textContent, /report\.md/);
  assert.equal(card.querySelector('img'), null, 'saved generated text is never executed');
});
