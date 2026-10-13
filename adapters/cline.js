// Cline (VS Code extension): file hooks. A global hook is one executable
// file per hook name in ~/Documents/Cline/Hooks/ (docs.cline.bot, hooks):
// TaskStart, TaskResume, TaskCancel, TaskComplete, PreToolUse, PostToolUse,
// UserPromptSubmit, PreCompact. The payload arrives on stdin (taskId,
// hookName, workspaceRoots, and a per-hook object: preToolUse.tool,
// postToolUse.success, …); stdout is read back as { cancel, errorMessage,
// contextModification }, so every hook of ours answers { cancel: false }.
// One file per name means Plexiform can only connect where that slot is
// empty or already its own script; a person's own hook is never replaced.
// Windows hooks are PowerShell (.ps1) and are not written: macOS and Linux only.
const fs = require('fs');
const path = require('path');
const Runtime = require('./runtime.js');

const MARKER = '# plexiform-cline-hook v1 (written by Plexiform; safe to delete)';
const EVENTS = [
  ['TaskStart', 'session-start'],
  ['TaskResume', 'prompt-submit'],
  ['UserPromptSubmit', 'prompt-submit'],
  ['PreToolUse', 'tool-use'],
  ['PostToolUse', 'tool-done'],
  ['TaskComplete', 'stop'],
  ['TaskCancel', 'stop'],
  ['PreCompact', 'compact'],
];
const SIGNAL_OF = Object.fromEntries(EVENTS);

const isOurs = (command) => Runtime.runsScript(command, ['emit.js']) && /--adapter cline\b/.test(String(command || ''));
const ourScript = (text) => typeof text === 'string' && text.includes(MARKER);

function commandFor(event, runtime) {
  return SIGNAL_OF[event] ? Runtime.shellCommand(runtime, Runtime.script(runtime, 'emit.js'), ['--adapter', 'cline', event]) : null;
}

const scriptText = (event, runtime) => `#!/bin/sh\n${MARKER}\nexec ${commandFor(event, runtime)}\n`;

function normalize(event, payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  const ev = SIGNAL_OF[event] ? event : (SIGNAL_OF[d.hookName] ? d.hookName : null);
  if (!ev) return [];
  const base = { sessionId: d.taskId || null, cwd: Array.isArray(d.workspaceRoots) && typeof d.workspaceRoots[0] === 'string' ? d.workspaceRoots[0] : (d.cwd || null), pid: null, extra: {} };
  if (ev === 'TaskStart') return [{ ...base, signal: 'session-start', tool: null }, { ...base, signal: 'prompt-submit', tool: null }];
  if (ev === 'PreToolUse') return [{ ...base, signal: 'tool-use', tool: d.preToolUse?.tool || null }];
  if (ev === 'PostToolUse') return [{ ...base, signal: d.postToolUse?.success === false ? 'tool-failed' : 'tool-done', tool: d.postToolUse?.tool || null }];
  return [{ ...base, signal: SIGNAL_OF[ev], tool: null }];
}

// Cline parses stdout as the hook's answer: never cancel, add nothing.
const reply = () => ({ cancel: false });

const hooksDir = (home) => path.join(home, 'Documents', 'Cline', 'Hooks');
const fileFor = (home, event) => path.join(hooksDir(home), event);
const files = (home) => EVENTS.map(([e]) => fileFor(home, e));
const configPath = (home) => fileFor(home, 'TaskStart');

// Which slots a person's own hook occupies: those are left alone and the
// connection is refused, so a half-connected Cline never happens.
function foreign({ home, fs: fsImpl = fs }) {
  const out = [];
  for (const [event] of EVENTS) {
    let text = null;
    try { text = fsImpl.readFileSync(fileFor(home, event), 'utf8'); } catch (err) { if (err.code !== 'ENOENT') out.push(event); continue; }
    if (!ourScript(text)) out.push(event);
  }
  return out;
}

function plan({ home, runtime, fs: fsImpl = fs }) {
  const taken = foreign({ home, fs: fsImpl });
  if (taken.length) throw new Error(`~/Documents/Cline/Hooks already has your own ${taken.join(', ')} hook${taken.length > 1 ? 's' : ''}. Cline runs one file per hook, so Plexiform left ${taken.length > 1 ? 'them' : 'it'} alone and did not connect.`);
  return { files: EVENTS.map(([event]) => { let before = ''; try { before = fsImpl.readFileSync(fileFor(home, event), 'utf8'); } catch { /* new */ } return { file: fileFor(home, event), before, after: scriptText(event, runtime) }; }) };
}

function check({ home, runtime, fs: fsImpl = fs }) {
  return EVENTS.every(([event]) => { try { return fsImpl.readFileSync(fileFor(home, event), 'utf8') === scriptText(event, runtime) && (fsImpl.statSync(fileFor(home, event)).mode & 0o100); } catch { return false; } });
}

module.exports = {
  id: 'cline',
  label: 'Cline',
  capabilities: { working: true, yourTurn: true, blocked: false, answer: false, subagents: false, limits: false, cost: false },
  transport: 'command',
  ownFile: true,
  text: true,
  MARKER,
  EVENTS,
  configPath,
  files,
  hooksDir,
  detect: ({ home, exists }) => exists(path.join(home, 'Documents', 'Cline')),
  isOurs,
  commandFor,
  scriptText,
  normalize,
  reply,
  plan,
  check,
  holdsOurs({ home, fs: fsImpl = fs }) {
    return EVENTS.some(([event]) => { try { return ourScript(fsImpl.readFileSync(fileFor(home, event), 'utf8')); } catch { return false; } });
  },
  install({ home, runtime, fs: fsImpl = fs }) {
    if (runtime.platform === 'win32') return { ok: false, error: 'Cline hooks on Windows are PowerShell scripts, which Plexiform does not write yet.' };
    const p = plan({ home, runtime, fs: fsImpl });
    if (Runtime.shellNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    for (const f of p.files) {
      Runtime.writeTextAtomic(f.file, f.after, fsImpl, undefined, { newMode: 0o755 });
      try { fsImpl.chmodSync(f.file, 0o755); } catch { /* best effort */ }
    }
    return { ok: true, file: configPath(home) };
  },
  uninstall({ home, fs: fsImpl = fs }) {
    for (const [event] of EVENTS) {
      const file = fileFor(home, event);
      let text = null;
      try { text = fsImpl.readFileSync(file, 'utf8'); } catch { continue; }
      if (ourScript(text)) fsImpl.rmSync(file, { force: true });
    }
    return { ok: true, file: configPath(home) };
  },
  isInstalled({ home, runtime, fs: fsImpl = fs }) {
    try { return check({ home, runtime, fs: fsImpl }) && Runtime.wrapperPresent(runtime, {}, fsImpl); } catch { return false; }
  },
};
