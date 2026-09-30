// "You've approved this 5 times — make it a rule?" (src/approval-nudge.js):
// identical approvals are counted by a hash; the file never holds the command.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNudgeCounter, suggestionFor, THRESHOLD } = require('../src/approval-nudge.js');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-nudge-')), 'approval-counts.json');
const bash = (command) => ({ kind: 'permission', tool: 'Bash', toolInput: { command }, cwd: '/w/app' });

test('the same command, however it was spaced, counts as one; the fifth approval nudges once', () => {
  const file = tmpFile();
  const c = createNudgeCounter({ file, home: '/Users/tester' });
  const seen = [];
  for (let i = 0; i < THRESHOLD + 2; i++) seen.push(c.record(bash(i % 2 ? 'npm   test' : 'npm test')));
  assert.deepEqual(seen.map((s) => s.count), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(seen.map((s) => !!s.nudge), [false, false, false, false, true, false, false], 'offered once per run');
  assert.deepEqual(seen[4].nudge, { action: 'allow', tools: ['Bash'], command: 'npm test' });
  assert.deepEqual(c.take(seen[4].key), seen[4].nudge);
  assert.equal(c.take(seen[4].key), null, 'taken once');
});

test('the counter file holds hashes and counts only, never the command or path', () => {
  const file = tmpFile();
  const c = createNudgeCounter({ file });
  c.record(bash('npm run secret-project-build'));
  c.record({ kind: 'permission', tool: 'Read', toolInput: { file_path: '/w/private-client/notes.md' } });
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /secret-project|private-client|npm|notes/);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const again = createNudgeCounter({ file });
  assert.equal(again.count(suggestionFor(bash('npm run secret-project-build')).key), 1, 'counts survive a restart');
});

test('never offered for what a rule could not allow, or what a rule already covers', () => {
  const c = createNudgeCounter({ file: tmpFile(), threshold: 2, home: '/Users/tester' });
  for (let i = 0; i < 3; i++) assert.equal(c.record(bash('rm build.log')).nudge, null, 'destructive');
  const rules = [{ tools: ['Bash'], command: 'npm test' }];
  for (let i = 0; i < 3; i++) assert.equal(c.record(bash('npm test'), rules).nudge, null, 'covered');
  assert.equal(c.record(bash('ls | wc -l')), null, 'not one plain command: not counted');
  assert.equal(c.record({ kind: 'plan', tool: 'ExitPlanMode', toolInput: {} }), null);
});

test('files count by folder; "don’t ask again" sticks', () => {
  const file = tmpFile();
  const c = createNudgeCounter({ file, threshold: 2 });
  const r = (f) => c.record({ kind: 'permission', tool: 'Edit', toolInput: { file_path: f } });
  r('/w/app/src/a.js');
  const second = r('/w/app/src/b.js');
  assert.deepEqual(second.nudge, { action: 'allow', tools: ['Edit'], path: '/w/app/src/*' });
  assert.equal(c.mute(second.key), true);
  assert.equal(c.mute('not a key'), false);
  const fresh = createNudgeCounter({ file, threshold: 2 });
  fresh.record({ kind: 'permission', tool: 'Edit', toolInput: { file_path: '/w/app/src/c.js' } });
  assert.equal(fresh.record({ kind: 'permission', tool: 'Edit', toolInput: { file_path: '/w/app/src/d.js' } }).nudge, null, 'muted across restarts');
});
