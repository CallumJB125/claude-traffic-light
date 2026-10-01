#!/usr/bin/env node
// Fake `claude` for runner tests (CONTRACT §13). Usage (via a wrapper script):
//   node fake-claude.js <scenario.json> <claude argv…>
// Speaks stream-json like the real CLI (spike 1): SessionStart hook at start,
// system/init after the first stdin user message, scripted steps (tool_use →
// PreToolUse hook → work → PostToolUse hook → tool_result), result, then idle
// until the next stdin line. Honours control_request interrupt, EOF, SIGTERM
// (unless scenario.ignore_term), and can spawn a detached grandchild in its
// own process group like the Bash tool does (for tree-kill tests).
// Logs everything it saw to <run_dir>/fake.log (run_dir = dirname(--settings)).
// scenario.mcp_stdio: board tools go through the real board MCP server (stdio).
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const [scenarioPath, ...args] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const settingsPath = opt('--settings');
const runDir = settingsPath ? path.dirname(settingsPath) : process.cwd();
const settings = settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
const mcp = opt('--mcp-config') ? JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8')) : {};
const resume = opt('--resume');
const sessionId = resume ?? opt('--session-id') ?? crypto.randomUUID();
const logFile = path.join(runDir, 'fake.log');
const log = (o) => fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...o })}\n`);
const out = (o) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...o })}\n`);

log({ ev: 'start', pid: process.pid, argv: args, env: process.env, cwd: process.cwd(), resume: !!resume });

const grandchildren = [];
let aborted = false;
let abortWake = null;
let idle = false;
let inputQueue = [];
let inputWaiter = null;
let cost = 0;

function runHook(event, payload, matcherTool) {
  const entry = (settings.hooks?.[event] ?? []).find((h) => !h.matcher || h.matcher === '*' || h.matcher === matcherTool);
  const cmd = entry?.hooks?.[0]?.command;
  if (!cmd) return Promise.resolve({ code: 0, out: null });
  return new Promise((resolve) => {
    // Like CLI 2.1.285 with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1: credential-named vars never reach hooks.
    const env = { ...process.env };
    if (env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1') for (const k of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY/.test(k)) delete env[k];
    const child = spawn('/bin/sh', ['-c', cmd], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let so = '';
    let se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = so.trim() ? JSON.parse(so) : null; } catch { parsed = { raw: so }; }
      log({ ev: 'hook', event, code, out: parsed, stderr: se.slice(0, 300) });
      resolve({ code, out: parsed });
    });
    child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: '/dev/null', cwd: process.cwd(), hook_event_name: event, ...payload }));
  });
}

// scenario.mcp_stdio: like the real CLI, spawn the board MCP server from
// mcp.json and call its tools over MCP (JSON-RPC, NDJSON on stdio).
let mcpProc = null;
let mcpNext = 1;
const mcpPending = new Map();
function mcpSend(obj) { mcpProc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`); }
function mcpRequest(method, params) {
  const id = mcpNext++;
  return new Promise((resolve, reject) => { mcpPending.set(id, { resolve, reject }); mcpSend({ id, method, params }); });
}
async function startMcp() {
  const srv = mcp.mcpServers?.board;
  mcpProc = spawn(srv.command, srv.args ?? [], { env: { ...process.env, ...(srv.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let mbuf = '';
  mcpProc.stdout.setEncoding('utf8');
  mcpProc.stdout.on('data', (d) => {
    mbuf += d;
    let i;
    while ((i = mbuf.indexOf('\n')) >= 0) {
      const line = mbuf.slice(0, i);
      mbuf = mbuf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const p = mcpPending.get(m.id);
      if (!p) continue;
      mcpPending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  mcpProc.stderr.on('data', (d) => log({ ev: 'mcp_stderr', text: String(d).slice(0, 300) }));
  const init = await mcpRequest('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
  mcpSend({ method: 'notifications/initialized' });
  const list = await mcpRequest('tools/list', {});
  log({ ev: 'mcp_ready', server: init.serverInfo?.name, tools: list.tools.map((t) => t.name) });
  return list.tools.map((t) => `mcp__board__${t.name}`);
}
async function mcpTool(name, args) {
  const r = await mcpRequest('tools/call', { name, arguments: args ?? {} });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) {
    const m = /^([A-Z_]+): ([\s\S]*)$/.exec(text);
    return { ok: false, error: { code: m?.[1] ?? 'INTERNAL', message: m?.[2] ?? text } };
  }
  try { return { ok: true, result: JSON.parse(text) }; } catch { return { ok: true, result: text }; }
}

function ipc(msg) {
  if (mcpProc && msg.type === 'tool') return mcpTool(msg.name, msg.args);
  const env = mcp.mcpServers?.board?.env ?? {};
  return new Promise((resolve, reject) => {
    const s = net.createConnection(env.BOARD_RUN_SOCKET);
    let buf = '';
    s.setEncoding('utf8');
    s.on('connect', () => s.write(`${JSON.stringify({ id: crypto.randomUUID(), token: env.BOARD_RUN_TOKEN, ...msg })}\n`));
    s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { s.end(); resolve(JSON.parse(buf.slice(0, i))); } });
    s.on('error', reject);
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { abortWake = null; resolve(true); }, ms);
    abortWake = () => { clearTimeout(t); abortWake = null; resolve(false); };
  });
}

function nextInput() {
  if (inputQueue.length) return Promise.resolve(inputQueue.shift());
  return new Promise((resolve) => { inputWaiter = resolve; });
}

function onStdinLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  log({ ev: 'stdin', msg: m });
  if (m.type === 'control_request' && m.request?.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    if (!idle && !scenario.ignore_interrupt) { aborted = true; abortWake?.(); }
    return;
  }
  if (m.type === 'user') {
    if (inputWaiter) { const w = inputWaiter; inputWaiter = null; w(m); } else inputQueue.push(m);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onStdinLine(l); }
});
process.stdin.on('end', () => { log({ ev: 'eof' }); if (!scenario.ignore_eof) process.exit(0); });

function killGrandchildren() {
  for (const g of grandchildren) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } }
}

process.on('SIGTERM', () => {
  log({ ev: 'signal', sig: 'SIGTERM' });
  if (scenario.ignore_term) return;
  killGrandchildren();
  mcpProc?.kill();
  process.exit(143);
});
process.on('SIGINT', () => {
  log({ ev: 'signal', sig: 'SIGINT' });
  aborted = true;
  abortWake?.();
});

const textOf = (m) => (Array.isArray(m.message?.content) ? m.message.content.map((c) => c.text ?? '').join('') : String(m.message?.content ?? ''));

async function tool(step) {
  const id = `toolu_${crypto.randomUUID().slice(0, 8)}`;
  const name = step.tool;
  const input = { ...(step.input ?? {}) };
  for (const k of ['file_path', 'notebook_path']) if (input[k] && !path.isAbsolute(input[k]) && !input[k].startsWith('~')) input[k] = path.join(process.cwd(), input[k]);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  if (step.approval) {
    const r = await ipc({ type: 'tool', name: 'approval', args: { tool_name: name, input, tool_use_id: id } });
    log({ ev: 'approval', result: r });
    if (!r.ok || r.result?.behavior !== 'allow') {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'permission denied', is_error: true }] } });
      return;
    }
  }
  const pre = await runHook('PreToolUse', { tool_name: name, tool_input: input, tool_use_id: id }, name);
  const denied = pre.code === 2 || pre.out?.hookSpecificOutput?.permissionDecision === 'deny';
  if (denied) {
    log({ ev: 'denied', tool: name, reason: pre.out?.hookSpecificOutput?.permissionDecisionReason });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `denied: ${pre.out?.hookSpecificOutput?.permissionDecisionReason ?? 'hook'}`, is_error: true }] } });
    return;
  }
  if (step.grandchild) {
    const g = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
    g.unref();
    grandchildren.push(g.pid);
    log({ ev: 'grandchild', pid: g.pid });
  }
  if (name === 'Write' && input.file_path && input.content != null) { fs.mkdirSync(path.dirname(input.file_path), { recursive: true }); fs.writeFileSync(input.file_path, input.content); }
  if (step.ms) await wait(step.ms);
  if (aborted) return;
  const ok = !step.fail;
  const response = step.response ?? (name === 'Bash' ? { stdout: step.output ?? 'ok', stderr: '', interrupted: false } : { ok: true });
  await runHook(ok ? 'PostToolUse' : 'PostToolUseFailure', { tool_name: name, tool_input: input, tool_use_id: id, tool_response: response, ...(ok ? {} : { error: step.error ?? 'Exit code 1\nboom' }) }, name);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: step.output ?? 'ok', is_error: !ok }] } });
}

async function runSteps(steps) {
  for (const step of steps) {
    if (aborted) break;
    if (step.tool) await tool(step);
    else if (step.assistant) out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: step.assistant }] } });
    else if (step.mcp) {
      const id = `toolu_${crypto.randomUUID().slice(0, 8)}`;
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__board__${step.mcp}`, input: step.args ?? {} }] } });
      const r = await ipc({ type: 'tool', name: step.mcp, args: step.args ?? {} });
      log({ ev: 'mcp', name: step.mcp, result: r });
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(r), is_error: !r.ok }] } });
    } else if (step.rate_limit) out({ type: 'rate_limit_event', rate_limit_info: step.rate_limit });
    else if (step.sleep) await wait(step.sleep);
    else if (step.stop_hook) await runHook('Stop', { stop_hook_active: false, last_assistant_message: step.stop_hook === true ? 'done' : step.stop_hook });
    else if (step.exit != null) { log({ ev: 'exit', code: step.exit }); process.exit(step.exit); }
    else if (step.result) {
      cost += step.cost ?? 0.001;
      out({ type: 'result', subtype: step.result, is_error: step.result !== 'success', total_cost_usd: cost, num_turns: 1, result: step.text ?? '', terminal_reason: step.terminal_reason ?? null, permission_denials: [], usage: { input_tokens: 10, output_tokens: 5 } });
      return 'result';
    }
  }
  return aborted ? 'aborted' : 'end';
}

async function main() {
  await runHook('SessionStart', { source: resume ? 'resume' : 'startup' });
  const mcpTools = scenario.mcp_stdio ? await startMcp() : ['mcp__board__approval'];
  if (scenario.no_init) { await new Promise(() => {}); }
  const first = await nextInput();
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: (opt('--tools') ?? '').split(',').concat(mcpTools), mcp_servers: [{ name: 'board', status: 'connected' }], model: 'fake', permissionMode: opt('--permission-mode') });
  await runHook('UserPromptSubmit', { prompt: textOf(first) });
  const outcome = await runSteps(resume ? (scenario.resume_steps ?? [{ result: 'success' }]) : (scenario.steps ?? []));
  if (outcome === 'aborted') {
    aborted = false;
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: cost, num_turns: 1, terminal_reason: 'aborted_tools', permission_denials: [] });
  } else if (outcome === 'end' && scenario.auto_result !== false) {
    out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, num_turns: 1, result: 'done', permission_denials: [] });
  }
  for (;;) {
    idle = true;
    const m = await nextInput();
    idle = false;
    const text = textOf(m);
    log({ ev: 'turn', text });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `ack: ${text.slice(0, 80)}` }] } });
    const steps = (scenario.on_input ?? {})[Object.keys(scenario.on_input ?? {}).find((k) => text.includes(k))] ?? [];
    const o = await runSteps(steps);
    if (o === 'aborted') {
      aborted = false;
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: cost, num_turns: 1, terminal_reason: 'aborted_tools', permission_denials: [] });
    } else if (o !== 'result') {
      out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, num_turns: 1, result: 'ok', permission_denials: [] });
    }
  }
}

main();
