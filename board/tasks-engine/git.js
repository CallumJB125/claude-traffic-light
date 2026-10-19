// The engine's own git: one absolute binary (resolveBin: owned by us or root,
// no foreign write bits up to /), a minimal env with no system config, and
// options that keep any repo it touches from running code or reaching the
// network: no hooks, no fsmonitor, no attributes file, no transport at all.
// A repo whose own config defines filters or includes is refused before any
// checkout (filter.* can't be unset generically).
import { execFile } from 'node:child_process';
import { resolveBin } from '../runner/backends/detect.js';

export const SAFE_GIT = Object.freeze([
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
  '-c', 'protocol.allow=never', '-c', 'core.sshCommand=false',
]);

export function resolveGit(env) {
  return resolveBin('git', env, ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin']).bin ?? null;
}

/** → git(cwd, args, {timeoutMs}) → stdout; rejects with {code, stderr} (never logged by callers). */
export function makeGit(bin, parentEnv) {
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LANG: 'C' };
  for (const k of ['HOME', 'PATH', 'TMPDIR']) if (parentEnv[k]) env[k] = parentEnv[k];
  return (cwd, args, { timeoutMs = 60000 } = {}) => new Promise((resolve, reject) => {
    execFile(bin, [...SAFE_GIT, ...args], { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 << 20, encoding: 'utf8' }, (err, stdout, stderr) => { // privacy-flow: runner-local
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}
