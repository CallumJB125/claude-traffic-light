// One-key approval: Enter in the waiting list allows a permission request,
// but only when the person turned "Allow one-key approval for read-only
// requests" on (off by default) AND the request is plainly read-only by the
// short allow-list below. Anything not recognised is not read-only: it needs
// an explicit click. There is no automatic path here; a key press is the
// decision, and each one is written to a local log.
'use strict';

const fs = require('fs');
const path = require('path');

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
// Secrets and credentials are never one-key, even to read.
const SENSITIVE = /(^|[\\/])(\.env[^\\/]*|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|id_[a-z0-9]+|[^\\/]*\.(pem|key|p12|pfx|keychain[^\\/]*)|[^\\/]*(secret|credential|token|password)[^\\/]*)([\\/]|$)/i;
// Bash: ls and pwd, or git status / git log; flags are plain letters (no
// "=", so no --output=file), arguments are relative paths inside the folder.
const BASH_SHAPES = [/^ls$/, /^pwd$/, /^git (status|log)$/];
const FLAG = /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/;
const SHELL_META = /[;&|<>$`(){}\\\n\r*?"'~!#]/;

const text = (v) => (typeof v === 'string' ? v : '');

function insideCwd(p, cwd) {
  if (!path.isAbsolute(cwd)) return false;
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.join(cwd, p);
  const rel = path.relative(cwd, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// → null when the request is read-only by this list, else why not.
function readOnlyReason(req) {
  const tool = text(req && req.tool);
  const input = (req && req.toolInput && typeof req.toolInput === 'object' && !Array.isArray(req.toolInput)) ? req.toolInput : {};
  const cwd = text(req && req.cwd);
  if (!cwd || !path.isAbsolute(cwd)) return 'no session folder';
  if (READ_TOOLS.has(tool)) {
    for (const k of PATH_KEYS) {
      if (input[k] === undefined) continue;
      const p = text(input[k]);
      if (!p || p.includes('\0')) return 'its path is not plain';
      if (!insideCwd(p, cwd)) return 'it reads outside the project';
      if (SENSITIVE.test(p)) return 'it touches credentials';
    }
    // A glob or grep pattern can point anywhere; ".." and absolute roots never.
    const pat = text(input.pattern);
    if (tool === 'Glob' && (/(^|[\\/])\.\.([\\/]|$)/.test(pat) || path.isAbsolute(pat))) return 'its pattern leaves the project';
    return null;
  }
  if (tool === 'Bash') {
    const cmd = text(input.command).trim();
    if (!cmd || SHELL_META.test(cmd)) return 'not a plain command';
    const words = cmd.split(/\s+/);
    const shape = BASH_SHAPES.find((re) => re.test(words.slice(0, re.source.includes('git') ? 2 : 1).join(' ')));
    if (!shape) return 'not on the read-only list';
    const rest = words.slice(shape.source.includes('git') ? 2 : 1);
    for (const w of rest) {
      if (w.startsWith('-')) { if (FLAG.test(w)) continue; return 'its flag is not plain'; }
      if (path.isAbsolute(w) || !insideCwd(w, cwd) || SENSITIVE.test(w)) return 'its argument is not a plain path in the project';
    }
    return null;
  }
  return 'not on the read-only list';
}

// Why Enter may not approve this request, or null when it may. `enabled` is
// the Preferences option (strictly true to count).
function reason(req, { enabled } = {}) {
  if (enabled !== true) return 'one-key approval is off in Preferences';
  return readOnlyReason(req);
}

// One line per approval, JSON, in the app's data folder.
function record(file, entry, { fsImpl = fs, now = Date.now() } = {}) {
  const line = JSON.stringify({ at: new Date(now).toISOString(), kind: 'one-key-approve', ...entry });
  try { fsImpl.appendFileSync(file, `${line}\n`); return true; } catch { return false; }
}

module.exports = { readOnlyReason, reason, record, READ_TOOLS };
