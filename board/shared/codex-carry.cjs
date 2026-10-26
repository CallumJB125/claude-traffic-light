'use strict';

// Carries the user's own Codex provider into Plexiform-started Codex runs (lab finding A8: with
// --ignore-user-config and no provider, Codex goes to OpenAI, and offline it waits forever). Reads
// $CODEX_HOME/config.toml through user-provider.cjs and answers:
//   overrides  `-c` values under model_provider and model_providers.<id>.* only (C16), never `model`
//              (the caller passes the model its own way)
//   model      the user's model, for a task that sets none
//   cliEnv     env_key / env_http_headers values and the translated PLEXIFORM_PROVIDER_* (C13). They go in
//              the Codex CLI's env only: its tool shells get shell_environment_policy.inherit="none" plus an
//              explicit set, and the board MCP server gets an explicit env with env_vars=[] (D26 as reworded:
//              no secret is reachable from a tool shell). Never on argv, never in a takeover command.
// Never used for hosted runs. prepare() never throws and never puts a value in a reason.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  codexProvider, boundedReadFile, CONFIG_TOML_MAX_BYTES,
} = require('./user-provider.cjs');
const { tcpProbe, burstOwnsPort, BURST_CODEX_GATEWAY_PORT, PROBE_MS } = require('./claude-carry.cjs');

const TRANSLATED = /^PLEXIFORM_PROVIDER_/;
const LOOPBACK = (host) => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
const BARE_ID = /^[A-Za-z0-9_-]+$/;

// How a key reaches Codex (lab 2026-10-26: codex-proc-environ.md showed an unsandboxed tool shell reads the CLI's
// env through /proc/$PPID/environ even with inherit="none"; codex-auth-command.md proved the fix on 0.164).
//   true  (b, the default): the key goes in a 0600 file in a 0700 per-run dir that tool shells are denied, read by
//              Codex itself through model_providers.<id>.auth={command="/bin/cat",args=[<file>],timeout_ms=5000}.
//              Only the path is on argv; the key is in no environ or cmdline (0 hits in 61 samples). auth can't be
//              combined with env_key, experimental_bearer_token or requires_openai_auth, so those go. No
//              refresh_interval_ms: the file is fixed for the run. Header values can't travel that way.
//   false (a): the fallback, also used when the file can't be written (or on Windows, which has no /bin/cat): a
//              run with a shell refuses a provider with any secret (auth park); a keyless provider goes everywhere.
const KEY_VIA_AUTH_FILE = true;
const CODEX_KEY_FILE = 'codex-provider.key';
const CODEX_TAKEOVER_KEY_FILE = 'codex-takeover.key';
const AUTH_TIMEOUT_MS = 5000;
// Without a key file, where a key may still sit in the Codex CLI env: sites whose Codex has no command tool at all
// (the owned chat; the board review, which disables every shell tool), and a takeover (the user's own terminal env
// supplies env_key; a translated key is refused there by the caller).
const MODES = new Set(['shell', 'noshell', 'takeover']);
const KEY_NOT_KEPT = 'This Codex provider\'s key can\'t be kept from Codex\'s commands yet, so Plexiform doesn\'t carry it into a run that has a shell. A provider that needs no key still works.';
const HEADER_NOT_KEPT = 'This Codex provider sends header values from variables, which can\'t be kept from Codex\'s commands yet, so Plexiform doesn\'t carry it into a run that has a shell.';
const EMPTY = Object.freeze({ carry: false, failure: null, providerId: null, overrides: [], model: null, cliEnv: {}, burst: false, translated: false, codexHome: null });

// C16: a provider override may only set these key paths, which are disjoint from codexConfig's.
function overrideKeyAllowed(override, providerId) {
  const eq = override.indexOf('=');
  if (eq < 0) return false;
  const key = override.slice(0, eq);
  if (key === 'model_provider') return true;
  const quoted = /^[A-Za-z0-9_-]+$/.test(providerId) ? providerId : JSON.stringify(providerId);
  const prefix = `model_providers.${quoted}.`;
  return key.startsWith(prefix) && /^[A-Za-z_]+$/.test(key.slice(prefix.length));
}

function gatewayOf(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return host ? { host, port, loopback: LOOPBACK(host) } : null;
}

function createCodexCarry({
  env = process.env, home = os.homedir(), platform = process.platform,
  loginShellEnv = null,     // seam for PR 2b (src/login-shell-env.js): async ({ names }) => ({ [name]: value })
  readFile = (file) => boundedReadFile(file, CONFIG_TOML_MAX_BYTES),
  probe = tcpProbe,
  // Burst's Codex gateway is 7779 (7777 is its Claude one).
  burstOwnsPort: burstOwns = (port) => burstOwnsPort(port, { home, platform, burstPort: BURST_CODEX_GATEWAY_PORT }),
  log = () => {},
  keyViaAuthFile = KEY_VIA_AUTH_FILE,
  writeKey = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, value, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  },
  removeKey = (file) => { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } },
} = {}) {
  const fail = (kind, reason) => ({ ...EMPTY, carry: true, failure: { kind, reason }, release() {} });

  // Two passes at most: the app env first, then the login shell for CODEX_HOME and any env_key still missing.
  async function resolve() {
    let provider = codexProvider({ env, home, readFile });
    if (typeof loginShellEnv !== 'function') return provider;
    const asked = new Set();
    let loginEnv = {};
    for (let pass = 0; pass < 2; pass++) {
      const names = [...(env.CODEX_HOME ? [] : ['CODEX_HOME']), ...provider.missingEnv].filter((n) => !asked.has(n));
      if (!names.length) break;
      names.forEach((n) => asked.add(n));
      let got = {};
      try { got = (await loginShellEnv({ names })) || {}; } catch { got = {}; }
      loginEnv = { ...loginEnv, ...Object.fromEntries(names.filter((n) => typeof got[n] === 'string').map((n) => [n, got[n]])) };
      provider = codexProvider({ env, loginEnv, home, readFile });
    }
    return provider;
  }

  /**
   * → { carry, failure:{kind:'auth'|'provider', reason}|null, providerId, overrides, model, cliEnv,
   *     burst, translated, codexHome, release() }. carry:false = no provider set: the caller behaves as before (OpenAI).
   * codexHome (every result without a failure): the CODEX_HOME this config was read from, possibly the login
   * shell's. Callers set it as the CLI's CODEX_HOME and deny it to tool shells, so the run and the deny list agree.
   */
  // opts.mode: 'shell' (a run with a tool shell: Tasks and board runs; the default), 'noshell', 'takeover'.
  // opts.keyFile: where (b) writes the key for a 'shell' run, inside a run dir denied to tool shells.
  async function prepare({ mode = 'shell', keyFile = null } = {}) {
    if (!MODES.has(mode)) mode = 'shell';
    let p;
    // carry:false means only "config read, no model_provider"; an unreadable config must never fall back to OpenAI.
    try { p = await resolve(); } catch { return fail('provider', 'Codex settings could not be read'); }
    if (p.unsupported.length) return fail('provider', `Codex settings: ${p.unsupported[0].message}`);
    if (!p.providerId) return { ...EMPTY, codexHome: p.codexHome, release() {} };
    // codex splits a -c key path on every '.', so a quoted id can't be addressed; refuse it rather than misroute.
    if (!BARE_ID.test(p.providerId)) return fail('provider', 'Codex provider ids with characters other than letters, digits, - and _ aren\'t carried yet');
    // Without its sign-in the run would reach the gateway unauthenticated and fail late with a 401.
    if (p.dropped.includes('auth')) return fail('auth', `Codex provider "${p.providerId}" signs in with a command (auth), which Plexiform doesn't run yet`);
    if (p.dropped.includes('aws')) return fail('auth', `Codex provider "${p.providerId}" signs in with AWS (aws), which Plexiform doesn't carry yet`);
    if (p.dropped.length) log(`codex provider fields not carried: ${p.dropped.join(', ')}`);
    if (p.missingEnv.length) {
      const name = p.missingEnv[0];
      return fail('auth', `Codex provider "${p.providerId}" reads its key from $${name}, which Plexiform can't see. Export it in your shell profile, or start Plexiform from a terminal where it is set, then retry.`);
    }
    const overrides = p.overrides.filter((o) => !o.startsWith('model='));
    if (overrides.some((o) => !overrideKeyAllowed(o, p.providerId))) return fail('provider', 'Codex settings: the provider could not be carried safely');

    const burstNamed = p.burst.detected === true;
    const gw = p.baseUrl ? gatewayOf(p.baseUrl) : null;
    let burst = burstNamed;
    if (gw && !(await probe({ host: gw.host, port: gw.port, timeoutMs: PROBE_MS }))) {
      if (!burst && gw.loopback) { try { burst = (await burstOwns(gw.port)) === true; } catch { burst = false; } }
      return fail('provider', burst ? "Burst gateway isn't running" : `the gateway at ${gw.host}:${gw.port} isn't answering`);
    }
    let carried = { overrides, cliEnv: { ...p.cliEnv }, keyFile: null };
    if (Object.keys(p.cliEnv).length) {
      const keyed = keyViaAuthFile && platform !== 'win32' && typeof keyFile === 'string' && path.isAbsolute(keyFile) ? viaAuthFile(p, overrides, keyFile) : { failure: KEY_NOT_KEPT };
      if (!keyed.failure) carried = keyed;
      else if (mode === 'shell') return fail('auth', keyed.failure);
      // else (a) for a site with no command tool, or a takeover: today's CLI env / terminal env.
    }
    const keyPath = carried.keyFile;
    return {
      carry: true, failure: null, providerId: p.providerId, overrides: carried.overrides, model: p.model, cliEnv: carried.cliEnv, burst,
      // A key that still has to travel in an env Plexiform translated it into: a terminal takeover can't carry that.
      translated: Object.keys(carried.cliEnv).some((k) => TRANSLATED.test(k)), codexHome: p.codexHome, keyFile: keyPath,
      release() { if (keyPath) removeKey(keyPath); },
    };
  }

  // (b): the env_key (or translated bearer token) value moves from the CLI env to the key file, and env_key gives way
  // to an auth command Plexiform owns. Anything else in the CLI env is a header value: refused.
  function viaAuthFile(p, overrides, keyFile) {
    const prefix = `model_providers.${p.providerId}.`;
    const envKeyOverride = overrides.find((o) => o.startsWith(`${prefix}env_key=`));
    let name = null;
    try { name = envKeyOverride ? JSON.parse(envKeyOverride.slice(`${prefix}env_key=`.length)) : null; } catch { name = null; }
    if (Object.keys(p.cliEnv).some((k) => k !== name)) return { failure: HEADER_NOT_KEPT };
    if (!name || typeof p.cliEnv[name] !== 'string') return { failure: KEY_NOT_KEPT };
    try { writeKey(keyFile, p.cliEnv[name]); } catch { return { failure: KEY_NOT_KEPT }; }
    const exclusive = ['env_key', 'experimental_bearer_token', 'requires_openai_auth'].map((f) => `${prefix}${f}=`);
    return {
      overrides: [...overrides.filter((o) => !exclusive.some((x) => o.startsWith(x))),
        `${prefix}auth={command="/bin/cat",args=[${JSON.stringify(keyFile)}],timeout_ms=${AUTH_TIMEOUT_MS}}`],
      cliEnv: {}, keyFile,
    };
  }

  return { prepare, resolve };
}

// The login-shell names main must read for the Codex carry (src/login-env-hub.js): CODEX_HOME, then the variables
// the provider in that CODEX_HOME's config.toml names (env_key, env_http_headers). Names only, never values.
function codexLoginNames({ env = process.env, loginEnv = {}, home = os.homedir(), readFile = (file) => boundedReadFile(file, CONFIG_TOML_MAX_BYTES) } = {}) {
  let p;
  try { p = codexProvider({ env, loginEnv, home, readFile }); } catch { return ['CODEX_HOME']; }
  return ['CODEX_HOME', ...p.envNames];
}

// The carry the app's own processes use. Under the no-real-cli guard (tests) there is none, so a test that
// starts an entry point never reads the developer's Codex config.
function productionCodexCarry(opts = {}) {
  if (globalThis.__plexiformNoRealCli) return null;
  return createCodexCarry({ env: process.env, ...opts });
}

// A Codex takeover runs in the user's own terminal: a value Plexiform translated out of config.toml can't follow it.
const TAKEOVER_TRANSLATED = 'This Codex provider has its key written in config.toml, which a terminal takeover can\'t carry. Move it to env_key with the variable exported in your shell, then take over again.';

module.exports = { createCodexCarry, productionCodexCarry, codexLoginNames, KEY_VIA_AUTH_FILE, CODEX_KEY_FILE, CODEX_TAKEOVER_KEY_FILE, AUTH_TIMEOUT_MS, KEY_NOT_KEPT, HEADER_NOT_KEPT, overrideKeyAllowed, gatewayOf, TAKEOVER_TRANSLATED };
