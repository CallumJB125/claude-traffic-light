'use strict';
// Owned Claude Code adapter for the session interaction contract. Each owned
// session is its own `claude -p --input-format stream-json --output-format
// stream-json` child started by Plexiform with a session id Plexiform picked.
// The CLI uses its own login (it reads its own keychain/config); nothing here
// reads, copies or stores credentials. Interactive Claude Code sessions the
// user started in a terminal have no supported inbound channel and are never
// reachable from this adapter.
//
// Wire facts (claude 2.1.287, verified against a real run, see docs/headless):
//   our user line carries uuid = the hub's clientId
//   {type:'command_lifecycle', command_uuid, state:'queued'|'started'|'completed'|…, session_id}  = provider ack
//   {type:'user', uuid, isReplay:true, message}   (--replay-user-messages)       = literal echo
//   {type:'stream_event', event:{type:'content_block_delta', delta:{type:'text_delta'}}} = stream
//   {type:'result', is_error, result}                                             = turn end
//   {type:'control_request', request:{subtype:'interrupt'}} -> {type:'control_response'}
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR', 'TZ', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];
// Text-only by default (like owned Codex): no tools, so nothing on disk can
// reach the model. File tools exist only inside an explicit safe root.
const NO_TOOLS = '';
const EDIT_TOOLS = 'Read,Glob,Grep,Edit,Write';
const MAX_LINE = 4 * 1024 * 1024;
const ACK_MS = 30_000, CONTROL_MS = 5_000, KILL_GRACE_MS = 3_000;
const EXISTING_SESSIONS_REASON = 'Claude Code terminal sessions have no supported inbound message channel; only sessions Plexiform starts with claude -p stream-json can be driven.';

function findClaudeBin({ env = process.env, exists = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } } } = {}) {
  const candidates = [env.HOME && path.join(env.HOME, '.local/bin/claude'), env.HOME && path.join(env.HOME, '.claude/local/claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].filter(Boolean);
  return candidates.find(exists) ?? null;
}

const inside = (root, p) => { const rel = path.relative(root, p); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); };

// Isolation: no user/project/local settings (so no user hooks calling back
// into Plexiform, no plugins, no permission allow rules), no MCP servers, no
// skills or slash commands, no CLAUDE.md (--safe-mode), no persistence, and
// nothing that would prompt is ever approved (dontAsk + prompts none).
function buildClaudeArgs({ sessionId, writable = false, model = 'haiku', systemPrompt = null, maxBudgetUsd = null }) {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages',
    '--session-id', sessionId, '--no-session-persistence',
    '--setting-sources', '', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands',
    '--tools', writable ? EDIT_TOOLS : NO_TOOLS,
    '--permission-mode', writable ? 'acceptEdits' : 'dontAsk', '--permission-prompts', 'none',
    '--model', model,
    ...(systemPrompt ? ['--system-prompt', systemPrompt] : []),
    ...(Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0 ? ['--max-budget-usd', String(maxBudgetUsd)] : [])];
}

function createClaudeCodeSession({ bin, env = process.env, spawn = childProcess.spawn, safeRoot = null, model = 'haiku', systemPrompt = null,
  maxBudgetUsd = null, ackMs = ACK_MS, controlMs = CONTROL_MS, killGraceMs = KILL_GRACE_MS } = {}) {
  const events = new EventEmitter();
  const children = new Map(); // target (our --session-id) -> child record
  const emit = (e) => events.emit('event', e);

  function close(c, reason) {
    if (c.closed) return;
    c.closed = true;
    for (const w of c.waiters.values()) { clearTimeout(w.timer); w.reject(new Error(reason)); }
    c.waiters.clear();
    if (c.active) emit({ kind: 'turn-completed', target: c.target, turnId: c.active, status: 'failed', error: reason });
    c.active = null;
    children.delete(c.target);
    reap(c);
    emit({ kind: 'closed', target: c.target });
  }
  function reap(c) {
    if (c.exited) return;
    // Detached child = own process group: tools it started go with it.
    const kill = (sig) => { try { process.kill(-c.child.pid, sig); } catch { try { c.child.kill(sig); } catch { /* gone */ } } };
    kill('SIGTERM');
    const t = setTimeout(() => { if (!c.exited) kill('SIGKILL'); }, killGraceMs);
    t.unref?.();
  }
  function settle(c, key, value) {
    const w = c.waiters.get(key);
    if (!w) return;
    c.waiters.delete(key); clearTimeout(w.timer); w.resolve(value);
  }
  function wait(c, key, ms, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { c.waiters.delete(key); reject(new Error(`${what} timed out`)); }, ms);
      c.waiters.set(key, { resolve, reject, timer });
    });
  }
  function finish(c, status, error = null, text = null) {
    const turnId = c.active;
    if (!turnId) return;
    if (typeof text === 'string') emit({ kind: 'message', target: c.target, turnId, text });
    emit({ kind: 'turn-completed', target: c.target, turnId, status: c.interrupting === turnId && status !== 'completed' ? 'interrupted' : status, error });
    c.done.add(turnId); c.active = null; c.interrupting = null;
  }

  function onLine(c, line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    // A control_response is matched by our own random request id (this child's stdout only); it need not carry a session id.
    if (m.type === 'control_response' && typeof m.response?.request_id === 'string') { settle(c, `ctl:${m.response.request_id}`, m.response.subtype === 'success'); return; }
    // Only this child's own session id counts; anything else is foreign.
    if (m.session_id !== c.target) {
      if (m.type === 'system' && m.subtype === 'init') close(c, 'Claude Code started a different session');
      return;
    }
    const { target } = c;
    if (m.type === 'command_lifecycle' && typeof m.command_uuid === 'string') {
      if (!c.sent.has(m.command_uuid)) return;
      if (m.state === 'queued' || m.state === 'started') {
        if (c.active !== m.command_uuid && !c.done.has(m.command_uuid)) { c.active = m.command_uuid; emit({ kind: 'turn-started', target, turnId: m.command_uuid }); }
        settle(c, `ack:${m.command_uuid}`, m.command_uuid);
      } else if (m.state !== 'completed' && c.active === m.command_uuid) finish(c, m.state === 'cancelled' ? 'interrupted' : 'failed', `Claude Code: ${String(m.state).slice(0, 40)}`);
    } else if (m.type === 'user' && m.isReplay === true && typeof m.uuid === 'string' && c.sent.has(m.uuid)) {
      const content = m.message?.content;
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
      emit({ kind: 'input-recorded', target, turnId: m.uuid, clientId: m.uuid, text });
    } else if (m.type === 'stream_event' && m.parent_tool_use_id == null && c.active) {
      const d = m.event?.type === 'content_block_delta' ? m.event.delta : null;
      if (d?.type === 'text_delta' && typeof d.text === 'string') emit({ kind: 'delta', target, turnId: c.active, text: d.text });
    } else if (m.type === 'result') {
      finish(c, m.is_error ? 'failed' : 'completed', m.is_error ? String(m.errors?.[0] ?? m.subtype ?? 'error').slice(0, 300) : null, typeof m.result === 'string' ? m.result : null);
    } else if (m.type === 'system' && m.subtype === 'permission_denied' && c.active) {
      emit({ kind: 'refused-request', target, turnId: c.active, method: 'permission' });
    } else if (m.type === 'system' && m.subtype === 'status' && typeof m.status === 'string') {
      emit({ kind: 'status', target, status: m.status.slice(0, 40) });
    }
  }

  async function open({ cwd }) {
    if (!bin) throw new Error('Claude Code CLI not found');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Owned Claude sessions need an absolute working directory');
    const target = crypto.randomUUID();
    const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
    const rootReal = safeRoot ? real(safeRoot) : null, cwdReal = real(cwd);
    const writable = !!rootReal && !!cwdReal && inside(rootReal, cwdReal);
    const childEnv = { ...Object.fromEntries(ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]])), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const child = spawn(bin, buildClaudeArgs({ sessionId: target, writable, model, systemPrompt, maxBudgetUsd }), // privacy-flow: owned-claude-session
      { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const c = { target, child, sent: new Set(), done: new Set(), waiters: new Map(), active: null, interrupting: null, closed: false, exited: false };
    children.set(target, c);
    let buffer = '', skipping = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (c.closed) return;
      buffer += chunk;
      let nl;
      while (!c.closed && (nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (skipping) { skipping = false; continue; }
        if (line.length > MAX_LINE) emit({ kind: 'oversize', target });
        else if (line.trim()) onLine(c, line);
      }
      // An oversized line is dropped, not the session; the rest of it is skipped.
      if (buffer.length > MAX_LINE) { buffer = ''; skipping = true; emit({ kind: 'oversize', target }); }
    });
    // stderr can carry account detail; it is never kept.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    const ended = () => { c.exited = true; close(c, 'Claude Code exited'); };
    child.on('error', ended);
    child.on('exit', ended);
    return { target };
  }

  function write(c, obj) {
    if (c.closed || c.exited || c.child.stdin.destroyed || c.child.stdin.writableEnded) throw new Error('Claude Code session is not running');
    c.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }
  // A new turn only: Claude Code has no "steer into turn X" precondition.
  // The ack is Claude Code's own command_lifecycle for our uuid in our session.
  async function send({ target, text, clientId, expectedTurnId = null }) {
    const c = children.get(target);
    if (!c) throw new Error('Unknown Claude Code session');
    if (expectedTurnId) throw new Error('Claude Code does not support steering a running turn');
    if (typeof clientId !== 'string' || !UUID.test(clientId) || c.active) throw new Error('Claude Code session is busy or the message id is invalid');
    c.sent.add(clientId);
    const acked = wait(c, `ack:${clientId}`, ackMs, 'Claude Code acknowledgement');
    write(c, { type: 'user', uuid: clientId, session_id: target, parent_tool_use_id: null, client_composed: true, message: { role: 'user', content: [{ type: 'text', text }] } });
    let turnId;
    try { turnId = await acked; } catch (error) {
      // Timed out: a late lifecycle line for this id must not start a turn, and anything it started is stopped.
      c.sent.delete(clientId);
      try { write(c, { type: 'control_request', request_id: `int-${crypto.randomUUID()}`, request: { subtype: 'interrupt' } }); } catch { /* gone */ }
      throw error;
    }
    return { turnId, mode: 'new-turn' };
  }
  async function interrupt({ target, turnId }) {
    const c = children.get(target);
    if (!c || !c.active || c.active !== turnId) throw new Error('Not the running Claude Code turn');
    const id = `int-${crypto.randomUUID()}`;
    c.interrupting = turnId;
    const ok = wait(c, `ctl:${id}`, controlMs, 'Claude Code interrupt');
    write(c, { type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });
    if (!(await ok)) throw new Error('Claude Code refused the interrupt');
    return true;
  }
  function release({ target } = {}) { const c = children.get(target); if (c) close(c, 'Closed by Plexiform'); }
  function stop() { for (const c of [...children.values()]) close(c, 'Plexiform stopped'); }

  return {
    provider: 'claude', label: 'Claude Code',
    capabilities: Object.freeze({ newTurn: true, steer: false, interrupt: true, ack: 'command-lifecycle', echo: 'replayed-user-uuid', stream: true,
      existingSessions: false, existingSessionsReason: EXISTING_SESSIONS_REASON, steerReason: 'Claude Code queues mid-turn messages as a new turn; there is no expected-turn precondition.' }),
    open, send, interrupt, release, stop,
    on: (fn) => { events.on('event', fn); return () => events.off('event', fn); },
    alive: () => !!bin,
    sessionCount: () => children.size,
  };
}

module.exports = { createClaudeCodeSession, findClaudeBin, buildClaudeArgs, EXISTING_SESSIONS_REASON };
