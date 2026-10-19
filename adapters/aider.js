// Aider: no hooks, but one notification: with `notifications: true` it runs
// `notifications-command` (a shell line, aider/io.py ring_bell) each time the
// model has finished and aider is waiting for the person. That is the
// "your turn" signal; aider says nothing when a prompt is sent, so working
// only shows when aider is launched through `plexiform-run aider`, which
// exports PLEXIFORM_SESSION so both land in one session. Plexiform adds two
// lines to ~/.aider.conf.yml, each ending in a marker comment, and removes
// exactly those; a notifications-command the person wrote is left alone and
// the connection refused.
const fs = require('fs');
const path = require('path');
const Runtime = require('./runtime.js');

const MARKER = '# plexiform';
const LINE_RE = /^(notifications|notifications-command|notifications_command)\s*:/;

const isOurs = (line) => typeof line === 'string' && line.trimEnd().endsWith(MARKER) && (Runtime.runsScript(line, ['emit.js']) || /^notifications\s*:/.test(line));
const yamlSingle = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Shell line aider runs with `sh -c`: $PPID is aider's own pid there.
function notifyCommand(runtime) {
  const emit = Runtime.shellCommand(runtime, Runtime.script(runtime, 'emit.js'), ['--adapter']);
  return `if [ -n "$PLEXIFORM_SESSION" ]; then printf '{"tool":"aider","session":"%s","pid":%s}' "$PLEXIFORM_SESSION" "$PPID" | ${emit} generic ready; else printf '{"session":"aider-%s","pid":%s}' "$PPID" "$PPID" | ${emit} aider ready; fi`;
}
const commandFor = (event, runtime) => (event === 'ready' ? notifyCommand(runtime) : null);
const ourLines = (runtime) => [`notifications: true ${MARKER}`, `notifications-command: ${yamlSingle(notifyCommand(runtime))} ${MARKER}`];

function normalize(event, payload) {
  if (event !== 'ready') return [];
  const d = payload && typeof payload === 'object' ? payload : {};
  const pid = Number.isInteger(d.pid) && d.pid > 1 ? d.pid : null;
  const sessionId = typeof d.session === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(d.session) ? d.session : (pid ? `aider-${pid}` : null);
  return [{ signal: 'stop', sessionId, cwd: typeof d.cwd === 'string' && d.cwd.length < 500 && !/[\0\r\n]/.test(d.cwd) ? d.cwd : null, tool: null, pid: null, extra: {} }];
}

const configPath = (home) => path.join(home, '.aider.conf.yml');
const files = (home) => [configPath(home)];
const splitLines = (text) => String(text || '').split(/\r?\n/);

// The file with every line of ours gone (and no trailing blank it left).
function strip(text) {
  const lines = splitLines(text).filter((l) => !isOurs(l));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function apply(text, runtime) {
  const kept = strip(text);
  const foreign = splitLines(kept).filter((l) => LINE_RE.test(l));
  if (foreign.some((l) => /^notifications[-_]command/.test(l))) throw new Error('~/.aider.conf.yml already has your own notifications-command, so it was left alone and Aider was not connected.');
  const [on, cmd] = ourLines(runtime);
  const add = foreign.some((l) => /^notifications\s*:/.test(l)) ? [cmd] : [on, cmd];
  return `${kept}${kept && !kept.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`;
}

function check(text, runtime) {
  const lines = splitLines(text);
  const [on, cmd] = ourLines(runtime);
  const notifyOn = lines.includes(on) || lines.some((l) => /^notifications\s*:\s*true\b/.test(l) && !isOurs(l));
  return notifyOn && lines.includes(cmd);
}

function plan({ home, runtime, fs: fsImpl = fs }) {
  const file = configPath(home);
  let before = '';
  try { before = fsImpl.readFileSync(file, 'utf8'); } catch { /* new */ }
  return { files: [{ file, before, after: apply(before, runtime) }] };
}

module.exports = {
  id: 'aider',
  label: 'Aider',
  capabilities: { working: true, yourTurn: true, blocked: false, answer: false, subagents: false, limits: false, cost: false },
  transport: 'command',
  ownFile: false,
  text: true,
  MARKER,
  configPath,
  files,
  detect: ({ home, exists }) => exists(path.join(home, '.aider.conf.yml')) || exists(path.join(home, '.aider')),
  isOurs,
  commandFor,
  notifyCommand,
  apply,
  strip,
  check,
  normalize,
  plan,
  holdsOurs({ home, fs: fsImpl = fs }) { try { return splitLines(fsImpl.readFileSync(configPath(home), 'utf8')).some(isOurs); } catch { return false; } },
  install({ home, runtime, fs: fsImpl = fs }) {
    const p = plan({ home, runtime, fs: fsImpl });
    if (Runtime.shellNeedsWrapper(runtime)) Runtime.ensureWrapper(runtime, fsImpl);
    Runtime.writeTextAtomic(p.files[0].file, p.files[0].after, fsImpl, undefined, { newMode: 0o644 });
    return { ok: true, file: p.files[0].file };
  },
  uninstall({ home, fs: fsImpl = fs }) {
    const file = configPath(home);
    let text;
    try { text = fsImpl.readFileSync(file, 'utf8'); } catch { return { ok: true, file, changed: false }; }
    const next = strip(text);
    if (next === text) return { ok: true, file, changed: false };
    if (next) Runtime.writeTextAtomic(file, next, fsImpl);
    else fsImpl.rmSync(file, { force: true });
    return { ok: true, file, changed: true };
  },
  isInstalled({ home, runtime, fs: fsImpl = fs }) {
    try { return check(fsImpl.readFileSync(configPath(home), 'utf8'), runtime) && Runtime.wrapperPresent(runtime, {}, fsImpl); } catch { return false; }
  },
};
