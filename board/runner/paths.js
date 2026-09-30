// Path confinement helpers for the PreToolUse gate and fact paths.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// realpath of the longest existing prefix + the non-existent rest, so a path
// that does not exist yet (Write) still resolves through symlinked parents.
export function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function inside(p, root) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Resolve a tool path (absolute, ~, or relative to cwd) and test it against the worktree. */
export function confine(rawPath, { cwd, rootReal }) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) return { ok: false, resolved: null };
  const abs = path.isAbsolute(expandHome(rawPath)) ? expandHome(rawPath) : path.resolve(cwd || rootReal, rawPath);
  const resolved = realish(abs);
  return { ok: inside(resolved, rootReal), resolved };
}

// The literal (non-glob) prefix of a glob pattern.
export function globBase(pattern) {
  const segs = String(pattern).split('/');
  const out = [];
  for (const s of segs) {
    if (/[*?[\]{}]/.test(s)) break;
    out.push(s);
  }
  return out.join('/') || '.';
}
