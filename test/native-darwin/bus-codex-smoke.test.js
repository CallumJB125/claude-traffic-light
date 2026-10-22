'use strict';
// Real `codex exec` through the agent bus on a scratch repo (temp dirs; the
// run ignores ~/.codex/config.toml). Skipped unless Codex is installed and
// signed in on this Mac. One tiny prompt; no edits, commands or network asked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const board = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'board', f)).href;
const CODEX = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local/bin/codex')].find((p) => fs.existsSync(p));
const signedIn = fs.existsSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'));
const skip = process.platform !== 'darwin' ? 'macOS only' : !CODEX ? 'codex is not installed' : !signedIn ? 'codex is not signed in' : false;

test('agent bus → real codex exec 0.16x in a worktree → result back to bus_wait', { skip, timeout: 300_000 }, async () => {
  const { startTasksEngine } = await import(board('tasks-engine/index.js'));
  const { CodexBackend } = await import(board('runner/backends/codex.js'));
  const { makeRepo, tmpDir, rm, writePolicy, ENV } = await import(board('tasks-engine/test/helpers.js'));
  const { connect } = await import(board('tasks-api/client.js'));
  const { makeLogger } = await import(board('runner/util.js'));
  const dir = tmpDir('pxsmoke-');
  const repo = makeRepo(dir);
  class Codex extends CodexBackend { static detect(o) { return CodexBackend.detect({ ...o, knownDirs: [path.dirname(CODEX)] }); } }
  const eng = await startTasksEngine({ dataDir: path.join(dir, 'data'), backends: { codex: Codex }, enabledAis: ['codex'], defaultAi: 'codex', env: ENV, log: makeLogger(process.stderr, { quiet: true }), buddyHome: null });
  const client = await connect({ socketPath: eng.socketPath, tokenPath: eng.tokenPath });
  try {
    writePolicy(path.join(dir, 'data'), { repos: { [repo.checkout]: { bus_auto: true } } });
    const caller = { provider: 'claude', cwd: repo.checkout };
    const offer = await client.bus('handoff', { request_id: `smoke-${Date.now()}`, to: { provider: 'codex' }, provider: 'claude',
      title: 'Reply with exactly the word PONG', brief: 'Do not run commands, do not read or edit files. Reply with exactly: PONG' }, caller);
    assert.equal(offer.state, 'offered', JSON.stringify(offer));
    let r;
    for (let i = 0; i < 4 && r?.state !== 'done' && r?.state !== 'failed'; i++) r = await client.bus('wait', { handoff_id: offer.handoff_id, timeout_s: 60, provider: 'claude' }, caller, { timeoutMs: 75_000 });
    assert.equal(r.state, 'done', JSON.stringify(r));
    assert.match(r.result.text, /PONG/);
    assert.equal(r.result.cost_basis, 'estimated');
    const task = eng.engine.tasks.get(r.task_id);
    assert.notEqual(task.worktree, repo.checkout);
    assert.ok((task.tokens?.inputTokens ?? 0) > 0, 'usage reported at turn.completed');
  } finally { client.close(); await eng.close(); rm(dir); }
});
