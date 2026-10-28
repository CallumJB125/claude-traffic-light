'use strict';
// QoL2: a session's own actions from its widget card. Main-side only: every value here comes from the session
// row main already holds (re-found by id), never from text the renderer sent.
//   resumeCommand(row) → the text to copy, `cd '<cwd>' && claude --resume <id>`. It is only ever copied, never run.
//   folderLabel(cwd, home) → the folder for the card, with the home folder as `~`, at most 80 characters.
//   waitShort(ms) → " · 4m"'s "4m"; '' under a minute.
//   openFolder(how, cwd, deps) → reveal the folder in Finder (never launch it) or open it in the editor.
const path = require('path');

// A session row's `source` → session-handover's adapter key. Anything else gets no command.
const ADAPTER = Object.freeze({ claude: 'claude-code', codex: 'codex' });
const CONTROL = /[\u0000-\u001f\u007f]/;
const shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

function resumeCommand(row) {
  // Loaded on use: session-card-view (and the strip, through it) needs only the pure helpers below.
  const { KEY, RESUME } = require('./session-handover.js');
  if (!row || typeof row !== 'object' || row.remote) return null;
  const source = row.source ?? 'claude';
  if (typeof source !== 'string' || !Object.hasOwn(ADAPTER, source)) return null;
  const id = row.sessionId;
  if (typeof id !== 'string' || !KEY.test(id)) return null;
  const cwd = row.cwd;
  // `claude --resume` finds the conversation through its folder, so the command goes there first.
  if (typeof cwd !== 'string' || !path.posix.isAbsolute(cwd) || CONTROL.test(cwd) || cwd.length > 4096) return null;
  return `cd ${shellQuote(cwd)} && ${RESUME[ADAPTER[source]](id)}`;
}

const MAX_FOLDER = 80;
function folderLabel(cwd, home) {
  if (typeof cwd !== 'string' || !cwd) return null;
  let s = cwd.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '');
  const h = typeof home === 'string' && home.length > 1 ? home.replace(/\/+$/, '') : '';
  // Only on a path boundary: /Users/callumx is not ~ for /Users/callum.
  if (h && s === h) s = '~';
  else if (h && s.startsWith(`${h}/`)) s = `~${s.slice(h.length)}`;
  const chars = [...s];
  if (chars.length <= MAX_FOLDER) return s;
  const keep = MAX_FOLDER - 1;
  return `${chars.slice(0, Math.floor(keep / 2)).join('')}…${chars.slice(chars.length - Math.ceil(keep / 2)).join('')}`;
}

function waitShort(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const FOLDER_APP = { darwin: 'Finder', win32: 'Explorer' };
const folderApp = (platform) => FOLDER_APP[platform] || 'Files';
const DEFAULT_EDITOR = 'Visual Studio Code';

/**
 * how: 'finder' | 'editor'. cwd: the session row's own folder. editor: the app from the person's saved gesture, or
 * null for the default. deps: {platform, fs, execFile, shell, editorCommand(arg) (Linux)}.
 * → {ok, feedback}. On macOS a folder is revealed with `open -R`: shell.openPath on a package folder (x.app) would
 * launch it.
 */
function openFolder(how, cwd, { platform, fs, execFile, shell, editorCommand = null }, editor = null) {
  if (how !== 'finder' && how !== 'editor') return { ok: false, feedback: '' };
  const isAbs = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (typeof cwd !== 'string' || !isAbs(cwd) || CONTROL.test(cwd)) return { ok: false, feedback: 'This session has no folder Plexiform can open.' };
  let real;
  try { real = fs.realpathSync(cwd); if (!fs.statSync(real).isDirectory()) real = null; } catch { real = null; }
  if (!real) return { ok: false, feedback: "This session's folder isn't there any more." };
  const name = path.basename(real) || real;
  if (how === 'finder') {
    if (platform === 'darwin') execFile('/usr/bin/open', ['-R', real], () => {}); // privacy-flow: widget-session-card
    else shell.openPath(real);
    return { ok: true, feedback: `${folderApp(platform)} → ${name}` };
  }
  const app = typeof editor === 'string' && editor.trim() ? editor.trim() : null;
  if (platform === 'win32') execFile('cmd', ['/c', 'start', '', app || 'code', real], () => {}); // privacy-flow: widget-session-card
  else if (platform === 'darwin') execFile('/usr/bin/open', ['-a', app || DEFAULT_EDITOR, real], () => {}); // privacy-flow: widget-session-card
  // Linux: the editor's command; if there is none, the folder in the file manager.
  else execFile(editorCommand ? editorCommand(app) : 'code', [real], (err) => { if (err && err.code === 'ENOENT') shell.openPath(real); }); // privacy-flow: widget-session-card
  return { ok: true, feedback: `${app || DEFAULT_EDITOR} → ${name}` };
}

module.exports = { resumeCommand, folderLabel, waitShort, openFolder, folderApp, shellQuote, ADAPTER, DEFAULT_EDITOR };
