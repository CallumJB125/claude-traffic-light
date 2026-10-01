// "You've approved this 5 times — make it a rule?" (src/approval-nudge.js):
// identical approvals are counted by a hash; the file never holds the command.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNudgeCounter, suggestionFor, THRESHOLD, WINDOW_MS } = require('../src/approval-nudge.js');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-nudge-')), 'approval-counts.json');
const SECRET = require('crypto').randomBytes(32);
const counter = (o) => createNudgeCounter({ secret: () => SECRET, ...o });
const bash = (command) => ({ kind: 'permission', tool: 'Bash', toolInput: { command }, cwd: '/w/app' });

test('the same command, however it was spaced, counts as one; the fifth approval nudges once', () => {
  const file = tmpFile();
  const c = counter({ file, home: '/Users/tester' });
  const seen = [];
  for (let i = 0; i < THRESHOLD + 2; i++) {
    const r = c.record(bash(i % 2 ? 'npm   test' : 'npm test'));
    seen.push(r);
    if (r.nudge) c.offer(r.key); // shown
  }
  assert.deepEqual(seen.map((s) => s.count), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(seen.map((s) => !!s.nudge), [false, false, false, false, true, false, false], 'offered once per run, once shown');
  assert.deepEqual(seen[4].nudge, { action: 'allow', tools: ['Bash'], command: 'npm test' });
  assert.deepEqual(c.take(seen[4].key), seen[4].nudge);
  assert.equal(c.take(seen[4].key), null, 'taken once');
});

test('the counter file holds hashes and counts only, never the command or path', () => {
  const file = tmpFile();
  const c = counter({ file });
  c.record(bash('npm run secret-project-build'));
  c.record({ kind: 'permission', tool: 'Read', toolInput: { file_path: '/w/private-client/notes.md' } });
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /secret-project|private-client|npm|notes/);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const again = counter({ file });
  assert.equal(again.count(again.keyFor(bash('npm run secret-project-build'))), 1, 'counts survive a restart');
});

test('never offered for what a rule could not allow, or what a rule already covers', () => {
  const c = counter({ file: tmpFile(), threshold: 2, home: '/Users/tester' });
  for (let i = 0; i < 3; i++) assert.equal(c.record(bash('rm build.log')).nudge, null, 'destructive');
  const rules = [{ tools: ['Bash'], command: 'npm test' }];
  for (let i = 0; i < 3; i++) assert.equal(c.record(bash('npm test'), rules).nudge, null, 'covered');
  assert.equal(c.record(bash('ls | wc -l')), null, 'not one plain command: not counted');
  assert.equal(c.record({ kind: 'plan', tool: 'ExitPlanMode', toolInput: {} }), null);
});

test('files count by folder; "don’t ask again" sticks', () => {
  const file = tmpFile();
  const c = counter({ file, threshold: 2 });
  const r = (f) => c.record({ kind: 'permission', tool: 'Edit', toolInput: { file_path: f } });
  r('/w/app/src/a.js');
  const second = r('/w/app/src/b.js');
  assert.deepEqual(second.nudge, { action: 'allow', tools: ['Edit'], path: '/w/app/src/*' });
  assert.equal(c.mute(second.key), true);
  assert.equal(c.mute('not a key'), false);
  const fresh = counter({ file, threshold: 2 });
  fresh.record({ kind: 'permission', tool: 'Edit', toolInput: { file_path: '/w/app/src/c.js' } });
  assert.equal(fresh.record({ kind: 'permission', tool: 'Edit', toolInput: { file_path: '/w/app/src/d.js' } }).nudge, null, 'muted across restarts');
});

test('keys are an HMAC under the install secret: another secret, another key; no secret, no count', () => {
  const file = tmpFile();
  const a = counter({ file });
  const b = createNudgeCounter({ file: tmpFile(), secret: () => require('crypto').randomBytes(32) });
  assert.notEqual(a.keyFor(bash('npm test')), b.keyFor(bash('npm test')));
  assert.equal(suggestionFor(bash('npm test')).key, undefined, 'no unkeyed hash anywhere');
  assert.throws(() => createNudgeCounter({ file: tmpFile(), secret: () => null }).record(bash('npm test')), /secret/);
});

test('the file is 0600 even if it already existed wider; a nudge not yet shown is offered again', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  const c = counter({ file, threshold: 1 });
  const r = c.record(bash('ls'));
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.ok(r.nudge);
  assert.ok(c.record(bash('ls')).nudge, 'never shown (auto-answer off): still on offer');
});

test('counts older than 30 days start again', () => {
  let t = Date.parse('2026-10-01T00:00:00Z');
  const c = counter({ file: tmpFile(), now: () => t });
  for (let i = 0; i < 4; i++) c.record(bash('ls'));
  t += WINDOW_MS + 1000;
  assert.equal(c.record(bash('ls')).count, 1);
});

test('an MCP tool that deletes or publishes is never suggested as a rule', () => {
  const c = counter({ file: tmpFile(), threshold: 1 });
  assert.equal(c.record({ kind: 'permission', tool: 'mcp__github__delete_repository', toolInput: {} }).nudge, null);
  assert.ok(c.record({ kind: 'permission', tool: 'mcp__linear__list_issues', toolInput: {} }).nudge);
});

test('a v1 counter file (plain hashes) is dropped on load', () => {
  const file = tmpFile();
  const plain = require('crypto').createHash('sha256').update(JSON.stringify(['Bash', 'npm test', null])).digest('hex').slice(0, 32);
  fs.writeFileSync(file, JSON.stringify({ v: 1, counts: { [plain]: { n: 4, at: Date.now() } }, muted: { [plain]: true } }));
  const c = counter({ file });
  assert.equal(c.count(plain), 0);
  assert.equal(c.record(bash('npm test')).count, 1, 'counting starts again under the keyed scheme');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.v, 2);
  assert.ok(!(plain in saved.counts) && !(plain in saved.muted));
});

test('the counter file is replaced atomically (temp file, rename, 0600), never written in place', () => {
  const file = tmpFile();
  const c = counter({ file });
  c.record(bash('ls'));
  const renames = [];
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => { renames.push([a, b]); return orig(a, b); };
  try { c.record(bash('ls')); } finally { fs.renameSync = orig; }
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], file);
  assert.notEqual(renames[0][0], file);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n !== path.basename(file)), [], 'no temp file left behind');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).counts[c.keyFor(bash('ls'))].n, 2);
});

test('PRIVACY.md lists the counter and its secret', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'PRIVACY.md'), 'utf8');
  assert.match(doc, /`approval-counts\.json`/);
  assert.match(doc, /`approval-secret\.json`/);
});
