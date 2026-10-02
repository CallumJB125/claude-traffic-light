#!/usr/bin/env node
// Exercises the generated trusted MCP profile and real local Git. The model
// is a deterministic fixture; sandbox boundaries have separate native probes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const scenario = JSON.parse(fs.readFileSync(process.env.PLEXIFORM_FAKE_CODEX_SCENARIO, 'utf8'));
const log = (x) => fs.appendFileSync(process.env.PLEXIFORM_FAKE_CODEX_LOG, `${JSON.stringify(x)}\n`);
const emit = (x) => process.stdout.write(`${JSON.stringify(x)}\n`);
const argv = process.argv.slice(2), config = {};
for (let n = 0; n < argv.length; n++) if (argv[n] === '-c') { const s = argv[++n], p = s.indexOf('='); config[s.slice(0, p)] = s.slice(p + 1); }
log({ kind: 'start', argv, cwd: process.cwd(), env: process.env });
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk; log({ kind: 'prompt', prompt });
emit({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000159' }); emit({ type: 'turn.started' });
const t = new StdioClientTransport({ command: JSON.parse(config['mcp_servers.board.command']), args: JSON.parse(config['mcp_servers.board.args']), env: {}, stderr: 'pipe' });
t.stderr.on('data', () => {});
const c = new Client({ name: 'fake-board-codex', version: '0' });
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }); log({ kind: 'tool', name, isError: !!r.isError });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};
const command = (id, bin, args) => {
  const text = [bin, ...args].join(' '); emit({ type: 'item.started', item: { id, type: 'command_execution', command: text } });
  let output = '', code = 0;
  try { output = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { output = String(e.stdout ?? '') + String(e.stderr ?? ''); code = e.status ?? 1; }
  emit({ type: 'item.completed', item: { id, type: 'command_execution', command: text, exit_code: code, aggregated_output: output } });
  if (code) throw new Error('fixture command failed'); return output.trim();
};
try {
  await c.connect(t);
  const tools = (await c.listTools()).tools.map((x) => x.name); log({ kind: 'tools', names: tools });
  await call('board_get_card');
  await call('board_declare_plan', { paths: ['result.txt'], summary: 'Write the fixture result and verify it' });
  const readOnly = config['permissions.plexiform.filesystem'].includes('":workspace_roots"="read"');
  log({ kind: 'profile', readOnly });
  await call('board_write_handover', { patch: { done: scenario.text ?? 'Fixture turn observed', next: 'Continue the card' } });
  if (scenario.wait) { emit({ type: 'item.started', item: { id: 'wait', type: 'command_execution', command: 'sleep 300' } }); await new Promise((r) => setTimeout(r, 300000)); }
  if (scenario.complete && !readOnly) {
    fs.writeFileSync(path.join(process.cwd(), 'result.txt'), 'observed fixture result\n');
    emit({ type: 'item.completed', item: { id: 'file_1', type: 'file_change', status: 'completed', changes: [{ path: path.join(process.cwd(), 'result.txt'), kind: 'add' }] } });
    command('test_1', process.execPath, ['--test', 'test.js']);
    command('commit_1', 'git', ['add', 'result.txt']); command('commit_2', 'git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture result']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const ev = await call('board_attach_evidence', { kind: 'commit', ref: sha, summary: 'Observed HEAD' });
    const tests = await call('board_attach_evidence', { kind: 'test_run', ref: 'node --test test.js', summary: 'Fixture test observed', result: 'pass' });
    await call('board_complete', { summary: 'Verified fixture complete', evidence_ids: [ev.evidence_id, tests.evidence_id] });
  }
  if (scenario.error) throw new Error(scenario.error);
  emit({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: scenario.text ?? 'Fixture turn done; card remains incomplete' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
} catch (e) { emit({ type: 'turn.failed', error: { message: String(e.message).slice(0, 300) } }); }
finally { await c.close(); }
