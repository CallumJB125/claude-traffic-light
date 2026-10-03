// Supervisor plumbing for Hermes and the cross-platform stop receipt. The
// Hermes binary is the replaying fixture; no real Hermes, model or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, OWNER } from './helpers.js';
import { ClaudeBackend } from '../backends/claude.js';
import { HermesBackend } from '../backends/hermes.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-hermes.js', import.meta.url));
const settle = () => new Promise((r) => setTimeout(r, 400));

// The real stop recipe runs, but its receipt is withheld: the observation
// that the old tree is gone never arrived (macOS/Linux, not only Windows).
class UnconfirmedStop extends ClaudeBackend {
  async stop() { await super.stop(); return false; }
}

test('an unconfirmed stop on macOS/Linux holds the run and workspace and blocks redispatch for the repo', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { ignore_eof: true, steps: [{ tool: 'Bash', input: { command: 'sleep 300' }, ms: 120000 }] }, opts: { Backend: UnconfirmedStop } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-31' }));
    assert.notEqual(run.backend.platform, 'win32');
    hub.send({ type: 'cmd', cmd_id: 'c1', run_id: run.run_id, card_id: run.card_id, fence: run.fence, cmd: 'stop' });
    await waitFor(() => run.windowsStopUnconfirmed, { what: 'quarantine', timeout: 15000 });
    await settle();
    assert.equal(run.ended, false, 'no end, release or cleanup without a stop receipt');
    assert.equal(run.gateState().open, false);
    assert.equal(await run.snapshotNow(), null, 'no snapshot of a worktree a live tree may still write');
    assert.ok(fs.existsSync(run.worktree), 'workspace preserved');
    assert.ok(sup.windowsQuarantinedRepos.has(run.repo_id));
    const claims = hub.of('claim').length;
    hub.send(offerFor({ key: 'APP-32' }));
    await settle();
    assert.equal(hub.of('claim').length, claims, 'no replacement claimed in the quarantined repo');
  } finally {
    // A quarantined run is kept for manual recovery, so its socket stays open.
    for (const r of sup.runs.values()) r.ipc?.close();
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('Hermes offers: only the member’s own dispatch is claimed; the run gets the per-run home, events and Git grant', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const bin = path.join(root, 'hermes');
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
  const hermes = { id: 'hermes', label: 'Hermes', installed: true, version: '0.21.3', signedIn: true, startable: true, bin, capabilities: HermesBackend.describe().capabilities };
  const env = { HOME: path.join(root, 'userhome'), PATH: process.env.PATH, TMPDIR: root, LANG: 'en_US.UTF-8' };
  fs.mkdirSync(env.HOME);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, env, opts: { detectAis: async () => [hermes], enabledAis: ['claude', 'hermes'] } });
  try {
    const claims = hub.of('claim').length;
    hub.send({ ...offerFor({ key: 'APP-41', by: 'm-teammate' }), ai: 'hermes', budget_usd: null, max_turns: null });
    await settle();
    assert.equal(hub.of('claim').length, claims, 'a teammate cannot start an unsandboxed AI on this machine');

    hub.send({ ...offerFor({ key: 'APP-42', by: OWNER }), ai: 'hermes', budget_usd: null, max_turns: 12, needs_confirm: false });
    const run = await waitFor(() => [...sup.runs.values()].find((r) => r.key === 'APP-42'), { what: 'hermes run' });
    await waitFor(() => run.sessionId === '20261003_101500_a1b2c3', { what: 'hermes session id' });
    await waitFor(() => run.backend && !run.backend.alive(), { what: 'turn exit' });
    assert.equal(run.backend.oneTurn, true);
    assert.ok(run.gitAccess, 'commit evidence can be published');
    const start = fs.readFileSync(path.join(run.runDir, 'fake-hermes.log'), 'utf8').trim().split('\n').map(JSON.parse).find((x) => x.kind === 'start');
    assert.equal(start.home, path.join(run.runDir, 'hermes-home'));
    assert.equal(start.argv[start.argv.indexOf('--max-turns') + 1], '12');
    assert.equal(start.config.mcp_servers.board.args.at(-1), run.runDir);
    assert.match(start.config.agent.system_prompt, /APP-42/);
    assert.equal(run.localState, 'idle', 'a successful one-turn exit leaves the run idle for the next message');
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
