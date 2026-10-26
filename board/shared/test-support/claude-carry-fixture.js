// A claude-carry over an in-memory file system and recorded commands: no real HOME, no real helper, no network.
import { createClaudeCarry } from '../claude-carry.cjs';

export const HOME = '/fx/home';
export const CFG = `${HOME}/.claude`;
export const MANAGED = '/etc/claude-code/managed-settings.json';
export const KEY = 'sk-ant-api03-FIXTUREKEY0000000000000000000000000000';

/**
 * files: {absPath: string}. commands: {commandString: result | (opts) => result}.
 * → { carry, calls (every runCommand call), probes (every probe call), intervals (scheduled refreshes) }
 */
export function fixtureCarry({ files = {}, dirs = {}, env = {}, loginShellEnv = null, platform = 'linux', commands = {}, probeUp = true, burst = false, loggedIn = true } = {}) {
  const calls = [];
  const probes = [];
  const intervals = [];
  const carry = createClaudeCarry({
    env, home: HOME, platform, loginShellEnv,
    readFile: (f) => (Object.hasOwn(files, f) ? files[f] : null),
    readDir: (d) => dirs[d] ?? null,
    runCommand: async (o) => {
      calls.push({ command: o.command, home: o.home, label: o.label, extraEnv: o.extraEnv });
      const r = commands[o.command];
      if (r === undefined) return { ok: false, timedOut: false, code: 127, reason: `${o.label} failed (exit 127)` };
      return typeof r === 'function' ? r(o) : r;
    },
    probe: async (o) => { probes.push(o); return probeUp; },
    burstOwnsPort: async () => burst,
    credentialsExist: () => loggedIn,
    setInterval: (fn, ms) => { const t = { fn, ms, unref() {} }; intervals.push(t); return t; },
    clearInterval: (t) => { t.cleared = true; },
  });
  return { carry, calls, probes, intervals };
}

export const settingsFile = (obj) => JSON.stringify(obj);
