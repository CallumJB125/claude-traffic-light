// Gemini adapter against a replaying stream-json fixture. No real Gemini CLI,
// model or network is ever used: the real CLI's flags and event shapes remain
// unverified here (see backends/gemini.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiBackend } from '../backends/gemini.js';
import { BACKENDS } from '../backends/index.js';
import { CODEX_BOARD_TOOLS } from '../../mcp/codex-run.js';
import { tmpDir, rm, waitFor } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-gemini.js', import.meta.url));
const SESSION = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';

function setup(dir, { streamFile, env: extraEnv = {}, ...extra } = {}) {
  const runDir = path.join(dir, 'run'); fs.mkdirSync(runDir, { mode: 0o700 });
  const log = path.join(dir, 'fake.log'); const bin = path.join(dir, 'gemini');
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
  const env = { HOME: dir, PATH: process.env.PATH, TMPDIR: dir, PLEXIFORM_FAKE_GEMINI_LOG: log, ...(streamFile ? { PLEXIFORM_FAKE_GEMINI_STREAM: streamFile } : {}), ...extraEnv };
  const backend = new GeminiBackend({ bin, cwd: dir, env, runDir, boardRunDir: runDir, sessionId: null, systemPrompt: 'trusted scope', permissionMode: 'acceptEdits', stopGraceMs: 300, ...extra });
  return { backend, runDir, read: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}
const collect = (b) => { const events = []; for (const n of ['init', 'tool_start', 'tool_end', 'assistant', 'usage', 'result', 'exit']) b.on(n, (data) => events.push({ n, data })); return events; };

test('Gemini turn: prompt only on stdin, isolated GEMINI_CLI_HOME with the per-run board server, stream-json events normalized', async () => {
  const dir = tmpDir('px-gemini-');
  try {
    fs.mkdirSync(path.join(dir, '.gemini')); fs.writeFileSync(path.join(dir, '.gemini', 'oauth_creds.json'), '{}');
    fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), '{"mcpServers":{"evil":{"command":"x"}}}');
    const f = setup(dir, { model: 'gemini-2.5-pro' }); const events = collect(f.backend);
    const prompt = 'task $(touch /tmp/forged) --yolo';
    await f.backend.start(prompt);
    await waitFor(() => f.backend.exited, { what: 'Gemini completion' });
    const start = f.read().find((x) => x.kind === 'start');
    assert.ok(!start.argv.some((a) => a.includes(prompt) || a.includes('trusted scope')), 'prompt never in argv');
    assert.equal(f.read().find((x) => x.kind === 'prompt').prompt, `trusted scope\n\n${prompt}`);
    assert.deepEqual(start.argv, ['--output-format', 'stream-json', '--approval-mode', 'yolo', '--model', 'gemini-2.5-pro']);
    assert.equal(start.home, path.join(f.runDir, 'gemini-home'), 'never the user Gemini home');
    assert.equal(start.cred, true, 'OAuth credentials linked, not copied');
    assert.equal(start.systemMd, null);
    assert.deepEqual(Object.keys(start.settings.mcpServers), ['board'], 'user settings never copied');
    assert.equal(start.settings.mcpServers.board.args.at(-1), f.runDir);
    assert.deepEqual(start.settings.mcpServers.board.includeTools, [...CODEX_BOARD_TOOLS]);

    assert.deepEqual(events.filter((e) => e.n === 'init').map((e) => e.data.session_id), [SESSION]);
    assert.deepEqual(events.filter((e) => e.n === 'assistant').map((e) => e.data.text), ['Looking at the repo.', 'Done.']);
    const starts = events.filter((e) => e.n === 'tool_start').map((e) => e.data);
    assert.deepEqual(starts.map((s) => [s.name, s.input]), [['Bash', { command: 'git status --short' }], ['Write', { file_path: 'notes.txt' }], ['mcp_board_board_update_status', { text: 'working' }]]);
    const ends = events.filter((e) => e.n === 'tool_end').map((e) => e.data);
    assert.deepEqual(ends.map((e) => [e.id, e.ok]), [['t1', true], ['t2', true], ['t3', false]]);
    assert.equal(ends[0].output, ' M README.md');
    assert.equal(ends[2].output, 'denied');
    assert.deepEqual(events.find((e) => e.n === 'usage').data, { inputTokens: 1200, outputTokens: 80, costUsd: null });
    const r = events.find((e) => e.n === 'result').data;
    assert.deepEqual([r.subtype, r.is_error, r.result, r.total_cost_usd], ['success', false, 'Done.', null]);
    assert.deepEqual(events.at(-1), { n: 'exit', data: { code: 0, signal: null, error: null, sawResult: true } });
    assert.equal(f.backend.send('next'), false);
    f.backend.resume = true;
    assert.deepEqual(f.backend.argv().slice(-2), ['--resume', SESSION]);
  } finally { rm(dir); }
});

test('Gemini refuses budgets, turn caps, approval/plan modes and unknown resume ids before spawn; failed turns normalize', async () => {
  const dir = tmpDir('px-gemini-');
  try {
    const failed = path.join(dir, 'failed.jsonl');
    fs.writeFileSync(failed, [{ type: 'init', session_id: SESSION }, { type: 'error', severity: 'error', message: 'quota exhausted' }, { type: 'result', status: 'error', stats: {} }].map((x) => JSON.stringify(x)).join('\n'));
    const f = setup(dir, { streamFile: failed });
    const refuse = (patch) => { Object.assign(f.backend, patch); assert.throws(() => f.backend.start('go'), (e) => e.code === 'NOT_AVAILABLE' && !/\//.test(e.message)); assert.equal(f.backend.pid, null); };
    refuse({ budgetUsd: 5 }); refuse({ budgetUsd: null, maxTurns: 40 }); refuse({ maxTurns: null, permissionMode: 'plan' }); refuse({ permissionMode: 'default' });
    refuse({ permissionMode: 'acceptEdits', resume: true, sessionId: '../../etc' });
    Object.assign(f.backend, { resume: false, sessionId: null });
    const events = collect(f.backend);
    await f.backend.start('go');
    await waitFor(() => f.backend.exited, { what: 'failed turn' });
    const r = events.find((e) => e.n === 'result').data;
    assert.deepEqual([r.subtype, r.is_error], ['error', true]); assert.match(r.result, /quota exhausted/);
  } finally { rm(dir); }
});

test('Gemini stop terminates its process group and returns a verified receipt', async () => {
  const dir = tmpDir('px-gemini-'); let b;
  try {
    const f = setup(dir, { env: { PLEXIFORM_FAKE_GEMINI_HANG: '1' } }); b = f.backend;
    await b.start('go'); await waitFor(() => b.sawResult, { what: 'result before hang' });
    assert.equal(await b.stop(), true); assert.equal(b.exited, true);
  } finally { await b?.stop(); rm(dir); }
});

test('Gemini detect: version gate, signed-in only from the presence of the member OAuth file', async () => {
  const dir = tmpDir('px-gemini-');
  try {
    const f = setup(dir); const bin = path.dirname(f.backend.bin);
    const out = await GeminiBackend.detect({ env: { HOME: dir, PATH: bin }, knownDirs: [] });
    assert.deepEqual([out.id, out.installed, out.version, out.signedIn, out.startable], ['gemini', true, '0.12.0', 'unknown', undefined]);
    fs.mkdirSync(path.join(dir, '.gemini')); fs.writeFileSync(path.join(dir, '.gemini', 'oauth_creds.json'), '{}');
    assert.equal((await GeminiBackend.detect({ env: { HOME: dir, PATH: bin }, knownDirs: [] })).signedIn, true);
    fs.writeFileSync(f.backend.bin, '#!/bin/sh\necho 0.9.0\n', { mode: 0o755 });
    const old = await GeminiBackend.detect({ env: { HOME: dir, PATH: bin }, knownDirs: [] });
    assert.deepEqual([old.startable, old.reason], [false, 'unsupported_version']);
    assert.equal(BACKENDS.gemini, GeminiBackend);
  } finally { rm(dir); }
});

test('hub capability mirror lists Gemini as an unsandboxed, own-machine, uncapped provider', async () => {
  const { AI_IDS, AI_CAPABILITIES, AI_BACKENDS } = await import('../../shared/ai.js');
  assert.ok(AI_IDS.includes('gemini'));
  const c = GeminiBackend.describe().capabilities;
  assert.deepEqual(AI_CAPABILITIES.gemini, { budget: c.budget, maxTurns: c.maxTurns, ownMachineOnly: c.permissions === 'none' });
  assert.deepEqual([c.budget, c.permissions, AI_CAPABILITIES.gemini.ownMachineOnly, AI_BACKENDS.gemini], ['none', 'none', true, 'gemini_cli']);
});
