#!/usr/bin/env node
// Generic emitter for any agent, not just Claude Code:
//
//   node emit.js <signal> [--source cursor] [--session id] [--cwd path] [--tool name]
//
// signals: prompt-submit | tool-use | tool-done | tool-failed | stop |
//          turn-failed | permission-ask | permission-denied | limit-hit |
//          idle-nudge | session-start | session-end | subagent-start |
//          subagent-done | compact
//
// Also understands Cursor and Codex payloads: pass --cursor <event> and the
// hook JSON on stdin, or --codex with Codex's notify JSON as the last arg.
const fs = require('fs');
const path = require('path');
const os = require('os');
const SessionState = require('./session-state.js');

const ROOT_DIR = process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const HOST_TAG = os.hostname().split('.')[0];
const KNOWN = ['prompt-submit', 'tool-use', 'tool-done', 'tool-failed', 'stop', 'turn-failed', 'permission-ask', 'permission-denied', 'limit-hit', 'idle-nudge', 'session-start', 'session-end', 'subagent-start', 'subagent-done', 'compact'];

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
let signal = argv.find((a) => KNOWN.includes(a)) || null;
let source = opt('source') || 'custom';
let session = opt('session') || null;
let cwd = opt('cwd') || null;
let tool = opt('tool') || null;

function readStdin() {
  if (process.stdin.isTTY) return '';
  const buf = Buffer.alloc(65536); let out = '';
  const sleeper = new Int32Array(new SharedArrayBuffer(4)); const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    let n; try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') { Atomics.wait(sleeper, 0, 0, 10); continue; } break; }
    if (n === 0) break; out += buf.toString('utf8', 0, n);
  }
  return out;
}

// Cursor hooks (~/.cursor/hooks.json): event name on the command line, JSON on stdin.
const cursorEvent = opt('cursor');
if (cursorEvent) {
  source = 'cursor';
  let d = {}; try { d = JSON.parse(readStdin() || '{}'); } catch { /* ignore */ }
  session = d.conversation_id || d.conversationId || session;
  cwd = d.workspace_roots?.[0] || d.cwd || cwd;
  const map = { beforeSubmitPrompt: 'prompt-submit', beforeShellExecution: 'tool-use', beforeMCPExecution: 'tool-use', afterFileEdit: 'tool-done', beforeReadFile: 'tool-use', stop: 'stop' };
  signal = map[cursorEvent] || null;
  tool = cursorEvent === 'beforeShellExecution' ? 'Bash' : cursorEvent === 'afterFileEdit' ? 'Edit' : cursorEvent === 'beforeMCPExecution' ? (d.tool_name ? `mcp__${d.tool_name}` : 'mcp__tool') : cursorEvent === 'beforeReadFile' ? 'Read' : null;
  // Cursor's permission hooks expect a JSON reply; "allow" keeps it unblocked.
  if (['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'beforeSubmitPrompt'].includes(cursorEvent)) process.stdout.write(JSON.stringify({ permission: 'allow', continue: true }));
}

// Codex CLI notify (config.toml: notify = ["node", ".../emit.js", "--codex"]): JSON as the last argument.
if (argv.includes('--codex')) {
  source = 'codex';
  let d = {}; try { d = JSON.parse(argv[argv.length - 1]); } catch { /* ignore */ }
  session = d['thread-id'] || d.thread_id || d.session_id || session;
  cwd = d.cwd || cwd;
  signal = d.type === 'agent-turn-complete' ? 'stop' : 'tool-use';
}

if (!signal) process.exit(0);
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
const sessionId = session || process.env.CLAUDE_SESSION_ID || `${source}-${process.ppid}`;
const file = path.join(SESSIONS_DIR, `${HOST_TAG}-${source}-${sessionId}.json`);
if (signal === 'session-end') { fs.rmSync(file, { force: true }); process.exit(0); }
// Same lock and state step as the Claude Code hook and the app's /signal
// endpoint, so what the app and the pollers stored on the file survives.
SessionState.withLock(file, () => {
  const prev = SessionState.readJson(file);
  const next = SessionState.applyBareSignal(prev, { sessionId, host: HOST_TAG, source, cwd: cwd || prev?.cwd || process.cwd(), signal, tool });
  SessionState.writeJsonAtomic(file, next);
});
