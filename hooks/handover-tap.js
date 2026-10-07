'use strict';
// Remembers, per session and on every adapter, the few facts a handover needs
// (prompts, files touched, commands, tool counts, how the last turn ended).
// Called by every hook path with the agent's own payload, because the
// normalized signal no longer carries any of it. Dependency-free: the packaged
// hooks run with nothing but hooks/ and adapters/ beside them. The facts are
// truncated here; src/session-handover.js scrubs them when it writes the doc.
// Never throws, never blocks the agent.
const fs = require('fs');
const path = require('path');
const { withLock, writeJsonAtomic, readJson, safeSessionId } = require('./session-state.js');

const CAP = { prompt: 400, command: 200, assistant: 400, files: 60, commands: 15, tools: 40 };
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit|apply_patch|write_file|replace|edit_file|create_file)$/i;

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const clip = (v, n) => (v.length > n ? `${v.slice(0, n)}…` : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');

// Same rule as src/quiet.js projectMuted (test/session-handover.test.js keeps them equal).
const norm = (p) => String(p || '').replace(/\/+$/, '');
function excluded(list, cwd) {
  const dir = norm(cwd);
  if (!dir || !Array.isArray(list)) return false;
  const parts = dir.split('/').filter(Boolean);
  return list.some((raw) => {
    const e = norm(typeof raw === 'string' ? raw.trim() : '');
    if (!e) return false;
    return e.includes('/') ? dir === e || dir.startsWith(`${e}/`) : parts.includes(e);
  });
}

const dirOf = (rootDir) => path.join(rootDir, 'handovers');
const factsFile = (rootDir, adapter, sessionId) => path.join(dirOf(rootDir), '.facts', `${safeSessionId(adapter)}-${safeSessionId(sessionId)}.json`);

function promptOf(d) {
  const direct = str(d.prompt) || str(d.user_prompt) || str(d.userPrompt);
  if (direct) return direct;
  const msgs = d['input-messages'] || d.input_messages;
  return Array.isArray(msgs) ? str(msgs[msgs.length - 1]) : null;
}
const assistantOf = (d) => str(d.last_assistant_message) || str(d['last-assistant-message']) || str(d.lastAssistantMessage);

function mutate(f, signal, d, now) {
  f.lastActive = now;
  const input = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : d;
  const tool = str(d.tool_name) || str(d.toolName) || null;
  if (signal === 'prompt-submit') {
    const p = promptOf(d);
    if (p) { f.lastPrompt = clip(p, CAP.prompt); f.lastPromptAt = now; if (!f.firstPrompt) f.firstPrompt = f.lastPrompt; }
    f.awaitingReply = true;
    f.lastToolFailed = null;
  } else if (signal === 'tool-use') {
    if (tool) {
      const name = clip(tool, 60);
      if (f.tools[name] !== undefined || Object.keys(f.tools).length < CAP.tools) f.tools[name] = (f.tools[name] || 0) + 1;
    }
    const file = str(input.file_path) || str(input.notebook_path) || str(input.filePath) || str(input.path);
    if (file) {
      const kind = tool && EDIT_TOOLS.test(tool) ? 'edit' : 'read';
      if (f.files[file] === 'edit') return;
      if (f.files[file] || Object.keys(f.files).length < CAP.files) f.files[file] = kind;
    }
    const cmd = str(input.command) || str(input.cmd);
    if (cmd) f.commands = f.commands.concat([clip(cmd, CAP.command)]).slice(-CAP.commands);
  } else if (signal === 'tool-failed') {
    f.lastToolFailed = { tool: tool ? clip(tool, 60) : null, at: now };
  } else if (signal === 'stop' || signal === 'turn-failed') {
    f.awaitingReply = false;
    f.lastStopAt = now;
    if (signal === 'turn-failed') f.lastTurnFailed = now;
    const a = assistantOf(d);
    if (a) f.lastAssistant = clip(a, CAP.assistant);
  } else if (signal === 'session-end') {
    f.endedAt = now;
  }
}

// adapter: the adapter's id ('claude-code' for Claude Code; a bare-signal
// source name otherwise). data: the agent's own hook payload (may be empty).
function record({ rootDir, adapter, signal, sessionId, cwd, data, mutedProjects, now = new Date().toISOString() }) {
  try {
    if (!rootDir || !adapter || !signal || !sessionId) return false;
    const d = data && typeof data === 'object' ? data : {};
    let muted = mutedProjects;
    if (muted === undefined) { const c = readJson(path.join(rootDir, 'config.json')); muted = c && c.mutedProjects; }
    const where = typeof cwd === 'string' ? cwd : '';
    if (excluded(muted, where)) return false;
    const file = factsFile(rootDir, adapter, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    withLock(file, () => {
      const f = readJson(file) || { v: 1, adapter, sessionId: safeSessionId(sessionId), cwd: where, startedAt: now, tools: {}, files: {}, commands: [] };
      if (where) f.cwd = where.slice(0, 500);
      mutate(f, signal, d, now);
      writeJsonAtomic(file, f);
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    }, 250);
    return true;
  } catch { return false; }
}

// mutate and clip are also how src/handover-transcripts.js builds facts from a transcript.
module.exports = { record, factsFile, dirOf, excluded, mutate, clip, CAP };
