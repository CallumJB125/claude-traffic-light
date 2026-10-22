// The bus sandbox pin (AGENT-BUS.md §2.4.7): a bus run has no network. Claude:
// allowedDomains [] whatever the repo allows, WebFetch/WebSearch disallowed, and
// push / gh pr patterns as a backup only. Codex: network.enabled=false.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSettings, buildArgv, BUS_DISALLOWED, DISALLOWED_TOOLS } from '../launch.js';
import { codexConfig } from '../backends/codex.js';
import { startEngine, makeRepo, tmpDir, rm, writePolicy, waitFor } from '../../tasks-engine/test/helpers.js';
import { startBus, rid } from '../../tasks-engine/test/bus-helpers.js';

test('buildSettings: bus forces allowedDomains [] over the repo allowlist; others keep it', () => {
  const repo = { allowed_domains: ['registry.npmjs.org', 'github.com'] };
  assert.deepEqual(buildSettings({ worktree: '/wt', tmpdir: '/t', repo, bus: true }).sandbox.network, { allowedDomains: [], strictAllowlist: true });
  assert.deepEqual(buildSettings({ worktree: '/wt', tmpdir: '/t', repo }).sandbox.network.allowedDomains, ['registry.npmjs.org', 'github.com']);
  assert.equal(buildSettings({ worktree: '/wt', tmpdir: '/t', bus: true }).sandbox.allowUnsandboxedCommands, false);
  const argv = buildArgv({ runDir: '/r', sessionId: 's', extraDisallowed: BUS_DISALLOWED });
  for (const t of ['WebFetch', 'WebSearch', 'Bash(git push*)', 'Bash(gh pr*)']) assert.ok(argv.includes(t), t);
  assert.ok(DISALLOWED_TOOLS.includes('WebFetch') && DISALLOWED_TOOLS.includes('WebSearch'));
});

test('a bus Claude run is launched with no domains and the push/PR backup disallows', async () => {
  const dir = tmpDir();
  const repo = makeRepo(dir);
  // Explicit slots: the bus run holds one for 60 s while the local run starts (RAM-based default is 1 on CI).
  const m = await startEngine({ dir, scenario: { steps: [{ tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] }, engineOpts: { maxParallel: 4 } });
  try {
    writePolicy(m.dataDir, { repos: { [repo.checkout]: { bus_auto: true, allowed_domains: ['example.com'] } } });
    const { id } = await m.eng.engine.createTask({ requestId: rid('sbx'), spec: { text: 'x', cwd: repo.checkout, ai: 'claude', source: 'bus',
      sourceMeta: { handoffId: 'hof_0123456789abcdef', fence: 1, originTier: 'local_attested', scope: 'local' } } });
    const run = await waitFor(() => m.eng.engine.runs.get(id)?.backend && m.eng.engine.runs.get(id), { label: 'claude run' });
    const settings = JSON.parse(fs.readFileSync(path.join(run.runDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.sandbox.network.allowedDomains, []);
    assert.equal(settings.sandbox.network.strictAllowlist, true);
    assert.ok(settings.sandbox.filesystem.denyWrite.includes('~/.local/state/ghostty-dock'), 'a bus run cannot write requests for Ghostty Dock');
    const argv = run.backend.argv();
    for (const t of ['WebFetch', 'WebSearch', 'Bash(git push*)', 'Bash(gh pr*)']) assert.ok(argv.includes(t), t);
    // A local task keeps the ordinary profile (no bus backup patterns).
    const local = await m.client.createTask({ text: 'local one', cwd: repo.checkout, ai: 'claude' });
    const lrun = await waitFor(() => m.eng.engine.runs.get(local.id)?.backend && m.eng.engine.runs.get(local.id), { label: 'local run' });
    assert.ok(!lrun.backend.argv().includes('Bash(gh pr*)'));
  } finally { await m.close(); rm(dir); }
});

test('a bus Codex run has network.enabled=false and no user config', async () => {
  const b = await startBus({ text: 'ok' });
  try {
    await b.handoff({ request_id: rid('cdx') });
    const started = await waitFor(() => b.h.log().find((x) => x.kind === 'start'), { label: 'codex start' });
    assert.ok(started.argv.some((s) => s === 'permissions.plexiform.network.enabled=false'));
    assert.ok(started.argv.includes('--ignore-user-config'));
    assert.ok(started.argv.some((s) => s.startsWith('permissions.plexiform.filesystem=') && /\.local\/state\/ghostty-dock"?\s*=\s*"deny"/.test(s)), 'Codex bus runs are denied Ghostty Dock\'s folder');
    assert.ok(started.argv.some((s) => s.startsWith('mcp_servers.board.enabled_tools=') && s.includes('bus_result') && s.includes('bus_handoff')));
  } finally { await b.cleanup(); }
});

// plan-ghostty-dock §5.3: Ghostty Dock types into live terminals on request files
// in ~/.local/state/ghostty-dock, so no run may write there, even when the
// sandbox is told it may write anywhere in the home folder.
test('the Ghostty Dock state folder is write-denied even when the home folder is writable', () => {
  const s = buildSettings({ worktree: '/wt', tmpdir: '/t', repo: { allow_write_extra: ['~'] }, bus: true });
  assert.ok(s.sandbox.filesystem.allowWrite.includes('~'));
  assert.ok(s.sandbox.filesystem.denyWrite.includes('~/.local/state/ghostty-dock'));
  assert.ok(buildSettings({ worktree: '/wt', tmpdir: '/t', extraDenyWrite: ['/data'] }).sandbox.filesystem.denyWrite.includes('~/.local/state/ghostty-dock'));
  const fsArg = codexConfig({ cwd: '/Users/me', env: { HOME: '/Users/me' }, platform: 'darwin' }).find((a) => a.startsWith('permissions.plexiform.filesystem='));
  assert.match(fsArg, /"\/Users\/me\/\.local\/state\/ghostty-dock"\s*=\s*"deny"/);
});
