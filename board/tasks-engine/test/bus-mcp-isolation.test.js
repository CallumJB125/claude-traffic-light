// Regression (plan-agent-awareness §0, §6; step 3): once Plexiform registers its
// plexiform-bus tools for the person's own Claude Code and Codex, bus runs must
// still get only their per-run MCP server. Claude runs keep --strict-mcp-config
// with the run's own mcp.json and no user setting sources; Codex runs keep
// --ignore-user-config (so ~/.codex/config.toml's mcp_servers, plexiform-bus
// included, never load) and --strict-config.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildArgv, buildMcpConfig, BUS_DISALLOWED } from '../../runner/launch.js';
import { CodexBackend } from '../../runner/backends/codex.js';
import { startBus, rid } from './bus-helpers.js';
import { waitFor } from './helpers.js';

test('a Claude bus run: --strict-mcp-config with only its own run-dir mcp.json, which holds only the board server', () => {
  const runDir = '/tmp/run-x';
  const argv = buildArgv({ runDir, sessionId: '00000000-0000-4000-8000-000000000000', extraDisallowed: BUS_DISALLOWED });
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(argv[argv.indexOf('--mcp-config') + 1], path.join(runDir, 'mcp.json'));
  assert.equal(argv.filter((a) => a === '--mcp-config').length, 1);
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], '', 'no user or project settings');
  assert.deepEqual(Object.keys(buildMcpConfig({ socket: '/tmp/s', token: 't' }).mcpServers), ['board']);
  for (const p of BUS_DISALLOWED) assert.ok(argv.includes(p), p);
});

test('a Codex bus run: --ignore-user-config and --strict-config, fresh and resumed', () => {
  for (const resume of [false, true]) {
    const argv = new CodexBackend({ runDir: '/tmp/run-x', cwd: '/tmp/wt', cacheDir: '/tmp/c', dataDir: '/tmp/d', sessionId: 's', resume, permissionMode: 'acceptEdits' }).argv();
    assert.ok(argv.includes('--ignore-user-config') && argv.includes('--strict-config'), String(resume));
    assert.ok(!argv.some((a) => /plexiform-bus|claude-buddy/.test(a)));
  }
});

test('end to end: a hand-off to Codex starts `codex exec --ignore-user-config` with no user MCP server anywhere in its argv or env', async () => {
  const b = await startBus({ delayMs: 200, text: 'ok' });
  try {
    await b.handoff({ request_id: rid('iso') });
    const started = await waitFor(() => b.h.log().find((x) => x.kind === 'start'), { timeoutMs: 5000, label: 'codex exec started' });
    assert.ok(started.argv.includes('exec') && started.argv.includes('--ignore-user-config') && started.argv.includes('--strict-config'));
    assert.ok(!JSON.stringify(started).match(/plexiform-bus|claude-buddy|PLEXIFORM_MCP/));
  } finally { await b.cleanup(); }
});
