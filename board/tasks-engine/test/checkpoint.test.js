import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, rm } from './helpers.js';
import { buildPacket, cleanPacketData, packetData, packetMarkdown } from '../checkpoint.js';

const data = () => ({ brief: 'Repair signup', decisions: ['Use the existing route.'], progress: 'Read the handler.', nextAction: 'Run the scoped regression.', artifacts: [], reportedChecks: ['Unit check pending.'] });
const meta = { version: 1, at: 1000, author: { kind: 'human', id: 'local-owner', source: 'local' }, provenance: 'participant', observed: { state: 'parked', tests: null } };

test('portable packets redact credentials, complete private keys, task capabilities, signed URLs and local paths before storage', () => {
  const root = tmpDir();
  try {
    const d = data();
    d.progress = `Bearer ${'a'.repeat(40)}\nBOARD_SECRET=${'b'.repeat(64)}\nbtr_${'x'.repeat(43)}\n${root}/src/route.js /Users/elsewhere/.ssh/key /opt/unrelated/file\nhttps://user:password@example.test/preview?token=abc#secret\n-----BEGIN PRIVATE KEY-----\nPRIVATE_TEST_SENTINEL\n-----END PRIVATE KEY-----`;
    d.progress += '\nfile:///opt/private/report C:\\build\\private\\file \\\\server\\private\\file';
    const p = buildPacket(d, { root }, meta);
    const stored = JSON.stringify(p);
    for (const secret of ['a'.repeat(40), 'b'.repeat(64), 'x'.repeat(43), 'PRIVATE_TEST_SENTINEL', root, '/Users/', '/opt/', 'password', '?token=', '#secret', 'C:', 'server']) assert.ok(!stored.includes(secret), secret.slice(0, 20));
    assert.match(p.progress, /src\/route.js/);
    assert.match(p.progress, /https:\/\/example.test\/preview/);
    assert.deepEqual(packetData(p), cleanPacketData(d, { root }));
    assert.ok(!/permissionLevel|planApproved/.test(packetMarkdown(p)));
    assert.match(packetMarkdown(p), /Current permissions and review decisions come from Plexiform/);
  } finally { rm(root); }
});

test('artifact references stay in the task scope, reject private files and traversal, and accept only observed commits/PRs', () => {
  const root = tmpDir(), outside = tmpDir();
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'data');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const sha = 'a'.repeat(40), ctx = { root, commits: [sha], prUrl: 'https://github.com/team/repo/pull/1' };
    const d = data(); d.artifacts = [{ kind: 'path', path: 'README.md' }, { kind: 'commit', sha }, { kind: 'pr', url: ctx.prUrl }];
    assert.deepEqual(buildPacket(d, ctx, meta).artifacts, d.artifacts);
    const invalids = [
      { kind: 'path', path: '../other/file' }, { kind: 'path', path: '/opt/other/file' }, { kind: 'path', path: 'C:\\Users\\other\\file' },
      { kind: 'path', path: '.env' }, { kind: 'path', path: 'config/.env.production' }, { kind: 'path', path: '.git/config' },
      { kind: 'path', path: 'config/secret.key' }, { kind: 'path', path: 'escape/file.js' }, { kind: 'commit', sha: 'b'.repeat(40) },
      { kind: 'path', path: 'bad\0file' },
      { kind: 'pr', url: 'https://github.com/other/repo/pull/1' }, { kind: 'command', command: 'git push' },
    ];
    for (const a of invalids) assert.throws(() => buildPacket({ ...d, artifacts: [a] }, ctx, meta), { code: 'VALIDATION' });
  } finally { rm(root); rm(outside); }
});

test('a packet cannot carry forged authority/provenance or unbounded participant data', () => {
  const root = tmpDir();
  try {
    for (const k of ['author', 'version', 'permissions', 'planApproved', 'reviewed', 'cwd', 'fence']) assert.throws(() => buildPacket({ ...data(), [k]: true }, { root }, meta), { code: 'VALIDATION' });
    assert.throws(() => buildPacket({ ...data(), brief: 'x'.repeat(4001) }, { root }, meta), { code: 'VALIDATION' });
    assert.throws(() => buildPacket({ ...data(), decisions: Array(21).fill('x') }, { root }, meta), { code: 'VALIDATION' });
    assert.throws(() => buildPacket({ ...data(), artifacts: [{ kind: 'path', path: 'README.md', owner: 'admin' }] }, { root }, meta), { code: 'VALIDATION' });
    assert.throws(() => buildPacket({ ...data(), brief: '字'.repeat(4000), progress: '字'.repeat(4000), decisions: Array(20).fill('字'.repeat(500)), reportedChecks: Array(20).fill('字'.repeat(500)) }, { root }, meta), { code: 'PAYLOAD_TOO_LARGE' });
  } finally { rm(root); }
});
