'use strict';
// Owned Gemini CLI adapter over ACP (Agent Client Protocol, JSON-RPC 2.0 on
// stdio: `gemini --acp`). Plexiform spawns its own agent process and only
// talks to sessions it created there with session/new. Gemini keeps its own
// login under its own home; nothing here reads or stores it. Gemini CLI is not
// installed on the build machine, so this adapter is proven only against the
// FAKE ACP fixture in test/fixtures/fake-gemini-acp.js.
//
// ACP v1 has no turn id and no client message id: session/prompt answers only
// at the end of the turn. The ack used here is the provider's own first
// session/update for exactly this session after our prompt (one prompt per
// session may be in flight), or the prompt response itself. Steer is not in
// ACP; session/cancel is the interrupt.
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];
const ACP_ARGS = Object.freeze(['--acp']);
const MAX_LINE = 4 * 1024 * 1024;
const REQUEST_MS = 30_000;
const NOT_INSTALLED = 'unavailable: gemini not installed';
const NOT_VERIFIED = 'unavailable: Gemini CLI is installed but Plexiform cannot yet isolate it from your own Gemini settings (MCP servers, extensions, hooks, approval mode); this stays off until that is verified on a real install';
const CONTENT_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);
const EXISTING_SESSIONS_REASON = 'Gemini CLI sessions started outside Plexiform expose no inbound channel; ACP sessions exist only on the agent process that created them.';
const STOP = { end_turn: 'completed', max_tokens: 'completed', max_turn_requests: 'completed', refusal: 'failed', cancelled: 'interrupted' };

function findGeminiBin({ env = process.env, exists = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } } } = {}) {
  const candidates = [env.HOME && path.join(env.HOME, '.local/bin/gemini'), '/opt/homebrew/bin/gemini', '/usr/local/bin/gemini'].filter(Boolean);
  return candidates.find(exists) ?? null;
}

function createGeminiAcp({ bin, args = ACP_ARGS, env = process.env, spawn = childProcess.spawn, requestMs = REQUEST_MS, verified = false } = {}) {
  const events = new EventEmitter();
  const pending = new Map();
  const sessions = new Map(); // target (ACP sessionId) -> {active, ack}
  let child = null, ready = null, nextId = 1, exited = false, skipping = false, turnSeq = 0;
  const emit = (e) => events.emit('event', e);

  function fail(error) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); }
  function write(message) {
    if (!child || exited) throw new Error('Gemini ACP agent is not running');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }
  function request(method, params, ms = requestMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = ms ? setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, ms) : null;
      pending.set(id, { resolve, reject, timer });
      try { write({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  // turn-started goes out synchronously with the ack, before any completion.
  function acked(s, target) { if (s.ack) { const a = s.ack; s.ack = null; emit({ kind: 'turn-started', target, turnId: s.active }); a(); } }

  // Permission, file and terminal requests are never granted on the human's
  // behalf: permission picks a reject option (or cancelled), the rest error.
  function onAgentRequest(m) {
    const target = m.params?.sessionId;
    const s = typeof target === 'string' ? sessions.get(target) : null;
    if (m.method === 'session/request_permission') {
      const reject = (Array.isArray(m.params?.options) ? m.params.options : []).find((o) => o?.kind === 'reject_once' || o?.kind === 'reject_always');
      try { write({ id: m.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } } }); } catch { /* exited */ }
    } else {
      try { write({ id: m.id, error: { code: -32601, message: 'Not supported by the Plexiform owned runner' } }); } catch { /* exited */ }
    }
    if (s) emit({ kind: 'refused-request', target, turnId: s.active, method: String(m.method).slice(0, 80) });
  }
  function onUpdate(p) {
    const target = p?.sessionId;
    const s = typeof target === 'string' ? sessions.get(target) : null;
    if (!s || !s.active) return;
    const u = p.update;
    // Only real content counts as an acknowledgement; housekeeping updates (e.g. available_commands_update) never do.
    if (CONTENT_UPDATES.has(u?.sessionUpdate)) acked(s, target);
    if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && typeof u.content.text === 'string') emit({ kind: 'delta', target, turnId: s.active, text: u.content.text });
  }
  function onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (Object.hasOwn(m, 'id') && typeof m.method === 'string') return onAgentRequest(m);
    if (Object.hasOwn(m, 'id')) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String(m.error.message ?? 'Gemini request failed').slice(0, 300)));
      else p.resolve(m.result);
      return;
    }
    if (m.method === 'session/update') onUpdate(m.params);
  }

  function start() {
    if (ready && !exited) return ready;
    if (!bin) return Promise.reject(new Error('Gemini CLI not found'));
    exited = false;
    const childEnv = Object.fromEntries(ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
    child = spawn(bin, [...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); // privacy-flow: owned-gemini-session
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
        if (line.length > MAX_LINE) emit({ kind: 'oversize' });
        else if (line.trim()) onLine(line);
      }
      if (buffer.length > MAX_LINE) { buffer = ''; skipping = true; emit({ kind: 'oversize' }); }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    const ended = () => {
      if (child !== self || exited) return;
      exited = true; fail(new Error('Gemini ACP agent exited'));
      for (const s of sessions.values()) s.ack = null;
      sessions.clear();
      emit({ kind: 'exit' });
    };
    child.on('error', ended);
    child.on('exit', ended);
    ready = request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
      .then((r) => { if (r?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version'); });
    return ready;
  }

  async function open({ cwd }) {
    await start();
    const result = await request('session/new', { cwd, mcpServers: [] });
    if (typeof result?.sessionId !== 'string' || !result.sessionId || sessions.has(result.sessionId)) throw new Error('Gemini did not return a new session');
    sessions.set(result.sessionId, { active: null, ack: null });
    return { target: result.sessionId };
  }
  async function send({ target, text, expectedTurnId = null }) {
    await start();
    const s = sessions.get(target);
    if (!s) throw new Error('Unknown Gemini session');
    if (expectedTurnId) throw new Error('ACP has no steer');
    if (s.active) throw new Error('A Gemini turn is running');
    const turnId = `acp-turn-${++turnSeq}`;
    s.active = turnId;
    const ack = new Promise((resolve) => { s.ack = resolve; });
    // No timeout on the prompt itself: it answers when the turn ends.
    const done = request('session/prompt', { sessionId: target, prompt: [{ type: 'text', text }] }, 0);
    done.then((r) => {
      acked(s, target);
      const status = STOP[r?.stopReason] ?? 'failed';
      if (s.active === turnId) { s.active = null; emit({ kind: 'turn-completed', target, turnId, status, error: status === 'failed' ? `Gemini stopped: ${String(r?.stopReason).slice(0, 40)}` : null }); }
    }, (error) => {
      if (s.active === turnId) { s.active = null; emit({ kind: 'turn-completed', target, turnId, status: 'failed', error: error.message }); }
      if (s.ack) { const a = s.ack; s.ack = null; a(error); }
    });
    let timer;
    const err = await Promise.race([ack, new Promise((r) => { timer = setTimeout(r, requestMs, new Error('Gemini acknowledgement timed out')); })]);
    clearTimeout(timer);
    if (err instanceof Error) {
      // The prompt may still be running: cancel it and keep the session busy until it resolves, so its late output can never be taken as the next message's.
      s.ack = null;
      try { write({ method: 'session/cancel', params: { sessionId: target } }); } catch { /* exited */ }
      throw err;
    }
    return { turnId, mode: 'new-turn' };
  }
  async function interrupt({ target, turnId }) {
    const s = sessions.get(target);
    if (!s || s.active !== turnId) throw new Error('Not the running Gemini turn');
    write({ method: 'session/cancel', params: { sessionId: target } });
    return true;
  }
  function release({ target } = {}) { sessions.delete(target); }
  function stop() {
    if (!child || exited) return;
    const proc = child;
    const kill = (sig) => { try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch { /* gone */ } } };
    kill('SIGTERM');
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) kill('SIGKILL'); }, 2000).unref?.();
  }

  return {
    provider: 'gemini', label: 'Gemini CLI',
    ...(bin && verified ? {} : { available: false, reason: bin ? NOT_VERIFIED : NOT_INSTALLED }),
    capabilities: Object.freeze({ newTurn: true, steer: false, interrupt: true, ack: 'first-session-update', echo: false, stream: true,
      existingSessions: false, existingSessionsReason: EXISTING_SESSIONS_REASON, steerReason: 'ACP v1 has no steer; one prompt per session at a time.' }),
    open, send, interrupt, release, stop,
    on: (fn) => { events.on('event', fn); return () => events.off('event', fn); },
    alive: () => !!child && !exited,
  };
}

module.exports = { createGeminiAcp, NOT_VERIFIED, findGeminiBin, ACP_ARGS, NOT_INSTALLED };
