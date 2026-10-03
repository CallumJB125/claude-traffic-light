// Hermes adapter against a replaying stream-json fixture (shaped after
// hermes_cli/stream_json.py, Hermes v0.21.3). No real Hermes, model or
// network is ever used: a real Hermes + DGX turn remains unproven here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HermesBackend, HermesDgxBackend, HERMES_TOOLSETS } from '../backends/hermes.js';
import { BACKENDS } from '../backends/index.js';
import { CODEX_BOARD_TOOLS } from '../../mcp/codex-run.js';
import { AI_IDS, AI_CAPABILITIES } from '../../shared/ai.js';
import { tmpDir, rm, waitFor } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-hermes.js', import.meta.url));
const stream = fileURLToPath(new URL('./fixtures/hermes-stream.jsonl', import.meta.url));
const SESSION = '20261003_101500_a1b2c3';

function setup(dir, { Backend = HermesBackend, streamFile = stream, env: extraEnv = {}, ...extra } = {}) {
  const runDir = path.join(dir, 'run'); fs.mkdirSync(runDir, { mode: 0o700 });
  const log = path.join(dir, 'fake.log'); const bin = path.join(dir, 'hermes');
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
  const env = { HOME: dir, PATH: process.env.PATH, TMPDIR: dir, PLEXIFORM_FAKE_HERMES_LOG: log, PLEXIFORM_FAKE_HERMES_STREAM: streamFile, ...extraEnv };
  const backend = new Backend({ bin, cwd: dir, env, runDir, boardRunDir: runDir, sessionId: null, systemPrompt: 'trusted scope', permissionMode: 'acceptEdits', stopGraceMs: 300, ...extra });
  return { backend, runDir, read: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}
const collect = (b) => { const events = []; for (const n of ['init', 'tool_start', 'tool_end', 'assistant', 'usage', 'result', 'exit']) b.on(n, (data) => events.push({ n, data })); return events; };

test('Hermes turn: prompt only on stdin, isolated HERMES_HOME with the per-run board server, stream-json events normalized', async () => {
  const dir = tmpDir('px-hermes-');
  try {
    fs.mkdirSync(path.join(dir, '.hermes')); fs.writeFileSync(path.join(dir, '.hermes', '.env'), 'X=1\n');
    fs.writeFileSync(path.join(dir, '.hermes', 'config.yaml'), 'model: {default: user-model}\n');
    const f = setup(dir, { maxTurns: 40 }); const events = collect(f.backend);
    const prompt = 'task $(touch /tmp/forged) --yolo';
    await f.backend.start(prompt);
    await waitFor(() => f.backend.exited, { what: 'Hermes completion' });
    const start = f.read().find((x) => x.kind === 'start');
    assert.ok(!start.argv.some((a) => a.includes(prompt)), 'prompt never in argv');
    assert.equal(f.read().find((x) => x.kind === 'prompt').prompt, prompt);
    assert.deepEqual(start.argv.slice(0, 7), ['chat', '--query-file', '-', '--format', 'stream-json', '--oneshot', '--in']);
    for (const a of ['--ignore-rules', '--no-restore-cwd']) assert.ok(start.argv.includes(a), a);
    for (const a of ['--safe-mode', '--yolo', '--ignore-user-config', '--resume']) assert.ok(!start.argv.includes(a), a);
    assert.equal(start.argv[start.argv.indexOf('-t') + 1], HERMES_TOOLSETS.join(','));
    assert.equal(start.argv[start.argv.indexOf('--max-turns') + 1], '40');
    assert.equal(start.argv[start.argv.indexOf('--source') + 1], 'tool');
    assert.equal(start.home, path.join(f.runDir, 'hermes-home'), 'never the user Hermes home');
    assert.equal(start.dotenv, true, 'credentials .env linked, not copied');
    assert.equal(start.config.model, undefined, 'user config/model never copied');
    assert.deepEqual(start.config.mcp_servers.board.args.at(-1), f.runDir);
    assert.deepEqual(start.config.mcp_servers.board.tools.include, [...CODEX_BOARD_TOOLS]);
    assert.equal(start.config.approvals.single_query_mode, 'deny');
    assert.equal(start.config.agent.system_prompt, 'trusted scope');
    assert.deepEqual(Object.keys(start.config).sort(), ['agent', 'approvals', 'mcp_servers']);

    assert.deepEqual(events.filter((e) => e.n === 'init').map((e) => e.data.session_id), [SESSION]);
    assert.equal(f.backend.sessionId, SESSION);
    assert.deepEqual(events.filter((e) => e.n === 'assistant').map((e) => e.data.text), ['Looking at the repo.', 'Done.']);
    const starts = events.filter((e) => e.n === 'tool_start').map((e) => e.data);
    assert.deepEqual(starts.map((s) => [s.name, s.input]), [['Bash', { command: 'git status --short' }], ['Write', { file_path: 'notes.txt' }], ['board_update_status', { text: 'working' }]]);
    const ends = events.filter((e) => e.n === 'tool_end').map((e) => e.data);
    assert.deepEqual(ends.map((e) => [e.id, e.ok]), [['call_1', true], ['call_2', true], [starts[2].id, false]], 'result without tool_call_id pairs by name');
    assert.equal(ends[0].output, ' M README.md');
    assert.deepEqual(events.find((e) => e.n === 'usage').data, { inputTokens: 1200, outputTokens: 80, costUsd: null });
    const r = events.find((e) => e.n === 'result').data;
    assert.deepEqual([r.subtype, r.is_error, r.result, r.total_cost_usd], ['success', false, 'Looking at the repo.Done.', null]);
    assert.deepEqual(events.at(-1), { n: 'exit', data: { code: 0, signal: null, error: null, sawResult: true } });
    assert.equal(f.backend.send('next'), false);
    f.backend.resume = true; f.backend.maxTurns = null;
    assert.deepEqual(f.backend.argv().slice(-2), ['--resume', SESSION]);
  } finally { rm(dir); }
});

test('Hermes refuses budgets, approval/plan modes and unknown resume ids before spawn; failed turns normalize', async () => {
  const dir = tmpDir('px-hermes-');
  try {
    const failed = path.join(dir, 'failed.jsonl');
    fs.writeFileSync(failed, [{ type: 'system', subtype: 'init', model: 'm', session_id: '' }, { type: 'result', session_id: SESSION, exit_code: 1, text: '', tokens: { input: 0, output: 0 }, error: 'credentials or agent init failed' }].map((x) => JSON.stringify(x)).join('\n'));
    const f = setup(dir, { streamFile: failed });
    const refuse = (patch) => { Object.assign(f.backend, patch); assert.throws(() => f.backend.start('go'), (e) => e.code === 'NOT_AVAILABLE' && !/\//.test(e.message)); assert.equal(f.backend.pid, null); };
    refuse({ budgetUsd: 5 }); refuse({ budgetUsd: null, permissionMode: 'plan' }); refuse({ permissionMode: 'default' });
    refuse({ permissionMode: 'acceptEdits', resume: true, sessionId: '../../etc' });
    Object.assign(f.backend, { resume: false, sessionId: null });
    const events = collect(f.backend);
    await f.backend.start('go');
    await waitFor(() => f.backend.exited, { what: 'failed turn' });
    const r = events.find((e) => e.n === 'result').data;
    assert.deepEqual([r.subtype, r.is_error], ['error', true]); assert.match(r.result, /agent init failed/);
    assert.deepEqual(events.filter((e) => e.n === 'init').map((e) => e.data.session_id), [SESSION], 'a session id only on the result still reaches the run');
  } finally { rm(dir); }
});

test('Hermes stop terminates its process group and returns a verified receipt', async () => {
  const dir = tmpDir('px-hermes-'); let b;
  try {
    const f = setup(dir, { env: { PLEXIFORM_FAKE_HERMES_HANG: '1' } }); b = f.backend;
    await b.start('go'); await waitFor(() => b.sawResult, { what: 'result before hang' });
    assert.equal(await b.stop(), true); assert.equal(b.exited, true);
  } finally { await b?.stop(); rm(dir); }
});

test('hermes-dgx: tailnet endpoint from local-models.json, custom provider, no credentials; public or DNS endpoints refused', async () => {
  const dir = tmpDir('px-hermes-');
  try {
    fs.mkdirSync(path.join(dir, '.hermes')); fs.writeFileSync(path.join(dir, '.hermes', '.env'), 'SECRET=1\n');
    const models = path.join(dir, 'local-models.json');
    const write = (url) => fs.writeFileSync(models, JSON.stringify({ endpoints: [{ id: 'dgx', label: 'DGX', url, kind: 'openai' }] }));
    write('http://100.68.66.98:8888/v1');
    const f = setup(dir, { Backend: HermesDgxBackend, env: { PLEXIFORM_LOCAL_MODELS_FILE: models }, model: 'GLM-5.3-Flash-EXL3' });
    await f.backend.start('go');
    await waitFor(() => f.backend.exited, { what: 'DGX turn' });
    const start = f.read().find((x) => x.kind === 'start');
    assert.deepEqual(start.config.model, { provider: 'custom', base_url: 'http://100.68.66.98:8888/v1', default: 'GLM-5.3-Flash-EXL3' });
    assert.equal(start.dotenv, null, 'no member credentials reach the local-model run');

    const probed = []; const g = setup(tmpDir('px-hermes-'), { Backend: HermesDgxBackend, env: { PLEXIFORM_LOCAL_MODELS_FILE: models },
      probeEndpoint: async (e) => { probed.push(e); return { reachable: true, models: ['first-model', 'second'], error: null }; } });
    try {
      assert.deepEqual(await g.backend.resolveModel(), { model: 'first-model', endpoint: { id: 'dgx', url: 'http://100.68.66.98:8888/v1', kind: 'openai' } });
      assert.equal(probed[0].allowPublic, false); assert.equal(probed[0].apiKeyEnv, null);
      for (const url of ['http://8.8.8.8:8888/v1', 'http://dgx.example.ts.net:8888/v1', 'http://169.254.169.254/v1', 'file:///etc/passwd']) {
        write(url);
        await assert.rejects(g.backend.start('go'), (e) => e.code === 'NOT_AVAILABLE', url);
        assert.equal(g.backend.pid, null); assert.equal(g.backend.exited, true);
      }
      write('http://192.168.0.20:8000');
      assert.equal((await g.backend.resolveModel()).endpoint.url, 'http://192.168.0.20:8000/v1');
    } finally { rm(path.dirname(g.runDir)); }

    const bin = path.dirname(f.backend.bin);
    const ready = await HermesDgxBackend.detect({ env: { HOME: dir, PATH: bin, PLEXIFORM_LOCAL_MODELS_FILE: models }, knownDirs: [], timeoutMs: 15000 });
    assert.deepEqual([ready.id, ready.installed, ready.signedIn, ready.startable], ['hermes-dgx', true, true, undefined]);
    fs.rmSync(models);
    const none = await HermesDgxBackend.detect({ env: { HOME: dir, PATH: bin, PLEXIFORM_LOCAL_MODELS_FILE: models }, knownDirs: [], timeoutMs: 15000 });
    assert.deepEqual([none.startable, none.reason], [false, 'no_local_model']);
    assert.equal((await HermesBackend.detect({ env: { HOME: dir, PATH: bin }, knownDirs: [], timeoutMs: 15000 })).signedIn, true, 'Hermes .env present');
  } finally { rm(dir); }
});

test('hub capability mirror matches every runner backend descriptor', () => {
  assert.deepEqual([...AI_IDS].sort(), Object.keys(BACKENDS).sort());
  for (const [id, B] of Object.entries(BACKENDS)) {
    const c = B.describe().capabilities;
    assert.equal(AI_CAPABILITIES[id].budget, c.budget, id);
    assert.equal(AI_CAPABILITIES[id].maxTurns, c.maxTurns, id);
    assert.equal(AI_CAPABILITIES[id].ownMachineOnly, c.permissions === 'none', id);
  }
});
