'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/burst-handover.js');

const FILE = `# Handoff

## 2026-10-05 Session
Older note. Fixed the parser.

## 2026-10-06 Session
Newest: working in /Users/callumbaker/Desktop/secret-project. Token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 is in .env.
Email me at someone@example.com.
`;

test('matchRoot: longest audited root containing the session cwd; nothing outside', () => {
  const audit = [{ root: '/work/a' }, { root: '/work/a/pkg' }, { root: '/work/b' }];
  assert.equal(H.matchRoot('/work/a/pkg/src', audit), '/work/a/pkg');
  assert.equal(H.matchRoot('/work/a', audit), '/work/a');
  assert.equal(H.matchRoot('/work/ab', audit), null);
  assert.equal(H.matchRoot('/etc', audit), null);
  assert.equal(H.matchRoot('', audit), null);
});

test('newestSection takes the newest dated section, wherever it sits', () => {
  assert.match(H.newestSection(FILE).text, /^## 2026-10-06/);
  assert.equal(H.newestSection(FILE).date, '2026-10-06');
  assert.match(H.newestSection(FILE.split('## 2026-10-06')[0]).text, /^## 2026-10-05/);
  assert.equal(H.localView(''), null);
});

test('local view needs no opt-in; hub payload does (default off, per repo)', () => {
  assert.ok(H.localView(FILE).text.includes('Newest'));
  assert.equal(H.hubPayload('/work/a', FILE, { shared: {} }), null);
  assert.equal(H.hubPayload('/work/a', FILE, { shared: { [H.repoKey('/work/b')]: true } }), null);
  assert.equal(H.hubPayload('/work/a', FILE, { shared: { [H.repoKey('/work/a')]: false } }), null);
});

test('shared payload is scrubbed and is a system-written salvage note only', () => {
  const p = H.hubPayload('/work/a', FILE, { shared: { [H.repoKey('/work/a')]: true }, home: '/Users/callumbaker', user: 'callumbaker' });
  assert.equal(p.written_by, 'system');
  assert.equal(p.section, 'salvage');
  assert.deepEqual(Object.keys(p).sort(), ['date', 'repo', 'section', 'text', 'written_by']);
  assert.ok(!p.text.includes('sk-ant-api03'), p.text);
  assert.ok(!p.text.includes('someone@example.com'), p.text);
  assert.ok(!p.text.includes('/Users/callumbaker'), p.text);
  assert.ok(!p.text.includes('Older note'));
  assert.ok(!p.repo.includes('work'), 'the repository is identified by a hash, not its path');
});

test('shareToHub sends nothing unless opted in and a hub sender exists', async () => {
  const sent = [];
  const send = async (m) => { sent.push(m); };
  assert.deepEqual(await H.shareToHub({ root: '/work/a', content: FILE, shared: {}, send }), { ok: false, reason: 'not-shared' });
  const shared = { [H.repoKey('/work/a')]: true };
  assert.deepEqual(await H.shareToHub({ root: '/work/a', content: FILE, shared }), { ok: false, reason: 'no-hub' });
  assert.equal(sent.length, 0);
  assert.deepEqual(await H.shareToHub({ root: '/work/a', content: FILE, shared, send }), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].written_by, 'system');
});
