'use strict';
// Owned Codex adapter for the session interaction contract. Plexiform spawns
// its own `codex app-server` (stdio JSON-RPC) and only talks to threads it
// started there. Codex keeps its own login in CODEX_HOME; nothing here reads
// or stores it. Existing desktop-app threads live on that app's private
// app-server and are never reachable from this adapter.
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Owned threads are text-only: no shell/exec, image viewing, skills,
// plugins, MCP servers, hooks, browser/computer use, web search, memories,
// sub-agents, project docs or daemon auto-start. Without shell tools the
// read-only sandbox is not the only thing keeping files off the wire.
const DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'view_image', 'skill_search',
  'apps', 'plugins', 'remote_plugin', 'hooks', 'computer_use', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'in_app_browser', 'in_app_local_automation', 'chronicle', 'memories', 'multi_agent',
  'image_generation', 'realtime_conversation', 'tool_suggest', 'skill_mcp_dependency_install', 'code_mode_host',
  'workspace_dependencies', 'worktrees', 'goals', 'sleep_tool', 'daemon_auto_start'];
// Explicit overrides win over the user's ~/.codex/config.toml: the built-in
// OpenAI provider, no MCP servers/plugins/project trust entries, no notify,
// no inherited environment for any command.
const CONFIG_OVERRIDES = ['model_provider="openai"', 'mcp_servers={}', 'plugins={}', 'projects={}', 'hooks={}', 'notify=[]',
  'web_search="disabled"', 'project_doc_max_bytes=0', 'include_apply_patch_tool=false', 'shell_environment_policy.inherit="none"'];
const APP_SERVER_ARGS = Object.freeze(['app-server', '--listen', 'stdio://',
  ...CONFIG_OVERRIDES.flatMap((c) => ['-c', c]), ...DISABLED_FEATURES.flatMap((f) => ['--disable', f])]);
const ENV_KEYS = ['HOME', 'PATH', 'LANG', 'TMPDIR', 'TZ', 'CODEX_HOME'];
const MAX_LINE = 4 * 1024 * 1024;
const REQUEST_MS = 30_000;
const KILL_MS = 2000;

function findCodexBin({ env = process.env, exists = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } } } = {}) {
  const candidates = [
    env.HOME && path.join(env.HOME, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', '/Applications/Codex.app/Contents/Resources/codex',
  ].filter(Boolean);
  return candidates.find(exists) ?? null;
}

const inputText = (content) => (Array.isArray(content) ? content : []).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');

function createCodexAppServer({ bin, env = process.env, spawn = childProcess.spawn, clientVersion = '0' } = {}) {
  const events = new EventEmitter();
  const pending = new Map();
  let child = null, ready = null, nextId = 1, exited = false, skipping = false;

  function fail(error) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  }
  function write(message) {
    if (!child || exited) throw new Error('Codex app-server is not running');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, REQUEST_MS);
      pending.set(id, { resolve, reject, timer });
      try { write({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function onServerRequest(message) {
    // Approval, elicitation, tool-call and auth-refresh requests are never
    // answered on the human's behalf. Refusal ends that action in Codex.
    try { write({ id: message.id, error: { code: -32601, message: 'Not supported by the Plexiform owned runner' } }); } catch { /* exited */ }
    const target = message.params?.threadId;
    if (typeof target === 'string') events.emit('event', { kind: 'refused-request', target, turnId: message.params?.turnId ?? null, method: String(message.method).slice(0, 80) });
  }
  function onNotification({ method, params: p = {} }) {
    const target = p.threadId;
    if (method === 'turn/started' && typeof target === 'string' && typeof p.turn?.id === 'string') events.emit('event', { kind: 'turn-started', target, turnId: p.turn.id });
    else if (method === 'turn/completed' && typeof target === 'string' && typeof p.turn?.id === 'string') {
      events.emit('event', { kind: 'turn-completed', target, turnId: p.turn.id, status: ['completed', 'interrupted', 'failed'].includes(p.turn.status) ? p.turn.status : 'failed', error: typeof p.turn.error?.message === 'string' ? p.turn.error.message : null });
    } else if (method === 'item/agentMessage/delta' && typeof target === 'string' && typeof p.delta === 'string') events.emit('event', { kind: 'delta', target, turnId: p.turnId, text: p.delta });
    else if (method === 'item/completed' && typeof target === 'string') {
      const item = p.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string') events.emit('event', { kind: 'message', target, turnId: p.turnId, text: item.text });
      else if (item?.type === 'userMessage') events.emit('event', { kind: 'input-recorded', target, turnId: p.turnId, clientId: typeof item.clientId === 'string' ? item.clientId : null, text: inputText(item.content) });
      else if (item?.type === 'contextCompaction') events.emit('event', { kind: 'compacted', target, turnId: p.turnId });
    } else if (method === 'thread/compacted' && typeof target === 'string') events.emit('event', { kind: 'compacted', target, turnId: p.turnId });
    else if (method === 'thread/tokenUsage/updated' && typeof target === 'string' && Number.isSafeInteger(p.tokenUsage?.last?.inputTokens)) {
      events.emit('event', { kind: 'usage', target, turnId: p.turnId, inputTokens: p.tokenUsage.last.inputTokens, window: Number.isSafeInteger(p.tokenUsage.modelContextWindow) ? p.tokenUsage.modelContextWindow : null });
    } else if (method === 'thread/status/changed' && typeof target === 'string' && typeof p.status?.type === 'string') events.emit('event', { kind: 'status', target, status: p.status.type });
    else if (method === 'thread/closed' && typeof target === 'string') events.emit('event', { kind: 'closed', target });
  }
  function onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (Object.hasOwn(message, 'id') && typeof message.method === 'string') return onServerRequest(message);
    if (Object.hasOwn(message, 'id')) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(Object.assign(new Error(String(message.error.message ?? 'Codex request failed').slice(0, 300)), { code: message.error.code }));
      else p.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') onNotification(message);
  }

  function start() {
    // After an exit a fresh process starts; its threads are new targets, so
    // sessions bound to the old process stay ended.
    if (ready && !exited) return ready;
    if (!bin) return Promise.reject(new Error('Codex CLI not found'));
    exited = false;
    const childEnv = Object.fromEntries(ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
    child = spawn(bin, APP_SERVER_ARGS, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }); // privacy-flow: owned-codex-session
    const self = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (child !== self) return;
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (skipping) { skipping = false; continue; }
        if (line.trim()) onLine(line);
      }
      // An oversized update is dropped (not the process): every session on
      // this server is told an update was lost.
      if (buffer.length > MAX_LINE) { buffer = ''; skipping = true; events.emit('event', { kind: 'oversize' }); }
    });
    // stderr can carry account or network detail; it is never kept.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    const ended = () => { if (child !== self || exited) return; exited = true; fail(new Error('Codex app-server exited')); events.emit('event', { kind: 'exit' }); };
    child.on('error', ended);
    child.on('exit', ended);
    const attempt = request('initialize', { clientInfo: { name: 'plexiform', title: 'Plexiform', version: String(clientVersion) } })
      .then(() => { write({ method: 'initialized' }); })
      .catch((error) => {
        if (ready === attempt) ready = null;
        if (child === self) { child = null; exited = true; kill(self); }
        throw error;
      });
    ready = attempt;
    return ready;
  }

  async function open({ cwd }) {
    await start();
    const result = await request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
    if (typeof result?.thread?.id !== 'string') throw new Error('Codex did not return a thread');
    return { target: result.thread.id };
  }
  // expectedTurnId selects steer: Codex itself refuses when it is not the
  // thread's active turn. Otherwise a new turn starts on exactly `target`.
  async function send({ target, text, clientId, expectedTurnId = null }) {
    await start();
    const input = [{ type: 'text', text, text_elements: [] }];
    if (expectedTurnId) {
      const result = await request('turn/steer', { threadId: target, expectedTurnId, input, clientUserMessageId: clientId });
      if (typeof result?.turnId !== 'string') throw new Error('Codex did not acknowledge the steer');
      return { turnId: result.turnId, mode: 'steer' };
    }
    const result = await request('turn/start', { threadId: target, input, clientUserMessageId: clientId, effort: 'low' });
    if (typeof result?.turn?.id !== 'string') throw new Error('Codex did not acknowledge the turn');
    return { turnId: result.turn.id, mode: 'new-turn' };
  }
  async function interrupt({ target, turnId }) { await start(); await request('turn/interrupt', { threadId: target, turnId }); return true; }
  // Codex's supported compaction: it runs as a turn on `target` and reports a
  // contextCompaction item. Codex decides what it keeps; `keep` is not sent.
  async function compact({ target }) { await start(); await request('thread/compact/start', { threadId: target }); return true; }
  // Unload a closed session's thread from this server.
  async function release({ target }) { if (!child || exited) return false; await request('thread/unsubscribe', { threadId: target }); return true; }
  function kill(proc) {
    try { proc.kill('SIGTERM'); } catch { return; }
    const timer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill('SIGKILL'); } catch { /* gone */ } } }, KILL_MS);
    timer.unref?.();
  }
  function stop() { if (child && !exited) kill(child); }

  return {
    provider: 'codex', label: 'Codex',
    capabilities: Object.freeze({ newTurn: true, steer: true, interrupt: true, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: false, compact: true, compactKeep: false }),
    open, send, interrupt, compact, release, stop,
    on: (fn) => { events.on('event', fn); return () => events.off('event', fn); },
    alive: () => !!child && !exited,
  };
}

module.exports = { createCodexAppServer, findCodexBin, APP_SERVER_ARGS, DISABLED_FEATURES, CONFIG_OVERRIDES };
