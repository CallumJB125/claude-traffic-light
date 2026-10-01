const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../src/feedback.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-feedback-'));
// Assembled from fragments so no token-shaped literal sits in the source.
const fakeToken = () => ['gh', 'p_', 'a1B2c3D4e5'.repeat(3), 'x1Y2z3'].join('');
const base = { kind: 'off', text: 'The lamp stayed red', version: '1.2.3', os: 'darwin 15 arm64', at: '2026-10-01T10:00:00.000Z' };

test('the report carries kind, text, expected, version, OS and time', () => {
  const r = F.buildReport({ ...base, expected: 'It goes green' });
  for (const s of ['# Something\'s off', 'Kind: off', 'App version: 1.2.3', 'OS: darwin 15 arm64', 'Time: 2026-10-01T10:00:00.000Z', 'The lamp stayed red', 'It goes green']) assert.ok(r.markdown.includes(s), s);
  assert.ok(!F.buildReport(base).markdown.includes('What did you expect'));
});

test('an empty text or an unknown kind is refused', () => {
  assert.throws(() => F.buildReport({ ...base, text: '   ' }), /empty/);
  assert.throws(() => F.buildReport({ ...base, kind: 'bug' }), /bad kind/);
});

test('free text is scrubbed of secrets and the home folder', () => {
  const tok = fakeToken();
  const r = F.buildReport({ ...base, text: `It broke with ${tok} in /Users/someone/proj`, expected: `or ${tok}`, home: '/Users/someone' });
  assert.ok(!r.markdown.includes(tok));
  assert.ok(!r.markdown.includes('/Users/someone'));
  assert.match(r.markdown, /\[redacted\]/);
  assert.match(r.markdown, /~\/proj/);
});

test('text is capped at 4000 characters', () => {
  const r = F.buildReport({ ...base, text: 'word '.repeat(2000) });
  assert.equal(r.what.length, F.MAX_TEXT);
  assert.ok(r.what.endsWith('…'));
});

test('save writes the files with private modes', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp(), 'feedback');
  const report = F.buildReport(base);
  const folder = F.save({ dir, report, diagnostics: 'diag text\n', screenshot: Buffer.from('PNGDATA'), at: base.at });
  assert.equal(path.basename(folder), '2026-10-01T10-00-00-000Z-off');
  assert.deepEqual(fs.readdirSync(folder).sort(), ['diagnostics.txt', 'report.md', 'screenshot.png']);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  for (const f of fs.readdirSync(folder)) assert.equal(fs.statSync(path.join(folder, f)).mode & 0o777, 0o600, f);
  assert.equal(fs.readFileSync(path.join(folder, 'report.md'), 'utf8'), report.markdown);
});

test('diagnostics and screenshot are only written when given', () => {
  const folder = F.save({ dir: tmp(), report: F.buildReport(base), at: base.at });
  assert.deepEqual(fs.readdirSync(folder), ['report.md']);
});

test('only the newest 50 reports are kept', () => {
  const dir = tmp();
  for (let i = 0; i < 53; i += 1) F.save({ dir, report: F.buildReport(base), at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 50);
  assert.ok(left[0].startsWith('2026-10-01T00-03'), left[0]);
});

test('the GitHub link is encoded, capped, and absent without a repo', () => {
  const report = F.buildReport({ ...base, text: 'x & y = "z" #1\nline two' });
  assert.equal(F.githubUrl(undefined, report), null);
  assert.equal(F.githubUrl('not a repo', report), null);
  assert.equal(F.githubUrl('a/b/../c', report), null);
  const u = F.githubUrl('owner/repo', report, 'diag', { screenshot: true });
  assert.ok(u.startsWith('https://github.com/owner/repo/issues/new?title='));
  const q = new URL(u).searchParams;
  assert.match(q.get('title'), /^Something's off: x & y/);
  assert.match(q.get('body'), /x & y = "z" #1\nline two/);
  assert.match(q.get('body'), /drag it into the issue/);
  const big = F.githubUrl('owner/repo', report, 'd'.repeat(50000), { screenshot: true });
  assert.ok(big.length <= F.MAX_ISSUE_URL);
  assert.match(new URL(big).searchParams.get('body'), /cut to fit/);
  assert.match(new URL(big).searchParams.get('body'), /drag it into the issue/);
});

test('the GitHub sender is only available when feedbackRepo is set; the hub sender is a stub', () => {
  const gh = F.senders.find((s) => s.id === 'github');
  assert.equal(gh.available({}), false);
  assert.equal(gh.available({ feedbackRepo: 'owner/repo' }), true);
  assert.equal(F.senders.find((s) => s.id === 'hub').available({ feedbackRepo: 'owner/repo' }), false);
});
