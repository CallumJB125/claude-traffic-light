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
const os = require('node:os');
const {
  codexProvider, boundedReadFile, CONFIG_TOML_MAX_BYTES,
} = require('./user-provider.cjs');
const { tcpProbe, burstOwnsPort, PROBE_MS } = require('./claude-carry.cjs');

const TRANSLATED = /^PLEXIFORM_PROVIDER_/;
const LOOPBACK = (host) => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
const BARE_ID = /^[A-Za-z0-9_-]+$/;
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
  burstOwnsPort: burstOwns = (port) => burstOwnsPort(port, { home, platform }),
  log = () => {},
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
  async function prepare() {
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
    return {
      carry: true, failure: null, providerId: p.providerId, overrides, model: p.model, cliEnv: { ...p.cliEnv }, burst,
      translated: Object.keys(p.cliEnv).some((k) => TRANSLATED.test(k)), codexHome: p.codexHome, release() {},
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

module.exports = { createCodexCarry, productionCodexCarry, codexLoginNames, overrideKeyAllowed, gatewayOf, TAKEOVER_TRANSLATED };
