'use strict';
// Take-over: macOS hands Plexiform Terminal a .command file (`open -a`). The
// keeper only starts Apple-signed login shells, so — like Terminal.app — the
// script runs by typing one exec line into a fresh shell tab of our own.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function commandFileProblem(file, { uid = process.getuid() } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file) !== '.command') return 'Only .command files can be opened.';
  if (/[\u0000-\u001f\u007f]/.test(file) || file.length > 1024) return 'That file path cannot be run safely.';
  let st;
  try { st = fs.lstatSync(file); } catch { return 'That file is no longer available.'; }
  if (st.isSymbolicLink() || !st.isFile()) return 'Only a regular .command file can be opened.';
  if (st.uid !== uid) return 'That .command file belongs to another user.';
  if (st.size > 256 * 1024) return 'That .command file is too large.';
  return null;
}
// Downloaded files keep their quarantine flag; those are never run from here.
function quarantined(file) {
  return new Promise((resolve) => execFile('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], { timeout: 2000, env: { PATH: '/usr/bin:/bin' } }, (error) => resolve(!error)));
}
// Plexiform's launcher writes <tmp>/plexiform-terminal-XXXXXX/continue.command.
function isPlexiformHandoff(file, tmpdirs) {
  const dir = path.dirname(file);
  return path.basename(file) === 'continue.command' && /^plexiform-terminal-[A-Za-z0-9]{6}$/.test(path.basename(dir)) && tmpdirs.includes(path.dirname(dir));
}
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
// Leading space keeps it out of shell history where HIST_IGNORE_SPACE is set.
const runLine = (file) => ` exec /bin/zsh -- ${quote(file)}\r`;

module.exports = { commandFileProblem, quarantined, isPlexiformHandoff, runLine, quote };
