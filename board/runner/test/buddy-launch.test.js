// Board runs launched for Claude Buddy (pet-features P3+): the worktree root is
// a working directory by settings, permission prompts go to the board MCP
// approval tool on every launch, and each run carries BUDDY_OWNED backed by a
// launch record the root hooks (hooks/owned.js) accept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildArgv, buildEnv, buildSettings, buildMcpConfig, recordBuddyLaunch, buddyHomeOf } from '../launch.js';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, readFakeLog, waitFor } from './helpers.js';

const Owned = createRequire(import.meta.url)('../../../hooks/owned.js');

test('settings: the worktree root is an additional working directory', () => {
  const s = buildSettings({ worktree: '/wt', tmpdir: '/tmp/x/' });
  assert.deepEqual(s.permissions.additionalDirectories, ['/wt']);
  assert.ok(s.sandbox.filesystem.allowWrite.includes('/wt'));
});

test('argv: every launch (new, resume, any model) routes permission prompts to the board approval tool', () => {
  for (const o of [{}, { resume: true }, { model: 'opus' }, { boardHome: '/tmp/bh' }]) {
    const a = buildArgv({ runDir: '/r', sessionId: 'S', ...o });
    assert.equal(a[a.indexOf('--permission-prompt-tool') + 1], 'mcp__board__approval');
    assert.ok(a.includes('--strict-mcp-config'));
    assert.ok(!a.includes('--add-dir'), 'no --add-dir: it would load plugin settings from the worktree');
  }
  assert.deepEqual(Object.keys(buildMcpConfig({ socket: 's', token: 't' }).mcpServers), ['board']);
  assert.ok(buildSettings({ worktree: '/wt' }).permissions.allow.includes('mcp__board'));
});

test('BUDDY_OWNED: set only with a launch record, which the Buddy hooks accept', () => {
  const home = tmpDir();
  try {
    const wt = path.join(home, 'wt');
    fs.mkdirSync(wt);
    assert.equal(recordBuddyLaunch(path.join(home, 'missing'), { cwd: wt }), null, 'Buddy not installed: nothing written');
    assert.equal(recordBuddyLaunch(home, { cwd: 'relative' }), null);
    const id = recordBuddyLaunch(home, { cwd: wt });
    assert.match(id, Owned.LAUNCH_ID_RE);
    assert.equal(fs.statSync(path.join(home, 'owned')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, 'owned', `${id}.json`)).mode & 0o777, 0o600);
    assert.deepEqual(Owned.checkOwned(home, id, { sessionId: 's', cwd: path.join(wt, 'src') }), { owned: true, launchId: id, launcher: 'board', since: JSON.parse(fs.readFileSync(path.join(home, 'owned', `${id}.json`), 'utf8')).createdAt });
    assert.equal(buildEnv({ HOME: '/h' }, { runDir: '/r', buddyOwned: id }).BUDDY_OWNED, id);
    assert.ok(!('BUDDY_OWNED' in buildEnv({ HOME: '/h' }, { runDir: '/r' })));
    assert.equal(buddyHomeOf({ HOME: '/h' }), '/h/.claude-traffic-light');
    assert.equal(buddyHomeOf({ HOME: '/h', CLAUDE_TRAFFIC_LIGHT_HOME: '/b' }), '/b');
  } finally { rm(home); }
});

test('a real run: the spawned CLI gets BUDDY_OWNED for its worktree', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const buddyHome = path.join(root, 'buddy');
  fs.mkdirSync(buddyHome);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { steps: [{ result: 'success' }] }, opts: { buddyHome } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-98' }));
    const start = await waitFor(() => readFakeLog(run.runDir).find((e) => e.ev === 'start'), { what: 'fake start' });
    const id = start.env.BUDDY_OWNED;
    const rec = JSON.parse(fs.readFileSync(path.join(buddyHome, 'owned', `${id}.json`), 'utf8'));
    assert.equal(rec.cwd, run.worktree);
    assert.equal(rec.launcher, 'board');
    assert.equal(start.argv[start.argv.indexOf('--permission-prompt-tool') + 1], 'mcp__board__approval');
    const settings = JSON.parse(fs.readFileSync(path.join(run.runDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.additionalDirectories, [run.worktree]);
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
